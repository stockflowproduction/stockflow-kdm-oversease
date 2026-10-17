import type {
  TelegramCollectionBatchSize,
  TelegramCollectionFrequencyUnit,
  TelegramCollectionRepeatMode,
  TelegramSchedulerProduct,
} from '../types';

import {
  TelegramClientError,
} from './telegramErrors';

export const TELEGRAM_MIN_FREQUENCY_MS =
  5_000;

export const TELEGRAM_ALLOWED_BATCH_SIZES:
  readonly TelegramCollectionBatchSize[] = [
    1,
    2,
    4,
    6,
    8,
  ];

export const TELEGRAM_ALLOWED_FREQUENCY_UNITS:
  readonly TelegramCollectionFrequencyUnit[] = [
    'seconds',
    'minutes',
    'hours',
  ];

export const TELEGRAM_ALLOWED_REPEAT_MODES:
  readonly TelegramCollectionRepeatMode[] = [
    'once',
    'loop',
  ];

export type TelegramValidationResult = {
  valid: boolean;
  message?: string;
  field?: string;
};

const valid = (): TelegramValidationResult => ({
  valid: true,
});

const invalid = (
  message: string,
  field?: string,
): TelegramValidationResult => ({
  valid: false,
  message,
  field,
});

const isFinitePositiveNumber = (
  value: unknown,
): value is number => {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0
  );
};

const isNonEmptyString = (
  value: unknown,
): value is string => {
  return (
    typeof value === 'string' &&
    value.trim().length > 0
  );
};

export const telegramFrequencyToMs = (
  value: number,
  unit: TelegramCollectionFrequencyUnit,
): number => {
  switch (unit) {
    case 'seconds':
      return value * 1_000;

    case 'minutes':
      return value * 60_000;

    case 'hours':
      return value * 3_600_000;

    default:
      return Number.NaN;
  }
};

export const normalizeTelegramFrequencyFloor = (
  value: unknown,
  unit: TelegramCollectionFrequencyUnit,
): {
  value: number;
  unit: TelegramCollectionFrequencyUnit;
} => {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return {
      value: 5,
      unit: 'seconds',
    };
  }

  const frequencyMs =
    telegramFrequencyToMs(
      parsed,
      unit,
    );

  if (
    !Number.isFinite(frequencyMs) ||
    frequencyMs >=
      TELEGRAM_MIN_FREQUENCY_MS
  ) {
    return {
      value: parsed,
      unit,
    };
  }

  return {
    value: 5,
    unit: 'seconds',
  };
};

export const isTelegramFrequencyUnit = (
  value: unknown,
): value is TelegramCollectionFrequencyUnit => {
  return (
    typeof value === 'string' &&
    TELEGRAM_ALLOWED_FREQUENCY_UNITS.includes(
      value as TelegramCollectionFrequencyUnit,
    )
  );
};

export const validateTelegramFrequency = (
  value: unknown,
  unit: unknown,
): TelegramValidationResult => {
  if (!isFinitePositiveNumber(value)) {
    return invalid(
      'Telegram frequency must be greater than zero.',
      'frequencyValue',
    );
  }

  if (!isTelegramFrequencyUnit(unit)) {
    return invalid(
      'Telegram frequency unit must be seconds, minutes, or hours.',
      'frequencyUnit',
    );
  }

  const frequencyMs =
    telegramFrequencyToMs(
      value,
      unit,
    );

  if (
    !Number.isFinite(frequencyMs) ||
    frequencyMs <
      TELEGRAM_MIN_FREQUENCY_MS
  ) {
    return invalid(
      'Telegram collections cannot run more frequently than once every 5 seconds.',
      'frequencyValue',
    );
  }

  return valid();
};

export const isTelegramBatchSize = (
  value: unknown,
): value is TelegramCollectionBatchSize => {
  const parsed = Number(value);

  return (
    Number.isInteger(parsed) &&
    TELEGRAM_ALLOWED_BATCH_SIZES.includes(
      parsed as TelegramCollectionBatchSize,
    )
  );
};

export const validateTelegramBatchSize = (
  value: unknown,
): TelegramValidationResult => {
  if (!isTelegramBatchSize(value)) {
    return invalid(
      'Telegram batch size must be 1, 2, 4, 6, or 8.',
      'batchSize',
    );
  }

  return valid();
};

export const isTelegramRepeatMode = (
  value: unknown,
): value is TelegramCollectionRepeatMode => {
  return (
    typeof value === 'string' &&
    TELEGRAM_ALLOWED_REPEAT_MODES.includes(
      value as TelegramCollectionRepeatMode,
    )
  );
};

export const validateTelegramRepeatMode = (
  value: unknown,
): TelegramValidationResult => {
  if (!isTelegramRepeatMode(value)) {
    return invalid(
      'Telegram repeat mode must be once or loop.',
      'repeatMode',
    );
  }

  return valid();
};

export const validateTelegramChannel = (
  channelId: unknown,
): TelegramValidationResult => {
  if (!isNonEmptyString(channelId)) {
    return invalid(
      'Telegram channel is required.',
      'channelId',
    );
  }

  return valid();
};

export const validateTelegramCollectionName = (
  name: unknown,
): TelegramValidationResult => {
  if (!isNonEmptyString(name)) {
    return invalid(
      'Telegram collection name is required.',
      'name',
    );
  }

  return valid();
};

export const validateTelegramTemplate = (
  template: unknown,
): TelegramValidationResult => {
  if (!isNonEmptyString(template)) {
    return invalid(
      'Telegram message template is required.',
      'template',
    );
  }

  return valid();
};

export const validateTelegramStartAt = (
  startAt: unknown,
): TelegramValidationResult => {
  if (
    startAt === null ||
    startAt === undefined ||
    startAt === ''
  ) {
    return valid();
  }

  if (typeof startAt !== 'string') {
    return invalid(
      'Telegram start time must be a valid date and time.',
      'startAt',
    );
  }

  const text = startAt.trim();

  if (!text) {
    return valid();
  }

  // Compatibility with the current TelegramPosts.tsx
  // <input type="time"> value, for example "14:30".
  if (
    /^([01]\d|2[0-3]):([0-5]\d)$/.test(
      text,
    )
  ) {
    return valid();
  }

  const parsed = Date.parse(text);

  if (!Number.isFinite(parsed)) {
    return invalid(
      'Telegram start time must be a valid date and time.',
      'startAt',
    );
  }

  return valid();
};

export const validateTelegramMaxFailures = (
  value: unknown,
): TelegramValidationResult => {
  const parsed =
    Number(value);

  if (
    !Number.isInteger(parsed) ||
    parsed <= 0
  ) {
    return invalid(
      'Maximum Telegram failures before pause must be a positive whole number.',
      'maxFailuresBeforePause',
    );
  }

  return valid();
};

export const validateTelegramSchedulerProduct = (
  product: unknown,
): TelegramValidationResult => {
  if (
    !product ||
    typeof product !== 'object'
  ) {
    return invalid(
      'Telegram product is invalid.',
      'products',
    );
  }

  const item =
    product as Partial<TelegramSchedulerProduct>;

  if (!isNonEmptyString(item.id)) {
    return invalid(
      'Telegram product ID is required.',
      'products',
    );
  }

  if (!isNonEmptyString(item.name)) {
    return invalid(
      'Telegram product name is required.',
      'products',
    );
  }

  if (!isNonEmptyString(item.imageUrl)) {
    return invalid(
      `Telegram product "${item.name || item.id}" requires an image.`,
      'products',
    );
  }

  if (
    typeof item.price !== 'number' ||
    !Number.isFinite(item.price) ||
    item.price < 0
  ) {
    return invalid(
      `Telegram product "${item.name}" has an invalid price.`,
      'products',
    );
  }

  if (
    typeof item.salePrice !== 'number' ||
    !Number.isFinite(item.salePrice) ||
    item.salePrice < 0
  ) {
    return invalid(
      `Telegram product "${item.name}" has an invalid sale price.`,
      'products',
    );
  }

  if (
    typeof item.stock !== 'number' ||
    !Number.isFinite(item.stock) ||
    item.stock < 0
  ) {
    return invalid(
      `Telegram product "${item.name}" has invalid stock.`,
      'products',
    );
  }

  return valid();
};

export const validateTelegramProducts = (
  products: unknown,
): TelegramValidationResult => {
  if (
    !Array.isArray(products) ||
    products.length === 0
  ) {
    return invalid(
      'Select at least one product for the Telegram collection.',
      'products',
    );
  }

  for (const product of products) {
    const result =
      validateTelegramSchedulerProduct(
        product,
      );

    if (!result.valid) {
      return result;
    }
  }

  return valid();
};

export const throwTelegramValidationError = (
  result: TelegramValidationResult,
): void => {
  if (result.valid) {
    return;
  }

  throw new TelegramClientError({
    kind: 'validation',
    message:
      result.message ||
      'Telegram request validation failed.',
    code: result.field,
  });
};
