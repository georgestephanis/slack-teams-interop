/**
 * Deduplication & Echo Prevention Cache
 * Prevents message loops when relayed messages trigger the recipient platform's webhook.
 */

import { LRUCache } from 'lru-cache';
import crypto from 'node:crypto';
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
   */
  registerBotId(platform: Platform, botId: string): void {
    if (!botId) return;
    const set = this.knownBotIds.get(platform);
    if (set) {
      set.add(botId);
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
   * Compute a deterministic hash for a message based on channel, content, and approximate timestamp.
   */
  computeHash(channelId: string, content: string): string {
    const normalized = content.trim().replace(/\s+/g, ' ');
    return crypto
      .createHash('sha256')
      .update(`${channelId}:${normalized}`)
      .digest('hex');
  }

  /**
   * Mark a message as being sent out by the bridge.
   */
  markRelayed(targetChannelId: string, content: string): void {
    const hash = this.computeHash(targetChannelId, content);
    this.cache.set(hash, true);
  }

  /**
   * Check if an incoming message is an echo of a recently relayed message.
   * If it is an echo, return true and keep it suppressed.
   */
  isEcho(channelId: string, content: string): boolean {
    const hash = this.computeHash(channelId, content);
    if (this.cache.has(hash)) {
      return true;
    }
    return false;
  }

  /**
   * Clear cache (useful for testing)
   */
  clear(): void {
    this.cache.clear();
  }
}
