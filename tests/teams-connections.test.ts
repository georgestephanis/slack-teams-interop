import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import { TurnContext } from 'botbuilder';
import { BridgeCore } from '../src/core/bridge.js';
import { CredentialCipher } from '../src/core/credentials.js';
import { TeamsAdapter } from '../src/adapters/teams/client.js';
import { TeamsConnectionError, TeamsConnectionStore } from '../src/adapters/teams/connections.js';
import { buildTeamsManifest, teamsAppIdFor } from '../src/adapters/teams/manifest.js';
import { createZip } from '../src/web/zip.js';
import { createWebServer } from '../src/web/server.js';
import { ChannelMapping, DEFAULT_MAPPING_OPTIONS, NormalizedMessage } from '../src/core/types.js';

const dbPath = './data/test-teams-connections.sqlite';
const KEY = 'k'.repeat(40);

function removeDb() {
  if (!fs.existsSync('./data')) return;
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('test-teams-connections.sqlite')) fs.rmSync(`./data/${f}`, { force: true });
  }
}

function mapping(id: string, channelId: string, connectionId?: string): ChannelMapping {
  return {
    id,
    name: id,
    enabled: true,
    slack: { channelId: `C-${id}` },
    teams: { teamId: `team-${id}`, channelId, connectionId },
    options: { ...DEFAULT_MAPPING_OPTIONS, teamsFormatStyle: 'clean_markdown' },
    createdAt: '',
    updatedAt: '',
  };
}

const ACME = { id: 'acme', name: 'Acme', appId: 'acme-app', appPassword: 'acme-secret', tenantId: 'acme-tenant' };
const GLOBEX = { id: 'globex', name: 'Globex', appId: 'globex-app', appPassword: 'globex-secret', tenantId: 'globex-tenant' };

/** Read stored entries back out of a zip made by createZip. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const crc = buf.readUInt32LE(i + 14);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString();
    const data = buf.subarray(i + 30 + nameLen, i + 30 + nameLen + size);
    expect(zlib.crc32(data)).toBe(crc);
    out.set(name, data);
    i += 30 + nameLen + size;
  }
  return out;
}

describe('CredentialCipher', () => {
  it('round-trips and uses a fresh IV each time', () => {
    const cipher = new CredentialCipher(KEY);
    const a = cipher.encrypt('s3cret');
    expect(a).not.toContain('s3cret');
    expect(cipher.encrypt('s3cret')).not.toBe(a);
    expect(cipher.decrypt(a)).toBe('s3cret');
  });

  it('refuses values encrypted with another key, and short keys', () => {
    const stored = new CredentialCipher(KEY).encrypt('s3cret');
    expect(() => new CredentialCipher('x'.repeat(40)).decrypt(stored)).toThrow();
    expect(() => new CredentialCipher('short')).toThrow(/at least 32/);
  });
});

describe('Teams connections', () => {
  let bridge: BridgeCore;
  let adapter: TeamsAdapter;
  let store: TeamsConnectionStore;
  let errors: Error[];

  beforeEach(() => {
    removeDb();
    bridge = new BridgeCore(dbPath);
    errors = [];
    bridge.on('error', (e: Error) => errors.push(e));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    adapter = new TeamsAdapter(
      { appId: 'env-app', appPassword: 'pw', appTenantId: 'env-tenant', appType: 'SingleTenant' },
      bridge,
      { defaultConnectionId: 'initech' }
    );
    store = new TeamsConnectionStore(bridge.db, adapter, new CredentialCipher(KEY), {
      id: 'initech',
      appId: 'env-app',
      tenantId: 'env-tenant',
      appType: 'SingleTenant',
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    bridge.db.close();
    removeDb();
  });

  describe('store', () => {
    it('encrypts secrets at rest, never lists them, and activates the connection', () => {
      store.save(ACME);
      const raw = JSON.stringify(bridge.db.getTeamsConnection('acme'));
      expect(raw).not.toContain('acme-secret');
      expect(JSON.stringify(store.list())).not.toContain('acme-secret');
      expect(store.list().map((c) => [c.id, c.source, c.active])).toEqual([
        ['initech', 'env', true],
        ['acme', 'db', true],
      ]);
      expect(adapter.hasConnection('acme')).toBe(true);
    });

    it('keeps the stored secret when an update omits it', () => {
      store.save(ACME);
      const before = bridge.db.getTeamsConnection('acme')!.appPasswordEnc;
      store.save({ ...ACME, appPassword: undefined, name: 'Acme Corp' });
      expect(bridge.db.getTeamsConnection('acme')).toMatchObject({ name: 'Acme Corp', appPasswordEnc: before });
    });

    it.each([
      [{ ...ACME, id: 'Bad Id' }, 400],
      [{ ...ACME, tenantId: undefined }, 400],
      [{ ...ACME, appPassword: undefined }, 400],
      [{ ...ACME, id: 'initech' }, 409],
      [{ ...ACME, appId: 'env-app' }, 409],
    ])('rejects invalid input %#', (input, status) => {
      expect(() => store.save(input)).toThrow(TeamsConnectionError);
      try {
        store.save(input);
      } catch (err) {
        expect((err as TeamsConnectionError).status).toBe(status);
      }
    });

    it('needs CREDENTIALS_KEY to store connections', () => {
      const keyless = new TeamsConnectionStore(bridge.db, adapter);
      expect(() => keyless.save(ACME)).toThrow(/CREDENTIALS_KEY/);
    });

    it('disabling deactivates; deleting is refused while bridges use it', () => {
      store.save(ACME);
      store.save({ ...ACME, appPassword: undefined, enabled: false });
      expect(adapter.hasConnection('acme')).toBe(false);

      bridge.db.saveChannelMapping(mapping('m1', '19:a@thread.tacv2', 'acme'));
      expect(() => store.delete('acme')).toThrow(/still use/);
      bridge.db.deleteChannelMapping('m1');
      store.delete('acme');
      expect(bridge.db.getTeamsConnection('acme')).toBeNull();
    });

    it('reloads stored connections after a restart, skipping ones it cannot decrypt', () => {
      store.save(ACME);
      store.save(GLOBEX);

      const fresh = new TeamsAdapter(undefined, bridge);
      expect(new TeamsConnectionStore(bridge.db, fresh, new CredentialCipher(KEY)).loadAll().loaded).toEqual(['acme', 'globex']);
      expect(fresh.listConnections().map((c) => c.appId)).toEqual(['acme-app', 'globex-app']);

      const wrongKey = new TeamsConnectionStore(bridge.db, new TeamsAdapter(undefined, bridge), new CredentialCipher('z'.repeat(40)));
      expect(wrongKey.loadAll()).toMatchObject({ loaded: [], failed: [{ id: 'acme' }, { id: 'globex' }] });
    });
  });

  describe('mappings', () => {
    it('stores the connection id, leaving older mappings on the default connection', () => {
      bridge.db.saveChannelMapping(mapping('legacy', '19:l@thread.tacv2'));
      bridge.db.saveChannelMapping(mapping('acme', '19:a@thread.tacv2', 'acme'));
      expect(bridge.db.getChannelMapping('legacy')!.teams.connectionId).toBeUndefined();
      expect(bridge.db.getChannelMapping('acme')!.teams.connectionId).toBe('acme');
      expect(bridge.db.countMappingsForTeamsConnection('initech', true)).toBe(1);
      expect(bridge.db.countMappingsForTeamsConnection('acme')).toBe(1);
    });
  });

  describe('outbound routing', () => {
    const message: NormalizedMessage = {
      id: 'x',
      sourcePlatform: 'slack',
      sourceChannelId: 'C1',
      sourceMessageId: '1.1',
      sender: { platformId: 'U1', displayName: 'Alice', platform: 'slack' },
      content: 'hi',
      timestamp: new Date(),
    };

    function capture(id: string, calls: string[]) {
      const cloud = (adapter as any).connections.get(id).cloudAdapter;
      vi.spyOn(cloud, 'continueConversationAsync').mockImplementation((async (appId: string, ref: any, logic: any) => {
        calls.push(`${id}:${appId}:${ref.serviceUrl}`);
        await logic({ sendActivity: async () => ({ id: 'sent' }) });
      }) as any);
    }

    it("posts as the mapping's connection, with that connection's region fallback", async () => {
      store.save({ ...ACME, serviceUrl: 'https://smba.trafficmanager.net/emea/' });
      store.save(GLOBEX);
      const calls: string[] = [];
      capture('initech', calls);
      capture('acme', calls);
      capture('globex', calls);

      await adapter.sendMessage('19:a@thread.tacv2', message, mapping('a', '19:a@thread.tacv2', 'acme'));
      await adapter.sendMessage('19:g@thread.tacv2', message, mapping('g', '19:g@thread.tacv2', 'globex'));
      await adapter.sendMessage('19:l@thread.tacv2', message, mapping('l', '19:l@thread.tacv2'));

      expect(calls).toEqual([
        'acme:acme-app:https://smba.trafficmanager.net/emea/',
        'globex:globex-app:https://smba.trafficmanager.net/amer/',
        'initech:env-app:https://smba.trafficmanager.net/amer/',
      ]);
    });

    it("never uses another tenant's learned region", () => {
      store.save(ACME);
      adapter.rememberServiceUrl({
        serviceUrl: 'https://smba.trafficmanager.net/apac/',
        conversation: { id: '19:other@thread.tacv2', tenantId: 'globex-tenant' } as any,
        channelData: { tenant: { id: 'globex-tenant' } },
      });
      expect(adapter.resolveServiceUrl('19:new@thread.tacv2', undefined, 'acme')).toBe('https://smba.trafficmanager.net/amer/');
    });

    it('fails clearly for an unknown connection', async () => {
      await expect(adapter.sendMessage('19:x', message, mapping('x', '19:x', 'nope'))).rejects.toThrow(
        /"nope" is not configured/
      );
    });
  });

  describe('inbound routing', () => {
    const CHANNEL_A = '19:acme-chan@thread.tacv2';
    const CHANNEL_L = '19:legacy-chan@thread.tacv2';

    function activity(channelId: string, tenantId: string) {
      return {
        type: 'message',
        id: 'msg-1',
        text: 'hello',
        serviceUrl: 'https://smba.trafficmanager.net/amer/',
        channelId: 'msteams',
        from: { id: '29:user', name: 'Bob' },
        recipient: { id: '28:bot' },
        conversation: { id: channelId, tenantId },
        channelData: { channel: { id: channelId }, team: { id: 'team' }, tenant: { id: tenantId } },
      } as any;
    }

    async function deliver(connectionId: string, channelId: string, tenantId: string) {
      const cloud = (adapter as any).connections.get(connectionId).cloudAdapter;
      await adapter.runForConnection(new TurnContext(cloud, activity(channelId, tenantId)), connectionId);
    }

    let received: NormalizedMessage[];
    beforeEach(() => {
      store.save(ACME);
      bridge.db.saveChannelMapping(mapping('acme', CHANNEL_A, 'acme'));
      bridge.db.saveChannelMapping(mapping('legacy', CHANNEL_L));
      received = [];
      vi.spyOn(bridge, 'handleIncomingMessage').mockImplementation(async (m) => {
        received.push(m);
      });
    });

    it('relays activities that arrive on the right connection from the right tenant', async () => {
      await deliver('acme', CHANNEL_A, 'acme-tenant');
      await deliver('initech', CHANNEL_L, 'env-tenant');
      expect(received.map((m) => m.sourceChannelId)).toEqual([CHANNEL_A, CHANNEL_L]);
      expect(errors).toEqual([]);
    });

    it("drops activities whose tenant doesn't match the connection", async () => {
      await deliver('acme', CHANNEL_A, 'globex-tenant');
      expect(received).toEqual([]);
      expect(errors[0].message).toMatch(/another tenant/);
      // Nothing from a rejected activity is persisted
      expect(bridge.db.hasTeamsServiceUrl(CHANNEL_A)).toBe(false);
    });

    it('drops activities for a channel bridged through a different connection', async () => {
      await deliver('initech', CHANNEL_A, 'env-tenant');
      expect(received).toEqual([]);
      expect(errors[0].message).toMatch(/its bridge uses "acme"/);
    });

    it("ignores the connection's own bot messages", async () => {
      const cloud = (adapter as any).connections.get('acme').cloudAdapter;
      const own = { ...activity(CHANNEL_A, 'acme-tenant'), from: { id: '28:acme-app' } };
      await adapter.runForConnection(new TurnContext(cloud, own), 'acme');
      expect(received).toEqual([]);
    });
  });
});

describe('Teams connection HTTP endpoints', () => {
  let bridge: BridgeCore;
  let server: http.Server;
  let base: string;
  const auth = { Authorization: `Basic ${Buffer.from('admin:pw-for-tests').toString('base64')}` };
  const json = { ...auth, 'Content-Type': 'application/json' };

  beforeEach(async () => {
    removeDb();
    bridge = new BridgeCore(dbPath);
    bridge.on('error', () => {});
    const teamsAdapter = new TeamsAdapter(
      { appId: 'env-app', appPassword: 'pw', appTenantId: 'env-tenant', appType: 'SingleTenant' },
      bridge
    );
    const teamsConnections = new TeamsConnectionStore(bridge.db, teamsAdapter, new CredentialCipher(KEY), {
      id: 'default',
      appId: 'env-app',
      tenantId: 'env-tenant',
      appType: 'SingleTenant',
    });
    const app = createWebServer({
      port: 0,
      host: '127.0.0.1',
      adminPassword: 'pw-for-tests',
      bridge,
      publicUrl: 'https://bridge.example.com',
      teamsAdapter,
      teamsConnections,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge.db.close();
    removeDb();
  });

  const createAcme = () =>
    fetch(`${base}/api/teams-connections`, { method: 'POST', headers: json, body: JSON.stringify(ACME) });

  it('serves each connection its own webhook, outside admin auth', async () => {
    await createAcme();
    for (const path of ['/api/messages', '/api/messages/default', '/api/messages/acme']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'message', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/amer/' }),
      });
      // Rejected by Bot Framework JWT validation, not by admin auth or routing
      expect(res.status, path).toBe(401);
      expect(res.headers.get('www-authenticate') ?? '', path).not.toContain('Basic');
    }
    const unknown = await fetch(`${base}/api/messages/nope`, { method: 'POST', body: '{}' });
    expect(unknown.status).toBe(404);
  });

  it('manages connections behind admin auth without exposing secrets', async () => {
    expect((await fetch(`${base}/api/teams-connections`)).status).toBe(401);
    expect((await createAcme()).status).toBe(201);

    const res = await fetch(`${base}/api/teams-connections`, { headers: auth });
    const text = await res.text();
    expect(text).not.toContain('acme-secret');
    const body = JSON.parse(text);
    expect(body.connections.map((c: any) => [c.id, c.messagingEndpoint])).toEqual([
      ['default', 'https://bridge.example.com/api/messages/default'],
      ['acme', 'https://bridge.example.com/api/messages/acme'],
    ]);

    const del = await fetch(`${base}/api/teams-connections/default`, { method: 'DELETE', headers: auth });
    expect(del.status).toBe(409);
  });

  it('validates the connection on channel bridges', async () => {
    await createAcme();
    const post = (m: ChannelMapping) =>
      fetch(`${base}/api/mappings`, { method: 'POST', headers: json, body: JSON.stringify(m) });

    expect((await post(mapping('bad', '19:x@thread.tacv2', 'nope'))).status).toBe(400);
    expect((await post(mapping('a', '19:x@thread.tacv2', 'acme'))).status).toBe(201);
    // The same Teams channel can't also be bridged through another connection
    expect((await post(mapping('b', '19:x@thread.tacv2'))).status).toBe(409);
  });

  it("builds a Teams app package for a connection's bot", async () => {
    await createAcme();
    const res = await fetch(`${base}/api/manifests/teams?connection=acme`, { headers: auth });
    expect(res.headers.get('content-disposition')).toContain('interbridge-teams-app-acme.zip');
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    expect([...files.keys()]).toEqual(['manifest.json', 'color.png', 'outline.png']);

    const manifest = JSON.parse(files.get('manifest.json')!.toString());
    expect(manifest.bots[0].botId).toBe('acme-app');
    expect(manifest.webApplicationInfo.id).toBe('acme-app');
    expect(manifest.id).toBe(teamsAppIdFor('acme-app'));
    expect(manifest.id).not.toBe(teamsAppIdFor('env-app'));

    expect((await fetch(`${base}/api/manifests/teams?connection=nope`, { headers: auth })).status).toBe(404);
  });
});

describe('Teams manifest template', () => {
  it('matches the generator, so the committed template and packages agree', () => {
    const committed = JSON.parse(fs.readFileSync('./manifests/teams/manifest.json', 'utf8'));
    expect(committed).toEqual(buildTeamsManifest());
  });
});

describe('createZip', () => {
  it('writes entries that read back intact', () => {
    const files = readZip(createZip([{ name: 'a.txt', data: Buffer.from('hello') }, { name: 'b.bin', data: Buffer.from([0, 1, 2]) }]));
    expect(files.get('a.txt')!.toString()).toBe('hello');
    expect([...files.get('b.bin')!]).toEqual([0, 1, 2]);
  });
});
