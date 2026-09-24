/**
 * Configuration & Environment Variables
 */

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().default(3978),
  HOST: z.string().default('0.0.0.0'),
  // Public base URL of this service (e.g. https://bridge.example.com), used in generated manifests
  PUBLIC_URL: z
    .string()
    .optional()
    .transform((val) => (val ? val.replace(/\/+$/, '') : undefined)),
  // Enables showing Slack images inline in Teams via signed proxy URLs (/media/slack/...). Anyone with
  // such a link can view that image; rotating this secret revokes all of them. Requires PUBLIC_URL.
  MEDIA_PROXY_SECRET: z.string().min(32, 'MEDIA_PROXY_SECRET must be at least 32 characters').optional(),
  DATABASE_PATH: z.string().default('./data/bridge.sqlite'),
  MESSAGE_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(30),

  // Slack Configuration
  SLACK_BOT_TOKEN: z.string().optional(),
  SLACK_APP_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),
  SLACK_USE_SOCKET_MODE: z
    .string()
    .transform((val) => val === 'true')
    .default(true),

  // Microsoft Teams / Azure Bot Configuration
  TEAMS_APP_ID: z.string().optional(),
  TEAMS_APP_PASSWORD: z.string().optional(),
  TEAMS_TENANT_ID: z.string().optional(),
  // Azure Bot registration type. New bots are SingleTenant; MultiTenant is kept for older registrations.
  TEAMS_APP_TYPE: z.enum(['SingleTenant', 'MultiTenant']).default('MultiTenant'),
  TEAMS_SERVICE_URL: z.string().default('https://smba.trafficmanager.net/amer/'),

  // Admin UI
  ADMIN_PASSWORD: z.string().min(1, 'ADMIN_PASSWORD must not be empty').default('admin'),
});

export const config = envSchema
  .refine((c) => c.TEAMS_APP_TYPE !== 'SingleTenant' || !c.TEAMS_APP_ID || Boolean(c.TEAMS_TENANT_ID), {
    message: 'TEAMS_APP_TYPE=SingleTenant requires TEAMS_TENANT_ID',
    path: ['TEAMS_TENANT_ID'],
  })
  .parse(process.env);
