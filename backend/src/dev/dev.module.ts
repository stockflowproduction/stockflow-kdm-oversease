import { Module } from '@nestjs/common';
import { DevController } from './dev.controller';
import { ProductsModule } from '../modules/products/products.module';
import { CustomersModule } from '../modules/customers/customers.module';
import { TransactionsModule } from '../modules/transactions/transactions.module';

@Module({
  imports: [
    ProductsModule,
    CustomersModule,
    TransactionsModule,
  ],
  controllers: [DevController],
})
export class DevModule {}