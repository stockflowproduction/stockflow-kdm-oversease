import { CustomersRepository } from '../../src/modules/customers/customers.repository';
import { CustomersService } from '../../src/modules/customers/customers.service';
import { IdempotencyService } from '../../src/infrastructure/idempotency/idempotency.service';
import { FinanceArtifactsRepository } from '../../src/modules/finance-artifacts/finance-artifacts.repository';
import { ProductsRepository } from '../../src/modules/products/products.repository';
import { ProductsService } from '../../src/modules/products/products.service';
import { TransactionsRepository } from '../../src/modules/transactions/transactions.repository';
import { TransactionsService } from '../../src/modules/transactions/transactions.service';

export const createTransactionsTestContext = () => {
  const productsRepository = new ProductsRepository();
  const customersRepository = new CustomersRepository();
  const transactionsRepository = new TransactionsRepository();
  const financeArtifactsRepository = new FinanceArtifactsRepository();
  const idempotencyService = new IdempotencyService();

  const productsService = new ProductsService(productsRepository);
  const customersService = new CustomersService(customersRepository);
  const transactionsService = new TransactionsService(
    transactionsRepository,
    productsRepository,
    customersRepository,
    idempotencyService,
    financeArtifactsRepository,
  );

  return {
    productsRepository,
    customersRepository,
    transactionsRepository,
    financeArtifactsRepository,
    productsService,
    customersService,
    transactionsService,
  };
};
