/**
 * Slack Adapter
 * Bridges Slack to the core engine using @slack/bolt.
 * Supports both Socket Mode (WebSocket) and HTTP webhook receiver.
 */

import { App, LogLevel } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { BridgeAdapter, BridgeCore } from '../../core/bridge.js';
import { MessageTranslator } from '../../core/translator.js';
import {
  ChannelMapping,
  NormalizedMessage,
  NormalizedReaction,
  Platform,
  UserIdentity,
} from '../../core/types.js';

export interface SlackAdapterConfig {
  botToken: string;
  appToken?: string; // Required for Socket Mode
  signingSecret?: string; // Required for HTTP Webhook mode
  useSocketMode?: boolean;
}

interface SlackMessageChangedEvent {
  channel: string;
  message?: { ts: string; text?: string; user?: string; bot_id?: string; thread_ts?: string; edited?: unknown };
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

    this.app = new App({
      token: config.botToken,
      appToken: isSocketMode ? config.appToken : undefined,
      signingSecret: config.signingSecret,
      socketMode: isSocketMode,
      logLevel: LogLevel.WARN,
    });

    this.client = this.app.client;
    this.setupEventListeners();
  }

  async start(): Promise<void> {
    const auth = await this.client.auth.test();
    this.botUserId = auth.user_id;
    if (this.botUserId) {
      this.bridge.dedup.registerBotId('slack', this.botUserId);
    }

    await this.app.start();
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
      };

      if (!messageEvent.user || !messageEvent.text) return;
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
        content: messageEvent.text,
        timestamp: new Date(parseFloat(messageEvent.ts) * 1000),
        rawEvent: event,
      };

      await this.bridge.handleIncomingMessage(normalized);
    });

    // 2. Listen for emoji reactions
    this.app.event('reaction_added', async ({ event }) => {
      if (event.item.type !== 'message') return;

      const sender = await this.resolveUserInfo(event.user);
      const normalizedReaction: NormalizedReaction = {
        id: `slack-reaction-${event.item.channel}-${event.item.ts}-${event.reaction}`,
        sourcePlatform: 'slack',
        sourceChannelId: event.item.channel,
        sourceMessageId: event.item.ts,
        sender,
        emoji: event.reaction,
        action: 'add',
      };

      await this.bridge.handleIncomingReaction(normalizedReaction);
    });
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
  ): Promise<{ messageId: string }> {
    const text = MessageTranslator.teamsToSlack(message.content);

    const postParams = {
      channel: targetChannelId,
      text,
      username: `${message.sender.displayName} (Teams)`,
      icon_url: message.sender.avatarUrl,
      thread_ts: parentMessageId,
    };

    const res = await this.client.chat.postMessage(postParams);

    if (!res.ts) {
      throw new Error(`Slack postMessage failed: missing timestamp in response`);
    }

    return { messageId: res.ts };
  }

  /**
   * Update a message the bridge posted to Slack (the Teams original was edited).
   * chat.update keeps the original username/icon override.
   */
  async updateMessage(targetChannelId: string, targetMessageId: string, message: NormalizedMessage): Promise<void> {
    await this.client.chat.update({
      channel: targetChannelId,
      ts: targetMessageId,
      text: MessageTranslator.teamsToSlack(message.content),
    });
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
