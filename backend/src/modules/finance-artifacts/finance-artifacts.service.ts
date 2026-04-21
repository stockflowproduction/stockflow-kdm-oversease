import { Injectable, NotFoundException } from '@nestjs/common';

import {
  DeleteCompensationArtifactListResponseDto,
  DeleteCompensationArtifactResponseDto,
  DeleteCompensationArtifactSummaryResponseDto,
  UpdateCorrectionDeltaArtifactListResponseDto,
  UpdateCorrectionDeltaArtifactResponseDto,
  UpdateCorrectionDeltaArtifactSummaryResponseDto,
} from '../../contracts/v1/finance-artifacts/finance-artifact-response.dto';
import {
  DeleteCompensationArtifactDto,
  ListDeleteCompensationsQueryDto,
  ListUpdateCorrectionDeltasQueryDto,
  UpdateCorrectionDeltaArtifactDto,
} from '../../contracts/v1/finance-artifacts/finance-artifact.types';
import { FinanceArtifactsRepository } from './finance-artifacts.repository';

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const emptyDelta = (): UpdateCorrectionDeltaArtifactDto['delta'] => ({
  grossSales: 0,
  salesReturn: 0,
  netSales: 0,
  cashIn: 0,
  cashOut: 0,
  onlineIn: 0,
  onlineOut: 0,
  currentDueEffect: 0,
  currentStoreCreditEffect: 0,
  cogsEffect: 0,
  grossProfitEffect: 0,
  netProfitEffect: 0,
});

@Injectable()
export class FinanceArtifactsService {
  constructor(private readonly repository: FinanceArtifactsRepository) {}

  async recordDeleteCompensation(
    storeId: string,
    input: Omit<DeleteCompensationArtifactDto, 'id' | 'storeId' | 'createdAt'>,
  ): Promise<DeleteCompensationArtifactDto> {
    return this.repository.createDeleteCompensation(storeId, {
      ...input,
      amount: roundMoney(input.amount),
    });
  }

  async listDeleteCompensations(
    storeId: string,
    query: ListDeleteCompensationsQueryDto,
  ): Promise<DeleteCompensationArtifactListResponseDto> {
    const all = await this.repository.findDeleteCompensations(storeId, query);
    const filtered = query.mode ? all.filter((item) => item.mode === query.mode) : all;
    return { items: filtered, total: filtered.length };
  }

  async getDeleteCompensationById(
    storeId: string,
    id: string,
  ): Promise<DeleteCompensationArtifactResponseDto> {
    const artifact = await this.repository.findDeleteCompensationById(storeId, id);
    if (!artifact) {
      throw new NotFoundException({
        message: 'Delete compensation artifact not found.',
        code: 'DELETE_COMPENSATION_NOT_FOUND',
      });
    }

    return { artifact };
  }

  async summarizeDeleteCompensations(
    storeId: string,
    query: ListDeleteCompensationsQueryDto,
  ): Promise<DeleteCompensationArtifactSummaryResponseDto> {
    const { items } = await this.listDeleteCompensations(storeId, query);

    const byMode = new Map<DeleteCompensationArtifactDto['mode'], { count: number; amount: number }>();
    for (const item of items) {
      const bucket = byMode.get(item.mode) ?? { count: 0, amount: 0 };
      bucket.count += 1;
      bucket.amount += item.amount;
      byMode.set(item.mode, bucket);
    }

    return {
      totals: {
        count: items.length,
        amount: roundMoney(items.reduce((sum, item) => sum + item.amount, 0)),
      },
      byMode: Array.from(byMode.entries()).map(([mode, value]) => ({
        mode,
        count: value.count,
        amount: roundMoney(value.amount),
      })),
      latestCreatedAt: items.map((item) => item.createdAt).sort((a, b) => b.localeCompare(a))[0] ?? null,
    };
  }

  async recordUpdateCorrection(
    storeId: string,
    input: Omit<UpdateCorrectionDeltaArtifactDto, 'id' | 'storeId' | 'updatedAt'>,
  ): Promise<UpdateCorrectionDeltaArtifactDto> {
    return this.repository.createUpdateCorrection(storeId, {
      ...input,
      delta: {
        grossSales: roundMoney(input.delta.grossSales),
        salesReturn: roundMoney(input.delta.salesReturn),
        netSales: roundMoney(input.delta.netSales),
        cashIn: roundMoney(input.delta.cashIn),
        cashOut: roundMoney(input.delta.cashOut),
        onlineIn: roundMoney(input.delta.onlineIn),
        onlineOut: roundMoney(input.delta.onlineOut),
        currentDueEffect: roundMoney(input.delta.currentDueEffect),
        currentStoreCreditEffect: roundMoney(input.delta.currentStoreCreditEffect),
        cogsEffect: roundMoney(input.delta.cogsEffect),
        grossProfitEffect: roundMoney(input.delta.grossProfitEffect),
        netProfitEffect: roundMoney(input.delta.netProfitEffect),
      },
    });
  }

  async listUpdateCorrections(
    storeId: string,
    query: ListUpdateCorrectionDeltasQueryDto,
  ): Promise<UpdateCorrectionDeltaArtifactListResponseDto> {
    const all = await this.repository.findUpdateCorrections(storeId, query);
    const filtered = query.changeTag
      ? all.filter((item) => item.changeTags.includes(query.changeTag!))
      : all;
    return { items: filtered, total: filtered.length };
  }

  async getUpdateCorrectionById(
    storeId: string,
    id: string,
  ): Promise<UpdateCorrectionDeltaArtifactResponseDto> {
    const artifact = await this.repository.findUpdateCorrectionById(storeId, id);
    if (!artifact) {
      throw new NotFoundException({
        message: 'Update correction delta artifact not found.',
        code: 'UPDATE_CORRECTION_NOT_FOUND',
      });
    }

    return { artifact };
  }

  async summarizeUpdateCorrections(
    storeId: string,
    query: ListUpdateCorrectionDeltasQueryDto,
  ): Promise<UpdateCorrectionDeltaArtifactSummaryResponseDto> {
    const { items } = await this.listUpdateCorrections(storeId, query);
    const totals = emptyDelta();
    const byChangeTag = new Map<string, number>();

    for (const item of items) {
      totals.grossSales += item.delta.grossSales;
      totals.salesReturn += item.delta.salesReturn;
      totals.netSales += item.delta.netSales;
      totals.cashIn += item.delta.cashIn;
      totals.cashOut += item.delta.cashOut;
      totals.onlineIn += item.delta.onlineIn;
      totals.onlineOut += item.delta.onlineOut;
      totals.currentDueEffect += item.delta.currentDueEffect;
      totals.currentStoreCreditEffect += item.delta.currentStoreCreditEffect;
      totals.cogsEffect += item.delta.cogsEffect;
      totals.grossProfitEffect += item.delta.grossProfitEffect;
      totals.netProfitEffect += item.delta.netProfitEffect;
      for (const tag of item.changeTags) {
        byChangeTag.set(tag, (byChangeTag.get(tag) ?? 0) + 1);
      }
    }

    return {
      totals: {
        count: items.length,
        delta: {
          grossSales: roundMoney(totals.grossSales),
          salesReturn: roundMoney(totals.salesReturn),
          netSales: roundMoney(totals.netSales),
          cashIn: roundMoney(totals.cashIn),
          cashOut: roundMoney(totals.cashOut),
          onlineIn: roundMoney(totals.onlineIn),
          onlineOut: roundMoney(totals.onlineOut),
          currentDueEffect: roundMoney(totals.currentDueEffect),
          currentStoreCreditEffect: roundMoney(totals.currentStoreCreditEffect),
          cogsEffect: roundMoney(totals.cogsEffect),
          grossProfitEffect: roundMoney(totals.grossProfitEffect),
          netProfitEffect: roundMoney(totals.netProfitEffect),
        },
      },
      byChangeTag: Array.from(byChangeTag.entries()).map(([changeTag, count]) => ({ changeTag, count })),
      latestUpdatedAt: items.map((item) => item.updatedAt).sort((a, b) => b.localeCompare(a))[0] ?? null,
    };
  }
}
