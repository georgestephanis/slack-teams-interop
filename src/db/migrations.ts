/**
 * Schema Migrations
 * Ordered, append-only list of schema changes, tracked with SQLite's `PRAGMA user_version`.
 *
 * Rules:
 * - Never edit or reorder an existing migration once it has shipped; add a new one instead.
 * - Each migration runs inside a transaction together with its `user_version` bump.
 */

import { Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';

export type Migration = (db: DatabaseType) => void;

export const migrations: Migration[] = [
  // 1: Baseline schema (as originally created by initTables()).
  // Uses IF NOT EXISTS so it is a no-op for databases created before migrations existed.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_mappings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        slack_channel_id TEXT NOT NULL,
        slack_channel_name TEXT,
        teams_team_id TEXT NOT NULL,
        teams_channel_id TEXT NOT NULL,
        teams_team_name TEXT,
        teams_channel_name TEXT,
        options TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_cm_slack ON channel_mappings (slack_channel_id);
      CREATE INDEX IF NOT EXISTS idx_cm_teams ON channel_mappings (teams_channel_id);

      CREATE TABLE IF NOT EXISTS message_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mapping_id TEXT NOT NULL,
        slack_channel_id TEXT NOT NULL,
        slack_message_ts TEXT NOT NULL,
        teams_team_id TEXT NOT NULL,
        teams_channel_id TEXT NOT NULL,
        teams_message_id TEXT NOT NULL,
        is_thread_root INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (mapping_id) REFERENCES channel_mappings (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mm_slack ON message_mappings (slack_channel_id, slack_message_ts);
      CREATE INDEX IF NOT EXISTS idx_mm_teams ON message_mappings (teams_channel_id, teams_message_id);
      CREATE INDEX IF NOT EXISTS idx_mm_created ON message_mappings (created_at);

      CREATE TABLE IF NOT EXISTS user_cache (
        platform TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_url TEXT,
        email TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (platform, platform_id)
      );
    `);
  },

  // 2: Persist Teams Bot Framework service URLs (region-specific) learned from inbound activities.
  (db) => {
    db.exec(`
      CREATE TABLE teams_conversations (
        conversation_id TEXT PRIMARY KEY,
        team_id TEXT,
        tenant_id TEXT,
        service_url TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_tc_team ON teams_conversations (team_id);
      CREATE INDEX idx_tc_updated ON teams_conversations (updated_at);
    `);
  },

  // 3: Track which platform a message was written on (edits/deletes only flow from the origin),
  // and the Teams thread root for replies (needed to address them when editing/deleting).
  (db) => {
    db.exec(`
      ALTER TABLE message_mappings ADD COLUMN origin_platform TEXT;
      ALTER TABLE message_mappings ADD COLUMN teams_root_message_id TEXT;
    `);
  },

  // 4: Reaction mirroring. Per-user reactions (for refcounting and "who reacted"), the source
  // content needed to re-render bridge-posted Teams messages with a reaction footer, and the
  // id of the single reaction notice posted for Teams-authored messages.
  (db) => {
    db.exec(`
      ALTER TABLE message_mappings ADD COLUMN source_content TEXT;
      ALTER TABLE message_mappings ADD COLUMN source_sender TEXT;
      ALTER TABLE message_mappings ADD COLUMN teams_notice_message_id TEXT;

      CREATE TABLE reactions (
        message_mapping_id INTEGER NOT NULL,
        platform TEXT NOT NULL,
        emoji TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (message_mapping_id, platform, emoji, user_id),
        FOREIGN KEY (message_mapping_id) REFERENCES message_mappings (id) ON DELETE CASCADE
      );
    `);
  },
];

export const LATEST_SCHEMA_VERSION = migrations.length;

export interface MigrateOptions {
  /** Path of the database file, used to write a backup before upgrading an existing DB. */
  dbPath?: string;
}

/**
 * Bring the database schema up to LATEST_SCHEMA_VERSION.
 * Returns the number of migrations applied.
 */
export function runMigrations(db: DatabaseType, options: MigrateOptions = {}): number {
  const current = db.pragma('user_version', { simple: true }) as number;

  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${LATEST_SCHEMA_VERSION}). ` +
        'Refusing to start; upgrade InterBridge or restore a matching backup.'
    );
  }

  if (current === LATEST_SCHEMA_VERSION) return 0;

  backupBeforeMigrating(db, current, options.dbPath);

  for (let version = current + 1; version <= LATEST_SCHEMA_VERSION; version++) {
    const migrate = migrations[version - 1];
    db.transaction(() => {
      migrate(db);
      db.pragma(`user_version = ${version}`);
    })();
  }

  return LATEST_SCHEMA_VERSION - current;
}

/**
 * Snapshot an existing, non-empty database before changing its schema.
 * Skipped for in-memory and brand-new databases.
 */
function backupBeforeMigrating(db: DatabaseType, fromVersion: number, dbPath?: string): void {
  if (!dbPath || dbPath === ':memory:') return;

  const tableCount = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as { n: number };
  if (tableCount.n === 0) return;

  const backupPath = `${dbPath}.bak-v${fromVersion}`;
  if (fs.existsSync(backupPath)) return;

  db.prepare('VACUUM INTO ?').run(backupPath);
}
