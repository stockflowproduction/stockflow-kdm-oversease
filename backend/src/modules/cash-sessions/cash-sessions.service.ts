import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { CashSessionResponseDto, CashSessionListResponseDto } from '../../contracts/v1/cash-sessions/cash-session-response.dto';
import { CashSessionRecordDto } from '../../contracts/v1/cash-sessions/cash-session.types';
import { CreateCashSessionDto } from '../../contracts/v1/cash-sessions/create-cash-session.dto';
import { ListCashSessionsQueryDto } from '../../contracts/v1/cash-sessions/list-cash-sessions-query.dto';
import { CashSessionsRepository } from './cash-sessions.repository';

const roundMoney = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class CashSessionsService {
  constructor(private readonly repository: CashSessionsRepository) {}

  async create(
    storeId: string,
    payload: CreateCashSessionDto,
    actorId: string | null,
  ): Promise<CashSessionRecordDto> {
    const status = payload.status ?? 'open';

    if (status === 'closed' && (!payload.endTime || payload.closingBalance === undefined)) {
      throw new BadRequestException({
        message: 'Closed session requires endTime and closingBalance.',
        code: 'CASH_SESSION_CLOSED_FIELDS_REQUIRED',
      });
    }

    return this.repository.create(storeId, {
      status,
      openingBalance: roundMoney(payload.openingBalance),
      startTime: payload.startTime ?? new Date().toISOString(),
      endTime: payload.endTime ?? null,
      closingBalance: payload.closingBalance !== undefined ? roundMoney(payload.closingBalance) : null,
      systemCashTotal: payload.systemCashTotal !== undefined ? roundMoney(payload.systemCashTotal) : null,
      difference: payload.difference !== undefined ? roundMoney(payload.difference) : null,
      openedBy: actorId,
      closedBy: status === 'closed' ? actorId : null,
      note: payload.note?.trim() || null,
    });
  }

  async list(storeId: string, query: ListCashSessionsQueryDto): Promise<CashSessionListResponseDto> {
    const { items, total } = await this.repository.findMany(storeId, query);
    return { items, total };
  }

  async getById(storeId: string, id: string): Promise<CashSessionResponseDto> {
    const session = await this.repository.findById(storeId, id);
    if (!session) {
      throw new NotFoundException({
        message: 'Cash session not found.',
        code: 'CASH_SESSION_NOT_FOUND',
      });
    }

    return { session };
  }
}
