import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

import { ListFinanceArtifactsQueryDto } from '../../contracts/v1/finance-artifacts/list-finance-artifacts-query.dto';
import {
  DeleteCompensationArtifactDocument,
} from './models/delete-compensation-artifact.model';
import {
  UpdateCorrectionArtifactDocument,
} from './models/update-correction-artifact.model';

@Injectable()
export class FinanceArtifactsRepository {
  // Phase 4D scaffold only: boundaries for future first-class artifact persistence.
  private readonly deleteCompensations: DeleteCompensationArtifactDocument[] = [];
  private readonly updateCorrections: UpdateCorrectionArtifactDocument[] = [];

  async createDeleteCompensation(
    storeId: string,
    input: Omit<DeleteCompensationArtifactDocument, 'id' | 'storeId' | 'createdAt'>,
  ): Promise<DeleteCompensationArtifactDocument> {
    const created: DeleteCompensationArtifactDocument = {
      ...input,
      id: randomUUID(),
      storeId,
      createdAt: new Date().toISOString(),
    };

    this.deleteCompensations.push(created);
    return created;
  }

  async findDeleteCompensations(
    storeId: string,
    query: ListFinanceArtifactsQueryDto,
  ): Promise<DeleteCompensationArtifactDocument[]> {
    const dateFrom = query.dateFrom ? new Date(query.dateFrom).getTime() : Number.NEGATIVE_INFINITY;
    const dateTo = query.dateTo ? new Date(query.dateTo).getTime() : Number.POSITIVE_INFINITY;

    return this.deleteCompensations
      .filter((item) => item.storeId === storeId)
      .filter((item) => {
        const ts = new Date(item.createdAt).getTime();
        return ts >= dateFrom && ts <= dateTo;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async findDeleteCompensationById(
    storeId: string,
    id: string,
  ): Promise<DeleteCompensationArtifactDocument | null> {
    return this.deleteCompensations.find((item) => item.storeId === storeId && item.id === id) ?? null;
  }

  async createUpdateCorrection(
    storeId: string,
    input: Omit<UpdateCorrectionArtifactDocument, 'id' | 'storeId' | 'updatedAt'>,
  ): Promise<UpdateCorrectionArtifactDocument> {
    const created: UpdateCorrectionArtifactDocument = {
      ...input,
      id: randomUUID(),
      storeId,
      updatedAt: new Date().toISOString(),
    };

    this.updateCorrections.push(created);
    return created;
  }

  async findUpdateCorrections(
    storeId: string,
    query: ListFinanceArtifactsQueryDto,
  ): Promise<UpdateCorrectionArtifactDocument[]> {
    const dateFrom = query.dateFrom ? new Date(query.dateFrom).getTime() : Number.NEGATIVE_INFINITY;
    const dateTo = query.dateTo ? new Date(query.dateTo).getTime() : Number.POSITIVE_INFINITY;

    return this.updateCorrections
      .filter((item) => item.storeId === storeId)
      .filter((item) => {
        const ts = new Date(item.updatedAt).getTime();
        return ts >= dateFrom && ts <= dateTo;
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async findUpdateCorrectionById(
    storeId: string,
    id: string,
  ): Promise<UpdateCorrectionArtifactDocument | null> {
    return this.updateCorrections.find((item) => item.storeId === storeId && item.id === id) ?? null;
  }
}
