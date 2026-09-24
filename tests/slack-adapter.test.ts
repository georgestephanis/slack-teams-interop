import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { SlackAdapter } from '../src/adapters/slack/client.js';
import { BridgeCore } from '../src/core/bridge.js';

describe('SlackAdapter', () => {
  it('throws an error if HTTP mode is used without SLACK_SIGNING_SECRET', () => {
    const bridge = new BridgeCore('./data/test-slack-cfg.sqlite');

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
  });

  it('relays only genuine user edits from message_changed', async () => {
    const dbPath = './data/test-slack-edits.sqlite';
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const bridge = new BridgeCore(dbPath);
    bridge.db.cacheUser('slack', 'U1', 'Alice');
    const adapter = new SlackAdapter({ botToken: 'xoxb-mock', signingSecret: 's', useSocketMode: false }, bridge);
    const spy = vi.spyOn(bridge, 'handleIncomingEdit').mockResolvedValue();
    const changed = (message: object) => (adapter as any).handleMessageChanged({ channel: 'C1', message });

    await changed({ ts: '1.1', user: 'U1', text: 'link unfurled' }); // no `edited`: unfurl, not an edit
    await changed({ ts: '1.2', bot_id: 'B1', user: 'U1', text: 'x', edited: { ts: '2' } }); // bridge chat.update
    await changed({ ts: '1.3', user: 'U1', text: 'fixed typo', edited: { ts: '2' } });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sourceMessageId: '1.3', content: 'fixed typo' });

    bridge.db.close();
    fs.unlinkSync(dbPath);
  });
});
