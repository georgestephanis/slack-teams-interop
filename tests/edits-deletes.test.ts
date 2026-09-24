import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeAdapter, BridgeCore } from '../src/core/bridge.js';
import { ChannelMapping, NormalizedMessage } from '../src/core/types.js';

const testDbPath = './data/test-edits-deletes.sqlite';
const SLACK_CH = 'C_SLACK_1';
const TEAMS_CH = '19:teams_chan@thread.tacv2';

function mapping(options: Partial<ChannelMapping['options']> = {}): ChannelMapping {
  return {
    id: 'map-1',
    name: 'Edits Bridge',
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
      ...options,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

const slackUser = { platformId: 'U_ALICE', displayName: 'Alice', platform: 'slack' as const };
const teamsUser = { platformId: 'AAD_BOB', displayName: 'Bob', platform: 'teams' as const };

function slackMsg(ts: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { id: `s-${ts}`, sourcePlatform: 'slack', sourceChannelId: SLACK_CH, sourceMessageId: ts, sender: slackUser, content, timestamp: new Date(), ...extra };
}

function teamsMsg(id: string, content: string, extra: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return { id: `t-${id}`, sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: id, sender: teamsUser, content, timestamp: new Date(), ...extra };
}

describe('Edit and delete sync', () => {
  let bridge: BridgeCore;
  let slack: BridgeAdapter;
  let teams: BridgeAdapter;
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
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    teams = {
      platform: 'teams',
      sendMessage: vi.fn().mockImplementation(async () => ({ messageId: `teams-${++n}` })),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };
    bridge.registerAdapter(slack);
    bridge.registerAdapter(teams);
    bridge.dedup.registerBotId('teams', 'app-guid');
    bridge.db.saveChannelMapping(mapping());
  });

  afterEach(() => {
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    expect(errors).toEqual([]);
  });

  it('updates the Teams copy when a Slack message is edited', async () => {
    await bridge.handleIncomingMessage(slackMsg('100.1', 'helo'));
    await bridge.handleIncomingEdit(slackMsg('100.1', 'hello'));

    expect(teams.updateMessage).toHaveBeenCalledWith(TEAMS_CH, 'teams-1', expect.objectContaining({ content: 'hello' }), expect.anything(), undefined, undefined);
  });

  it('passes the Teams thread root when editing a mirrored thread reply', async () => {
    await bridge.handleIncomingMessage(slackMsg('100.1', 'root'));
    await bridge.handleIncomingMessage(slackMsg('100.2', 'reply', { sourceParentId: '100.1' }));
    await bridge.handleIncomingEdit(slackMsg('100.2', 'reply (edited)', { sourceParentId: '100.1' }));

    expect(teams.updateMessage).toHaveBeenCalledWith(TEAMS_CH, 'teams-2', expect.anything(), expect.anything(), 'teams-1', undefined);
  });

  it('updates the Slack copy when a Teams message is edited', async () => {
    await bridge.handleIncomingMessage(teamsMsg('tm-1', 'hi'));
    await bridge.handleIncomingEdit(teamsMsg('tm-1', 'hi there'));

    expect(slack.updateMessage).toHaveBeenCalledWith(SLACK_CH, '1711.001', expect.objectContaining({ content: 'hi there' }), expect.anything(), undefined, undefined);
  });

  it('ignores edit events produced by the bridge updating its own copy', async () => {
    await bridge.handleIncomingMessage(slackMsg('100.1', 'helo'));
    // Teams reports the bridge's updateActivity as an edit from the bot
    await bridge.handleIncomingEdit(teamsMsg('teams-1', 'hello', { sender: { ...teamsUser, platformId: '28:app-guid' } }));

    expect(slack.updateMessage).not.toHaveBeenCalled();
  });

  it('never edits the origin from its mirror side', async () => {
    await bridge.handleIncomingMessage(slackMsg('100.1', 'original'));
    // A non-bot edit event on the Teams mirror copy (should not happen, but must not propagate)
    await bridge.handleIncomingEdit(teamsMsg('teams-1', 'tampered'));

    expect(slack.updateMessage).not.toHaveBeenCalled();
  });

  it('respects syncEdits = false', async () => {
    bridge.db.saveChannelMapping(mapping({ syncEdits: false }));
    await bridge.handleIncomingMessage(slackMsg('100.1', 'helo'));
    await bridge.handleIncomingEdit(slackMsg('100.1', 'hello'));

    expect(teams.updateMessage).not.toHaveBeenCalled();
  });

  it('deletes the mirrored copy and forgets the pair', async () => {
    await bridge.handleIncomingMessage(teamsMsg('tm-1', 'oops, secret'));
    await bridge.handleIncomingDelete({ sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: 'tm-1', senderId: 'AAD_BOB' });

    expect(slack.deleteMessage).toHaveBeenCalledWith(SLACK_CH, '1711.001', expect.anything(), undefined);
    expect(bridge.db.findByTeamsMessage(TEAMS_CH, 'tm-1')).toBeNull();
  });

  it('does not delete the original when the mirror copy is deleted', async () => {
    await bridge.handleIncomingMessage(slackMsg('100.1', 'keep me'));
    await bridge.handleIncomingDelete({ sourcePlatform: 'teams', sourceChannelId: TEAMS_CH, sourceMessageId: 'teams-1' });

    expect(slack.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not propagate deletes for pairs recorded before origin tracking', async () => {
    bridge.threadMapper.recordMessagePair({
      mappingId: 'map-1',
      slackChannelId: SLACK_CH,
      slackMessageTs: '99.1',
      teamsTeamId: 'T1',
      teamsChannelId: TEAMS_CH,
      teamsMessageId: 'legacy-1',
    });
    await bridge.handleIncomingDelete({ sourcePlatform: 'slack', sourceChannelId: SLACK_CH, sourceMessageId: '99.1' });

    expect(teams.deleteMessage).not.toHaveBeenCalled();
  });

  it('respects syncDeletes = false', async () => {
    bridge.db.saveChannelMapping(mapping({ syncDeletes: false }));
    await bridge.handleIncomingMessage(slackMsg('100.1', 'hi'));
    await bridge.handleIncomingDelete({ sourcePlatform: 'slack', sourceChannelId: SLACK_CH, sourceMessageId: '100.1' });

    expect(teams.deleteMessage).not.toHaveBeenCalled();
  });
});
