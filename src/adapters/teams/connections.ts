/**
 * Teams Connection Store
 * Manages the Teams connections kept in the database (one Azure Bot each, usually one per
 * Microsoft 365 tenant): validates and encrypts them, and keeps the TeamsAdapter in sync so
 * changes take effect without a restart. The TEAMS_APP_ID connection lives in env, not here.
 */

import { CredentialCipher } from '../../core/credentials.js';
import { BridgeDatabase, TeamsConnectionRecord } from '../../db/index.js';
import { TeamsAdapter, teamsCredentials } from './client.js';

/** What the admin API accepts when creating or updating a connection. */
export interface TeamsConnectionInput {
  id: string;
  name: string;
  appId: string;
  /** Required when creating; omit on update to keep the stored secret */
  appPassword?: string;
  tenantId?: string;
  appType?: 'SingleTenant' | 'MultiTenant';
  serviceUrl?: string;
  secretExpiresAt?: string;
  enabled?: boolean;
}

/** A connection as reported to the admin API. Never includes the secret. */
export interface TeamsConnectionSummary {
  id: string;
  name: string;
  appId: string;
  tenantId?: string;
  appType: 'SingleTenant' | 'MultiTenant';
  serviceUrl?: string;
  secretExpiresAt?: string;
  enabled: boolean;
  /** 'env' for the TEAMS_APP_ID connection (read-only here), 'db' for ones managed in the dashboard */
  source: 'env' | 'db';
  /** Whether the adapter is currently receiving and posting for it */
  active: boolean;
}

export class TeamsConnectionError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

/** Connection ids appear in webhook URLs and mappings: keep them short, lowercase slugs. */
export const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class TeamsConnectionStore {
  constructor(
    private db: BridgeDatabase,
    private adapter: TeamsAdapter,
    /** Without CREDENTIALS_KEY, stored connections can't be read or saved */
    private cipher?: CredentialCipher,
    /** The TEAMS_APP_ID connection, if configured */
    private envConnection?: { id: string; appId: string; tenantId?: string; appType: 'SingleTenant' | 'MultiTenant' }
  ) {}

  get canStore(): boolean {
    return Boolean(this.cipher);
  }

  /**
   * Register every enabled stored connection with the adapter. Returns the ids that failed (for
   * example, secrets encrypted with a different CREDENTIALS_KEY); the rest still load.
   */
  loadAll(): { loaded: string[]; failed: { id: string; error: string }[] } {
    const loaded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const record of this.db.getAllTeamsConnections()) {
      if (!record.enabled) continue;
      try {
        this.activate(record);
        loaded.push(record.id);
      } catch (err) {
        failed.push({ id: record.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { loaded, failed };
  }

  /** Every connection the bridge knows about: env first, then stored ones. */
  list(): TeamsConnectionSummary[] {
    const out: TeamsConnectionSummary[] = [];
    if (this.envConnection) {
      out.push({
        id: this.envConnection.id,
        name: 'Environment (TEAMS_APP_ID)',
        appId: this.envConnection.appId,
        tenantId: this.envConnection.tenantId,
        appType: this.envConnection.appType,
        enabled: true,
        source: 'env',
        active: this.adapter.hasConnection(this.envConnection.id),
      });
    }
    for (const r of this.db.getAllTeamsConnections()) {
      out.push({
        id: r.id,
        name: r.name,
        appId: r.appId,
        tenantId: r.tenantId,
        appType: r.appType,
        serviceUrl: r.serviceUrl,
        secretExpiresAt: r.secretExpiresAt,
        enabled: r.enabled,
        source: 'db',
        active: this.adapter.hasConnection(r.id),
      });
    }
    return out;
  }

  /** True if a mapping may reference this connection id. */
  exists(id: string): boolean {
    return this.envConnection?.id === id || Boolean(this.db.getTeamsConnection(id));
  }

  /** Create or update a stored connection, then apply it to the adapter. */
  save(input: TeamsConnectionInput): TeamsConnectionSummary {
    const cipher = this.requireCipher();
    const id = (input.id || '').trim();
    if (!CONNECTION_ID_PATTERN.test(id)) {
      throw new TeamsConnectionError('id must be a lowercase slug (letters, digits, hyphens)', 400);
    }
    if (id === this.envConnection?.id) {
      throw new TeamsConnectionError(`"${id}" is the TEAMS_APP_ID connection; change it in the environment`, 409);
    }
    if (!input.name?.trim() || !input.appId?.trim()) {
      throw new TeamsConnectionError('name and appId are required', 400);
    }
    const appType = input.appType ?? 'SingleTenant';
    if (appType !== 'SingleTenant' && appType !== 'MultiTenant') {
      throw new TeamsConnectionError('appType must be SingleTenant or MultiTenant', 400);
    }
    if (appType === 'SingleTenant' && !input.tenantId?.trim()) {
      throw new TeamsConnectionError('tenantId is required for SingleTenant bots', 400);
    }
    if (input.secretExpiresAt && Number.isNaN(Date.parse(input.secretExpiresAt))) {
      throw new TeamsConnectionError('secretExpiresAt must be a date', 400);
    }

    const existing = this.db.getTeamsConnection(id);
    if (!existing && !input.appPassword) {
      throw new TeamsConnectionError('appPassword is required for a new connection', 400);
    }
    const appId = input.appId.trim();
    const clash = this.db.getAllTeamsConnections().find((c) => c.appId === appId && c.id !== id);
    if (clash || (this.envConnection?.appId === appId)) {
      throw new TeamsConnectionError('another connection already uses this appId', 409);
    }

    const record: TeamsConnectionRecord = {
      id,
      name: input.name.trim(),
      appId,
      appPasswordEnc: input.appPassword ? cipher.encrypt(input.appPassword) : existing!.appPasswordEnc,
      tenantId: input.tenantId?.trim() || undefined,
      appType,
      serviceUrl: input.serviceUrl?.trim() || undefined,
      secretExpiresAt: input.secretExpiresAt || undefined,
      enabled: input.enabled ?? true,
    };

    // Build the adapter first, so an invalid config is rejected before it's stored
    if (record.enabled) this.activate(record);
    else this.adapter.removeConnection(id);
    this.db.saveTeamsConnection(record);

    return this.list().find((c) => c.id === id)!;
  }

  /** Delete a stored connection. Refused while channel bridges still use it. */
  delete(id: string): void {
    if (id === this.envConnection?.id) {
      throw new TeamsConnectionError('the TEAMS_APP_ID connection is configured in the environment', 409);
    }
    if (!this.db.getTeamsConnection(id)) throw new TeamsConnectionError('connection not found', 404);
    const inUse = this.db.countMappingsForTeamsConnection(id);
    if (inUse > 0) {
      throw new TeamsConnectionError(`${inUse} channel bridge(s) still use this connection; delete them first`, 409);
    }
    this.adapter.removeConnection(id);
    this.db.deleteTeamsConnection(id);
  }

  /** Check a connection's credentials by requesting a Bot Framework token. */
  async test(id: string): Promise<void> {
    const record = this.db.getTeamsConnection(id);
    if (!record) {
      if (id === this.envConnection?.id) {
        throw new TeamsConnectionError('test the TEAMS_APP_ID connection by restarting with its credentials', 400);
      }
      throw new TeamsConnectionError('connection not found', 404);
    }
    await teamsCredentials({
      appId: record.appId,
      appPassword: this.requireCipher().decrypt(record.appPasswordEnc),
      appTenantId: record.tenantId,
      appType: record.appType,
    }).getToken(true);
  }

  private activate(record: TeamsConnectionRecord): void {
    this.adapter.addConnection({
      id: record.id,
      name: record.name,
      appId: record.appId,
      appPassword: this.requireCipher().decrypt(record.appPasswordEnc),
      appTenantId: record.tenantId,
      appType: record.appType,
      serviceUrl: record.serviceUrl,
    });
  }

  private requireCipher(): CredentialCipher {
    if (!this.cipher) {
      throw new TeamsConnectionError('set CREDENTIALS_KEY to store Teams connections in the database', 503);
    }
    return this.cipher;
  }
}
