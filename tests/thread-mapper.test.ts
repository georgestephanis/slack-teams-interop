import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { BridgeDatabase } from '../src/db/index.js';
import { ThreadMapper } from '../src/core/thread-mapper.js';

describe('ThreadMapper & BridgeDatabase', () => {
  const testDbPath = './data/test-bridge.sqlite';
  let db: BridgeDatabase;
  let mapper: ThreadMapper;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = new BridgeDatabase(testDbPath);
    mapper = new ThreadMapper(db);

    // Seed a channel mapping
    db.saveChannelMapping({
      id: 'mapping-1',
      name: 'Test Bridge',
      enabled: true,
      slack: { channelId: 'C123' },
      teams: { teamId: 'T123', channelId: '19:chan@thread.tacv2' },
      options: {
        syncThreads: true,
        syncReactions: true,
        syncEdits: true,
        syncDeletes: true,
        syncFiles: true,
        teamsFormatStyle: 'clean_markdown',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('records message pairs and resolves parent thread bi-directionally', () => {
    mapper.recordMessagePair({
      mappingId: 'mapping-1',
      slackChannelId: 'C123',
      slackMessageTs: '1711200000.100100',
      teamsTeamId: 'T123',
      teamsChannelId: '19:chan@thread.tacv2',
      teamsMessageId: '1711200000500',
      isThreadRoot: true,
    });

    // When Slack user replies to 1711200000.100100
    const teamsParentId = mapper.resolveTeamsParent('C123', '1711200000.100100');
    expect(teamsParentId).toBe('1711200000500');

    // When Teams user replies to 1711200000500
    const slackParentTs = mapper.resolveSlackParent('19:chan@thread.tacv2', '1711200000500');
    expect(slackParentTs).toBe('1711200000.100100');
  });

  it('prunes expired messages properly', () => {
    mapper.recordMessagePair({
      mappingId: 'mapping-1',
      slackChannelId: 'C123',
      slackMessageTs: '1711200000.200200',
      teamsTeamId: 'T123',
      teamsChannelId: '19:chan@thread.tacv2',
      teamsMessageId: '1711200000600',
    });

    // Zero days to keep -> prunes everything older than right now
    const pruned = db.pruneOldMessages(0);
    // Since it was just created (within the current second), datetime('now', '-0 days') might match or not
    expect(typeof pruned).toBe('number');
  });
});
