/**
 * Thread Mapper
 * Resolves parent thread IDs bi-directionally between Slack timestamps and Teams message IDs.
 */

import { BridgeDatabase, MessageMappingRecord } from '../db/index.js';
import { Platform, UserIdentity } from './types.js';

export class ThreadMapper {
  constructor(private db: BridgeDatabase) {}

  /**
   * For an incoming Slack message with a `thread_ts`, resolve the target Teams parent message ID.
   */
  resolveTeamsParent(slackChannelId: string, slackThreadTs?: string): string | undefined {
    if (!slackThreadTs) return undefined;

    const record = this.db.findBySlackMessage(slackChannelId, slackThreadTs);
    return record ? record.teamsMessageId : undefined;
  }

  /**
   * For an incoming Teams message with a `replyToId`, resolve the target Slack parent `thread_ts`.
   */
  resolveSlackParent(teamsChannelId: string, teamsReplyToId?: string): string | undefined {
    if (!teamsReplyToId) return undefined;

    const record = this.db.findByTeamsMessage(teamsChannelId, teamsReplyToId);
    return record ? record.slackMessageTs : undefined;
  }

  /**
   * Record a newly relayed message pair so future thread replies will link to it.
   */
  recordMessagePair(params: {
    mappingId: string;
    slackChannelId: string;
    slackMessageTs: string;
    teamsTeamId: string;
    teamsChannelId: string;
    teamsMessageId: string;
    isThreadRoot?: boolean;
    originPlatform?: Platform;
    teamsRootMessageId?: string;
    sourceContent?: string;
    sourceSender?: UserIdentity;
  }): void {
    this.db.saveMessageMapping({
      mappingId: params.mappingId,
      slackChannelId: params.slackChannelId,
      slackMessageTs: params.slackMessageTs,
      teamsTeamId: params.teamsTeamId,
      teamsChannelId: params.teamsChannelId,
      teamsMessageId: params.teamsMessageId,
      isThreadRoot: params.isThreadRoot ?? false,
      originPlatform: params.originPlatform,
      teamsRootMessageId: params.teamsRootMessageId,
      sourceContent: params.sourceContent,
      sourceSender: params.sourceSender,
    });
  }

  /**
   * Find mapping by Slack message
   */
  findBySlack(slackChannelId: string, slackTs: string): MessageMappingRecord | null {
    return this.db.findBySlackMessage(slackChannelId, slackTs);
  }

  /**
   * Find mapping by Teams message
   */
  findByTeams(teamsChannelId: string, teamsMsgId: string): MessageMappingRecord | null {
    return this.db.findByTeamsMessage(teamsChannelId, teamsMsgId);
  }
}
