import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeCore } from '../src/core/bridge.js';
import { TeamsAdapter } from '../src/adapters/teams/client.js';
import { ChannelMapping, NormalizedMessage } from '../src/core/types.js';

const testDbPath = './data/test-teams-adapter.sqlite';
const CHANNEL = '19:chan@thread.tacv2';

const mapping: ChannelMapping = {
  id: 'm',
  name: 'm',
  enabled: true,
  slack: { channelId: 'C1' },
  teams: { teamId: 'T1', channelId: CHANNEL },
  options: {
    syncThreads: true,
    syncReactions: true,
    syncEdits: true,
    syncDeletes: true,
    syncFiles: false,
    teamsFormatStyle: 'clean_markdown',
    reactionNotices: false,
  },
  createdAt: '',
  updatedAt: '',
};

const message: NormalizedMessage = {
  id: 'x',
  sourcePlatform: 'slack',
  sourceChannelId: 'C1',
  sourceMessageId: '1.1',
  sender: { platformId: 'U1', displayName: 'Alice', platform: 'slack' },
  content: 'hi',
  timestamp: new Date(),
};

describe('TeamsAdapter outbound addressing', () => {
  let bridge: BridgeCore;
  let adapter: TeamsAdapter;
  let references: any[];
  let sent: any[];

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter = new TeamsAdapter({ appId: 'app-guid', appPassword: 'x' }, bridge);
    references = [];
    sent = [];
    vi.spyOn(adapter.adapter, 'continueConversationAsync').mockImplementation((async (_id: string, ref: any, logic: any) => {
      references.push(ref);
      await logic({
        sendActivity: async (a: any) => {
          sent.push(a);
          return { id: 'new-id' };
        },
      });
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('posts top-level messages to the channel conversation', async () => {
    await adapter.sendMessage(CHANNEL, message, mapping);
    expect(references[0].conversation.id).toBe(CHANNEL);
  });

  it('posts thread replies into the thread conversation', async () => {
    const res = await adapter.sendMessage(CHANNEL, message, mapping, 'root-123');
    expect(references[0].conversation.id).toBe(`${CHANNEL};messageid=root-123`);
    expect(sent[0].replyToId).toBe('root-123');
    expect(res.messageId).toBe('new-id');
  });
});
