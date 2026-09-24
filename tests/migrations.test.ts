import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { BridgeDatabase } from '../src/db/index.js';
import { LATEST_SCHEMA_VERSION, runMigrations } from '../src/db/migrations.js';

const testDbPath = './data/test-migrations.sqlite';

function cleanup() {
  for (const f of fs.readdirSync('./data').filter((f) => f.startsWith('test-migrations.sqlite'))) {
    fs.unlinkSync(`./data/${f}`);
  }
}

/** Create a database the way pre-migration builds did: tables present, user_version = 0. */
function createLegacyDb() {
  const raw = new Database(testDbPath);
  raw.exec(`
    CREATE TABLE channel_mappings (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      slack_channel_id TEXT NOT NULL, slack_channel_name TEXT,
      teams_team_id TEXT NOT NULL, teams_channel_id TEXT NOT NULL,
      teams_team_name TEXT, teams_channel_name TEXT, options TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  raw
    .prepare(
      `INSERT INTO channel_mappings (id, name, slack_channel_id, teams_team_id, teams_channel_id, options)
       VALUES ('legacy', 'Legacy', 'C1', 'T1', '19:x', ?)`
    )
    .run(JSON.stringify({ syncThreads: false, teamsFormatStyle: 'clean_markdown' }));
  raw.close();
}

describe('Schema migrations', () => {
  beforeEach(() => {
    fs.mkdirSync('./data', { recursive: true });
    cleanup();
  });
  afterEach(cleanup);

  it('creates a fresh database at the latest version without a backup', () => {
    const db = new BridgeDatabase(testDbPath);
    db.close();

    const raw = new Database(testDbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    raw.close();
    expect(fs.existsSync(`${testDbPath}.bak-v0`)).toBe(false);
  });

  it('upgrades a pre-migration database, preserving rows and writing a backup', () => {
    createLegacyDb();

    const db = new BridgeDatabase(testDbPath);
    const mapping = db.getChannelMapping('legacy');
    db.close();

    expect(mapping?.name).toBe('Legacy');
    expect(fs.existsSync(`${testDbPath}.bak-v0`)).toBe(true);

    const raw = new Database(testDbPath);
    expect(raw.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    raw.close();
  });

  it('fills in defaults for option keys missing from stored mappings', () => {
    createLegacyDb();

    const db = new BridgeDatabase(testDbPath);
    const mapping = db.getChannelMapping('legacy');
    db.close();

    expect(mapping?.options.syncThreads).toBe(false); // stored value wins
    expect(mapping?.options.teamsFormatStyle).toBe('clean_markdown');
    expect(mapping?.options.syncReactions).toBe(true); // default filled in
  });

  it('is idempotent', () => {
    const raw = new Database(testDbPath);
    expect(runMigrations(raw, { dbPath: testDbPath })).toBe(LATEST_SCHEMA_VERSION);
    expect(runMigrations(raw, { dbPath: testDbPath })).toBe(0);
    raw.close();
  });

  it('refuses to open a database from a newer build', () => {
    const raw = new Database(testDbPath);
    raw.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`);
    raw.close();

    expect(() => new BridgeDatabase(testDbPath)).toThrow(/newer than this build supports/);
  });
});
