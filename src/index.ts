/**
 * Application Entry Point
 * Boots the Bridge Core, adapters, and HTTP management server.
 */

import { SLACK_EVENTS_PATH, SlackAdapter } from './adapters/slack/client.js';
import { TeamsAdapter } from './adapters/teams/client.js';
import { config } from './config.js';
import { BridgeCore } from './core/bridge.js';
import { MediaSigner } from './core/media.js';
import { createWebServer } from './web/server.js';

async function bootstrap() {
  console.log('🚀 Initializing InterBridge service...');

  // 1. Initialize Bridge Core & Database
  const bridge = new BridgeCore(config.DATABASE_PATH);

  // BridgeCore reports relay failures via 'error' events. Without a listener,
  // EventEmitter rethrows them, so failures went unlogged and bubbled into the
  // platform SDKs (e.g. a 500 back to Bot Framework, prompting redelivery).
  bridge.on('error', (err: unknown) => {
    console.error('❌ Bridge error:', err);
  });

  // Keep the message ID mapping table bounded (threading/reactions only need recent history).
  const pruneMessages = () => {
    try {
      const removed = bridge.db.pruneOldMessages(config.MESSAGE_RETENTION_DAYS);
      if (removed > 0) {
        console.log(`🧹 Pruned ${removed} message mappings older than ${config.MESSAGE_RETENTION_DAYS} days.`);
      }
    } catch (err: unknown) {
      console.error('❌ Failed to prune message mappings:', err);
    }
  };
  pruneMessages();
  const pruneTimer = setInterval(pruneMessages, 24 * 60 * 60 * 1000);
  pruneTimer.unref();

  // 2. Initialize Slack Adapter (if configured)
  let mediaSigner: MediaSigner | undefined;
  if (config.MEDIA_PROXY_SECRET && config.PUBLIC_URL) {
    mediaSigner = new MediaSigner(config.MEDIA_PROXY_SECRET, config.PUBLIC_URL);
  } else if (config.MEDIA_PROXY_SECRET) {
    console.warn('⚠️ MEDIA_PROXY_SECRET is set but PUBLIC_URL is not; Slack images will be relayed to Teams as links.');
  }

  let slackAdapter: SlackAdapter | undefined;
  if (config.SLACK_BOT_TOKEN) {
    console.log('⚡ Starting Slack adapter...');
    try {
      const adapter = new SlackAdapter(
        {
          botToken: config.SLACK_BOT_TOKEN,
          appToken: config.SLACK_APP_TOKEN,
          signingSecret: config.SLACK_SIGNING_SECRET,
          useSocketMode: config.SLACK_USE_SOCKET_MODE,
          mediaSigner,
        },
        bridge
      );
      await adapter.start();
      slackAdapter = adapter;
      bridge.registerAdapter(slackAdapter);
      console.log('✅ Slack adapter connected successfully.');
    } catch (err: unknown) {
      console.warn('⚠️ Slack adapter failed to connect:', err);
    }
  } else {
    console.log('ℹ️ No SLACK_BOT_TOKEN provided. Running in configuration/API mode.');
  }

  // 3. Initialize Teams Adapter (if configured)
  let teamsAdapter: TeamsAdapter | undefined;
  if (config.TEAMS_APP_ID) {
    console.log('⚡ Starting Teams adapter...');
    teamsAdapter = new TeamsAdapter(
      {
        appId: config.TEAMS_APP_ID,
        appPassword: config.TEAMS_APP_PASSWORD,
        appTenantId: config.TEAMS_TENANT_ID,
        appType: config.TEAMS_APP_TYPE,
        serviceUrl: config.TEAMS_SERVICE_URL,
      },
      bridge
    );
    bridge.registerAdapter(teamsAdapter);
    console.log('✅ Teams adapter initialized and listening for activities.');
  } else {
    console.log('ℹ️ No TEAMS_APP_ID provided. Running in configuration/API mode.');
  }

  if (config.ADMIN_PASSWORD === 'admin') {
    console.warn('⚠️ ADMIN_PASSWORD is set to the default "admin". Change it before exposing this service.');
  }

  // 4. Start Web & API Server
  const app = createWebServer({
    port: config.PORT,
    host: config.HOST,
    adminPassword: config.ADMIN_PASSWORD,
    bridge,
    publicUrl: config.PUBLIC_URL,
    slackSocketMode: config.SLACK_USE_SOCKET_MODE,
    mediaSigner,
    slackAdapter,
    teamsAdapter,
  });

  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`🌐 InterBridge Admin UI & API listening on http://${config.HOST}:${config.PORT}`);
    console.log(`📡 Teams Bot Framework Webhook available at http://${config.HOST}:${config.PORT}/api/messages`);
    if (slackAdapter?.httpRouter) {
      console.log(`📡 Slack Events API endpoint available at http://${config.HOST}:${config.PORT}${SLACK_EVENTS_PATH}`);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
    clearInterval(pruneTimer);
    server.close(() => {
      bridge.db.close();
      console.log('Database and server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
