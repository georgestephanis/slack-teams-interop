/**
 * Core Bridge Engine
 * Orchestrates message routing, dialect translation, deduplication, and thread mapping.
 */

import { EventEmitter } from 'node:events';
import { BridgeDatabase } from '../db/index.js';
import { DeduplicationManager } from './deduplication.js';
import { ThreadMapper } from './thread-mapper.js';
import { MessageTranslator } from './translator.js';
import { MessageMappingRecord } from '../db/index.js';
import {
  ChannelMapping,
  NormalizedMessage,
  NormalizedMessageRef,
  NormalizedReaction,
  Platform,
} from './types.js';

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
  /** Replace the content of a message the bridge previously posted. */
  updateMessage?(
    targetChannelId: string,
    targetMessageId: string,
    message: NormalizedMessage,
    mapping: ChannelMapping,
    threadRootId?: string
  ): Promise<void>;
  /** Delete a message the bridge previously posted. */
  deleteMessage?(
    targetChannelId: string,
    targetMessageId: string,
    mapping: ChannelMapping,
    threadRootId?: string
  ): Promise<void>;
}

/** Where a message on one platform lives on the other, resolved from a stored ID pair. */
interface MirroredTarget {
  mapping: ChannelMapping;
  pair: MessageMappingRecord;
  targetPlatform: Platform;
  targetChannelId: string;
  targetMessageId: string;
  /** Teams thread root, when the target is a Teams reply */
  threadRootId?: string;
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
      if (this.dedup.isEcho(msg.sourcePlatform, msg.sourceChannelId, msg.sourceMessageId)) {
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
      this.dedup.markRelayed(targetPlatform, targetChannelId, result.messageId);

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
          originPlatform: 'slack',
          teamsRootMessageId: targetParentId,
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
          originPlatform: 'teams',
          teamsRootMessageId: msg.sourceParentId,
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

  /**
   * Handle an edit to a message on its origin platform by updating the mirrored copy.
   */
  async handleIncomingEdit(msg: NormalizedMessage): Promise<void> {
    try {
      if (this.dedup.isBotSender(msg.sourcePlatform, msg.sender.platformId)) {
        return;
      }

      const target = this.findMirroredTarget(msg.sourcePlatform, msg.sourceChannelId, msg.sourceMessageId);
      if (!target || !target.mapping.options.syncEdits) return;

      // Only the author's side can edit; ignore edits to the bridge's own mirror copies.
      // Rows recorded before origin tracking have no originPlatform; an edit event from a
      // non-bot sender implies they authored it on this side.
      if (target.pair.originPlatform && target.pair.originPlatform !== msg.sourcePlatform) return;

      const adapter = this.adapters.get(target.targetPlatform);
      if (!adapter?.updateMessage) return;

      await adapter.updateMessage(
        target.targetChannelId,
        target.targetMessageId,
        msg,
        target.mapping,
        target.threadRootId
      );

      this.emit('message:edited', {
        sourcePlatform: msg.sourcePlatform,
        targetPlatform: target.targetPlatform,
        sourceMessageId: msg.sourceMessageId,
        targetMessageId: target.targetMessageId,
        channel: target.mapping.name,
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Handle a deletion on the origin platform by deleting the mirrored copy.
   */
  async handleIncomingDelete(ref: NormalizedMessageRef): Promise<void> {
    try {
      if (ref.senderId && this.dedup.isBotSender(ref.sourcePlatform, ref.senderId)) {
        return;
      }

      const target = this.findMirroredTarget(ref.sourcePlatform, ref.sourceChannelId, ref.sourceMessageId);
      if (!target || !target.mapping.options.syncDeletes) return;

      // Deletes are destructive: only propagate when we know this side is the origin, so that
      // removing the bridge's mirror copy never deletes the author's original.
      if (target.pair.originPlatform !== ref.sourcePlatform) return;

      const adapter = this.adapters.get(target.targetPlatform);
      if (!adapter?.deleteMessage) return;

      await adapter.deleteMessage(target.targetChannelId, target.targetMessageId, target.mapping, target.threadRootId);
      this.db.deleteMessageMapping(target.pair.id!);

      this.emit('message:deleted', {
        sourcePlatform: ref.sourcePlatform,
        targetPlatform: target.targetPlatform,
        sourceMessageId: ref.sourceMessageId,
        targetMessageId: target.targetMessageId,
        channel: target.mapping.name,
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Resolve the mirrored copy of a source message via its enabled mapping and stored ID pair.
   */
  private findMirroredTarget(
    sourcePlatform: Platform,
    sourceChannelId: string,
    sourceMessageId: string
  ): MirroredTarget | null {
    if (sourcePlatform === 'slack') {
      const mapping = this.db.findMappingBySlackChannel(sourceChannelId);
      const pair = this.threadMapper.findBySlack(sourceChannelId, sourceMessageId);
      if (!mapping || !mapping.enabled || !pair) return null;
      return {
        mapping,
        pair,
        targetPlatform: 'teams',
        targetChannelId: mapping.teams.channelId,
        targetMessageId: pair.teamsMessageId,
        threadRootId: pair.teamsRootMessageId,
      };
    }

    if (sourcePlatform === 'teams') {
      const mapping = this.db.findMappingByTeamsChannel(sourceChannelId);
      const pair = this.threadMapper.findByTeams(sourceChannelId, sourceMessageId);
      if (!mapping || !mapping.enabled || !pair) return null;
      return {
        mapping,
        pair,
        targetPlatform: 'slack',
        targetChannelId: mapping.slack.channelId,
        targetMessageId: pair.slackMessageTs,
      };
    }

    return null;
  }
}
