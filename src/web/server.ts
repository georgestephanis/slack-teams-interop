/**
 * Web and API Server
 * Hosts the Teams Bot Framework webhook endpoint, Admin REST API, and Dashboard static assets.
 */

import express, { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { BridgeCore } from '../core/bridge.js';
import { MAX_TRANSFER_BYTES, MEDIA_PROXY_PATH, MediaSigner } from '../core/media.js';
import { SLACK_EVENTS_PATH, SlackAdapter } from '../adapters/slack/client.js';
import { TeamsAdapter } from '../adapters/teams/client.js';
import { TeamsConnectionError, TeamsConnectionInput, TeamsConnectionStore } from '../adapters/teams/connections.js';
import { buildTeamsAppPackage, buildTeamsManifest } from '../adapters/teams/manifest.js';
import { ChannelMapping } from '../core/types.js';

export interface ServerOptions {
  port: number;
  host: string;
  /** Password required (via HTTP Basic auth) for the admin UI and REST API */
  adminPassword: string;
  bridge: BridgeCore;
  /** Public base URL, used for the Slack Request URL in generated manifests */
  publicUrl?: string;
  /** Whether the Slack app is configured for Socket Mode (affects the generated manifest) */
  slackSocketMode?: boolean;
  slackAdapter?: SlackAdapter;
  teamsAdapter?: TeamsAdapter;
  /** Teams connections stored in the database (one Azure Bot per Microsoft 365 tenant) */
  teamsConnections?: TeamsConnectionStore;
  /** Enables the signed Slack image proxy (needs MEDIA_PROXY_SECRET and PUBLIC_URL) */
  mediaSigner?: MediaSigner;
}

export function createWebServer(options: ServerOptions) {
  const app = express();
  const { bridge, slackAdapter, teamsAdapter, teamsConnections } = options;

  let relayedCount = 0;
  bridge.on('message:relayed', () => {
    relayedCount++;
  });

  // 1. Teams Bot Framework Endpoints. `/api/messages` serves the TEAMS_APP_ID connection;
  // `/api/messages/<connectionId>` serves any connection, so each tenant's Azure Bot gets its own
  // messaging endpoint. Authenticated by the connection's Bot Framework adapter (Azure JWT), not
  // admin auth. CloudAdapter requires an already-parsed JSON body, and the global express.json()
  // is mounted after admin auth, so these routes need their own parser.
  const teamsBody = express.json({ limit: '1mb' });
  const handleTeamsWebhook = async (req: Request, res: Response, connectionId?: string) => {
    if (!teamsAdapter || teamsAdapter.connectionCount === 0) {
      res.status(503).json({ error: 'Teams adapter not configured' });
      return;
    }
    const id = connectionId ?? teamsAdapter.defaultConnectionId;
    if (!teamsAdapter.hasConnection(id)) {
      res.status(404).json({ error: 'Unknown Teams connection' });
      return;
    }
    try {
      await teamsAdapter.processHttpRequest(req, res, id);
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  };
  app.post('/api/messages', teamsBody, (req: Request, res: Response) => handleTeamsWebhook(req, res));
  app.post('/api/messages/:connectionId', teamsBody, (req: Request, res: Response) =>
    handleTeamsWebhook(req, res, String(req.params.connectionId))
  );

  // Slack Events API endpoint (HTTP mode only). Authenticated by Slack's signing secret, and
  // must see the raw body, so it is mounted before admin auth and express.json().
  if (slackAdapter?.httpRouter) {
    app.use(slackAdapter.httpRouter);
  }

  // Signed Slack image proxy, so Teams can show Slack images inline. Authorized by the URL's
  // signature rather than the admin password, because Teams clients load these images directly.
  if (options.mediaSigner && slackAdapter) {
    const signer = options.mediaSigner;
    app.get(`${MEDIA_PROXY_PATH}/:token`, async (req: Request, res: Response) => {
      const fileUrl = signer.verify(String(req.params.token));
      if (!fileUrl) {
        res.status(404).end();
        return;
      }

      try {
        const upstream = await slackAdapter.fetchPrivateFile(fileUrl);
        const type = upstream.headers.get('content-type') || '';
        const length = Number(upstream.headers.get('content-length') || 0);
        // Only raster images; SVG can carry script
        if (!upstream.ok || !type.startsWith('image/') || type.startsWith('image/svg')) {
          res.status(upstream.status === 404 ? 404 : 502).end();
          return;
        }
        if (length > MAX_TRANSFER_BYTES) {
          res.status(413).end();
          return;
        }

        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.length > MAX_TRANSFER_BYTES) {
          res.status(413).end();
          return;
        }
        res.set({
          'Content-Type': type,
          'Cache-Control': 'private, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        });
        res.send(body);
      } catch (err) {
        bridge.emit('error', err);
        res.status(502).end();
      }
    });
  }

  // Unauthenticated liveness probe (used by the Docker healthcheck)
  app.get('/api/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Everything below is admin surface: require HTTP Basic auth with ADMIN_PASSWORD.
  // The server must be publicly reachable for the Teams webhook, so this cannot be left open.
  app.use(requireAdminAuth(options.adminPassword));

  // Standard JSON body parsing for API endpoints
  app.use(express.json());

  // Serve static UI assets
  const publicDir = path.resolve(process.cwd(), 'public');
  app.use(express.static(publicDir));

  // --- REST API ---

  // Health and metrics
  app.get('/api/health', (_req: Request, res: Response) => {
    const mappings = bridge.db.getAllChannelMappings();
    const activeBridges = mappings.filter((m) => m.enabled).length;

    res.json({
      status: 'ok',
      uptime: process.uptime(),
      relayedMessages: relayedCount,
      activeBridges,
      slack: {
        configured: Boolean(slackAdapter),
        connected: slackAdapter?.connected ?? false,
        socketMode: slackAdapter?.socketMode ?? false,
      },
      teams: {
        configured: Boolean(teamsAdapter && teamsAdapter.connectionCount > 0),
        connections: teamsAdapter?.connectionCount ?? 0,
        rscSupported: true,
      },
    });
  });

  // Get all channel mappings
  app.get('/api/mappings', (_req: Request, res: Response) => {
    const knownTeamsChannels = bridge.db.getKnownTeamsConversationIds();
    res.json(
      bridge.db.getAllChannelMappings().map((m) => ({
        ...m,
        status: {
          // False until the bridge has seen an activity from this Teams channel (see #10)
          teamsServiceUrlKnown: knownTeamsChannels.has(m.teams.channelId),
        },
      }))
    );
  });

  // Create or update mapping
  app.post('/api/mappings', (req: Request, res: Response) => {
    const data = req.body as ChannelMapping;
    if (!data.id || !data.name || !data.slack?.channelId || !data.teams?.channelId) {
      res.status(400).json({ error: 'Missing required mapping fields' });
      return;
    }
    const connectionId = data.teams.connectionId || undefined;
    if (connectionId && !teamsConnections?.exists(connectionId)) {
      res.status(400).json({ error: `Unknown Teams connection: ${connectionId}` });
      return;
    }
    // Without TEAMS_APP_ID there's no default connection to fall back to
    if (!connectionId && teamsAdapter && teamsConnections?.list().length && !teamsConnections.exists(teamsAdapter.defaultConnectionId)) {
      res.status(400).json({ error: 'Choose the Teams connection this channel belongs to' });
      return;
    }
    // One Teams channel belongs to exactly one tenant, so it may only be bridged through one connection
    const existing = bridge.db.findMappingByTeamsChannel(data.teams.channelId);
    if (existing && existing.id !== data.id && (existing.teams.connectionId || undefined) !== connectionId) {
      res.status(409).json({ error: 'This Teams channel is already bridged through a different connection' });
      return;
    }
    data.teams.connectionId = connectionId;
    bridge.db.saveChannelMapping(data);
    res.status(201).json(data);
  });

  // Delete mapping
  app.delete('/api/mappings/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const deleted = bridge.db.deleteChannelMapping(id);
    if (deleted) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Mapping not found' });
    }
  });

  // Test diagnostic message across a channel bridge
  app.post('/api/mappings/:id/test', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    const mapping = bridge.db.getChannelMapping(id);
    if (!mapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    try {
      // Send diagnostic message to Slack
      if (slackAdapter) {
        await slackAdapter.sendMessage(
          mapping.slack.channelId,
          {
            id: `test-${Date.now()}`,
            sourcePlatform: 'teams',
            sourceChannelId: mapping.teams.channelId,
            sourceMessageId: `${Date.now()}`,
            sender: {
              platformId: 'bridge-system',
              displayName: 'Bridge Diagnostic',
              platform: 'teams',
            },
            content: `*InterBridge Connection Test*: Two-way sync is active between Slack <-> Microsoft Teams.`,
            timestamp: new Date(),
          },
          mapping
        );
      }

      res.json({ success: true, message: 'Diagnostic message dispatched to Slack' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Teams connections (one Azure Bot per Microsoft 365 tenant) ---

  const sendConnectionError = (res: Response, err: unknown) => {
    if (err instanceof TeamsConnectionError) {
      res.status(err.status).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };

  // List connections with their webhook URL and usage. Secrets are never returned.
  app.get('/api/teams-connections', (_req: Request, res: Response) => {
    if (!teamsConnections) {
      res.json({ canStore: false, connections: [] });
      return;
    }
    const base = options.publicUrl || '';
    res.json({
      canStore: teamsConnections.canStore,
      connections: teamsConnections.list().map((c) => ({
        ...c,
        messagingEndpoint: `${base}/api/messages/${c.id}`,
        bridges: bridge.db.countMappingsForTeamsConnection(c.id, c.id === teamsAdapter?.defaultConnectionId),
        lastActivityAt: c.tenantId ? bridge.db.lastTeamsActivityForTenant(c.tenantId) : undefined,
      })),
    });
  });

  // Create or update a connection (omit appPassword on update to keep the stored secret)
  app.post('/api/teams-connections', (req: Request, res: Response) => {
    if (!teamsConnections) {
      res.status(503).json({ error: 'Teams connections are unavailable' });
      return;
    }
    try {
      res.status(201).json(teamsConnections.save(req.body as TeamsConnectionInput));
    } catch (err) {
      sendConnectionError(res, err);
    }
  });

  app.delete('/api/teams-connections/:id', (req: Request, res: Response) => {
    try {
      if (!teamsConnections) throw new TeamsConnectionError('connection not found', 404);
      teamsConnections.delete(String(req.params.id));
      res.json({ success: true });
    } catch (err) {
      sendConnectionError(res, err);
    }
  });

  // Check credentials by requesting a Bot Framework token (does not contact Teams itself)
  app.post('/api/teams-connections/:id/test', async (req: Request, res: Response) => {
    try {
      if (!teamsConnections) throw new TeamsConnectionError('connection not found', 404);
      await teamsConnections.test(String(req.params.id));
      res.json({ success: true, message: 'Credentials accepted by Microsoft' });
    } catch (err) {
      if (err instanceof TeamsConnectionError) sendConnectionError(res, err);
      else res.status(502).json({ error: `Credentials rejected: ${err instanceof Error ? err.message : String(err)}` });
    }
  });

  // Generate Slack App Manifest JSON
  app.get('/api/manifests/slack', (req: Request, res: Response) => {
    // ?mode=http|socket overrides the running configuration
    const socketMode =
      req.query.mode === 'http' ? false : req.query.mode === 'socket' ? true : options.slackSocketMode ?? true;
    const requestUrl = `${options.publicUrl || 'https://YOUR_PUBLIC_HOST'}${SLACK_EVENTS_PATH}`;

    const manifest = {
      display_information: {
        name: 'InterBridge (Slack-Teams)',
        description: 'Two-way channel bridge connecting Slack to Microsoft Teams',
        background_color: '#4338ca',
      },
      features: {
        bot_user: {
          display_name: 'InterBridge',
          always_online: true,
        },
      },
      oauth_config: {
        scopes: {
          bot: [
            'chat:write',
            'chat:write.customize',
            'channels:history',
            'groups:history',
            'files:read',
            'files:write',
            'reactions:read',
            'reactions:write',
            'users:read',
          ],
        },
      },
      settings: {
        event_subscriptions: {
          ...(socketMode ? {} : { request_url: requestUrl }),
          bot_events: ['message.channels', 'message.groups', 'reaction_added', 'reaction_removed'],
        },
        interactivity: { is_enabled: false },
        socket_mode_enabled: socketMode,
      },
    };

    res.setHeader('Content-Disposition', 'attachment; filename="slack-manifest.json"');
    res.json(manifest);
  });

  // Generate Teams App Manifest / Package. `?connection=<id>` builds it for that connection's
  // bot (defaults to the TEAMS_APP_ID connection), so it installs as-is. With no connection
  // configured, serves the placeholder template. `?json=1` returns just the manifest.
  app.get('/api/manifests/teams', (req: Request, res: Response) => {
    const connectionId = req.query.connection ? String(req.query.connection) : teamsAdapter?.defaultConnectionId;
    const connection = teamsConnections?.list().find((c) => c.id === connectionId);
    if (req.query.connection && !connection) {
      res.status(404).json({ error: 'Unknown Teams connection' });
      return;
    }
    const manifestOptions = connection ? { botAppId: connection.appId, connectionName: connection.name } : {};

    if (req.query.json) {
      res.setHeader('Content-Disposition', 'attachment; filename="teams-manifest.json"');
      res.json(buildTeamsManifest(manifestOptions));
      return;
    }

    const filename = connection ? `interbridge-teams-app-${connection.id}.zip` : 'interbridge-teams-app.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buildTeamsAppPackage(manifestOptions));
  });

  return app;
}

/**
 * HTTP Basic auth guard. Any username is accepted; the password must match ADMIN_PASSWORD.
 */
function requireAdminAuth(adminPassword: string) {
  if (!adminPassword || adminPassword.trim().length === 0) {
    throw new Error('ADMIN_PASSWORD must not be empty');
  }

  const expected = crypto.createHash('sha256').update(adminPassword).digest();

  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const match = header.match(/^Basic\s+(.+)$/i);
    if (match) {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx !== -1) {
        const password = decoded.slice(colonIdx + 1);
        const actual = crypto.createHash('sha256').update(password).digest();
        if (crypto.timingSafeEqual(actual, expected)) {
          next();
          return;
        }
      }
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="InterBridge Admin", charset="UTF-8"');
    res.status(401).json({ error: 'Authentication required' });
  };
}
