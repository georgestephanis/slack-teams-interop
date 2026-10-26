/**
 * Teams link parsing for the dashboard. Turns a link copied from Teams ("Get link to team",
 * "Get link to channel", or a message link) into the IDs a channel bridge needs.
 *
 * A plain script (no build step): it sets globalThis.InterBridgeTeamsLink, which app.js uses and
 * the tests import.
 */
(function () {
  const THREAD_ID = /^19:[^/?#\s]+@thread\.(tacv2|skype)$/i;

  /** Decode a Teams conversation id (`19%3a…%40thread.tacv2` → `19:…@thread.tacv2`), or return null. */
  function normalizeTeamsId(value) {
    let id = String(value || '').trim();
    try {
      if (/%[0-9a-f]{2}/i.test(id)) id = decodeURIComponent(id);
    } catch {
      return null;
    }
    return THREAD_ID.test(id) ? id : null;
  }

  /**
   * Parse a Teams link (or a bare, possibly URL-encoded, conversation id).
   *
   * Returns null if it isn't one, otherwise `{ kind, teamId?, channelId?, channelName?, teamName?,
   * tenantId? }`. A team link's id is both the team id and the id of its General channel. A channel
   * link carries only the channel id; the team id is unknown unless the channel is General.
   */
  function parseTeamsLink(input) {
    const text = String(input || '').trim();
    const bare = normalizeTeamsId(text);
    if (bare) return { kind: 'id', channelId: bare };

    let url;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const host = url.hostname.toLowerCase();
    if (host !== 'teams.microsoft.com' && host !== 'teams.cloud.microsoft' && !host.endsWith('.teams.microsoft.com')) {
      return null;
    }

    // /l/<kind>/<id>/<rest>
    const parts = url.pathname.split('/').filter(Boolean);
    const at = parts.indexOf('l');
    if (at === -1 || parts.length < at + 3) return null;
    const kind = parts[at + 1].toLowerCase();
    const id = normalizeTeamsId(parts[at + 2]);
    if (!id) return null;

    const query = url.searchParams;
    const tenantId = query.get('tenantId') || undefined;
    const teamName = query.get('teamName') || undefined;
    const decode = (s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    };

    if (kind === 'team') {
      return { kind: 'team', teamId: id, channelId: id, channelName: 'General', teamName, tenantId };
    }
    if (kind === 'channel') {
      const channelName = query.get('channelName') || (parts[at + 3] ? decode(parts[at + 3]) : undefined);
      return { kind: 'channel', channelId: id, channelName, teamName, tenantId };
    }
    if (kind === 'message') {
      // Message links in channels also name the channel and team
      return { kind: 'message', channelId: id, channelName: query.get('channelName') || undefined, teamName, tenantId };
    }
    return null;
  }

  globalThis.InterBridgeTeamsLink = { parseTeamsLink, normalizeTeamsId };
})();
