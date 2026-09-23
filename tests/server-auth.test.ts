import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import { createWebServer } from '../src/web/server.js';
import { BridgeCore } from '../src/core/bridge.js';

describe('Web Server Authentication', () => {
  const testDbPath = './data/test-auth.sqlite';
  let bridge: BridgeCore;
  let app: express.Express;
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);

    app = createWebServer({
      port: 0,
      host: '127.0.0.1',
      adminPassword: 'supersecretpassword',
      bridge,
    });

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        port = addr.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('allows unauthenticated access to /api/health/live', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/health/live`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('ok');
  });

  it('rejects unauthenticated access to /api/mappings with 401', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mappings`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Basic');
  });

  it('allows authenticated access with valid credentials (case-insensitive header)', async () => {
    const credentials = Buffer.from('admin:supersecretpassword').toString('base64');
    const res = await fetch(`http://127.0.0.1:${port}/api/mappings`, {
      headers: {
        Authorization: `basic ${credentials}`,
      },
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid password with 401', async () => {
    const credentials = Buffer.from('admin:wrongpassword').toString('base64');
    const res = await fetch(`http://127.0.0.1:${port}/api/mappings`, {
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });
    expect(res.status).toBe(401);
  });
});
