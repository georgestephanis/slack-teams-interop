/**
 * Deduplication & Echo Prevention Cache
 * Prevents message loops when relayed messages trigger the recipient platform's webhook.
 */

import { LRUCache } from 'lru-cache';
import { Platform } from './types.js';

export interface DeduplicationOptions {
  ttlMs?: number;
  maxEntries?: number;
}

export class DeduplicationManager {
  private cache: LRUCache<string, boolean>;
  private knownBotIds: Map<Platform, Set<string>>;

  constructor(options: DeduplicationOptions = {}) {
    this.cache = new LRUCache<string, boolean>({
      max: options.maxEntries || 5000,
      ttl: options.ttlMs || 120_000, // 2 minutes default
    });

    this.knownBotIds = new Map([
      ['slack', new Set()],
      ['teams', new Set()],
      ['matrix', new Set()],
    ]);
  }

  /**
   * Register a bot ID for a platform to automatically filter its own messages.
   * Teams addresses bots as `28:<appId>`, so both forms are registered.
   */
  registerBotId(platform: Platform, botId: string): void {
    if (!botId) return;
    const set = this.knownBotIds.get(platform);
    if (set) {
      set.add(botId);
      if (platform === 'teams' && !botId.startsWith('28:')) {
        set.add(`28:${botId}`);
      }
    }
  }

  /**
   * Check if a message sender is a known bot for that platform.
   */
  isBotSender(platform: Platform, senderId: string): boolean {
    const set = this.knownBotIds.get(platform);
    return set ? set.has(senderId) : false;
  }

  /**
   * Record a message the bridge just posted, keyed by the ID the target platform returned.
   * If that platform later delivers the same message back to us, isEcho() will match it.
   *
   * Keying on message ID (rather than content) means a human who happens to type the same
   * text in the other channel is never mistaken for an echo.
   */
  markRelayed(platform: Platform, channelId: string, messageId: string): void {
    if (!messageId) return;
    this.cache.set(this.key(platform, channelId, messageId), true);
  }

  /**
   * Check if an incoming message is one the bridge itself posted.
   */
  isEcho(platform: Platform, channelId: string, messageId: string): boolean {
    return this.cache.has(this.key(platform, channelId, messageId));
  }

  private key(platform: Platform, channelId: string, messageId: string): string {
    return `${platform}:${channelId}:${messageId}`;
  }

  /**
   * Clear cache (useful for testing)
   */
  clear(): void {
    this.cache.clear();
  }
}
