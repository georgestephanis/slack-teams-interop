/**
 * Application Entry Point
 * Boots the Bridge Core, adapters, and HTTP management server.
 */

import { SlackAdapter } from './adapters/slack/client.js';
import { TeamsAdapter } from './adapters/teams/client.js';
import { config } from './config.js';
import { BridgeCore } from './core/bridge.js';
import { createWebServer } from './web/server.js';

async function bootstrap() {
  console.log('🚀 Initializing InterBridge service...');

  // 1. Initialize Bridge Core & Database
  const bridge = new BridgeCore(config.DATABASE_PATH);

  // 2. Initialize Slack Adapter (if configured)
  let slackAdapter: SlackAdapter | undefined;
  if (config.SLACK_BOT_TOKEN) {
    console.log('⚡ Starting Slack adapter...');
    try {
      slackAdapter = new SlackAdapter(
        {
          botToken: config.SLACK_BOT_TOKEN,
          appToken: config.SLACK_APP_TOKEN,
          signingSecret: config.SLACK_SIGNING_SECRET,
          useSocketMode: config.SLACK_USE_SOCKET_MODE,
        },
        bridge
      );
      bridge.registerAdapter(slackAdapter);
      await slackAdapter.start();
      console.log('✅ Slack adapter connected successfully.');
    } catch (err: any) {
      console.warn(`⚠️ Slack adapter failed to connect: ${err.message}`);
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
        serviceUrl: config.TEAMS_SERVICE_URL,
      },
      bridge
    );
    bridge.registerAdapter(teamsAdapter);
    console.log('✅ Teams adapter initialized and listening for activities.');
  } else {
    console.log('ℹ️ No TEAMS_APP_ID provided. Running in configuration/API mode.');
  }

  // 4. Start Web & API Server
  const app = createWebServer({
    port: config.PORT,
    host: config.HOST,
    bridge,
    slackAdapter,
    teamsAdapter,
  });

  const server = app.listen(config.PORT, config.HOST, () => {
    console.log(`🌐 InterBridge Admin UI & API listening on http://${config.HOST}:${config.PORT}`);
    console.log(`📡 Teams Bot Framework Webhook available at http://${config.HOST}:${config.PORT}/api/messages`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nShutting down gracefully...');
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
