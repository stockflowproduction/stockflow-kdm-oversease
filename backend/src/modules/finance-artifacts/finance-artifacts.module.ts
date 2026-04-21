import { Module } from '@nestjs/common';

import { FinanceArtifactsRepository } from './finance-artifacts.repository';
import { FinanceArtifactsService } from './finance-artifacts.service';

@Module({
  providers: [FinanceArtifactsRepository, FinanceArtifactsService],
  exports: [FinanceArtifactsRepository, FinanceArtifactsService],
})
export class FinanceArtifactsModule {}
