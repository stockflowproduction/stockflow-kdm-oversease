import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  buildTelegramCollectionControlRequest,
  buildTelegramCollectionStartRequest,
  normalizeTelegramStartAt,
} from './telegramPayloads';

describe('telegramPayloads', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('normalizeTelegramStartAt', () => {
    it('returns null for an omitted start time', () => {
      expect(
        normalizeTelegramStartAt(null),
      ).toBeNull();

      expect(
        normalizeTelegramStartAt(undefined),
      ).toBeNull();

      expect(
        normalizeTelegramStartAt(''),
      ).toBeNull();

      expect(
        normalizeTelegramStartAt('   '),
      ).toBeNull();
    });

    it('normalizes an ISO-compatible date to ISO format', () => {
      expect(
        normalizeTelegramStartAt(
          '2026-08-26T14:30:00.000Z',
        ),
      ).toBe(
        '2026-08-26T14:30:00.000Z',
      );
    });

    it('returns null for an invalid date value', () => {
      expect(
        normalizeTelegramStartAt(
          'not-a-date',
        ),
      ).toBeNull();
    });

    it('converts a future HH:mm value to today in local time', () => {
      vi.useFakeTimers();

      vi.setSystemTime(
        new Date(
          2026,
          7,
          26,
          10,
          0,
          0,
          0,
        ),
      );

      const result =
        normalizeTelegramStartAt(
          '14:30',
        );

      const expected = new Date(
        2026,
        7,
        26,
        14,
        30,
        0,
        0,
      ).toISOString();

      expect(result).toBe(expected);
    });

    it('moves a past HH:mm value to the next local day', () => {
      vi.useFakeTimers();

      vi.setSystemTime(
        new Date(
          2026,
          7,
          26,
          15,
          0,
          0,
          0,
        ),
      );

      const result =
        normalizeTelegramStartAt(
          '14:30',
        );

      const expected = new Date(
        2026,
        7,
        27,
        14,
        30,
        0,
        0,
      ).toISOString();

      expect(result).toBe(expected);
    });
  });

  describe('buildTelegramCollectionStartRequest', () => {
    const validProduct = {
      id: ' product-1 ',
      name: ' Test Product ',
      description: ' Test description ',
      price: 100,
      salePrice: 90,
      imageUrl:
        ' https://example.com/product.jpg ',
      category: ' test ',
      stock: 5,
      barcode: ' 123456 ',
    };

    const createInput = () => ({
      collectionId: ' collection-1 ',
      name: ' Summer Collection ',
      channelId: ' @stockflow ',
      category: ' featured ',
      template: ' {{name}} ',
      notes: ' Test notes ',
      frequencyValue: 1,
      frequencyUnit:
        'minutes' as const,
      batchSize: 2 as const,
      startAt:
        '2026-08-26T14:30:00.000Z',
      repeatMode: 'loop' as const,
      maxFailuresBeforePause: 3,
      products: [validProduct],
    });

    it('builds the canonical collection start request', () => {
      const result =
        buildTelegramCollectionStartRequest(
          createInput(),
        );

      expect(result).toEqual({
        collectionId: 'collection-1',
        name: 'Summer Collection',
        channelId: '@stockflow',
        category: 'featured',
        template: '{{name}}',
        notes: 'Test notes',
        frequencyValue: 1,
        frequencyUnit: 'minutes',
        batchSize: 2,
        startAt:
          '2026-08-26T14:30:00.000Z',
        repeatMode: 'loop',
        maxFailuresBeforePause: 3,
        products: [
          {
            id: 'product-1',
            name: 'Test Product',
            description:
              'Test description',
            price: 100,
            salePrice: 90,
            imageUrl:
              'https://example.com/product.jpg',
            category: 'test',
            stock: 5,
            barcode: '123456',
          },
        ],
      });
    });

    it('uses id as the collectionId fallback', () => {
      const input = {
        ...createInput(),
        collectionId: undefined,
        id: ' draft-123 ',
      };

      const result =
        buildTelegramCollectionStartRequest(
          input,
        );

      expect(
        result.collectionId,
      ).toBe('draft-123');
    });

    it('prefers collectionId over id', () => {
      const input = {
        ...createInput(),
        collectionId:
          ' backend-id ',
        id: ' draft-id ',
      };

      const result =
        buildTelegramCollectionStartRequest(
          input,
        );

      expect(
        result.collectionId,
      ).toBe('backend-id');
    });

    it('omits collectionId when neither id is provided', () => {
      const input = {
        ...createInput(),
        collectionId: undefined,
      };

      const result =
        buildTelegramCollectionStartRequest(
          input,
        );

      expect(
        Object.prototype.hasOwnProperty.call(
          result,
          'collectionId',
        ),
      ).toBe(false);
    });

    it('uses all as the default category', () => {
      const input = {
        ...createInput(),
        category: '   ',
      };

      const result =
        buildTelegramCollectionStartRequest(
          input,
        );

      expect(result.category).toBe('all');
    });

    it('keeps an omitted start time as null', () => {
      const input = {
        ...createInput(),
        startAt: null,
      };

      const result =
        buildTelegramCollectionStartRequest(
          input,
        );

      expect(result.startAt).toBeNull();
    });

    it('converts HH:mm startAt to the next local occurrence', () => {
      vi.useFakeTimers();

      vi.setSystemTime(
        new Date(
          2026,
          7,
          26,
          15,
          0,
          0,
          0,
        ),
      );

      const input = {
        ...createInput(),
        startAt: '14:30',
      };

      const result =
        buildTelegramCollectionStartRequest(
          input,
        );

      expect(result.startAt).toBe(
        new Date(
          2026,
          7,
          27,
          14,
          30,
          0,
          0,
        ).toISOString(),
      );
    });

    it('accepts a flexible seconds frequency', () => {
      const input = {
        ...createInput(),
        frequencyValue: 5,
        frequencyUnit:
          'seconds' as const,
      };

      expect(
        buildTelegramCollectionStartRequest(
          input,
        ).frequencyValue,
      ).toBe(5);
    });

    it('caps too-fast collection frequencies at five seconds', () => {
      const result =
        buildTelegramCollectionStartRequest({
          ...createInput(),
          frequencyValue: 1,
          frequencyUnit:
            'seconds' as const,
        });

      expect(result.frequencyValue).toBe(5);
      expect(result.frequencyUnit).toBe(
        'seconds',
      );
    });

    it('normalizes the legacy telegram_details token for backend compatibility', () => {
      const input = {
        ...createInput(),
        template:
          'New arrival\n{telegram_details}',
      };

      expect(
        buildTelegramCollectionStartRequest(
          input,
        ).template,
      ).toBe('New arrival\n{telegram details}');
    });

    it('rejects an unsupported batch size', () => {
      const input = {
        ...createInput(),
        batchSize: 3 as any,
      };

      expect(() =>
        buildTelegramCollectionStartRequest(
          input,
        ),
      ).toThrow();
    });

    it('rejects an invalid startAt value', () => {
      const input = {
        ...createInput(),
        startAt: 'not-a-date',
      };

      expect(() =>
        buildTelegramCollectionStartRequest(
          input,
        ),
      ).toThrow();
    });

    it('rejects an empty product list', () => {
      const input = {
        ...createInput(),
        products: [],
      };

      expect(() =>
        buildTelegramCollectionStartRequest(
          input,
        ),
      ).toThrow();
    });
  });

  describe('buildTelegramCollectionControlRequest', () => {
    it('normalizes a collection ID', () => {
      expect(
        buildTelegramCollectionControlRequest(
          ' collection-123 ',
        ),
      ).toEqual({
        collectionId:
          'collection-123',
      });
    });

    it('rejects an empty collection ID', () => {
      expect(() =>
        buildTelegramCollectionControlRequest(
          '   ',
        ),
      ).toThrow();
    });
  });
});
