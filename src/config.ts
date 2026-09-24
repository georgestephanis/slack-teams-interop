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
  TEAMS_SERVICE_URL: z.string().default('https://smba.trafficmanager.net/amer/'),

  // Admin UI
  ADMIN_PASSWORD: z.string().min(1, 'ADMIN_PASSWORD must not be empty').default('admin'),
});

export const config = envSchema.parse(process.env);
