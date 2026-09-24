import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { BridgeAdapter, BridgeCore } from '../src/core/bridge.js';
import { MessageTranslator } from '../src/core/translator.js';
import { ChannelMapping, NormalizedMessage } from '../src/core/types.js';

const testDbPath = './data/test-file-notices.sqlite';

function mapping(syncFiles: boolean): ChannelMapping {
  return {
    id: 'map-1',
    name: 'Files',
    enabled: true,
    slack: { channelId: 'C1' },
    teams: { teamId: 'T1', channelId: '19:c' },
    options: {
      syncThreads: true,
      syncReactions: true,
      syncEdits: true,
      syncDeletes: true,
      syncFiles,
      teamsFormatStyle: 'clean_markdown',
      reactionNotices: false,
    },
    createdAt: '',
    updatedAt: '',
  };
}

const fileOnly: NormalizedMessage = {
  id: 's-1',
  sourcePlatform: 'slack',
  sourceChannelId: 'C1',
  sourceMessageId: '1.1',
  sender: { platformId: 'U1', displayName: 'Alice', platform: 'slack' },
  content: '',
  attachments: [
    { id: 'F1', name: 'report.pdf', contentType: 'application/pdf', permalink: 'https://x.slack.com/files/U1/F1/report.pdf' },
  ],
  timestamp: new Date(),
};

describe('File share notices', () => {
  let bridge: BridgeCore;
  let teams: BridgeAdapter;

  beforeEach(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    bridge = new BridgeCore(testDbPath);
    bridge.on('error', (e) => {
      throw e;
    });
    teams = { platform: 'teams', sendMessage: vi.fn().mockResolvedValue({ messageId: 't-1' }) };
    bridge.registerAdapter(teams);
  });

  afterEach(() => {
    bridge.db.close();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  it('relays a file-only Slack message as a named link when syncFiles is on', async () => {
    bridge.db.saveChannelMapping(mapping(true));
    await bridge.handleIncomingMessage(fileOnly);

    const sent = vi.mocked(teams.sendMessage).mock.calls[0][1];
    expect(sent.content).toBe("📎 <https://x.slack.com/files/U1/F1/report.pdf|report.pdf> (shared in Slack)\n_Files aren't copied between Slack and Teams; opening them may require access to Slack._");
    expect(MessageTranslator.slackToTeams(sent.content)).toContain('[report.pdf](https://x.slack.com/files/U1/F1/report.pdf)');
    // Stored content includes the file line, so footer re-renders keep it
    expect(bridge.db.findBySlackMessage('C1', '1.1')?.sourceContent).toBe(sent.content);
  });

  it('drops a file-only message when syncFiles is off', async () => {
    bridge.db.saveChannelMapping(mapping(false));
    await bridge.handleIncomingMessage(fileOnly);

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the text of a message with files when syncFiles is off', async () => {
    bridge.db.saveChannelMapping(mapping(false));
    await bridge.handleIncomingMessage({ ...fileOnly, content: 'see attached' });

    expect(vi.mocked(teams.sendMessage).mock.calls[0][1].content).toBe('see attached');
  });

  it('formats Teams-dialect lines and link-less files', () => {
    const out = MessageTranslator.appendAttachmentLines(
      'notes',
      [
        { id: 'a', name: 'Q3 [final].xlsx', contentType: 'reference', permalink: 'https://contoso.sharepoint.com/x' },
        { id: 'b', name: 'image', contentType: 'image/png' },
      ],
      'teams'
    );
    expect(out).toBe("notes\n📎 [Q3 final.xlsx](https://contoso.sharepoint.com/x) (shared in Teams)\n📎 image (shared in Teams)\n*Files aren't copied between Slack and Teams; opening them may require access to Teams.*");
    expect(MessageTranslator.teamsToSlack(out)).toContain('<https://contoso.sharepoint.com/x|Q3 final.xlsx>');
  });

  it('relays an edit that leaves only attachments, and skips it when syncFiles is off', async () => {
    const withText = { ...fileOnly, content: 'draft notes' };
    teams.updateMessage = vi.fn().mockResolvedValue(undefined);

    bridge.db.saveChannelMapping(mapping(true));
    await bridge.handleIncomingMessage(withText);
    await bridge.handleIncomingEdit({ ...fileOnly, sender: { ...fileOnly.sender } });
    expect(vi.mocked(teams.updateMessage).mock.calls[0][2].content).toContain('report.pdf');

    bridge.db.saveChannelMapping(mapping(false));
    await bridge.handleIncomingEdit({ ...fileOnly });
    expect(teams.updateMessage).toHaveBeenCalledTimes(1);
  });
});
