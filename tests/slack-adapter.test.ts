import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { SlackAdapter } from '../src/adapters/slack/client.js';
import { BridgeCore } from '../src/core/bridge.js';

/**
 * Delete a test DB and its WAL/backup siblings. A leftover DB from a branch with a newer schema
 * would otherwise trip the migration "newer than this build" guard.
 */
function removeDb(dbPath: string) {
  const dir = './data';
  const base = dbPath.split('/').pop()!;
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.rmSync(`${dir}/${f}`, { force: true });
}

describe('SlackAdapter', () => {
  it('throws an error if HTTP mode is used without SLACK_SIGNING_SECRET', () => {
    const dbPath = './data/test-slack-cfg.sqlite';
    removeDb(dbPath);
    const bridge = new BridgeCore(dbPath);

    expect(() => {
      new SlackAdapter(
        {
          botToken: 'xoxb-mock',
          useSocketMode: false,
        },
        bridge
      );
    }).toThrow('Slack HTTP mode requires SLACK_SIGNING_SECRET');

    bridge.db.close();
    removeDb(dbPath);
  });
});
