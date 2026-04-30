import { Module } from '@nestjs/common';

import { LoggerModule } from './common/logger/logger.module';
import { ConfigModule } from './config/config.module';
import { IdempotencyModule } from './infrastructure/idempotency/idempotency.module';
import { MongoDbModule } from './infrastructure/mongodb/mongodb.module';
import { AuditModule } from './modules/audit/audit.module';
import { CashSessionsModule } from './modules/cash-sessions/cash-sessions.module';
import { AuthModule } from './modules/auth/auth.module';
import { CustomersModule } from './modules/customers/customers.module';
import { FinanceModule } from './modules/finance/finance.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { FinanceArtifactsModule } from './modules/finance-artifacts/finance-artifacts.module';
import { HealthModule } from './modules/health/health.module';
import { ProcurementModule } from './modules/procurement/procurement.module';
import { ProductsModule } from './modules/products/products.module';
import { ReportsModule } from './modules/reports/reports.module';
import { TenancyModule } from './modules/tenancy/tenancy.module';
import { TransactionsModule } from './modules/transactions/transactions.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { DevModule } from './dev/dev.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule,
    MongoDbModule,
    IdempotencyModule,
    AuditModule,
    AuthModule,
    TenancyModule,
    HealthModule,
    ProductsModule,
    CustomersModule,
    TransactionsModule,
    FinanceModule,
    ExpensesModule,
    CashSessionsModule,
    FinanceArtifactsModule,
    ProcurementModule,
    ReportsModule,
    UploadsModule,
    DevModule,
  ],
})
export class AppModule {}
