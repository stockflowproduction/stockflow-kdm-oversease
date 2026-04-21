import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CustomersModule } from '../customers/customers.module';
import { FinanceArtifactsModule } from '../finance-artifacts/finance-artifacts.module';
import { ProductsModule } from '../products/products.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { TransactionsController } from './transactions.controller';
import { TransactionsRepository } from './transactions.repository';
import { TransactionsService } from './transactions.service';

@Module({
  imports: [AuthModule, TenancyModule, ProductsModule, CustomersModule, FinanceArtifactsModule],
  controllers: [TransactionsController],
  providers: [TransactionsRepository, TransactionsService],
  exports: [TransactionsService, TransactionsRepository],
})
export class TransactionsModule {}
