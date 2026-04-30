import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PREFIX: z.string().default('api'),
  API_VERSION: z.string().default('v1'),
  SECURITY_ENABLE_CORS: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  AUTH_REQUIRED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  AUTH_DEV_STATIC_TOKEN: z.string().min(8).default('dev-static-token'),
  AUTH_DEV_ACTOR_ID: z.string().min(1).default('dev-owner'),
  AUTH_DEV_DEFAULT_STORE_ID: z.string().min(1).default('dev-store'),
  AUTH_DEV_VERIFIED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  AUTH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  FEATURE_FLAG_PRODUCTS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  FEATURE_FLAG_FINANCE_V2_SUMMARY_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  FINANCE_V2_ALLOWED_CONSUMERS: z.string().default(''),
  FINANCE_V2_USAGE_LOG_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  FINANCE_V2_DIFF_LOG_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  FINANCE_V2_DIFF_ALERT_THRESHOLD: z.coerce.number().min(0).default(0.01),
  MONGODB_URI: z.string().min(1).default('mongodb://localhost:27017'),
  MONGODB_DB_NAME: z.string().min(1).default('stockflow'),
  MONGODB_APP_NAME: z.string().default('stockflow-backend'),
  MONGODB_MIN_POOL_SIZE: z.coerce.number().int().min(0).default(1),
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).default(10),
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  MONGODB_SOCKET_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  USE_MONGO_READS: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  SHADOW_COMPARE: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
  ENABLE_DEV_ROUTES: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true'),
});

export type EnvConfig = z.infer<typeof envSchema>;
