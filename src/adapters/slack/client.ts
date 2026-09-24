/**
 * Slack Adapter
 * Bridges Slack to the core engine using @slack/bolt.
 * Supports both Socket Mode (WebSocket) and HTTP webhook receiver.
 */

import { App, ExpressReceiver, LogLevel } from '@slack/bolt';
import type { Block, KnownBlock } from '@slack/web-api';
import type { IRouter } from 'express';
import { WebClient } from '@slack/web-api';
import { BridgeAdapter, BridgeCore, SendResult } from '../../core/bridge.js';
import { MessageTranslator } from '../../core/translator.js';
import { MAX_TRANSFER_BYTES, MediaSigner } from '../../core/media.js';
import {
  Attachment,
  ChannelMapping,
  isImageAttachment,
  NormalizedMessage,
  NormalizedReaction,
  Platform,
  UserIdentity,
} from '../../core/types.js';

/** Path the Slack Events API posts to in HTTP mode (mounted on the shared web server). */
export const SLACK_EVENTS_PATH = '/slack/events';

export interface SlackAdapterConfig {
  botToken: string;
  appToken?: string; // Required for Socket Mode
  signingSecret?: string; // Required for HTTP Webhook mode
  useSocketMode?: boolean;
  /** Signs proxy URLs so Teams can show Slack images inline; without it images are relayed as links */
  mediaSigner?: MediaSigner;
}

interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
  url_private?: string;
  thumb_360?: string;
}

interface SlackMessageChangedEvent {
  channel: string;
  message?: {
    ts: string;
    text?: string;
    user?: string;
    bot_id?: string;
    thread_ts?: string;
    edited?: unknown;
    files?: SlackFile[];
  };
}

/** Map Slack file objects to normalized attachments (links only; files aren't transferred). */
function toAttachments(files?: SlackFile[], signer?: MediaSigner): Attachment[] | undefined {
  if (!files?.length) return undefined;
  return files.map((f) => {
    const attachment: Attachment = {
      id: f.id,
      name: f.name || f.title || 'file',
      contentType: f.mimetype || 'application/octet-stream',
      size: f.size,
      downloadUrl: f.url_private,
      permalink: f.permalink,
      thumbnailUrl: f.thumb_360,
    };
    if (signer && f.url_private && isImageAttachment(attachment) && (f.size ?? 0) <= MAX_TRANSFER_BYTES) {
      attachment.displayUrl = signer.sign(f.url_private);
    }
    return attachment;
  });
}

interface SlackMessageDeletedEvent {
  channel: string;
  deleted_ts: string;
  previous_message?: { user?: string; bot_id?: string };
}

export class SlackAdapter implements BridgeAdapter {
  public platform: Platform = 'slack';
  public app: App;
  public client: WebClient;
  /** True once auth succeeded and the receiver started */
  public connected = false;
  public readonly socketMode: boolean;
  /**
   * HTTP mode only: Express router serving SLACK_EVENTS_PATH. Mount it on the shared server
   * before any JSON body parser (signature verification needs the raw body) and before admin auth.
   */
  public readonly httpRouter?: IRouter;
  private botUserId?: string;

  constructor(
    private config: SlackAdapterConfig,
    private bridge: BridgeCore
  ) {
    const isSocketMode = config.useSocketMode !== false && Boolean(config.appToken);
    this.socketMode = isSocketMode;

    if (!isSocketMode && !config.signingSecret) {
      throw new Error(
        'Slack HTTP mode requires SLACK_SIGNING_SECRET (or set SLACK_APP_TOKEN to use Socket Mode).'
      );
    }

    if (isSocketMode) {
      this.app = new App({
        token: config.botToken,
        appToken: config.appToken,
        socketMode: true,
        logLevel: LogLevel.WARN,
      });
    } else {
      // Serve events from the shared Express server rather than Bolt's own listener (port 3000)
      const receiver = new ExpressReceiver({
        signingSecret: config.signingSecret!,
        endpoints: SLACK_EVENTS_PATH,
        logLevel: LogLevel.WARN,
      });
      this.httpRouter = receiver.router;
      this.app = new App({
        token: config.botToken,
        receiver,
        logLevel: LogLevel.WARN,
      });
    }

    this.client = this.app.client;
    this.setupEventListeners();
  }

  async start(): Promise<void> {
    const auth = await this.client.auth.test();
    this.botUserId = auth.user_id;
    if (this.botUserId) {
      this.bridge.dedup.registerBotId('slack', this.botUserId);
    }

    // In HTTP mode the shared web server receives events, so there is no listener to start
    if (this.socketMode) {
      await this.app.start();
    }
    this.connected = true;
  }

  private setupEventListeners(): void {
    // 1. Listen for new messages in channels
    this.app.event('message', async ({ event }) => {
      const subtype = 'subtype' in event ? event.subtype : undefined;

      // Edits: only relay real user edits (unfurls and bridge chat.update calls also fire message_changed)
      if (subtype === 'message_changed') {
        await this.handleMessageChanged(event as unknown as SlackMessageChangedEvent);
        return;
      }

      if (subtype === 'message_deleted') {
        const deleted = event as unknown as SlackMessageDeletedEvent;
        // A deleted bridge post (e.g. removed by a Slack admin) must not delete the Teams original
        if (deleted.previous_message?.bot_id) return;
        await this.bridge.handleIncomingDelete({
          sourcePlatform: 'slack',
          sourceChannelId: deleted.channel,
          sourceMessageId: deleted.deleted_ts,
          senderId: deleted.previous_message?.user,
        });
        return;
      }

      // Ignore joins and bot echoes
      if (subtype === 'channel_join' || subtype === 'channel_leave' || subtype === 'bot_message') {
        return;
      }

      const messageEvent = event as {
        user?: string;
        text?: string;
        channel: string;
        ts: string;
        thread_ts?: string;
        bot_id?: string;
        files?: SlackFile[];
      };

      const attachments = toAttachments(messageEvent.files, this.config.mediaSigner);
      if (!messageEvent.user || (!messageEvent.text && !attachments)) return;
      if (messageEvent.bot_id) return;

      // Resolve user profile
      const sender = await this.resolveUserInfo(messageEvent.user);

      const normalized: NormalizedMessage = {
        id: `slack-${messageEvent.channel}-${messageEvent.ts}`,
        sourcePlatform: 'slack',
        sourceChannelId: messageEvent.channel,
        sourceMessageId: messageEvent.ts,
        sourceParentId: messageEvent.thread_ts !== messageEvent.ts ? messageEvent.thread_ts : undefined,
        sender,
        content: messageEvent.text || '',
        attachments,
        timestamp: new Date(parseFloat(messageEvent.ts) * 1000),
        rawEvent: event,
      };

      await this.bridge.handleIncomingMessage(normalized);
    });

    // 2. Listen for emoji reactions being added and removed
    const onReaction = (action: 'add' | 'remove') =>
      async ({ event }: { event: { user: string; reaction: string; item: { type: string; channel?: string; ts?: string } } }) => {
        if (event.item.type !== 'message' || !event.item.channel || !event.item.ts) return;

        const sender = await this.resolveUserInfo(event.user);
        const normalizedReaction: NormalizedReaction = {
          id: `slack-reaction-${event.item.channel}-${event.item.ts}-${event.reaction}`,
          sourcePlatform: 'slack',
          sourceChannelId: event.item.channel,
          sourceMessageId: event.item.ts,
          sender,
          emoji: event.reaction,
          action,
        };

        await this.bridge.handleIncomingReaction(normalizedReaction);
      };

    this.app.event('reaction_added', onReaction('add'));
    this.app.event('reaction_removed', onReaction('remove'));
  }

  private async handleMessageChanged(event: SlackMessageChangedEvent): Promise<void> {
    const edited = event.message;
    if (!edited?.user || !edited.edited || edited.bot_id || edited.text === undefined) return;

    const sender = await this.resolveUserInfo(edited.user);
    await this.bridge.handleIncomingEdit({
      id: `slack-edit-${event.channel}-${edited.ts}`,
      sourcePlatform: 'slack',
      sourceChannelId: event.channel,
      sourceMessageId: edited.ts,
      sourceParentId: edited.thread_ts !== edited.ts ? edited.thread_ts : undefined,
      sender,
      content: edited.text,
      attachments: toAttachments(edited.files, this.config.mediaSigner),
      timestamp: new Date(),
      rawEvent: event,
    });
  }

  /**
   * Resolve user display name and avatar, using cache if available.
   */
  private async resolveUserInfo(userId: string): Promise<UserIdentity> {
    const cached = this.bridge.db.getCachedUser('slack', userId);
    if (cached) {
      return {
        platformId: userId,
        displayName: cached.display_name,
        avatarUrl: cached.avatar_url,
        email: cached.email,
        platform: 'slack',
      };
    }

    try {
      const info = await this.client.users.info({ user: userId });
      const user = info.user;
      const displayName =
        user?.profile?.display_name || user?.profile?.real_name || user?.name || userId;
      const avatarUrl = user?.profile?.image_72 || user?.profile?.image_48;
      const email = user?.profile?.email;

      this.bridge.db.cacheUser('slack', userId, displayName, avatarUrl, email);

      return {
        platformId: userId,
        displayName,
        avatarUrl,
        email,
        platform: 'slack',
      };
    } catch {
      return {
        platformId: userId,
        displayName: userId,
        platform: 'slack',
      };
    }
  }

  /**
   * Send a message to Slack originating from Microsoft Teams.
   */
  async sendMessage(
    targetChannelId: string,
    message: NormalizedMessage,
    mapping: ChannelMapping,
    parentMessageId?: string
  ): Promise<SendResult> {
    const { text, blocks, attachments } = await this.renderMessage(message);

    const res = await this.postWithBlocks(blocks, text, (withBlocks) =>
      this.client.chat.postMessage({
        channel: targetChannelId,
        text,
        blocks: withBlocks,
        username: `${message.sender.displayName} (Teams)`,
        icon_url: message.sender.avatarUrl,
        thread_ts: parentMessageId,
      })
    );

    if (!res.ts) {
      throw new Error(`Slack postMessage failed: missing timestamp in response`);
    }

    return { messageId: res.ts, attachments };
  }

  /**
   * Update a message the bridge posted to Slack (the Teams original was edited).
   * chat.update keeps the original username/icon override.
   */
  async updateMessage(
    targetChannelId: string,
    targetMessageId: string,
    message: NormalizedMessage
  ): Promise<{ attachments?: Attachment[] }> {
    const { text, blocks, attachments } = await this.renderMessage(message);
    await this.postWithBlocks(blocks, text, (withBlocks) =>
      this.client.chat.update({ channel: targetChannelId, ts: targetMessageId, text, blocks: withBlocks ?? [] })
    );
    return { attachments };
  }

  /**
   * Translate a Teams message for Slack. Images are uploaded privately (once; the file id is reused
   * on edits) and shown as image blocks inside the relayed message, so the sender's name and avatar
   * override still applies. Images that can't be transferred fall back to a named line.
   */
  private async renderMessage(
    message: NormalizedMessage
  ): Promise<{ text: string; blocks?: (KnownBlock | Block)[]; attachments?: Attachment[] }> {
    let text = MessageTranslator.teamsToSlack(message.content);
    if (!message.attachments?.length) return { text };

    const delivered: Attachment[] = [];
    const failed: Attachment[] = [];
    for (const attachment of message.attachments) {
      try {
        const slackFileId = attachment.slackFileId ?? (await this.uploadImage(attachment));
        delivered.push({ ...attachment, slackFileId });
      } catch (err) {
        this.bridge.emit('error', new Error(`Could not transfer "${attachment.name}" to Slack: ${(err as Error).message}`));
        failed.push(attachment);
      }
    }

    if (failed.length) {
      text = MessageTranslator.teamsToSlack(MessageTranslator.appendAttachmentLines(message.content, failed, 'teams'));
    }
    if (!delivered.length) return { text };

    const blocks: (KnownBlock | Block)[] = [];
    // Section text is capped at 3000 characters per block
    for (let i = 0; i < text.length; i += 3000) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: text.slice(i, i + 3000) } });
    }
    for (const a of delivered) {
      blocks.push({ type: 'image', slack_file: { id: a.slackFileId! }, alt_text: a.name, title: { type: 'plain_text', text: a.name } });
    }

    return { text: text || delivered.map((a) => a.name).join(', '), blocks, attachments: delivered };
  }

  /** Upload an image privately (no channel), for use in image blocks. Returns the Slack file id. */
  private async uploadImage(attachment: Attachment): Promise<string> {
    if (!attachment.fetchContent) throw new Error('no content available');
    const file = await attachment.fetchContent();
    const res = (await this.client.files.uploadV2({ file, filename: attachment.name, alt_text: attachment.name })) as {
      files?: { files?: { id?: string }[] }[];
    };
    const id = res.files?.[0]?.files?.[0]?.id;
    if (!id) throw new Error('Slack did not return a file id');
    return id;
  }

  /**
   * Post with image blocks, retrying once if Slack hasn't finished processing a fresh upload
   * (`invalid_blocks`), then falling back to text only.
   */
  private async postWithBlocks<T>(
    blocks: (KnownBlock | Block)[] | undefined,
    text: string,
    post: (blocks: (KnownBlock | Block)[] | undefined) => Promise<T>
  ): Promise<T> {
    if (!blocks) return post(undefined);
    for (let attempt = 0; ; attempt++) {
      try {
        return await post(blocks);
      } catch (err) {
        if (slackErrorCode(err) !== 'invalid_blocks') throw err;
        if (attempt >= 1) {
          this.bridge.emit('error', new Error('Slack rejected image blocks; posted text only'));
          return post(undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, this.uploadRetryDelayMs));
      }
    }
  }

  /** Delay before retrying image blocks after an upload (overridable in tests) */
  uploadRetryDelayMs = 1500;

  /**
   * Download a private Slack file with the bot token (used by the media proxy).
   */
  async fetchPrivateFile(url: string): Promise<Response> {
    return fetch(url, { headers: { Authorization: `Bearer ${this.config.botToken}` }, redirect: 'follow' });
  }

  /**
   * Delete a message the bridge posted to Slack (the Teams original was deleted).
   */
  async deleteMessage(targetChannelId: string, targetMessageId: string): Promise<void> {
    try {
      await this.client.chat.delete({ channel: targetChannelId, ts: targetMessageId });
    } catch (err: unknown) {
      if (slackErrorCode(err) === 'message_not_found') return;
      throw err;
    }
  }

  /**
   * Remove a mirrored reaction from a Slack message.
   */
  async removeReaction(targetChannelId: string, targetMessageId: string, reaction: NormalizedReaction): Promise<void> {
    const name =
      reaction.sourcePlatform === 'teams' ? MessageTranslator.teamsReactionToSlack(reaction.emoji) : reaction.emoji;
    if (!name) return;

    try {
      await this.client.reactions.remove({ channel: targetChannelId, timestamp: targetMessageId, name });
    } catch (err: unknown) {
      if (slackErrorCode(err) === 'no_reaction') return;
      throw err;
    }
  }

  /**
   * Mirror a reaction onto a Slack message.
   */
  async sendReaction(
    targetChannelId: string,
    targetMessageId: string,
    reaction: NormalizedReaction
  ): Promise<void> {
    const name =
      reaction.sourcePlatform === 'teams'
        ? MessageTranslator.teamsReactionToSlack(reaction.emoji)
        : reaction.emoji;
    if (!name) return;

    try {
      await this.client.reactions.add({
        channel: targetChannelId,
        timestamp: targetMessageId,
        name,
      });
    } catch (err: unknown) {
      // Ignore already_reacted error
      if (slackErrorCode(err) === 'already_reacted') return;
      throw err;
    }
  }
}

/** Extract the Slack Web API error code (e.g. `already_reacted`) from a thrown error, if any. */
function slackErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'data' in err) {
    return (err as { data?: { error?: string } }).data?.error;
  }
  return undefined;
}
