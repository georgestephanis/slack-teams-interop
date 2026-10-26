import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { TurnContext } from 'botbuilder';
import { BridgeCore } from '../src/core/bridge.js';
import { TeamsAdapter, TeamsNotInstalledError, isNotInConversationRoster } from '../src/adapters/teams/client.js';
import { ChannelMapping, DEFAULT_MAPPING_OPTIONS, NormalizedMessage } from '../src/core/types.js';
import { teamsInstallationKey } from '../src/db/index.js';

const KEY = teamsInstallationKey('default', '19:team@thread.tacv2');

const testDbPath = './data/test-teams-install-status.sqlite';
const TEAM = '19:team@thread.tacv2';
const CHANNEL = '19:chan@thread.tacv2';
const BOT = 'app-guid';

function removeDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(testDbPath + suffix)) fs.unlinkSync(testDbPath + suffix);
  }
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('test-teams-install-status.sqlite.bak-v')) fs.unlinkSync(`./data/${f}`);
  }
}

const mapping: ChannelMapping = {
  id: 'm',
  name: 'm',
  enabled: true,
  slack: { channelId: 'C1' },
  teams: { teamId: TEAM, channelId: CHANNEL, teamName: 'Example Team' },
  options: { ...DEFAULT_MAPPING_OPTIONS, teamsFormatStyle: 'clean_markdown' },
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

/** Teams' 403 when the bot isn't in the team, shaped like the connector's RestError */
function rosterError() {
  return Object.assign(new Error('The bot is not part of the conversation roster.'), {
    code: 'BotNotInConversationRoster',
    statusCode: 403,
  });
}

/** Run an inbound activity through the adapter's handlers, as if it arrived on its webhook */
async function receive(adapter: TeamsAdapter, activity: Record<string, unknown>) {
  const context = new TurnContext(adapter.adapter, {
    channelId: 'msteams',
    serviceUrl: 'https://smba.trafficmanager.net/amer/',
    recipient: { id: `28:${BOT}`, name: 'InterBridge' },
    conversation: { id: TEAM, isGroup: true, conversationType: 'channel', name: '' },
    channelData: { team: { id: TEAM, name: 'Example Team' }, tenant: { id: 'tenant-1' } },
    ...activity,
  } as any);
  await adapter.runForConnection(context, adapter.defaultConnectionId);
}

describe('Teams install status', () => {
  let bridge: BridgeCore;
  let adapter: TeamsAdapter;

  beforeEach(() => {
    removeDb();
    bridge = new BridgeCore(testDbPath);
    bridge.on('error', () => {});
    bridge.db.saveChannelMapping(mapping);
    adapter = new TeamsAdapter({ appId: BOT, appPassword: 'x' }, bridge);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.db.close();
    removeDb();
  });

  it('records and logs the bot being added to a team, once', async () => {
    const added = { type: 'conversationUpdate', membersAdded: [{ id: `28:${BOT}` }] };
    await receive(adapter, added);
    await receive(adapter, { type: 'installationUpdate', action: 'add' });

    const install = bridge.db.getTeamsInstallations().get(KEY);
    expect(install).toMatchObject({ installed: true, connectionId: 'default', teamName: 'Example Team', tenantId: 'tenant-1' });
    const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
    expect(logs.filter((l) => l.includes('was added to the Teams team "Example Team"'))).toHaveLength(1);
    expect(logs[0]).toContain('1 bridge(s) use this team');
  });

  it('records and warns when the bot is removed from a team', async () => {
    await receive(adapter, { type: 'installationUpdate', action: 'add' });
    await receive(adapter, { type: 'installationUpdate', action: 'remove' });

    expect(bridge.db.getTeamsInstallations().get(KEY)?.installed).toBe(false);
    expect(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])).toContain('was removed from the Teams team "Example Team"');
  });

  it('keeps install state separately for each connection', () => {
    bridge.db.saveTeamsInstallation({ teamId: TEAM, connectionId: 'default', installed: true });
    bridge.db.saveTeamsInstallation({ teamId: TEAM, connectionId: 'other', installed: false });

    const installs = bridge.db.getTeamsInstallations();
    expect(installs.get(KEY)?.installed).toBe(true);
    expect(installs.get(teamsInstallationKey('other', TEAM))?.installed).toBe(false);
  });

  it('ignores other members joining the team', async () => {
    await receive(adapter, { type: 'conversationUpdate', membersAdded: [{ id: '29:someone-else' }] });
    expect(bridge.db.getTeamsInstallations().size).toBe(0);
  });
});

describe('Teams delivery failures', () => {
  let bridge: BridgeCore;
  let adapter: TeamsAdapter;
  let failWith: Error | undefined;
  let turnErrors: unknown[];

  beforeEach(() => {
    removeDb();
    bridge = new BridgeCore(testDbPath);
    turnErrors = [];
    bridge.on('error', (err) => turnErrors.push(err));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter = new TeamsAdapter({ appId: BOT, appPassword: 'x' }, bridge);
    failWith = undefined;
    // Behave like CloudAdapter: an error inside the callback goes to onTurnError, and the call resolves
    vi.spyOn(adapter.adapter, 'continueConversationAsync').mockImplementation((async (_id: string, _ref: any, logic: any) => {
      try {
        await logic({
          sendActivity: async () => {
            if (failWith) throw failWith;
            return { id: 'new-id' };
          },
        });
      } catch (err) {
        await adapter.adapter.onTurnError!({} as any, err as Error);
      }
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.db.close();
    removeDb();
  });

  it('recognises the roster rejection', () => {
    expect(isNotInConversationRoster(rosterError())).toBe(true);
    expect(isNotInConversationRoster(Object.assign(new Error('Forbidden'), { statusCode: 403 }))).toBe(false);
  });

  it('fails a post Teams rejected instead of reporting a made-up message id', async () => {
    failWith = rosterError();
    const err = await adapter.sendMessage(CHANNEL, message, mapping).catch((e) => e);

    expect(err).toBeInstanceOf(TeamsNotInstalledError);
    expect(err.message).toContain('isn\'t installed in the Teams team "Example Team"');
    expect(err.cause).toBe(failWith);
    expect(adapter.lastDeliveryFailure(CHANNEL)).toMatchObject({ notInstalled: true });
  });

  it('rethrows other failures unchanged and clears the failure after a successful post', async () => {
    failWith = new Error('boom');
    await expect(adapter.sendMessage(CHANNEL, message, mapping)).rejects.toBe(failWith);
    expect(adapter.lastDeliveryFailure(CHANNEL)).toMatchObject({ notInstalled: false, error: 'boom' });

    failWith = undefined;
    await expect(adapter.sendMessage(CHANNEL, message, mapping)).resolves.toEqual({ messageId: 'new-id' });
    expect(adapter.lastDeliveryFailure(CHANNEL)).toBeUndefined();
  });

  it('does not record a pair for a message Teams rejected', async () => {
    failWith = rosterError();
    bridge.db.saveChannelMapping(mapping);
    bridge.registerAdapter(adapter);
    await bridge.handleIncomingMessage(message);

    expect(bridge.db.findBySlackMessage('C1', '1.1')).toBeNull();
    expect(turnErrors.some((e) => e instanceof TeamsNotInstalledError)).toBe(true);
  });
});
