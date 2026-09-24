/**
 * Web and API Server
 * Hosts the Teams Bot Framework webhook endpoint, Admin REST API, and Dashboard static assets.
 */

import express, { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { BridgeCore } from '../core/bridge.js';
import { SlackAdapter } from '../adapters/slack/client.js';
import { TeamsAdapter } from '../adapters/teams/client.js';
import { ChannelMapping } from '../core/types.js';

export interface ServerOptions {
  port: number;
  host: string;
  /** Password required (via HTTP Basic auth) for the admin UI and REST API */
  adminPassword: string;
  bridge: BridgeCore;
  slackAdapter?: SlackAdapter;
  teamsAdapter?: TeamsAdapter;
}

export function createWebServer(options: ServerOptions) {
  const app = express();
  const { bridge, slackAdapter, teamsAdapter } = options;

  let relayedCount = 0;
  bridge.on('message:relayed', () => {
    relayedCount++;
  });

  // 1. Teams Bot Framework Endpoint (/api/messages)
  // Must use raw body or let botbuilder adapter parse JSON
  app.post('/api/messages', async (req: Request, res: Response) => {
    if (!teamsAdapter) {
      res.status(503).json({ error: 'Teams adapter not configured' });
      return;
    }
    try {
      await teamsAdapter.processHttpRequest(req, res);
    } catch (err: any) {
      res.status(500).send(err.message);
    }
  });

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
        configured: Boolean(teamsAdapter),
        rscSupported: true,
      },
    });
  });

  // Get all channel mappings
  app.get('/api/mappings', (_req: Request, res: Response) => {
    res.json(
      bridge.db.getAllChannelMappings().map((m) => ({
        ...m,
        status: {
          // False until the bridge has seen an activity from this Teams channel (see #10)
          teamsServiceUrlKnown: bridge.db.hasTeamsServiceUrl(m.teams.channelId),
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

  // Generate Slack App Manifest JSON
  app.get('/api/manifests/slack', (_req: Request, res: Response) => {
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
          bot_events: ['message.channels', 'message.groups', 'reaction_added', 'reaction_removed'],
        },
        interactivity: { is_enabled: false },
        socket_mode_enabled: true,
      },
    };

    res.setHeader('Content-Disposition', 'attachment; filename="slack-manifest.json"');
    res.json(manifest);
  });

  // Generate Teams App Manifest / Package
  app.get('/api/manifests/teams', (req: Request, res: Response) => {
    const zipPath = path.resolve(process.cwd(), 'public', 'teams-app.zip');
    if (!req.query.json && fs.existsSync(zipPath)) {
      res.download(zipPath, 'interbridge-teams-app.zip');
      return;
    }

    const manifest = {
      $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
      manifestVersion: '1.16',
      version: '1.0.0',
      id: 'e86b2d18-508b-4a57-897d-419b48c03632',
      packageName: 'com.interbridge.teams',
      developer: {
        name: 'InterBridge Self-Hosted',
        websiteUrl: 'https://github.com/georgestephanis/slack-teams-interop',
        privacyUrl: 'https://github.com/georgestephanis/slack-teams-interop',
        termsOfUseUrl: 'https://github.com/georgestephanis/slack-teams-interop',
      },
      icons: {
        color: 'color.png',
        outline: 'outline.png',
      },
      name: {
        short: 'InterBridge',
        full: 'InterBridge Slack-Teams Interop',
      },
      description: {
        short: 'Two-way channel bridge connecting Microsoft Teams to Slack',
        full: 'Bridges messages, threads, reactions, and files between Microsoft Teams and Slack channels using Resource-Specific Consent.',
      },
      accentColor: '#6366f1',
      bots: [
        {
          botId: 'YOUR_MICROSOFT_APP_ID',
          scopes: ['team'],
          supportsFiles: true,
          isNotificationOnly: false,
        },
      ],
      authorization: {
        permissions: {
          resourceSpecific: [
            {
              name: 'ChannelMessage.Read.Group',
              type: 'Application',
            },
          ],
        },
      },
    };

    res.setHeader('Content-Disposition', 'attachment; filename="teams-manifest.json"');
    res.json(manifest);
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
