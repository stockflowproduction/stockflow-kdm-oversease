import { Module } from '@nestjs/common';

import { ExpensesRepository } from './expenses.repository';
import { ExpensesService } from './expenses.service';

@Module({
  providers: [ExpensesRepository, ExpensesService],
  exports: [ExpensesRepository, ExpensesService],
})
export class ExpensesModule {}
