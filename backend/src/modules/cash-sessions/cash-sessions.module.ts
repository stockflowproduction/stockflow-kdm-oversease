import { Module } from '@nestjs/common';

import { CashSessionsRepository } from './cash-sessions.repository';
import { CashSessionsService } from './cash-sessions.service';

@Module({
  providers: [CashSessionsRepository, CashSessionsService],
  exports: [CashSessionsRepository, CashSessionsService],
})
export class CashSessionsModule {}
