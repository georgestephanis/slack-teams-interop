/**
 * Core Bridge Engine
 * Orchestrates message routing, dialect translation, deduplication, and thread mapping.
 */

import { EventEmitter } from 'node:events';
import { BridgeDatabase } from '../db/index.js';
import { DeduplicationManager } from './deduplication.js';
import { ThreadMapper } from './thread-mapper.js';
import { MessageTranslator } from './translator.js';
import { ChannelMapping, NormalizedMessage, NormalizedReaction, Platform } from './types.js';

export interface BridgeAdapter {
  platform: Platform;
  sendMessage(
    targetChannelId: string,
    message: NormalizedMessage,
    mapping: ChannelMapping,
    parentMessageId?: string
  ): Promise<{ messageId: string }>;
  sendReaction?(
    targetChannelId: string,
    targetMessageId: string,
    reaction: NormalizedReaction
  ): Promise<void>;
}

export class BridgeCore extends EventEmitter {
  public db: BridgeDatabase;
  public dedup: DeduplicationManager;
  public threadMapper: ThreadMapper;
  private adapters: Map<Platform, BridgeAdapter> = new Map();

  constructor(dbPath?: string) {
    super();
    this.db = new BridgeDatabase(dbPath);
    this.dedup = new DeduplicationManager();
    this.threadMapper = new ThreadMapper(this.db);
  }

  registerAdapter(adapter: BridgeAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  /**
   * Handle an incoming message from any registered platform.
   */
  async handleIncomingMessage(msg: NormalizedMessage): Promise<void> {
    try {
      // 1. Check if sender is a known bot
      if (this.dedup.isBotSender(msg.sourcePlatform, msg.sender.platformId)) {
        return;
      }

      // 2. Check if this is an echo of a relayed message
      if (this.dedup.isEcho(msg.sourceChannelId, msg.content)) {
        return;
      }

      // 3. Find the mapping for this source channel
      let mapping: ChannelMapping | null = null;
      let targetPlatform: Platform;
      let targetChannelId: string;

      if (msg.sourcePlatform === 'slack') {
        mapping = this.db.findMappingBySlackChannel(msg.sourceChannelId);
        targetPlatform = 'teams';
        targetChannelId = mapping?.teams.channelId || '';
      } else if (msg.sourcePlatform === 'teams') {
        mapping = this.db.findMappingByTeamsChannel(msg.sourceChannelId);
        targetPlatform = 'slack';
        targetChannelId = mapping?.slack.channelId || '';
      } else {
        return;
      }

      if (!mapping || !mapping.enabled) {
        return;
      }

      const targetAdapter = this.adapters.get(targetPlatform);
      if (!targetAdapter) {
        this.emit('error', new Error(`No adapter registered for target platform: ${targetPlatform}`));
        return;
      }

      // 4. Resolve Threading Parent
      let targetParentId: string | undefined;
      if (mapping.options.syncThreads && msg.sourceParentId) {
        if (msg.sourcePlatform === 'slack') {
          targetParentId = this.threadMapper.resolveTeamsParent(msg.sourceChannelId, msg.sourceParentId);
        } else if (msg.sourcePlatform === 'teams') {
          targetParentId = this.threadMapper.resolveSlackParent(msg.sourceChannelId, msg.sourceParentId);
        }
      }

      // 5. Send to target platform
      const result = await targetAdapter.sendMessage(
        targetChannelId,
        msg,
        mapping,
        targetParentId
      );

      // 6. Suppress echoes from target channel
      this.dedup.markRelayed(targetChannelId, msg.content);

      // 7. Record the message ID pair for threading continuity
      if (msg.sourcePlatform === 'slack') {
        this.threadMapper.recordMessagePair({
          mappingId: mapping.id,
          slackChannelId: msg.sourceChannelId,
          slackMessageTs: msg.sourceMessageId,
          teamsTeamId: mapping.teams.teamId,
          teamsChannelId: mapping.teams.channelId,
          teamsMessageId: result.messageId,
          isThreadRoot: !msg.sourceParentId,
        });
      } else {
        this.threadMapper.recordMessagePair({
          mappingId: mapping.id,
          slackChannelId: mapping.slack.channelId,
          slackMessageTs: result.messageId,
          teamsTeamId: msg.sourceTeamId || mapping.teams.teamId,
          teamsChannelId: msg.sourceChannelId,
          teamsMessageId: msg.sourceMessageId,
          isThreadRoot: !msg.sourceParentId,
        });
      }

      this.emit('message:relayed', {
        sourcePlatform: msg.sourcePlatform,
        targetPlatform,
        sourceMessageId: msg.sourceMessageId,
        targetMessageId: result.messageId,
        channel: mapping.name,
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Handle an incoming emoji reaction.
   */
  async handleIncomingReaction(reaction: NormalizedReaction): Promise<void> {
    try {
      if (this.dedup.isBotSender(reaction.sourcePlatform, reaction.sender.platformId)) {
        return;
      }

      let mapping: ChannelMapping | null = null;
      let targetPlatform: Platform;
      let targetParentMessageId: string | undefined;

      if (reaction.sourcePlatform === 'slack') {
        mapping = this.db.findMappingBySlackChannel(reaction.sourceChannelId);
        targetPlatform = 'teams';
        const pair = this.threadMapper.findBySlack(reaction.sourceChannelId, reaction.sourceMessageId);
        targetParentMessageId = pair?.teamsMessageId;
      } else {
        mapping = this.db.findMappingByTeamsChannel(reaction.sourceChannelId);
        targetPlatform = 'slack';
        const pair = this.threadMapper.findByTeams(reaction.sourceChannelId, reaction.sourceMessageId);
        targetParentMessageId = pair?.slackMessageTs;
      }

      if (!mapping || !mapping.options.syncReactions || !targetParentMessageId) {
        return;
      }

      const targetAdapter = this.adapters.get(targetPlatform);
      if (targetAdapter?.sendReaction) {
        const targetChannelId = targetPlatform === 'teams' ? mapping.teams.channelId : mapping.slack.channelId;
        await targetAdapter.sendReaction(targetChannelId, targetParentMessageId, reaction);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }
}
