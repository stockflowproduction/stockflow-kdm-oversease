import { Injectable } from '@nestjs/common';

import { EnvConfig } from './env.schema';

@Injectable()
export class AppConfigService {
  constructor(private readonly env: EnvConfig) {}

  get port(): number {
    return this.env.PORT;
  }

  get apiPrefix(): string {
    return this.env.API_PREFIX;
  }

  get apiVersion(): string {
    return this.env.API_VERSION;
  }

  get securityEnableCors(): boolean {
    return this.env.SECURITY_ENABLE_CORS;
  }

  get authRequired(): boolean {
    return this.env.AUTH_REQUIRED;
  }

  get authDevStaticToken(): string {
    return this.env.AUTH_DEV_STATIC_TOKEN;
  }

  get authDevActorId(): string {
    return this.env.AUTH_DEV_ACTOR_ID;
  }

  get authDevDefaultStoreId(): string {
    return this.env.AUTH_DEV_DEFAULT_STORE_ID;
  }

  get authDevVerified(): boolean {
    return this.env.AUTH_DEV_VERIFIED;
  }

  get authTokenTtlSeconds(): number {
    return this.env.AUTH_TOKEN_TTL_SECONDS;
  }

  get featureFlagProductsEnabled(): boolean {
    return this.env.FEATURE_FLAG_PRODUCTS_ENABLED;
  }

  get featureFlagFinanceV2SummaryEnabled(): boolean {
    return this.env.FEATURE_FLAG_FINANCE_V2_SUMMARY_ENABLED;
  }

  get financeV2AllowedConsumers(): string[] {
    return this.env.FINANCE_V2_ALLOWED_CONSUMERS.split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  get financeV2UsageLogEnabled(): boolean {
    return this.env.FINANCE_V2_USAGE_LOG_ENABLED;
  }

  get financeV2DiffLogEnabled(): boolean {
    return this.env.FINANCE_V2_DIFF_LOG_ENABLED;
  }

  get financeV2DiffAlertThreshold(): number {
    return this.env.FINANCE_V2_DIFF_ALERT_THRESHOLD;
  }

  get mongodbUri(): string {
    return this.env.MONGODB_URI;
  }

  get mongodbDbName(): string {
    return this.env.MONGODB_DB_NAME;
  }

  get mongodbAppName(): string {
    return this.env.MONGODB_APP_NAME;
  }

  get mongodbMinPoolSize(): number {
    return this.env.MONGODB_MIN_POOL_SIZE;
  }

  get mongodbMaxPoolSize(): number {
    return this.env.MONGODB_MAX_POOL_SIZE;
  }

  get mongodbServerSelectionTimeoutMs(): number {
    return this.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS;
  }

  get mongodbSocketTimeoutMs(): number {
    return this.env.MONGODB_SOCKET_TIMEOUT_MS;
  }

  get useMongoReads(): boolean {
    return this.env.USE_MONGO_READS;
  }

  get shadowCompare(): boolean {
    return this.env.SHADOW_COMPARE;
  }

  get enableDevRoutes(): boolean {
    return this.env.ENABLE_DEV_ROUTES;
  }
}


