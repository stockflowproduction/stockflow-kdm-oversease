import { Controller, Get, Param } from '@nestjs/common';
import { ProductsService } from '../modules/products/products.service';
import { CustomersService } from '../modules/customers/customers.service';
import { TransactionsService } from '../modules/transactions/transactions.service';

const STORE_ID = '4rwCg6qYT3ciB0X8S1OtgnoywDB3';

@Controller('dev')
export class DevController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly customersService: CustomersService,
    private readonly transactionsService: TransactionsService,
  ) {}

  // 🔹 PRODUCTS
  @Get('products')
  async getProducts() {
    return this.productsService.list(STORE_ID, {} as any);
  }

  @Get('products/:id')
  async getProductById(@Param('id') id: string) {
    return this.productsService.getById(STORE_ID, id);
  }

  // 🔹 CUSTOMERS
  @Get('customers')
  async getCustomers() {
    return this.customersService.list(STORE_ID, {} as any);
  }

  @Get('customers/:id')
  async getCustomerById(@Param('id') id: string) {
    return this.customersService.getById(STORE_ID, id);
  }


  // 🔹 TRANSACTIONS
@Get('transactions')
async getTransactions() {
  return this.transactionsService.list(STORE_ID, {} as any);
}

@Get('transactions/deleted')
async getDeletedTransactions() {
  return this.transactionsService.listDeleted(STORE_ID);
}

@Get('transactions/:id')
async getTransactionById(@Param('id') id: string) {
  return this.transactionsService.getById(STORE_ID, id);
}

}