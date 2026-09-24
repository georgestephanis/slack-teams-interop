import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const credentialArgs: unknown[][] = [];
vi.mock('botframework-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('botframework-connector')>();
  return {
    ...actual,
    MicrosoftAppCredentials: class {
      constructor(...args: unknown[]) {
        credentialArgs.push(args);
      }
      async getToken() {
        return 'token';
      }
    },
  };
});

const { BridgeCore } = await import('../src/core/bridge.js');
const { TeamsAdapter } = await import('../src/adapters/teams/client.js');

const dbPath = './data/test-teams-app-type.sqlite';
const IMAGE = 'https://us-api.asm.skype.com/v1/objects/abc/views/imgo';

describe('Teams app type', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    credentialArgs.length = 0;
    for (const f of fs.existsSync('./data') ? fs.readdirSync('./data') : []) {
      if (f.startsWith('test-teams-app-type.sqlite')) fs.rmSync(`./data/${f}`, { force: true });
    }
  });

  it.each([
    ['SingleTenant', 'tenant-guid'],
    ['MultiTenant', undefined],
  ] as const)('%s bots fetch attachment tokens from the right tenant', async (appType, expectedTenant) => {
    const bridge = new BridgeCore(dbPath);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from('png'))));
    const adapter = new TeamsAdapter({ appId: 'app', appPassword: 'pw', appTenantId: 'tenant-guid', appType }, bridge);

    await adapter.downloadAttachment(IMAGE);

    expect(credentialArgs[0]).toEqual(['app', 'pw', expectedTenant]);
    bridge.db.close();
  });
});
