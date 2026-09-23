import { describe, expect, it } from 'vitest';
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
});
