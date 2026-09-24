/**
 * Slack Adapter
 * Bridges Slack to the core engine using @slack/bolt.
 * Supports both Socket Mode (WebSocket) and HTTP webhook receiver.
 */

import { App, ExpressReceiver, LogLevel } from '@slack/bolt';
import type { IRouter } from 'express';
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

/** Path the Slack Events API posts to in HTTP mode (mounted on the shared web server). */
export const SLACK_EVENTS_PATH = '/slack/events';

export interface SlackAdapterConfig {
  botToken: string;
  appToken?: string; // Required for Socket Mode
  signingSecret?: string; // Required for HTTP Webhook mode
  useSocketMode?: boolean;
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
      // Ignore edits, deletions, joins, and bot echoes
      if (
        'subtype' in event &&
        (event.subtype === 'message_changed' ||
          event.subtype === 'message_deleted' ||
          event.subtype === 'channel_join' ||
          event.subtype === 'channel_leave' ||
          event.subtype === 'bot_message')
      ) {
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
      if (typeof err === 'object' && err !== null && 'data' in err) {
        const slackErr = err as { data?: { error?: string } };
        if (slackErr.data?.error === 'already_reacted') return;
      }
      throw err;
    }
  }
}
