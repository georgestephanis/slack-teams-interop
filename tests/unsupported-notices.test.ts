import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeAdapter, BridgeCore } from '../src/core/bridge.js';
import { SlackAdapter } from '../src/adapters/slack/client.js';
import { TeamsAdapter, teamsUnsupportedContent } from '../src/adapters/teams/client.js';
import { ChannelMapping, NormalizedMessage } from '../src/core/types.js';

function mapping(options: Partial<ChannelMapping['options']> = {}): ChannelMapping {
  return {
    id: 'map-1',
    name: 'Notices',
    enabled: true,
    slack: { channelId: 'C1' },
    teams: { teamId: 'T1', channelId: '19:c' },
    options: {
      syncThreads: true,
      syncReactions: true,
      syncEdits: true,
      syncDeletes: true,
      syncFiles: true,
      teamsFormatStyle: 'clean_markdown',
      reactionNotices: false,
      unsupportedNotices: true,
      ...options,
    },
    createdAt: '',
    updatedAt: '',
  };
}

function removeDb(dbPath: string) {
  const base = dbPath.split('/').pop()!;
  if (!fs.existsSync('./data')) return;
  for (const f of fs.readdirSync('./data')) if (f.startsWith(base)) fs.rmSync(`./data/${f}`, { force: true });
}

const pdf = { id: 'F1', name: 'report.pdf', contentType: 'application/pdf', permalink: 'https://x.slack.com/files/F1' };
const slackMsg = (extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: 's', sourcePlatform: 'slack', sourceChannelId: 'C1', sourceMessageId: '1.1',
  sender: { platformId: 'U_ALICE', displayName: 'Alice', platform: 'slack' }, content: 'see attached', timestamp: new Date(), ...extra,
});
const teamsMsg = (extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: 't', sourcePlatform: 'teams', sourceChannelId: '19:c', sourceMessageId: 'tm-1',
  sender: { platformId: 'AAD_BOB', displayName: 'Bob', platform: 'teams' }, content: '', timestamp: new Date(), ...extra,
});

describe('Unsupported content notices', () => {
  const dbPath = './data/test-unsupported-notices.sqlite';
  let bridge: BridgeCore;
  let slack: BridgeAdapter;
  let teams: BridgeAdapter;
  let errors: unknown[];

  beforeEach(() => {
    removeDb(dbPath);
    bridge = new BridgeCore(dbPath);
    errors = [];
    bridge.on('error', (e) => errors.push(e));
    slack = {
      platform: 'slack',
      sendMessage: vi.fn().mockResolvedValue({ messageId: '1711.001' }),
      notifySender: vi.fn().mockResolvedValue(undefined),
    };
    teams = {
      platform: 'teams',
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'teams-1' }),
      notifySender: vi.fn().mockResolvedValue({ messageId: 'notice-1' }),
    };
    bridge.registerAdapter(slack);
    bridge.registerAdapter(teams);
  });
  afterEach(() => {
    bridge.db.close();
    removeDb(dbPath);
  });

  it('adds a disclaimer to the relayed message and tells a Slack sender their file went as a link', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(slackMsg({ attachments: [pdf] }));

    expect(vi.mocked(teams.sendMessage).mock.calls[0][1].content).toContain("_Files aren't copied between Slack and Teams");
    expect(slack.notifySender).toHaveBeenCalledWith(
      'C1',
      'U_ALICE',
      expect.stringContaining('"report.pdf" was shared as a link'),
      expect.anything(),
      undefined
    );
    const text = vi.mocked(slack.notifySender!).mock.calls[0][2];
    expect(text).toMatch(/^⚠️ Part of your message didn't reach Teams as sent\./);
    expect(text).not.toContain('Alice'); // private, so no need to name them
  });

  it('notifies in the thread for replies', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(slackMsg({ attachments: [pdf], sourceParentId: '1.0' }));
    expect(vi.mocked(slack.notifySender!).mock.calls[0][4]).toBe('1.0');
  });

  it('says the message was not sent when files are its only content and file sync is off', async () => {
    bridge.db.saveChannelMapping(mapping({ syncFiles: false }));
    await bridge.handleIncomingMessage(slackMsg({ content: '', attachments: [pdf] }));

    expect(teams.sendMessage).not.toHaveBeenCalled();
    expect(vi.mocked(slack.notifySender!).mock.calls[0][2]).toBe(
      "⚠️ Your message wasn't sent to Teams. \"report.pdf\" was not sent, because file sharing is off for this bridge."
    );
  });

  it('tells a Teams sender, by name in the thread, when a card could not be relayed', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(teamsMsg({ unsupported: ['Adaptive Cards'] }));

    expect(slack.sendMessage).not.toHaveBeenCalled();
    expect(teams.notifySender).toHaveBeenCalledWith(
      '19:c',
      'AAD_BOB',
      "⚠️ Bob: Your message wasn't sent to Slack. Adaptive Cards can't be relayed to Slack.",
      expect.anything(),
      'tm-1'
    );
    // The notice is a real Teams post; it must never be relayed back
    expect(bridge.dedup.isEcho('teams', '19:c', 'notice-1')).toBe(true);
  });

  it('reports images the target adapter failed to copy', async () => {
    bridge.db.saveChannelMapping(mapping());
    slack.sendMessage = vi.fn().mockResolvedValue({ messageId: '1711.002', undelivered: [{ id: 'i', name: 'shot.png', contentType: 'image/png' }] });
    await bridge.handleIncomingMessage(teamsMsg({ content: 'look' }));

    expect(vi.mocked(teams.notifySender!).mock.calls[0][2]).toContain('"shot.png" couldn\'t be copied to Slack');
  });

  it('does not repeat the same notice to the same person within the cooldown', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(slackMsg({ attachments: [pdf] }));
    await bridge.handleIncomingMessage(slackMsg({ sourceMessageId: '1.2', attachments: [pdf] }));
    expect(slack.notifySender).toHaveBeenCalledTimes(1);

    // A different problem still gets through
    bridge.db.saveChannelMapping(mapping({ syncFiles: false }));
    await bridge.handleIncomingMessage(slackMsg({ sourceMessageId: '1.3', attachments: [pdf] }));
    expect(slack.notifySender).toHaveBeenCalledTimes(2);
  });

  it('respects unsupportedNotices = false, but keeps the in-message disclaimer', async () => {
    bridge.db.saveChannelMapping(mapping({ unsupportedNotices: false }));
    await bridge.handleIncomingMessage(slackMsg({ attachments: [pdf] }));

    expect(slack.notifySender).not.toHaveBeenCalled();
    expect(vi.mocked(teams.sendMessage).mock.calls[0][1].content).toContain("Files aren't copied");
  });

  it('never notifies bots, and does not block relaying if a notice fails', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(teamsMsg({ unsupported: ['cards'], sender: { platformId: '28:other', displayName: 'Bot', platform: 'teams', isBot: true } }));
    expect(teams.notifySender).not.toHaveBeenCalled();

    slack.notifySender = vi.fn().mockRejectedValue(new Error('channel_not_found'));
    await bridge.handleIncomingMessage(slackMsg({ attachments: [pdf] }));
    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
  });

  it('does not send notices for edits', async () => {
    bridge.db.saveChannelMapping(mapping({ unsupportedNotices: true }));
    teams.updateMessage = vi.fn().mockResolvedValue(undefined);
    await bridge.handleIncomingMessage(slackMsg());
    await bridge.handleIncomingEdit(slackMsg({ attachments: [pdf] }));

    expect(teams.updateMessage).toHaveBeenCalled();
    expect(slack.notifySender).not.toHaveBeenCalled();
  });
});

describe('Adapter support', () => {
  it('detects Teams content that cannot be relayed', () => {
    expect(
      teamsUnsupportedContent({
        attachments: [
          { contentType: 'text/html', content: '<p>x</p>' },
          { contentType: 'image/png', contentUrl: 'https://us-api.asm.skype.com/x' },
          { contentType: 'reference', contentUrl: 'https://contoso.sharepoint.com/x' },
          { contentType: 'application/vnd.microsoft.card.adaptive', content: {} },
          { contentType: 'application/vnd.microsoft.card.hero', content: {} },
        ],
      } as any)
    ).toEqual(['Adaptive Cards', 'cards']);
    expect(teamsUnsupportedContent({ attachments: [{ contentType: 'text/html' }] } as any)).toBeUndefined();
  });

  it('Slack notices are ephemeral; Teams notices are thread replies', async () => {
    const dbPath = './data/test-notice-adapters.sqlite';
    removeDb(dbPath);
    const bridge = new BridgeCore(dbPath);

    const slack = new SlackAdapter({ botToken: 'xoxb', signingSecret: 's', useSocketMode: false }, bridge);
    const ephemeral = vi.spyOn(slack.client.chat, 'postEphemeral').mockResolvedValue({ ok: true } as any);
    await slack.notifySender('C1', 'U1', 'hi', mapping(), '1.0');
    expect(ephemeral).toHaveBeenCalledWith({ channel: 'C1', user: 'U1', text: 'hi', thread_ts: '1.0' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const teams = new TeamsAdapter({ appId: 'app', appPassword: 'x' }, bridge);
    const notice = vi.spyOn(teams, 'postNotice').mockResolvedValue({ messageId: 'n-1' });
    await expect(teams.notifySender('19:c', 'AAD', 'hi', mapping(), 'tm-1')).resolves.toEqual({ messageId: 'n-1' });
    expect(notice).toHaveBeenCalledWith('19:c', 'hi', expect.anything(), 'tm-1');

    vi.restoreAllMocks();
    bridge.db.close();
    removeDb(dbPath);
  });
});
