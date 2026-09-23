import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeCore, BridgeAdapter } from '../src/core/bridge.js';
import { NormalizedMessage } from '../src/core/types.js';

describe('BridgeCore E2E Simulation', () => {
  const testDbPath = './data/test-e2e.sqlite';
  let bridge: BridgeCore;
  let mockSlackAdapter: BridgeAdapter;
  let mockTeamsAdapter: BridgeAdapter;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);

    mockSlackAdapter = {
      platform: 'slack',
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'slack-ts-1234' }),
    };

    mockTeamsAdapter = {
      platform: 'teams',
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'teams-id-5678' }),
    };

    bridge.registerAdapter(mockSlackAdapter);
    bridge.registerAdapter(mockTeamsAdapter);

    // Save channel mapping
    bridge.db.saveChannelMapping({
      id: 'map-e2e',
      name: 'E2E Channel Bridge',
      enabled: true,
      slack: { channelId: 'C_SLACK_1' },
      teams: { teamId: 'T_TEAMS_1', channelId: '19:teams_chan@thread.tacv2' },
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
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('routes message from Slack to Teams and records ID pair', async () => {
    const slackMsg: NormalizedMessage = {
      id: 'event-1',
      sourcePlatform: 'slack',
      sourceChannelId: 'C_SLACK_1',
      sourceMessageId: '1711000000.000100',
      sender: {
        platformId: 'U_SLACK_USER',
        displayName: 'Alice',
        platform: 'slack',
      },
      content: 'Hello Teams!',
      timestamp: new Date(),
    };

    await bridge.handleIncomingMessage(slackMsg);

    expect(mockTeamsAdapter.sendMessage).toHaveBeenCalledWith(
      '19:teams_chan@thread.tacv2',
      slackMsg,
      expect.anything(),
      undefined
    );

    // Check thread mapper recorded the pair
    const pair = bridge.threadMapper.findBySlack('C_SLACK_1', '1711000000.000100');
    expect(pair).toBeDefined();
    expect(pair?.teamsMessageId).toBe('teams-id-5678');
  });

  it('routes threaded reply from Teams back to Slack with thread_ts', async () => {
    // 1. Establish parent root
    bridge.threadMapper.recordMessagePair({
      mappingId: 'map-e2e',
      slackChannelId: 'C_SLACK_1',
      slackMessageTs: '1711000000.000100',
      teamsTeamId: 'T_TEAMS_1',
      teamsChannelId: '19:teams_chan@thread.tacv2',
      teamsMessageId: 'teams-id-root',
      isThreadRoot: true,
    });

    // 2. Incoming reply from Teams
    const teamsReply: NormalizedMessage = {
      id: 'event-teams-reply',
      sourcePlatform: 'teams',
      sourceChannelId: '19:teams_chan@thread.tacv2',
      sourceMessageId: 'teams-id-reply-1',
      sourceParentId: 'teams-id-root',
      sender: {
        platformId: 'AAD_BOB',
        displayName: 'Bob',
        platform: 'teams',
      },
      content: 'Replying in thread from Teams!',
      timestamp: new Date(),
    };

    await bridge.handleIncomingMessage(teamsReply);

    expect(mockSlackAdapter.sendMessage).toHaveBeenCalledWith(
      'C_SLACK_1',
      teamsReply,
      expect.anything(),
      '1711000000.000100' // Target parent Slack thread_ts!
    );
  });

  it('suppresses echoes and bot loops', async () => {
    bridge.dedup.registerBotId('slack', 'B_BRIDGE_BOT');

    const botMessage: NormalizedMessage = {
      id: 'event-bot',
      sourcePlatform: 'slack',
      sourceChannelId: 'C_SLACK_1',
      sourceMessageId: '1711000000.000999',
      sender: {
        platformId: 'B_BRIDGE_BOT',
        displayName: 'InterBridge Bot',
        platform: 'slack',
      },
      content: 'Some message',
      timestamp: new Date(),
    };

    await bridge.handleIncomingMessage(botMessage);
    expect(mockTeamsAdapter.sendMessage).not.toHaveBeenCalled();
  });
});
