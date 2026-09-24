/**
 * Core Bridge Engine
 * Orchestrates message routing, dialect translation, deduplication, and thread mapping.
 */

import { EventEmitter } from 'node:events';
import { BridgeDatabase } from '../db/index.js';
import { DeduplicationManager } from './deduplication.js';
import { ThreadMapper } from './thread-mapper.js';
import { MessageTranslator, ReactionGroup } from './translator.js';
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
  /** Remove a reaction the bridge previously mirrored. */
  removeReaction?(
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
    threadRootId?: string,
    options?: { footer?: string }
  ): Promise<void>;
  /** Post a plain bridge notice (not attributed to a user) into a thread. */
  postNotice?(
    targetChannelId: string,
    text: string,
    mapping: ChannelMapping,
    threadRootId: string
  ): Promise<{ messageId: string }>;
  /** Replace the text of a notice posted with postNotice. */
  updateNotice?(
    targetChannelId: string,
    noticeId: string,
    text: string,
    mapping: ChannelMapping,
    threadRootId: string
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
  /** Serializes work per message pair so concurrent reactions/edits don't race (e.g. two notices) */
  private pairLocks = new Map<number, Promise<void>>();

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
          sourceContent: msg.content,
          sourceSender: msg.sender,
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
          sourceContent: msg.content,
          sourceSender: msg.sender,
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
   * Handle an emoji reaction being added or removed.
   *
   * - Teams -> Slack: native Slack reactions, reference-counted because the bridge reacts as a
   *   single bot user (two Teams "likes" are one Slack :+1:, removed only when both are gone).
   * - Slack -> Teams: Teams bots can't react, so reactions are shown as a footer on messages the
   *   bridge posted, or (opt-in, `reactionNotices`) as one thread-reply notice on Teams-authored ones.
   */
  async handleIncomingReaction(reaction: NormalizedReaction): Promise<void> {
    try {
      if (this.dedup.isBotSender(reaction.sourcePlatform, reaction.sender.platformId)) {
        return;
      }

      const target = this.findMirroredTarget(reaction.sourcePlatform, reaction.sourceChannelId, reaction.sourceMessageId);
      if (!target || !target.mapping.options.syncReactions) return;

      await this.withPairLock(target.pair.id!, async () => {
        // Re-read inside the lock: a concurrent reaction may have just posted the notice
        const fresh = this.findMirroredTarget(reaction.sourcePlatform, reaction.sourceChannelId, reaction.sourceMessageId);
        if (!fresh) return;
        await (reaction.sourcePlatform === 'teams'
          ? this.mirrorReactionToSlack(reaction, fresh)
          : this.mirrorReactionToTeams(reaction, fresh));
      });
    } catch (err) {
      this.emit('error', err);
    }
  }

  private async mirrorReactionToSlack(reaction: NormalizedReaction, target: MirroredTarget): Promise<void> {
    const pairId = target.pair.id!;
    const { emoji, sender } = reaction;

    if (reaction.action === 'add') {
      if (!this.db.addReaction(pairId, 'teams', emoji, sender.platformId, sender.displayName)) return;
      if (this.db.countReactions(pairId, 'teams', emoji) !== 1) return;

      const adapter = this.adapters.get('slack');
      if (!adapter?.sendReaction) return;
      try {
        await adapter.sendReaction(target.targetChannelId, target.targetMessageId, reaction);
      } catch (err) {
        // Keep the count consistent with Slack so a retry can add it again
        this.db.removeReaction(pairId, 'teams', emoji, sender.platformId);
        throw err;
      }
      return;
    }

    if (!this.db.removeReaction(pairId, 'teams', emoji, sender.platformId)) return;
    if (this.db.countReactions(pairId, 'teams', emoji) !== 0) return;
    await this.adapters.get('slack')?.removeReaction?.(target.targetChannelId, target.targetMessageId, reaction);
  }

  private async mirrorReactionToTeams(reaction: NormalizedReaction, target: MirroredTarget): Promise<void> {
    const { pair, mapping } = target;
    const pairId = pair.id!;
    const { emoji, sender } = reaction;

    const changed =
      reaction.action === 'add'
        ? this.db.addReaction(pairId, 'slack', emoji, sender.platformId, sender.displayName)
        : this.db.removeReaction(pairId, 'slack', emoji, sender.platformId);
    if (!changed) return;

    const teams = this.adapters.get('teams');
    if (!teams) return;
    const groups = this.reactionGroups(pairId, 'slack');

    // Case A: the bridge posted this Teams message, so it can re-render it with a footer
    const stored = this.storedMessage(pair);
    if (pair.originPlatform === 'slack' && stored && teams.updateMessage) {
      await teams.updateMessage(target.targetChannelId, target.targetMessageId, stored, mapping, target.threadRootId, {
        footer: MessageTranslator.formatReactionFooter(groups),
      });
      return;
    }

    // Case B: a person wrote it in Teams; keep one notice in its thread, edited as reactions change
    if (!mapping.options.reactionNotices) return;

    const threadRootId = pair.teamsRootMessageId ?? pair.teamsMessageId;
    // Quote the message when it's a reply, since the notice lands at the bottom of the thread
    const text = MessageTranslator.formatReactionNotice(groups, pair.teamsRootMessageId ? pair.sourceContent : undefined);

    if (pair.teamsNoticeMessageId) {
      if (groups.length === 0) {
        await teams.deleteMessage?.(target.targetChannelId, pair.teamsNoticeMessageId, mapping, threadRootId);
        this.db.setTeamsNoticeMessageId(pairId, null);
      } else {
        await teams.updateNotice?.(target.targetChannelId, pair.teamsNoticeMessageId, text, mapping, threadRootId);
      }
    } else if (groups.length > 0 && teams.postNotice) {
      const { messageId } = await teams.postNotice(target.targetChannelId, text, mapping, threadRootId);
      this.dedup.markRelayed('teams', target.targetChannelId, messageId);
      this.db.setTeamsNoticeMessageId(pairId, messageId);
    }
  }

  /** Reactions recorded on `platform` for a pair, grouped by emoji in first-seen order. */
  private reactionGroups(pairId: number, platform: Platform): ReactionGroup[] {
    const groups = new Map<string, string[]>();
    for (const r of this.db.listReactions(pairId, platform)) {
      const users = groups.get(r.emoji) ?? [];
      users.push(r.userName || r.userId);
      groups.set(r.emoji, users);
    }
    return [...groups].map(([emoji, users]) => ({ emoji, users }));
  }

  /** Rebuild the original message from a pair's stored content, if it was recorded. */
  private storedMessage(pair: MessageMappingRecord): NormalizedMessage | null {
    if (pair.sourceContent === undefined || !pair.sourceSender || !pair.originPlatform) return null;
    const onSlack = pair.originPlatform === 'slack';
    return {
      id: `stored-${pair.id}`,
      sourcePlatform: pair.originPlatform,
      sourceChannelId: onSlack ? pair.slackChannelId : pair.teamsChannelId,
      sourceMessageId: onSlack ? pair.slackMessageTs : pair.teamsMessageId,
      sender: pair.sourceSender,
      content: pair.sourceContent,
      timestamp: new Date(),
    };
  }

  private async withPairLock(pairId: number, fn: () => Promise<void>): Promise<void> {
    const previous = this.pairLocks.get(pairId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    this.pairLocks.set(pairId, current);
    try {
      await current;
    } finally {
      if (this.pairLocks.get(pairId) === current) this.pairLocks.delete(pairId);
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

      await this.withPairLock(target.pair.id!, async () => {
        // Preserve the Slack reaction footer on bridge-posted Teams messages
        const footer =
          target.targetPlatform === 'teams'
            ? MessageTranslator.formatReactionFooter(this.reactionGroups(target.pair.id!, 'slack'))
            : undefined;

        await adapter.updateMessage!(
          target.targetChannelId,
          target.targetMessageId,
          msg,
          target.mapping,
          target.threadRootId,
          footer ? { footer } : undefined
        );
        this.db.updateMessageContent(target.pair.id!, msg.content);
      });

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

      // A deleted Teams original takes its Slack-reaction notice with it
      const noticeId = target.pair.teamsNoticeMessageId;
      if (noticeId) {
        await this.adapters
          .get('teams')
          ?.deleteMessage?.(target.pair.teamsChannelId, noticeId, target.mapping, target.pair.teamsRootMessageId ?? target.pair.teamsMessageId)
          .catch((err) => this.emit('error', err));
      }

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
