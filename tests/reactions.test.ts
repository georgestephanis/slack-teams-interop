import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeAdapter, BridgeCore } from '../src/core/bridge.js';
import { ChannelMapping, NormalizedMessage, NormalizedReaction } from '../src/core/types.js';

const testDbPath = './data/test-reactions.sqlite';
const SLACK_CH = 'C_SLACK_1';
const TEAMS_CH = '19:teams_chan@thread.tacv2';

function mapping(options: Partial<ChannelMapping['options']> = {}): ChannelMapping {
  return {
    id: 'map-1',
    name: 'Reactions Bridge',
    enabled: true,
    slack: { channelId: SLACK_CH },
    teams: { teamId: 'T1', channelId: TEAMS_CH },
    options: {
      syncThreads: true,
      syncReactions: true,
      syncEdits: true,
      syncDeletes: true,
      syncFiles: false,
      teamsFormatStyle: 'clean_markdown',
      reactionNotices: false,
      ...options,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const alice = { platformId: 'U_ALICE', displayName: 'Alice', platform: 'slack' as const };
const omar = { platformId: 'U_OMAR', displayName: 'Omar', platform: 'slack' as const };
const bob = { platformId: 'AAD_BOB', displayName: 'Bob', platform: 'teams' as const };
const carol = { platformId: 'AAD_CAROL', displayName: 'Carol', platform: 'teams' as const };

const slackMsg = (ts: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `s-${ts}`, sourcePlatform: 'slack', sourceChannelId: SLACK_CH, sourceMessageId: ts, sender: alice, content, timestamp: new Date(), ...extra,
});
const teamsMsg = (id: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: `t-${id}`, sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: id, sender: bob, content, timestamp: new Date(), ...extra,
});
const slackReaction = (ts: string, emoji: string, sender = alice, action: 'add' | 'remove' = 'add'): NormalizedReaction => ({
  id: `r-${ts}-${emoji}`, sourcePlatform: 'slack', sourceChannelId: SLACK_CH, sourceMessageId: ts, sender, emoji, action,
});
const teamsReaction = (id: string, emoji: string, sender = bob, action: 'add' | 'remove' = 'add'): NormalizedReaction => ({
  id: `r-${id}-${emoji}`, sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: id, sender, emoji, action,
});

describe('Reaction mirroring', () => {
  let bridge: BridgeCore;
  let slack: Required<Pick<BridgeAdapter, 'sendMessage' | 'sendReaction' | 'removeReaction' | 'updateMessage'>> & BridgeAdapter;
  let teams: Required<Pick<BridgeAdapter, 'sendMessage' | 'updateMessage' | 'deleteMessage' | 'postNotice' | 'updateNotice'>> & BridgeAdapter;
  let errors: unknown[];

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);
    errors = [];
    bridge.on('error', (e) => errors.push(e));

    let n = 0;
    slack = {
      platform: 'slack',
      sendMessage: vi.fn().mockImplementation(async () => ({ messageId: `1711.00${++n}` })),
      sendReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    teams = {
      platform: 'teams',
      sendMessage: vi.fn().mockImplementation(async () => ({ messageId: `teams-${++n}` })),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
      postNotice: vi.fn().mockImplementation(async () => ({ messageId: `notice-${++n}` })),
      updateNotice: vi.fn().mockResolvedValue(undefined),
    };
    bridge.registerAdapter(slack);
    bridge.registerAdapter(teams);
    bridge.dedup.registerBotId('slack', 'U_BRIDGE');
    bridge.db.saveChannelMapping(mapping());
  });

  afterEach(() => {
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  describe('Teams -> Slack (native, reference-counted)', () => {
    it('adds one Slack reaction for many Teams users and removes it after the last one', async () => {
      await bridge.handleIncomingMessage(teamsMsg('tm-1', 'ship it?'));

      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like', bob));
      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like', carol));
      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like', bob)); // duplicate delivery
      expect(slack.sendReaction).toHaveBeenCalledTimes(1);

      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like', bob, 'remove'));
      expect(slack.removeReaction).not.toHaveBeenCalled();

      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like', carol, 'remove'));
      expect(slack.removeReaction).toHaveBeenCalledTimes(1);
      expect(slack.removeReaction).toHaveBeenCalledWith(SLACK_CH, '1711.001', expect.objectContaining({ emoji: 'like' }));
      expect(errors).toEqual([]);
    });

    it('rolls back the count when Slack rejects the reaction, so a retry works', async () => {
      await bridge.handleIncomingMessage(teamsMsg('tm-1', 'hi'));
      slack.sendReaction = vi.fn().mockRejectedValueOnce(new Error('ratelimited')).mockResolvedValue(undefined);

      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like'));
      await bridge.handleIncomingReaction(teamsReaction('tm-1', 'like'));

      expect(slack.sendReaction).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
    });
  });

  describe('Slack -> Teams, bridge-posted message (footer)', () => {
    it('re-renders the Teams copy with a reaction footer, and clears it on removal', async () => {
      await bridge.handleIncomingMessage(slackMsg('100.1', 'Sounds good, ship it'));

      await bridge.handleIncomingReaction(slackReaction('100.1', '+1', alice));
      await bridge.handleIncomingReaction(slackReaction('100.1', '+1', omar));
      await bridge.handleIncomingReaction(slackReaction('100.1', 'tada', omar));

      expect(teams.updateMessage).toHaveBeenLastCalledWith(
        TEAMS_CH,
        'teams-1',
        expect.objectContaining({ content: 'Sounds good, ship it', sender: alice }),
        expect.anything(),
        undefined,
        { footer: '👍 2 · 🎉 1 — reactions from Slack' }
      );

      await bridge.handleIncomingReaction(slackReaction('100.1', '+1', alice, 'remove'));
      await bridge.handleIncomingReaction(slackReaction('100.1', '+1', omar, 'remove'));
      await bridge.handleIncomingReaction(slackReaction('100.1', 'tada', omar, 'remove'));

      expect(teams.updateMessage).toHaveBeenLastCalledWith(TEAMS_CH, 'teams-1', expect.anything(), expect.anything(), undefined, { footer: '' });
      expect(teams.postNotice).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    });

    it('works for thread replies by addressing the Teams thread root', async () => {
      await bridge.handleIncomingMessage(slackMsg('100.1', 'root'));
      await bridge.handleIncomingMessage(slackMsg('100.2', 'reply', { sourceParentId: '100.1' }));
      await bridge.handleIncomingReaction(slackReaction('100.2', 'eyes'));

      expect(teams.updateMessage).toHaveBeenLastCalledWith(TEAMS_CH, 'teams-2', expect.objectContaining({ content: 'reply' }), expect.anything(), 'teams-1', { footer: '👀 1 — reactions from Slack' });
    });

    it('keeps the footer when the Slack original is edited', async () => {
      await bridge.handleIncomingMessage(slackMsg('100.1', 'helo'));
      await bridge.handleIncomingReaction(slackReaction('100.1', '+1'));
      await bridge.handleIncomingEdit(slackMsg('100.1', 'hello'));
      await bridge.handleIncomingReaction(slackReaction('100.1', 'tada', omar));

      const calls = vi.mocked(teams.updateMessage).mock.calls;
      expect(calls[1][2]).toMatchObject({ content: 'hello' });
      expect(calls[1][5]).toEqual({ footer: '👍 1 — reactions from Slack' });
      // A later reaction re-renders from the edited content, not the original
      expect(calls[2][2]).toMatchObject({ content: 'hello' });
    });

    it('ignores reactions made by the bridge bot itself', async () => {
      await bridge.handleIncomingMessage(slackMsg('100.1', 'hi'));
      await bridge.handleIncomingReaction(slackReaction('100.1', '+1', { ...alice, platformId: 'U_BRIDGE' }));

      expect(teams.updateMessage).not.toHaveBeenCalled();
    });
  });

  describe('Slack -> Teams, Teams-authored message (notice)', () => {
    it('does nothing unless reactionNotices is enabled', async () => {
      await bridge.handleIncomingMessage(teamsMsg('tm-1', 'hello from Teams'));
      await bridge.handleIncomingReaction(slackReaction('1711.001', '+1'));

      expect(teams.postNotice).not.toHaveBeenCalled();
      expect(teams.updateMessage).not.toHaveBeenCalled();
    });

    it('keeps a single notice in the thread, edited as reactions change and deleted when empty', async () => {
      bridge.db.saveChannelMapping(mapping({ reactionNotices: true }));
      await bridge.handleIncomingMessage(teamsMsg('tm-1', 'hello from Teams'));

      await bridge.handleIncomingReaction(slackReaction('1711.001', '+1', alice));
      expect(teams.postNotice).toHaveBeenCalledWith(TEAMS_CH, '_Reactions from Slack:_ 👍 Alice', expect.anything(), 'tm-1');

      await bridge.handleIncomingReaction(slackReaction('1711.001', '+1', omar));
      expect(teams.postNotice).toHaveBeenCalledTimes(1);
      expect(teams.updateNotice).toHaveBeenLastCalledWith(TEAMS_CH, 'notice-2', '_Reactions from Slack:_ 👍 Alice, Omar', expect.anything(), 'tm-1');

      await bridge.handleIncomingReaction(slackReaction('1711.001', '+1', alice, 'remove'));
      await bridge.handleIncomingReaction(slackReaction('1711.001', '+1', omar, 'remove'));
      expect(teams.deleteMessage).toHaveBeenCalledWith(TEAMS_CH, 'notice-2', expect.anything(), 'tm-1');
      expect(bridge.db.findByTeamsMessage(TEAMS_CH, 'tm-1')?.teamsNoticeMessageId).toBeUndefined();
      expect(errors).toEqual([]);
    });

    it('quotes the message when the target is a reply inside a thread', async () => {
      bridge.db.saveChannelMapping(mapping({ reactionNotices: true }));
      await bridge.handleIncomingMessage(teamsMsg('tm-root', 'Release plan'));
      await bridge.handleIncomingMessage(teamsMsg('tm-reply', '<p>Sounds <b>good</b>, ship it</p>', { sourceParentId: 'tm-root' }));

      await bridge.handleIncomingReaction(slackReaction('1711.002', 'tada'));

      expect(teams.postNotice).toHaveBeenCalledWith(TEAMS_CH, '_Reactions from Slack on "Sounds good, ship it":_ 🎉 Alice', expect.anything(), 'tm-root');
    });

    it('does not post duplicate notices for simultaneous reactions', async () => {
      bridge.db.saveChannelMapping(mapping({ reactionNotices: true }));
      await bridge.handleIncomingMessage(teamsMsg('tm-1', 'hello'));

      await Promise.all([
        bridge.handleIncomingReaction(slackReaction('1711.001', '+1', alice)),
        bridge.handleIncomingReaction(slackReaction('1711.001', 'tada', omar)),
      ]);

      expect(teams.postNotice).toHaveBeenCalledTimes(1);
      expect(teams.updateNotice).toHaveBeenCalledTimes(1);
    });

    it('deletes the notice along with a deleted Teams original', async () => {
      bridge.db.saveChannelMapping(mapping({ reactionNotices: true }));
      await bridge.handleIncomingMessage(teamsMsg('tm-1', 'oops'));
      await bridge.handleIncomingReaction(slackReaction('1711.001', '+1'));
      await bridge.handleIncomingDelete({ sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: 'tm-1', senderId: 'AAD_BOB' });

      expect(teams.deleteMessage).toHaveBeenCalledWith(TEAMS_CH, 'notice-2', expect.anything(), 'tm-1');
      expect(slack.sendMessage).toHaveBeenCalledTimes(1);
      expect(errors).toEqual([]);
    });
  });

  it('keeps the pair when deleting the reaction notice fails', async () => {
    bridge.db.saveChannelMapping(mapping({ reactionNotices: true }));
    await bridge.handleIncomingMessage(teamsMsg('tm-1', 'oops'));
    await bridge.handleIncomingReaction(slackReaction('1711.001', '+1'));
    teams.deleteMessage = vi.fn().mockRejectedValue(new Error('Teams 503'));

    await bridge.handleIncomingDelete({ sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: 'tm-1', senderId: 'AAD_BOB' });

    expect(errors).toHaveLength(1);
    expect(bridge.db.findByTeamsMessage(TEAMS_CH, 'tm-1')?.teamsNoticeMessageId).toBe('notice-2');
  });
});
