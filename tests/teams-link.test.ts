import { describe, expect, it } from 'vitest';
import '../public/teams-link.js';

const { parseTeamsLink, normalizeTeamsId } = (globalThis as any).InterBridgeTeamsLink as {
  parseTeamsLink: (input: string) => Record<string, string | undefined> | null;
  normalizeTeamsId: (input: string) => string | null;
};

const TEAM = '19:abcDEF123@thread.tacv2';
const CHANNEL = '19:9f8e7d6c5b4a@thread.tacv2';
const ENCODED_TEAM = encodeURIComponent(TEAM);
const ENCODED_CHANNEL = encodeURIComponent(CHANNEL);
const TENANT = '00000000-0000-0000-0000-000000000001';
const GROUP = '00000000-0000-0000-0000-000000000002';

describe('Teams link parsing', () => {
  it('reads a team link as the team and its General channel', () => {
    for (const host of ['teams.microsoft.com', 'teams.cloud.microsoft']) {
      expect(parseTeamsLink(`https://${host}/l/team/${ENCODED_TEAM}/conversations?groupId=${GROUP}&tenantId=${TENANT}`)).toEqual({
        kind: 'team',
        teamId: TEAM,
        channelId: TEAM,
        channelName: 'General',
        teamName: undefined,
        tenantId: TENANT,
      });
    }
  });

  it('reads a channel link, with the channel name from the path', () => {
    expect(
      parseTeamsLink(`https://teams.microsoft.com/l/channel/${ENCODED_CHANNEL}/Project%20Updates?groupId=${GROUP}&tenantId=${TENANT}`)
    ).toEqual({ kind: 'channel', channelId: CHANNEL, channelName: 'Project Updates', teamName: undefined, tenantId: TENANT });
  });

  it('reads a message link, which names the team and channel', () => {
    expect(
      parseTeamsLink(
        `https://teams.microsoft.com/l/message/${ENCODED_CHANNEL}/1700000000000?tenantId=${TENANT}&groupId=${GROUP}&parentMessageId=1700000000000&teamName=Example%20Team&channelName=Project%20Updates`
      )
    ).toMatchObject({ kind: 'message', channelId: CHANNEL, channelName: 'Project Updates', teamName: 'Example Team' });
  });

  it('accepts a bare id, encoded or not', () => {
    expect(parseTeamsLink(ENCODED_CHANNEL)).toEqual({ kind: 'id', channelId: CHANNEL });
    expect(normalizeTeamsId(`  ${ENCODED_TEAM.replace('%3A', '%3a')} `)).toBe(TEAM);
    expect(normalizeTeamsId(TEAM)).toBe(TEAM);
  });

  it('rejects anything else', () => {
    expect(parseTeamsLink('https://example.com/l/team/' + ENCODED_TEAM + '/conversations')).toBeNull();
    expect(parseTeamsLink('https://teams.microsoft.com/l/chat/0/0?users=someone@example.com')).toBeNull();
    expect(parseTeamsLink('https://teams.microsoft.com/l/team/not-an-id/conversations')).toBeNull();
    expect(parseTeamsLink('C0123456789')).toBeNull();
    expect(normalizeTeamsId('19%E0%A4%A')).toBeNull();
  });
});
