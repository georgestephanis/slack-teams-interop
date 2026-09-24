import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Server } from 'node:http';
import { BridgeCore } from '../src/core/bridge.js';
import { SlackAdapter } from '../src/adapters/slack/client.js';
import { createWebServer } from '../src/web/server.js';

const testDbPath = './data/test-slack-http.sqlite';
const signingSecret = 'test-signing-secret';

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const sig = crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex');
  return { 'x-slack-signature': `v0=${sig}`, 'x-slack-request-timestamp': String(timestamp) };
}

describe('Slack HTTP (Events API) mode', () => {
  let bridge: BridgeCore;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);
    const slackAdapter = new SlackAdapter({ botToken: 'xoxb-mock', signingSecret, useSocketMode: false }, bridge);
    const app = createWebServer({
      port: 0,
      host: '127.0.0.1',
      adminPassword: 'secret',
      bridge,
      slackAdapter,
      slackSocketMode: false,
      publicUrl: 'https://bridge.example.com',
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('answers a signed url_verification challenge on the shared server without admin auth', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await fetch(`${base}/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sign(body) },
      body,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('abc123');
  });

  it('rejects requests with a bad signature', async () => {
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123' });
    const res = await fetch(`${base}/slack/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-signature': 'v0=bad', 'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)) },
      body,
    });

    expect(res.status).toBe(401);
  });

  it('generates an HTTP-mode manifest with the Request URL', async () => {
    const res = await fetch(`${base}/api/manifests/slack`, {
      headers: { authorization: 'Basic ' + Buffer.from('admin:secret').toString('base64') },
    });
    const manifest = await res.json();

    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.event_subscriptions.request_url).toBe('https://bridge.example.com/slack/events');
  });
});
