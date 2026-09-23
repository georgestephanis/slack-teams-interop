import { describe, expect, it } from 'vitest';
import { DeduplicationManager } from '../src/core/deduplication.js';

describe('DeduplicationManager', () => {
  it('registers and detects bot senders', () => {
    const dedup = new DeduplicationManager();
    dedup.registerBotId('slack', 'B123456');

    expect(dedup.isBotSender('slack', 'B123456')).toBe(true);
    expect(dedup.isBotSender('slack', 'U999999')).toBe(false);
  });

  it('treats Teams 28:-prefixed bot IDs as the same bot regardless of registration format', () => {
    const dedup1 = new DeduplicationManager();
    dedup1.registerBotId('teams', 'app-guid');
    expect(dedup1.isBotSender('teams', 'app-guid')).toBe(true);
    expect(dedup1.isBotSender('teams', '28:app-guid')).toBe(true);

    const dedup2 = new DeduplicationManager();
    dedup2.registerBotId('teams', '28:app-guid');
    expect(dedup2.isBotSender('teams', 'app-guid')).toBe(true);
    expect(dedup2.isBotSender('teams', '28:app-guid')).toBe(true);
  });

  it('detects echoes by platform, channel, and message ID without delimiter collision', () => {
    const dedup = new DeduplicationManager();
    const channelId = '19:channel@thread.tacv2';

    expect(dedup.isEcho('teams', channelId, 'msg-1')).toBe(false);

    dedup.markRelayed('teams', channelId, 'msg-1');

    expect(dedup.isEcho('teams', channelId, 'msg-1')).toBe(true);
    expect(dedup.isEcho('teams', channelId, 'msg-2')).toBe(false);
    expect(dedup.isEcho('teams', 'other-channel', 'msg-1')).toBe(false);
    expect(dedup.isEcho('slack', channelId, 'msg-1')).toBe(false);

    // Verify channel IDs and message IDs with colons do not collide
    dedup.markRelayed('teams', 'chan:1', 'msg');
    expect(dedup.isEcho('teams', 'chan', '1:msg')).toBe(false);
  });

  it('ignores empty message IDs', () => {
    const dedup = new DeduplicationManager();
    dedup.markRelayed('slack', 'C1', '');
    expect(dedup.isEcho('slack', 'C1', '')).toBe(false);
  });
});
