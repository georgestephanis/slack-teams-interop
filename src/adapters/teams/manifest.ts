/**
 * Teams App Manifest
 * Builds the Teams app package (manifest.json plus icons) for a specific Azure Bot, so each
 * connection gets a package that installs as-is.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createZip } from '../../web/zip.js';

const PLACEHOLDER_BOT_ID = 'YOUR_AZURE_BOT_APP_ID';

/**
 * Teams app id for a bot. Deterministic, so re-downloading a connection's package updates the
 * installed app instead of adding a second copy, and distinct per bot.
 */
export function teamsAppIdFor(botAppId: string): string {
  const hex = crypto.createHash('sha256').update(`interbridge-teams-app:${botAppId}`).digest('hex');
  // Format as a version-4-shaped UUID (the manifest schema only checks the GUID pattern)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface TeamsManifestOptions {
  /** Azure Bot Microsoft App ID; omitted for the placeholder template */
  botAppId?: string;
  /** Connection display name, appended to the app's full name */
  connectionName?: string;
}

export function buildTeamsManifest(options: TeamsManifestOptions = {}): Record<string, unknown> {
  const botId = options.botAppId || PLACEHOLDER_BOT_ID;
  return {
    $schema: 'https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json',
    manifestVersion: '1.16',
    version: '1.0.0',
    id: options.botAppId ? teamsAppIdFor(options.botAppId) : 'e86b2d18-508b-4a57-897d-419b48c03632',
    packageName: 'com.interbridge.teams',
    developer: {
      name: 'InterBridge Self-Hosted',
      websiteUrl: 'https://github.com/georgestephanis/slack-teams-interop',
      privacyUrl: 'https://github.com/georgestephanis/slack-teams-interop/blob/trunk/SECURITY.md',
      termsOfUseUrl: 'https://github.com/georgestephanis/slack-teams-interop/blob/trunk/LICENSE',
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
    accentColor: '#4338CA',
    bots: [
      {
        botId,
        scopes: ['team'],
        supportsFiles: true,
        isNotificationOnly: false,
      },
    ],
    // Resource-specific consent identifies the app by its Entra app id (the bot's App ID)
    webApplicationInfo: {
      id: botId,
      resource: 'https://interbridge.invalid/rsc',
    },
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
    validDomains: ['*.trafficmanager.net', '*.botframework.com'],
  };
}

/** Zip of manifest.json, color.png and outline.png at the top level, ready to upload to Teams. */
export function buildTeamsAppPackage(options: TeamsManifestOptions, iconDir = path.resolve(process.cwd(), 'manifests', 'teams')): Buffer {
  return createZip([
    { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(buildTeamsManifest(options), null, 2)}\n`) },
    { name: 'color.png', data: fs.readFileSync(path.join(iconDir, 'color.png')) },
    { name: 'outline.png', data: fs.readFileSync(path.join(iconDir, 'outline.png')) },
  ]);
}
