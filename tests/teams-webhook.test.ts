import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { BridgeCore } from '../src/core/bridge.js';
import { TeamsAdapter } from '../src/adapters/teams/client.js';
import { createWebServer } from '../src/web/server.js';

const dbPath = './data/test-teams-webhook.sqlite';

function removeDb() {
  if (!fs.existsSync('./data')) return;
  for (const f of fs.readdirSync('./data')) {
    if (f.startsWith('test-teams-webhook.sqlite')) fs.rmSync(`./data/${f}`, { force: true });
  }
}

describe('Teams webhook', () => {
  let bridge: BridgeCore;
  let server: http.Server;
  let url: string;

  beforeEach(async () => {
    removeDb();
    bridge = new BridgeCore(dbPath);
    const teamsAdapter = new TeamsAdapter(
      { appId: 'app', appPassword: 'pw', appTenantId: 'tenant', appType: 'SingleTenant' },
      bridge
    );
    const app = createWebServer({ port: 0, host: '127.0.0.1', adminPassword: 'pw', bridge, teamsAdapter });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/messages`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge.db.close();
    removeDb();
  });

  it('parses the activity and reaches Bot Framework authentication', async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'message', channelId: 'msteams', serviceUrl: 'https://smba.trafficmanager.net/amer/' }),
    });
    // 401 from JWT validation (no Authorization header). Before the fix this was a 400:
    // "`req.body` not an object", so no Teams activity was ever processed.
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate') ?? '').not.toContain('Basic');
  });
});
