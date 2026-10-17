import { describe, expect, it } from 'vitest';

import {
  TELEGRAM_MIN_FREQUENCY_MS,
  isTelegramBatchSize,
  isTelegramFrequencyUnit,
  isTelegramRepeatMode,
  normalizeTelegramFrequencyFloor,
  telegramFrequencyToMs,
  validateTelegramBatchSize,
  validateTelegramFrequency,
  validateTelegramMaxFailures,
  validateTelegramProducts,
  validateTelegramRepeatMode,
  validateTelegramSchedulerProduct,
  validateTelegramStartAt,
} from './telegramValidation';

describe('telegramValidation', () => {
  describe('frequency', () => {
    it('uses a five-second minimum frequency', () => {
      expect(TELEGRAM_MIN_FREQUENCY_MS).toBe(5_000);
    });

    it('converts supported frequency units to milliseconds', () => {
      expect(
        telegramFrequencyToMs(60, 'seconds'),
      ).toBe(60_000);

      expect(
        telegramFrequencyToMs(1, 'minutes'),
      ).toBe(60_000);

      expect(
        telegramFrequencyToMs(1, 'hours'),
      ).toBe(3_600_000);
    });

    it('recognizes supported frequency units', () => {
      expect(
        isTelegramFrequencyUnit('seconds'),
      ).toBe(true);

      expect(
        isTelegramFrequencyUnit('minutes'),
      ).toBe(true);

      expect(
        isTelegramFrequencyUnit('hours'),
      ).toBe(true);

      expect(
        isTelegramFrequencyUnit('days'),
      ).toBe(false);
    });

    it('accepts flexible positive frequencies', () => {
      expect(
        validateTelegramFrequency(
          5,
          'seconds',
        ),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramFrequency(
          1,
          'minutes',
        ),
      ).toEqual({
        valid: true,
      });
    });

    it('normalizes too-fast frequencies to five seconds', () => {
      expect(
        normalizeTelegramFrequencyFloor(
          1,
          'seconds',
        ),
      ).toEqual({
        value: 5,
        unit: 'seconds',
      });

      expect(
        normalizeTelegramFrequencyFloor(
          1,
          'minutes',
        ),
      ).toEqual({
        value: 1,
        unit: 'minutes',
      });
    });

    it('rejects a frequency below five seconds', () => {
      expect(
        validateTelegramFrequency(
          4,
          'seconds',
        ),
      ).toEqual({
        valid: false,
        message:
          'Telegram collections cannot run more frequently than once every 5 seconds.',
        field: 'frequencyValue',
      });
    });

    it('rejects invalid frequency values and units', () => {
      expect(
        validateTelegramFrequency(
          0,
          'minutes',
        ).field,
      ).toBe('frequencyValue');

      expect(
        validateTelegramFrequency(
          1,
          'days',
        ).field,
      ).toBe('frequencyUnit');
    });
  });

  describe('batch size', () => {
    it('accepts only canonical Telegram batch sizes', () => {
      for (const value of [1, 2, 4, 6, 8]) {
        expect(
          isTelegramBatchSize(value),
        ).toBe(true);

        expect(
          validateTelegramBatchSize(value),
        ).toEqual({
          valid: true,
        });
      }

      for (const value of [0, 3, 5, 7, 9]) {
        expect(
          isTelegramBatchSize(value),
        ).toBe(false);

        expect(
          validateTelegramBatchSize(value).valid,
        ).toBe(false);
      }
    });
  });

  describe('repeat mode', () => {
    it('accepts once and loop only', () => {
      expect(
        isTelegramRepeatMode('once'),
      ).toBe(true);

      expect(
        isTelegramRepeatMode('loop'),
      ).toBe(true);

      expect(
        isTelegramRepeatMode('forever'),
      ).toBe(false);

      expect(
        validateTelegramRepeatMode('once'),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramRepeatMode('loop'),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramRepeatMode(
          'forever',
        ).field,
      ).toBe('repeatMode');
    });
  });

  describe('startAt', () => {
    it('accepts an omitted optional start time', () => {
      expect(
        validateTelegramStartAt(null),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramStartAt(undefined),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramStartAt(''),
      ).toEqual({
        valid: true,
      });
    });

    it('accepts the HH:mm value produced by the time input', () => {
      expect(
        validateTelegramStartAt('14:30'),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramStartAt('23:59'),
      ).toEqual({
        valid: true,
      });
    });

    it('accepts a valid ISO date-time', () => {
      expect(
        validateTelegramStartAt(
          '2026-08-26T14:30:00.000Z',
        ),
      ).toEqual({
        valid: true,
      });
    });

    it('rejects invalid start times', () => {
      expect(
        validateTelegramStartAt(
          '25:99',
        ).field,
      ).toBe('startAt');

      expect(
        validateTelegramStartAt(
          'not-a-date',
        ).field,
      ).toBe('startAt');

      expect(
        validateTelegramStartAt(
          12345,
        ).field,
      ).toBe('startAt');
    });
  });

  describe('maximum failures', () => {
    it('requires a positive whole number', () => {
      expect(
        validateTelegramMaxFailures(1),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramMaxFailures(5),
      ).toEqual({
        valid: true,
      });

      for (const value of [
        0,
        -1,
        1.5,
        'invalid',
      ]) {
        expect(
          validateTelegramMaxFailures(
            value,
          ).field,
        ).toBe(
          'maxFailuresBeforePause',
        );
      }
    });
  });

  describe('scheduler products', () => {
    const validProduct = {
      id: 'product-1',
      name: 'Test Product',
      description: 'Test description',
      price: 100,
      salePrice: 90,
      imageUrl:
        'https://example.com/product.jpg',
      category: 'test',
      stock: 5,
    };

    it('accepts a valid scheduler product', () => {
      expect(
        validateTelegramSchedulerProduct(
          validProduct,
        ),
      ).toEqual({
        valid: true,
      });
    });

    it('requires product id, name, image and valid numeric values', () => {
      expect(
        validateTelegramSchedulerProduct({
          ...validProduct,
          id: '',
        }).field,
      ).toBe('products');

      expect(
        validateTelegramSchedulerProduct({
          ...validProduct,
          name: '',
        }).field,
      ).toBe('products');

      expect(
        validateTelegramSchedulerProduct({
          ...validProduct,
          imageUrl: '',
        }).field,
      ).toBe('products');

      expect(
        validateTelegramSchedulerProduct({
          ...validProduct,
          price: -1,
        }).field,
      ).toBe('products');

      expect(
        validateTelegramSchedulerProduct({
          ...validProduct,
          salePrice: -1,
        }).field,
      ).toBe('products');

      expect(
        validateTelegramSchedulerProduct({
          ...validProduct,
          stock: -1,
        }).field,
      ).toBe('products');
    });

    it('requires at least one product', () => {
      expect(
        validateTelegramProducts([]),
      ).toEqual({
        valid: false,
        message:
          'Select at least one product for the Telegram collection.',
        field: 'products',
      });
    });

    it('validates every product in the collection', () => {
      expect(
        validateTelegramProducts([
          validProduct,
        ]),
      ).toEqual({
        valid: true,
      });

      expect(
        validateTelegramProducts([
          validProduct,
          {
            ...validProduct,
            id: 'product-2',
            imageUrl: '',
          },
        ]).field,
      ).toBe('products');
    });
  });
});
