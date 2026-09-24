import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { Server } from 'node:http';
import { BridgeAdapter, BridgeCore } from '../src/core/bridge.js';
import { MediaSigner } from '../src/core/media.js';
import { SlackAdapter } from '../src/adapters/slack/client.js';
import { TeamsAdapter, isTeamsAttachmentHost, teamsAttachments } from '../src/adapters/teams/client.js';
import { createWebServer } from '../src/web/server.js';
import { ChannelMapping, NormalizedMessage } from '../src/core/types.js';

const SECRET = 'x'.repeat(40);
const signer = new MediaSigner(SECRET, 'https://bridge.example.com');
const SLACK_URL = 'https://files.slack.com/files-pri/T1-F1/cat.png';

function mapping(options: Partial<ChannelMapping['options']> = {}): ChannelMapping {
  return {
    id: 'map-1',
    name: 'Images',
    enabled: true,
    slack: { channelId: 'C1' },
    teams: { teamId: 'T1', channelId: '19:c' },
    options: {
      syncThreads: true,
      syncReactions: true,
      syncEdits: true,
      syncDeletes: true,
      syncFiles: true,
      teamsFormatStyle: 'adaptive_card',
      reactionNotices: false,
      ...options,
    },
    createdAt: '',
    updatedAt: '',
  };
}

function removeDb(dbPath: string) {
  const base = dbPath.split('/').pop()!;
  if (!fs.existsSync('./data')) return;
  for (const f of fs.readdirSync('./data')) if (f.startsWith(base)) fs.rmSync(`./data/${f}`, { force: true });
}

describe('MediaSigner', () => {
  it('round-trips Slack file URLs and rejects tampering or other hosts', () => {
    const url = signer.sign(SLACK_URL);
    const token = url.split('/').pop()!;
    expect(url.startsWith('https://bridge.example.com/media/slack/')).toBe(true);
    expect(signer.verify(token)).toBe(SLACK_URL);

    expect(signer.verify(token.slice(0, -2) + 'AA')).toBeNull();
    expect(new MediaSigner('y'.repeat(40), 'https://b').verify(token)).toBeNull();
    const evil = signer.sign('https://evil.example.com/steal').split('/').pop()!;
    expect(signer.verify(evil)).toBeNull();
  });
});

describe('Image routing in BridgeCore', () => {
  const dbPath = './data/test-image-routing.sqlite';
  let bridge: BridgeCore;
  let slack: BridgeAdapter;
  let teams: BridgeAdapter;

  const teamsImage = (fetchContent = vi.fn().mockResolvedValue(Buffer.from('png'))) => ({
    id: 'https://us-api.asm.skype.com/v1/objects/abc/views/imgo',
    name: 'image',
    contentType: 'image/png',
    fetchContent,
  });
  const teamsMsg = (attachments: NormalizedMessage['attachments'], content = 'look'): NormalizedMessage => ({
    id: 't-1', sourcePlatform: 'teams', sourceChannelId: '19:c', sourceMessageId: 'tm-1',
    sender: { platformId: 'AAD_BOB', displayName: 'Bob', platform: 'teams' }, content, attachments, timestamp: new Date(),
  });
  const slackMsg = (attachments: NormalizedMessage['attachments']): NormalizedMessage => ({
    id: 's-1', sourcePlatform: 'slack', sourceChannelId: 'C1', sourceMessageId: '1.1',
    sender: { platformId: 'U1', displayName: 'Alice', platform: 'slack' }, content: 'cat', attachments, timestamp: new Date(),
  });

  beforeEach(() => {
    removeDb(dbPath);
    bridge = new BridgeCore(dbPath);
    bridge.on('error', (e) => {
      throw e;
    });
    slack = {
      platform: 'slack',
      sendMessage: vi.fn().mockImplementation(async (_c, m: NormalizedMessage) => ({
        messageId: '1711.001',
        attachments: m.attachments?.map((a) => ({ ...a, slackFileId: 'F_UP' })),
      })),
      updateMessage: vi.fn().mockImplementation(async (_c, _t, m: NormalizedMessage) => ({ attachments: m.attachments })),
    };
    teams = {
      platform: 'teams',
      sendMessage: vi.fn().mockResolvedValue({ messageId: 'teams-1' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    bridge.registerAdapter(slack);
    bridge.registerAdapter(teams);
  });
  afterEach(() => {
    bridge.db.close();
    removeDb(dbPath);
  });

  it('hands downloadable Teams images to Slack instead of a link line, and stores the upload id', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(teamsMsg([teamsImage()]));

    const sent = vi.mocked(slack.sendMessage).mock.calls[0][1];
    expect(sent.content).toBe('look');
    expect(sent.attachments).toHaveLength(1);
    const stored = bridge.db.findByTeamsMessage('19:c', 'tm-1')?.sourceAttachments;
    expect(stored?.[0]).toMatchObject({ slackFileId: 'F_UP' });
    expect(stored?.[0]).not.toHaveProperty('fetchContent');
  });

  it('reuses the uploaded Slack file on edits instead of downloading again', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(teamsMsg([teamsImage()]));

    const refetch = vi.fn().mockResolvedValue(Buffer.from('png'));
    await bridge.handleIncomingEdit(teamsMsg([teamsImage(refetch)], 'look again'));

    const edited = vi.mocked(slack.updateMessage!).mock.calls[0][2];
    expect(edited.attachments?.[0].slackFileId).toBe('F_UP');
  });

  it('falls back to a named line for Teams images it cannot download', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(teamsMsg([{ id: 'x', name: 'image', contentType: 'image/png' }]));

    const sent = vi.mocked(slack.sendMessage).mock.calls[0][1];
    expect(sent.content).toBe('look\n📎 image (shared in Teams)');
    expect(sent.attachments).toBeUndefined();
  });

  it('transfers nothing when syncFiles is off', async () => {
    bridge.db.saveChannelMapping(mapping({ syncFiles: false }));
    await bridge.handleIncomingMessage(teamsMsg([teamsImage()]));

    expect(vi.mocked(slack.sendMessage).mock.calls[0][1].attachments).toBeUndefined();
  });

  it('passes proxied Slack images to Teams and keeps them in reaction-footer re-renders', async () => {
    bridge.db.saveChannelMapping(mapping());
    const image = { id: 'F1', name: 'cat.png', contentType: 'image/png', permalink: 'https://x/F1', displayUrl: signer.sign(SLACK_URL) };
    await bridge.handleIncomingMessage(slackMsg([image]));

    expect(vi.mocked(teams.sendMessage).mock.calls[0][1]).toMatchObject({ content: 'cat', attachments: [image] });

    await bridge.handleIncomingReaction({
      id: 'r', sourcePlatform: 'slack', sourceChannelId: 'C1', sourceMessageId: '1.1',
      sender: { platformId: 'U2', displayName: 'Omar', platform: 'slack' }, emoji: 'tada', action: 'add',
    });
    expect(vi.mocked(teams.updateMessage!).mock.calls[0][2].attachments).toEqual([image]);
  });

  it('links Slack images when the media proxy is not configured', async () => {
    bridge.db.saveChannelMapping(mapping());
    await bridge.handleIncomingMessage(slackMsg([{ id: 'F1', name: 'cat.png', contentType: 'image/png', permalink: 'https://x/F1' }]));

    expect(vi.mocked(teams.sendMessage).mock.calls[0][1].content).toBe('cat\n📎 <https://x/F1|cat.png> (shared in Slack)');
  });
});

describe('SlackAdapter image delivery', () => {
  const dbPath = './data/test-slack-images.sqlite';
  let bridge: BridgeCore;
  let adapter: SlackAdapter;
  let errors: Error[];
  const message: NormalizedMessage = {
    id: 't', sourcePlatform: 'teams', sourceChannelId: '19:c', sourceMessageId: 'tm-1',
    sender: { platformId: 'AAD_BOB', displayName: 'Bob', platform: 'teams', avatarUrl: 'https://a/b.png' },
    content: 'look', timestamp: new Date(),
    attachments: [{ id: 'img', name: 'shot.png', contentType: 'image/png', fetchContent: async () => Buffer.from('png') }],
  };

  beforeEach(() => {
    removeDb(dbPath);
    bridge = new BridgeCore(dbPath);
    errors = [];
    bridge.on('error', (e) => errors.push(e));
    adapter = new SlackAdapter({ botToken: 'xoxb', signingSecret: 's', useSocketMode: false }, bridge);
    adapter.uploadRetryDelayMs = 0;
  });
  afterEach(() => {
    bridge.db.close();
    removeDb(dbPath);
  });

  it('uploads privately and posts an image block under the sender override', async () => {
    const upload = vi.spyOn(adapter.client.files, 'uploadV2').mockResolvedValue({ ok: true, files: [{ files: [{ id: 'F_NEW' }] }] } as any);
    const post = vi.spyOn(adapter.client.chat, 'postMessage').mockResolvedValue({ ok: true, ts: '1.2' } as any);

    const res = await adapter.sendMessage('C1', message, mapping(), '1.0');

    expect(upload.mock.calls[0][0]).not.toHaveProperty('channel_id');
    const args = post.mock.calls[0][0] as any;
    expect(args).toMatchObject({ channel: 'C1', username: 'Bob (Teams)', thread_ts: '1.0' });
    expect(args.blocks[1]).toMatchObject({ type: 'image', slack_file: { id: 'F_NEW' } });
    expect(res.attachments?.[0].slackFileId).toBe('F_NEW');
  });

  it('retries once on invalid_blocks, then posts text only', async () => {
    vi.spyOn(adapter.client.files, 'uploadV2').mockResolvedValue({ ok: true, files: [{ files: [{ id: 'F_NEW' }] }] } as any);
    const invalid = Object.assign(new Error('invalid_blocks'), { data: { error: 'invalid_blocks' } });
    const post = vi
      .spyOn(adapter.client.chat, 'postMessage')
      .mockRejectedValueOnce(invalid)
      .mockRejectedValueOnce(invalid)
      .mockResolvedValue({ ok: true, ts: '1.2' } as any);

    await adapter.sendMessage('C1', message, mapping());

    expect(post).toHaveBeenCalledTimes(3);
    expect((post.mock.calls[2][0] as any).blocks).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it('falls back to a named line when the image cannot be transferred', async () => {
    vi.spyOn(adapter.client.files, 'uploadV2').mockRejectedValue(new Error('ratelimited'));
    const post = vi.spyOn(adapter.client.chat, 'postMessage').mockResolvedValue({ ok: true, ts: '1.2' } as any);

    await adapter.sendMessage('C1', message, mapping());

    expect(post.mock.calls[0][0]).toMatchObject({ text: 'look\n📎 shot.png (shared in Teams)' });
    expect(errors[0].message).toContain('shot.png');
  });

  it('signs image files for the proxy when a signer is configured', () => {
    const withSigner = new SlackAdapter({ botToken: 'xoxb', signingSecret: 's', useSocketMode: false, mediaSigner: signer }, bridge);
    const spy = vi.spyOn(bridge, 'handleIncomingEdit').mockResolvedValue();
    bridge.db.cacheUser('slack', 'U1', 'Alice');
    return (withSigner as any)
      .handleMessageChanged({
        channel: 'C1',
        message: { ts: '1.1', user: 'U1', text: 'cat', edited: {}, files: [
          { id: 'F1', name: 'cat.png', mimetype: 'image/png', url_private: SLACK_URL },
          { id: 'F2', name: 'notes.pdf', mimetype: 'application/pdf', url_private: 'https://files.slack.com/files-pri/T1-F2/notes.pdf' },
        ] },
      })
      .then(() => {
        const [img, pdf] = spy.mock.calls[0][0].attachments!;
        expect(img.displayUrl).toBe(signer.sign(SLACK_URL));
        expect(pdf.displayUrl).toBeUndefined();
      });
  });
});

describe('Teams image handling', () => {
  it('only offers downloads from Microsoft attachment hosts', () => {
    expect(isTeamsAttachmentHost('https://us-api.asm.skype.com/v1/objects/a/views/imgo')).toBe(true);
    expect(isTeamsAttachmentHost('https://smba.trafficmanager.net/amer/v3/attachments/a')).toBe(true);
    expect(isTeamsAttachmentHost('https://asm.skype.com.evil.example/x')).toBe(false);
    expect(isTeamsAttachmentHost('http://us-api.asm.skype.com/x')).toBe(false);

    const download = vi.fn();
    const [good, bad] = teamsAttachments(
      {
        id: 'm',
        attachments: [
          { contentType: 'image/png', contentUrl: 'https://us-api.asm.skype.com/v1/objects/a/views/imgo' },
          { contentType: 'image/png', contentUrl: 'https://evil.example/x.png' },
        ],
      } as any,
      download
    )!;
    expect(good.fetchContent).toBeTypeOf('function');
    expect(bad.fetchContent).toBeUndefined();
  });

  it('renders proxied images in adaptive cards and markdown messages', () => {
    const dbPath = './data/test-teams-images.sqlite';
    removeDb(dbPath);
    const bridge = new BridgeCore(dbPath);
    const adapter = new TeamsAdapter({ appId: 'app', appPassword: 'x' }, bridge);
    const msg: NormalizedMessage = {
      id: 's', sourcePlatform: 'slack', sourceChannelId: 'C1', sourceMessageId: '1.1',
      sender: { platformId: 'U1', displayName: 'Alice', platform: 'slack' }, content: 'cat', timestamp: new Date(),
      attachments: [{ id: 'F1', name: 'cat.png', contentType: 'image/png', displayUrl: 'https://bridge.example.com/media/slack/t' }],
    };

    const card = (adapter as any).buildActivity(msg, mapping()).attachments[0].content;
    expect(card.body).toContainEqual(expect.objectContaining({ type: 'Image', url: 'https://bridge.example.com/media/slack/t' }));

    const md = (adapter as any).buildActivity(msg, mapping({ teamsFormatStyle: 'clean_markdown' }));
    expect(md.attachments).toEqual([{ contentType: 'image/png', contentUrl: 'https://bridge.example.com/media/slack/t', name: 'cat.png' }]);

    bridge.db.close();
    removeDb(dbPath);
  });
});

describe('Media proxy endpoint', () => {
  const dbPath = './data/test-media-proxy.sqlite';
  let bridge: BridgeCore;
  let server: Server;
  let base: string;
  let fetchPrivateFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    removeDb(dbPath);
    bridge = new BridgeCore(dbPath);
    bridge.on('error', () => {});
    fetchPrivateFile = vi.fn();
    const app = createWebServer({
      port: 0, host: '127.0.0.1', adminPassword: 'secret', bridge,
      slackAdapter: { fetchPrivateFile } as unknown as SlackAdapter,
      mediaSigner: signer,
    });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    bridge.db.close();
    removeDb(dbPath);
  });

  const path = (url: string) => new URL(signer.sign(url)).pathname;

  it('serves a signed Slack image without admin auth, with safe headers', async () => {
    fetchPrivateFile.mockResolvedValue(new Response(Buffer.from('PNGDATA'), { headers: { 'content-type': 'image/png' } }));

    const res = await fetch(base + path(SLACK_URL));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('PNGDATA');
    expect(fetchPrivateFile).toHaveBeenCalledWith(SLACK_URL);
  });

  it('rejects bad signatures without contacting Slack', async () => {
    const res = await fetch(`${base}/media/slack/${Buffer.from(SLACK_URL).toString('base64url')}.forged`);
    expect(res.status).toBe(404);
    expect(fetchPrivateFile).not.toHaveBeenCalled();
  });

  it('refuses to serve non-image or SVG content', async () => {
    fetchPrivateFile.mockResolvedValue(new Response('<svg onload=alert(1)>', { headers: { 'content-type': 'image/svg+xml' } }));
    expect((await fetch(base + path(SLACK_URL))).status).toBe(502);

    fetchPrivateFile.mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }));
    expect((await fetch(base + path(SLACK_URL))).status).toBe(502);
  });
});
