import { describe, expect, it } from 'vitest';
import { DeduplicationManager } from '../src/core/deduplication.js';

describe('DeduplicationManager', () => {
  it('registers and detects bot senders', () => {
    const dedup = new DeduplicationManager();
    dedup.registerBotId('slack', 'B123456');

    expect(dedup.isBotSender('slack', 'B123456')).toBe(true);
    expect(dedup.isBotSender('slack', 'U999999')).toBe(false);
  });

  it('detects and suppresses echoes after marking relayed', () => {
    const dedup = new DeduplicationManager();
    const channelId = '19:channel@thread.tacv2';
    const message = 'Hello everyone from the bridge!';

    expect(dedup.isEcho(channelId, message)).toBe(false);

    dedup.markRelayed(channelId, message);

    expect(dedup.isEcho(channelId, message)).toBe(true);
    // Different channel should not be marked
    expect(dedup.isEcho('other-channel', message)).toBe(false);
  });

  it('normalizes whitespace in hash comparison', () => {
    const dedup = new DeduplicationManager();
    const channelId = 'C012345';
    dedup.markRelayed(channelId, 'Line 1\n  Line 2');

    expect(dedup.isEcho(channelId, 'Line 1 Line 2')).toBe(true);
  });
});
