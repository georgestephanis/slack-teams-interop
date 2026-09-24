import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeCore } from '../src/core/bridge.js';
import { TeamsAdapter } from '../src/adapters/teams/client.js';

const testDbPath = './data/test-teams-service-url.sqlite';
const config = { appId: 'app-guid', appPassword: 'x', serviceUrl: 'https://smba.trafficmanager.net/amer/' };

describe('Teams service URL persistence', () => {
  let bridge: BridgeCore;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('survives an adapter restart', () => {
    const first = new TeamsAdapter(config, bridge);
    first.rememberServiceUrl({
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      conversation: { id: '19:chan@thread.tacv2;messageid=123' } as any,
      channelData: { channel: { id: '19:chan@thread.tacv2' }, team: { id: '19:team@thread.tacv2' } },
    });

    const second = new TeamsAdapter(config, bridge);
    expect(second.resolveServiceUrl('19:chan@thread.tacv2')).toBe('https://smba.trafficmanager.net/emea/');
  });

  it('uses a URL learned from another channel in the same team (e.g. on install)', () => {
    const adapter = new TeamsAdapter(config, bridge);
    adapter.rememberServiceUrl({
      serviceUrl: 'https://smba.trafficmanager.net/apac/',
      conversation: { id: '19:general@thread.tacv2' } as any,
      channelData: { team: { id: '19:general@thread.tacv2' } },
    });

    expect(adapter.resolveServiceUrl('19:other@thread.tacv2', '19:general@thread.tacv2')).toBe(
      'https://smba.trafficmanager.net/apac/'
    );
  });

  it('falls back to config and warns once when nothing is known', () => {
    const adapter = new TeamsAdapter(config, bridge);
    expect(adapter.resolveServiceUrl('19:unknown')).toBe(config.serviceUrl);
    adapter.resolveServiceUrl('19:unknown');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(bridge.db.hasTeamsServiceUrl('19:unknown')).toBe(false);
  });
});
