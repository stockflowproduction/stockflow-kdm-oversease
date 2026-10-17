import {
  describe,
  expect,
  it,
} from 'vitest';

import {
  extractTelegramActivityRows,
  extractTelegramCollectionRow,
  extractTelegramCollectionRows,
  mapTelegramCollectionActivityItem,
  mapTelegramCollectionActivityRecord,
  mapTelegramLiveCollection,
  mapTelegramRuntimeCollection,
  normalizeTelegramCollectionStatus,
  normalizeTelegramFrequencyUnit,
  normalizeTelegramRepeatMode,
} from './telegramMapper';

describe('telegramMapper', () => {
  describe('normalizers', () => {
    it('normalizes frequency units', () => {
      expect(
        normalizeTelegramFrequencyUnit(
          'seconds',
        ),
      ).toBe('seconds');

      expect(
        normalizeTelegramFrequencyUnit(
          'hours',
        ),
      ).toBe('hours');

      expect(
        normalizeTelegramFrequencyUnit(
          'minutes',
        ),
      ).toBe('minutes');

      expect(
        normalizeTelegramFrequencyUnit(
          'unknown',
        ),
      ).toBe('minutes');
    });

    it('normalizes repeat modes', () => {
      expect(
        normalizeTelegramRepeatMode(
          'once',
        ),
      ).toBe('once');

      expect(
        normalizeTelegramRepeatMode(
          'loop',
        ),
      ).toBe('loop');

      expect(
        normalizeTelegramRepeatMode(
          'unknown',
        ),
      ).toBe('loop');
    });

    it('normalizes backend status aliases', () => {
      expect(
        normalizeTelegramCollectionStatus(
          'active',
        ),
      ).toBe('running');

      expect(
        normalizeTelegramCollectionStatus(
          'cancelled',
        ),
      ).toBe('stopped');

      expect(
        normalizeTelegramCollectionStatus(
          'done',
        ),
      ).toBe('completed');

      expect(
        normalizeTelegramCollectionStatus(
          'error',
        ),
      ).toBe('failed');

      expect(
        normalizeTelegramCollectionStatus(
          'unexpected',
        ),
      ).toBe('failed');
    });
  });

  describe('runtime collection mapping', () => {
    it('maps canonical backend runtime fields', () => {
      const result =
        mapTelegramRuntimeCollection({
          ownerStoreId: 'store-1',
          id: 'collection-1',
          name: 'Featured',
          channelId: '@stockflow',
          category: 'featured',
          template: '{{name}}',
          notes: 'notes',
          products: [],
          productsCount: 4,
          batchSize: 2,
          productCursor: 3,
          status: 'running',
          frequencyValue: 5,
          frequencyUnit: 'minutes',
          repeatMode: 'loop',
          startAt:
            '2026-08-26T10:00:00.000Z',
          nextRunAt:
            '2026-08-26T10:05:00.000Z',
          lastRunAt:
            '2026-08-26T09:55:00.000Z',
          lastPostedProductName:
            'Product A',
          lastTelegramMessageId:
            'message-123',
          sentCount: 10,
          failedCount: 2,
          consecutiveFailures: 1,
          maxFailuresBeforePause: 3,
          activity: [],
          createdAt:
            '2026-08-25T10:00:00.000Z',
          updatedAt:
            '2026-08-26T09:55:00.000Z',
          startedAt:
            '2026-08-26T09:00:00.000Z',
          stoppedAt: null,
        });

      expect(result).toMatchObject({
        ownerStoreId: 'store-1',
        id: 'collection-1',
        name: 'Featured',
        channelId: '@stockflow',
        category: 'featured',
        productsCount: 4,
        batchSize: 2,
        productCursor: 3,
        status: 'running',
        frequencyValue: 5,
        frequencyUnit: 'minutes',
        repeatMode: 'loop',
        startAt:
          '2026-08-26T10:00:00.000Z',
        nextRunAt:
          '2026-08-26T10:05:00.000Z',
        lastRunAt:
          '2026-08-26T09:55:00.000Z',
        lastPostedProductName:
          'Product A',
        lastTelegramMessageId:
          'message-123',
        sentCount: 10,
        failedCount: 2,
        consecutiveFailures: 1,
        maxFailuresBeforePause: 3,
        stoppedAt: null,
      });
    });

    it('uses collectionId when id is absent', () => {
      const result =
        mapTelegramRuntimeCollection({
          collectionId:
            'collection-from-api',
        });

      expect(result.id).toBe(
        'collection-from-api',
      );
    });

    it('creates a stable fallback id when backend id is absent', () => {
      const result =
        mapTelegramRuntimeCollection(
          {},
          7,
        );

      expect(result.id).toBe(
        'telegram-collection-7',
      );
    });

    it('maps nested frequency values', () => {
      const result =
        mapTelegramRuntimeCollection({
          frequency: {
            value: 2,
            unit: 'hours',
          },
        });

      expect(result.frequencyValue).toBe(
        2,
      );

      expect(result.frequencyUnit).toBe(
        'hours',
      );
    });

    it('defaults seconds frequency values to five seconds', () => {
      const result =
        mapTelegramRuntimeCollection({
          frequencyUnit: 'seconds',
        });

      expect(result.frequencyValue).toBe(
        5,
      );
    });

    it('supports existing cursor and counter aliases', () => {
      const result =
        mapTelegramRuntimeCollection({
          currentCursor: 6,
          postedCount: 12,
          failureCount: 4,
        });

      expect(result.productCursor).toBe(
        6,
      );

      expect(result.sentCount).toBe(12);
      expect(result.failedCount).toBe(4);
    });

    it('supports nextPostAt and lastPostedAt aliases', () => {
      const result =
        mapTelegramRuntimeCollection({
          nextPostAt:
            '2026-08-26T11:00:00.000Z',
          lastPostedAt:
            '2026-08-26T10:00:00.000Z',
        });

      expect(result.nextRunAt).toBe(
        '2026-08-26T11:00:00.000Z',
      );

      expect(result.lastRunAt).toBe(
        '2026-08-26T10:00:00.000Z',
      );
    });

    it('does not map legacy autoStartTime into startAt', () => {
      const result =
        mapTelegramRuntimeCollection({
          autoStartTime:
            '2026-08-26T12:00:00.000Z',
        });

      expect(result.startAt).toBeNull();
    });
  });

  describe('live collection mapping', () => {
    it('maps backend runtime into UI-ready live collection fields', () => {
      const result =
        mapTelegramLiveCollection({
          id: 'collection-1',
          name: 'Collection',
          channelId: '@stockflow',
          category: 'all',
          status: 'running',
          productsCount: 5,
          productCursor: 2,
          sentCount: 8,
          failedCount: 1,
          consecutiveFailures: 0,
          startAt:
            '2026-08-26T10:00:00.000Z',
          lastRunAt:
            '2026-08-26T10:05:00.000Z',
          nextRunAt:
            '2026-08-26T10:10:00.000Z',
          frequencyValue: 5,
          frequencyUnit: 'minutes',
          repeatMode: 'loop',
          batchSize: 2,
          maxFailuresBeforePause: 3,
        });

      expect(result).toMatchObject({
        id: 'collection-1',
        collectionId:
          'collection-1',
        status: 'running',
        productsCount: 5,
        currentCursor: 2,
        productCursor: 2,
        sentCount: 8,
        failedCount: 1,
        startAt:
          '2026-08-26T10:00:00.000Z',
        lastRunAt:
          '2026-08-26T10:05:00.000Z',
        nextRunAt:
          '2026-08-26T10:10:00.000Z',
        lastPostedAt:
          '2026-08-26T10:05:00.000Z',
        nextPostAt:
          '2026-08-26T10:10:00.000Z',
      });
    });

    it('does not emit autoStartTime', () => {
      const result =
        mapTelegramLiveCollection({
          id: 'collection-1',
          startAt:
            '2026-08-26T10:00:00.000Z',
        });

      expect(
        Object.prototype.hasOwnProperty.call(
          result,
          'autoStartTime',
        ),
      ).toBe(false);
    });
  });

  describe('activity mapping', () => {
    it('maps canonical backend activity records', () => {
      const result =
        mapTelegramCollectionActivityRecord({
          timestamp:
            '2026-08-26T10:00:00.000Z',
          collectionId:
            'collection-1',
          collectionName:
            'Featured',
          event: 'posted',
          productId: 'product-1',
          productName: 'Product A',
          maskedChannelId: '@sto***',
          telegramMessageId:
            'message-1',
          errorCode: '',
          errorMessage: '',
        });

      expect(result).toEqual({
        timestamp:
          '2026-08-26T10:00:00.000Z',
        collectionId:
          'collection-1',
        collectionName:
          'Featured',
        event: 'posted',
        productId: 'product-1',
        productName: 'Product A',
        maskedChannelId: '@sto***',
        telegramMessageId:
          'message-1',
        errorCode: '',
        errorMessage: '',
      });
    });

    it('maps supported legacy activity aliases', () => {
      const result =
        mapTelegramCollectionActivityRecord({
          postedAt:
            '2026-08-26T10:00:00.000Z',
          id: 'collection-1',
          name: 'Featured',
          status: 'failed',
          lastPostedProductName:
            'Product B',
          messageId: 'message-2',
          code: 'SEND_FAILED',
          error: 'Telegram failed',
        });

      expect(result).toMatchObject({
        timestamp:
          '2026-08-26T10:00:00.000Z',
        collectionId:
          'collection-1',
        collectionName:
          'Featured',
        event: 'failed',
        productName: 'Product B',
        telegramMessageId:
          'message-2',
        errorCode: 'SEND_FAILED',
        errorMessage:
          'Telegram failed',
      });
    });

    it('builds a deterministic activity item id when no id exists', () => {
      const result =
        mapTelegramCollectionActivityItem({
          collectionId:
            'collection-1',
          timestamp:
            '2026-08-26T10:00:00.000Z',
          event: 'posted',
          productId: 'product-1',
        });

      expect(result.id).toBe(
        'collection-1-2026-08-26T10:00:00.000Z-posted-product-1',
      );

      expect(result.status).toBe(
        'posted',
      );

      expect(result.postedAt).toBe(
        '2026-08-26T10:00:00.000Z',
      );
    });
  });

  describe('response extraction', () => {
    const rows = [
      { id: 'one' },
      { id: 'two' },
    ];

    it('extracts collection arrays from supported response shapes', () => {
      expect(
        extractTelegramCollectionRows(
          rows,
        ),
      ).toEqual(rows);

      expect(
        extractTelegramCollectionRows({
          collections: rows,
        }),
      ).toEqual(rows);

      expect(
        extractTelegramCollectionRows({
          data: rows,
        }),
      ).toEqual(rows);

      expect(
        extractTelegramCollectionRows({
          items: rows,
        }),
      ).toEqual(rows);

      expect(
        extractTelegramCollectionRows(
          null,
        ),
      ).toEqual([]);
    });

    it('extracts a single collection from supported response shapes', () => {
      const collection = {
        id: 'collection-1',
      };

      expect(
        extractTelegramCollectionRow({
          collection,
        }),
      ).toEqual(collection);

      expect(
        extractTelegramCollectionRow({
          data: collection,
        }),
      ).toEqual(collection);

      expect(
        extractTelegramCollectionRow(
          collection,
        ),
      ).toEqual(collection);

      expect(
        extractTelegramCollectionRow(
          null,
        ),
      ).toBeNull();
    });

    it('extracts activity arrays from supported response shapes', () => {
      expect(
        extractTelegramActivityRows(
          rows,
        ),
      ).toEqual(rows);

      expect(
        extractTelegramActivityRows({
          activity: rows,
        }),
      ).toEqual(rows);

      expect(
        extractTelegramActivityRows({
          data: rows,
        }),
      ).toEqual(rows);

      expect(
        extractTelegramActivityRows({
          items: rows,
        }),
      ).toEqual(rows);

      expect(
        extractTelegramActivityRows(
          null,
        ),
      ).toEqual([]);
    });
  });
});
