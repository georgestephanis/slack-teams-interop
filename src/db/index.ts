/**
 * Database Layer for SQLite
 * Stores channel configurations, bi-directional message ID mappings, and user profile cache.
 */

import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { ChannelMapping, DEFAULT_MAPPING_OPTIONS } from '../core/types.js';
import { runMigrations } from './migrations.js';

export interface MessageMappingRecord {
  id?: number;
  mappingId: string;
  slackChannelId: string;
  slackMessageTs: string;
  teamsTeamId: string;
  teamsChannelId: string;
  teamsMessageId: string;
  isThreadRoot: boolean;
  createdAt?: string;
}

export class BridgeDatabase {
  private db: DatabaseType;

  constructor(dbPath: string = './data/bridge.sqlite') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    runMigrations(this.db, { dbPath });
  }

  // --- Channel Mapping Methods ---

  saveChannelMapping(mapping: ChannelMapping): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_mappings (
        id, name, enabled,
        slack_channel_id, slack_channel_name,
        teams_team_id, teams_channel_id, teams_team_name, teams_channel_name,
        options, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        enabled = excluded.enabled,
        slack_channel_id = excluded.slack_channel_id,
        slack_channel_name = excluded.slack_channel_name,
        teams_team_id = excluded.teams_team_id,
        teams_channel_id = excluded.teams_channel_id,
        teams_team_name = excluded.teams_team_name,
        teams_channel_name = excluded.teams_channel_name,
        options = excluded.options,
        updated_at = datetime('now')
    `);

    stmt.run(
      mapping.id,
      mapping.name,
      mapping.enabled ? 1 : 0,
      mapping.slack.channelId,
      mapping.slack.channelName || null,
      mapping.teams.teamId,
      mapping.teams.channelId,
      mapping.teams.teamName || null,
      mapping.teams.channelName || null,
      JSON.stringify(mapping.options),
      mapping.createdAt || new Date().toISOString()
    );
  }

  getChannelMapping(id: string): ChannelMapping | null {
    const row = this.db.prepare('SELECT * FROM channel_mappings WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToMapping(row) : null;
  }

  getAllChannelMappings(): ChannelMapping[] {
    const rows = this.db.prepare('SELECT * FROM channel_mappings ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToMapping(r));
  }

  findMappingBySlackChannel(slackChannelId: string): ChannelMapping | null {
    const row = this.db
      .prepare('SELECT * FROM channel_mappings WHERE slack_channel_id = ? AND enabled = 1')
      .get(slackChannelId) as Record<string, unknown> | undefined;
    return row ? this.rowToMapping(row) : null;
  }

  findMappingByTeamsChannel(teamsChannelId: string): ChannelMapping | null {
    const row = this.db
      .prepare('SELECT * FROM channel_mappings WHERE teams_channel_id = ? AND enabled = 1')
      .get(teamsChannelId) as Record<string, unknown> | undefined;
    return row ? this.rowToMapping(row) : null;
  }

  deleteChannelMapping(id: string): boolean {
    const res = this.db.prepare('DELETE FROM channel_mappings WHERE id = ?').run(id);
    return res.changes > 0;
  }

  private rowToMapping(r: Record<string, unknown>): ChannelMapping {
    return {
      id: r.id as string,
      name: r.name as string,
      enabled: Boolean(r.enabled),
      slack: {
        channelId: r.slack_channel_id as string,
        channelName: (r.slack_channel_name as string) || undefined,
      },
      teams: {
        teamId: r.teams_team_id as string,
        channelId: r.teams_channel_id as string,
        teamName: (r.teams_team_name as string) || undefined,
        channelName: (r.teams_channel_name as string) || undefined,
      },
      // Merge over defaults so option keys added after a mapping was saved get sensible values
      options: { ...DEFAULT_MAPPING_OPTIONS, ...JSON.parse(r.options as string) },
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  // --- Message Mapping Methods (Threading & Reactions) ---

  saveMessageMapping(record: MessageMappingRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO message_mappings (
        mapping_id, slack_channel_id, slack_message_ts,
        teams_team_id, teams_channel_id, teams_message_id, is_thread_root
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      record.mappingId,
      record.slackChannelId,
      record.slackMessageTs,
      record.teamsTeamId,
      record.teamsChannelId,
      record.teamsMessageId,
      record.isThreadRoot ? 1 : 0
    );
  }

  findBySlackMessage(slackChannelId: string, slackMessageTs: string): MessageMappingRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM message_mappings WHERE slack_channel_id = ? AND slack_message_ts = ? LIMIT 1'
      )
      .get(slackChannelId, slackMessageTs) as Record<string, unknown> | undefined;

    return row ? this.rowToMessageMapping(row) : null;
  }

  findByTeamsMessage(teamsChannelId: string, teamsMessageId: string): MessageMappingRecord | null {
    const row = this.db
      .prepare(
        'SELECT * FROM message_mappings WHERE teams_channel_id = ? AND teams_message_id = ? LIMIT 1'
      )
      .get(teamsChannelId, teamsMessageId) as Record<string, unknown> | undefined;

    return row ? this.rowToMessageMapping(row) : null;
  }

  private rowToMessageMapping(r: Record<string, unknown>): MessageMappingRecord {
    return {
      id: r.id as number,
      mappingId: r.mapping_id as string,
      slackChannelId: r.slack_channel_id as string,
      slackMessageTs: r.slack_message_ts as string,
      teamsTeamId: r.teams_team_id as string,
      teamsChannelId: r.teams_channel_id as string,
      teamsMessageId: r.teams_message_id as string,
      isThreadRoot: Boolean(r.is_thread_root),
      createdAt: r.created_at as string,
    };
  }

  /**
   * Prune expired message mappings (default older than 30 days) to keep database lean.
   */
  pruneOldMessages(daysToKeep = 30): number {
    const stmt = this.db.prepare(`
      DELETE FROM message_mappings
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `);
    const res = stmt.run(daysToKeep);
    return res.changes;
  }

  // --- Teams Service URL Methods ---

  saveTeamsServiceUrl(conversationId: string, serviceUrl: string, teamId?: string, tenantId?: string): void {
    this.db
      .prepare(
        `INSERT INTO teams_conversations (conversation_id, team_id, tenant_id, service_url, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(conversation_id) DO UPDATE SET
           team_id = COALESCE(excluded.team_id, teams_conversations.team_id),
           tenant_id = COALESCE(excluded.tenant_id, teams_conversations.tenant_id),
           service_url = excluded.service_url,
           updated_at = datetime('now')`
      )
      .run(conversationId, teamId || null, tenantId || null, serviceUrl);
  }

  /**
   * Find the best-known service URL for a Teams channel: exact conversation, then any
   * conversation in the same team, then the most recently seen URL (service URLs are
   * per-tenant region, and most deployments bridge a single tenant).
   */
  findTeamsServiceUrl(conversationId: string, teamId?: string): string | undefined {
    const exact = this.db
      .prepare('SELECT service_url FROM teams_conversations WHERE conversation_id = ?')
      .get(conversationId) as { service_url: string } | undefined;
    if (exact) return exact.service_url;

    if (teamId) {
      const team = this.db
        .prepare(
          'SELECT service_url FROM teams_conversations WHERE team_id = ? OR conversation_id = ? ORDER BY updated_at DESC LIMIT 1'
        )
        .get(teamId, teamId) as { service_url: string } | undefined;
      if (team) return team.service_url;
    }

    const latest = this.db
      .prepare('SELECT service_url FROM teams_conversations ORDER BY updated_at DESC LIMIT 1')
      .get() as { service_url: string } | undefined;
    return latest?.service_url;
  }

  hasTeamsServiceUrl(conversationId: string): boolean {
    return Boolean(
      this.db.prepare('SELECT 1 FROM teams_conversations WHERE conversation_id = ?').get(conversationId)
    );
  }

  // --- User Cache Methods ---

  cacheUser(platform: string, platformId: string, displayName: string, avatarUrl?: string, email?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO user_cache (platform, platform_id, display_name, avatar_url, email, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(platform, platform_id) DO UPDATE SET
        display_name = excluded.display_name,
        avatar_url = COALESCE(excluded.avatar_url, user_cache.avatar_url),
        email = COALESCE(excluded.email, user_cache.email),
        updated_at = datetime('now')
    `);
    stmt.run(platform, platformId, displayName, avatarUrl || null, email || null);
  }

  getCachedUser(platform: string, platformId: string) {
    return this.db
      .prepare('SELECT * FROM user_cache WHERE platform = ? AND platform_id = ?')
      .get(platform, platformId) as { display_name: string; avatar_url?: string; email?: string } | undefined;
  }

  close(): void {
    this.db.close();
  }
}
