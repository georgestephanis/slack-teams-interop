/**
 * Normalized Message and Event Types
 * Protocol-neutral data structures inspired by the Matrix.org event schema,
 * allowing seamless bridging between Slack, Microsoft Teams, and future protocols.
 */

export type Platform = 'slack' | 'teams' | 'matrix';

export interface UserIdentity {
  /** Platform-specific user identifier (e.g. U123456 or AAD ObjectId) */
  platformId: string;
  /** Display name shown to end users */
  displayName: string;
  /** Avatar/Profile image URL */
  avatarUrl?: string;
  /** Email address if known (useful for cross-platform identity mapping) */
  email?: string;
  /** The originating platform */
  platform: Platform;
}

export interface Attachment {
  id: string;
  name: string;
  contentType: string;
  size?: number;
  /** Direct file URL; usually requires the source platform's credentials */
  downloadUrl?: string;
  /** Link a person can open to view the file on the source platform (may require access there) */
  permalink?: string;
  thumbnailUrl?: string;
  /** Publicly loadable image URL (the bridge's signed media proxy), so the other platform can show it inline */
  displayUrl?: string;
  /** Downloads the file with the source platform's credentials. Transient: never stored. */
  fetchContent?: () => Promise<Buffer>;
  /** Id of the copy uploaded to Slack, once transferred (reused on edits and re-renders) */
  slackFileId?: string;
}

export function isImageAttachment(a: Attachment): boolean {
  return a.contentType.startsWith('image/') && a.contentType !== 'image/svg+xml';
}

export interface NormalizedMessage {
  /** Unique bridge-internal event ID */
  id: string;
  /** Originating platform */
  sourcePlatform: Platform;
  /** Source channel identifier */
  sourceChannelId: string;
  /** Source team/workspace identifier */
  sourceTeamId?: string;
  /** Source message timestamp or ID */
  sourceMessageId: string;
  /** Sender info */
  sender: UserIdentity;
  /** Clean normalized markdown content */
  content: string;
  /** Optional parent message ID on the source platform if this is a threaded reply */
  sourceParentId?: string;
  /** Attached files or images */
  attachments?: Attachment[];
  /** Message creation timestamp */
  timestamp: Date;
  /** Raw platform payload for specialized adapter processing if needed */
  rawEvent?: unknown;
}

/** Identifies a message on its source platform (used for deletes). */
export interface NormalizedMessageRef {
  sourcePlatform: Platform;
  sourceChannelId: string;
  sourceMessageId: string;
  /** Who performed the action, when known */
  senderId?: string;
}

export interface NormalizedReaction {
  id: string;
  sourcePlatform: Platform;
  sourceChannelId: string;
  sourceMessageId: string;
  sender: UserIdentity;
  /** Standard emoji name (e.g., 'thumbsup', 'heart', 'smile') or unicode */
  emoji: string;
  /** 'add' or 'remove' */
  action: 'add' | 'remove';
}

export interface ChannelMapping {
  id: string;
  name: string;
  enabled: boolean;
  slack: {
    channelId: string;
    channelName?: string;
  };
  teams: {
    teamId: string;
    channelId: string;
    teamName?: string;
    channelName?: string;
  };
  options: {
    syncThreads: boolean;
    syncReactions: boolean;
    syncEdits: boolean;
    syncDeletes: boolean;
    syncFiles: boolean;
    teamsFormatStyle: 'adaptive_card' | 'clean_markdown';
    /**
     * Post Slack reactions to Teams-authored messages as a thread reply (Teams bots can't react).
     * Reactions to bridge-posted Teams messages are always shown as an in-place footer.
     */
    reactionNotices: boolean;
  };
  createdAt: string;
  updatedAt: string;
}

/**
 * Defaults applied to mapping options on read. Add new option keys here with their default value.
 */
export const DEFAULT_MAPPING_OPTIONS: ChannelMapping['options'] = {
  syncThreads: true,
  syncReactions: true,
  syncEdits: false,
  syncDeletes: false,
  syncFiles: false,
  teamsFormatStyle: 'adaptive_card',
  reactionNotices: false,
};
