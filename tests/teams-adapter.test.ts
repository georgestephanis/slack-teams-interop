import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeCore } from '../src/core/bridge.js';
import { TeamsAdapter, teamsAttachments } from '../src/adapters/teams/client.js';
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

describe('teamsAttachments', () => {
  it('keeps files and images, skipping the HTML body copy and cards', () => {
    const out = teamsAttachments({
      id: 'msg-1',
      attachments: [
        { contentType: 'text/html', content: '<p>hi</p>' },
        { contentType: 'application/vnd.microsoft.card.adaptive', content: {} },
        { contentType: 'reference', name: 'Plan.docx', contentUrl: 'https://contoso.sharepoint.com/Plan.docx' },
        { contentType: 'image/png', contentUrl: 'https://us-api.asm.skype.com/v1/objects/abc/views/imgo' },
      ],
    } as any);

    expect(out).toEqual([
      expect.objectContaining({ name: 'Plan.docx', permalink: 'https://contoso.sharepoint.com/Plan.docx' }),
      expect.objectContaining({ name: 'image', contentType: 'image/png' }),
    ]);
    // Inline images need the bot's token, so there is no link a Slack user could open
    expect(out?.[1].permalink).toBeUndefined();
  });

  it('returns undefined when there are no user-visible files', () => {
    expect(teamsAttachments({ attachments: [{ contentType: 'text/html', content: '' }] } as any)).toBeUndefined();
  });
});
