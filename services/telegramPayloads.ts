import type {
  TelegramCollectionBatchSize,
  TelegramCollectionControlRequest,
  TelegramCollectionFrequencyUnit,
  TelegramCollectionRepeatMode,
  TelegramCollectionStartRequest,
  TelegramManualProductPostRequest,
  TelegramManualPostProduct,
  TelegramSchedulerProduct,
} from '../types';

import {
  isTelegramBatchSize,
  normalizeTelegramFrequencyFloor,
  throwTelegramValidationError,
  validateTelegramBatchSize,
  validateTelegramChannel,
  validateTelegramCollectionName,
  validateTelegramFrequency,
  validateTelegramMaxFailures,
  validateTelegramProducts,
  validateTelegramRepeatMode,
  validateTelegramStartAt,
  validateTelegramTemplate,
} from './telegramValidation';

export type TelegramCollectionStartInput = {
  id?: string;
  collectionId?: string;

  name: string;
  channelId: string;
  category?: string;

  template: string;
  notes?: string;

  frequencyValue: number;
  frequencyUnit: TelegramCollectionFrequencyUnit;

  batchSize: number;

  startAt?: string | null;
repeatMode: TelegramCollectionRepeatMode;
  maxFailuresBeforePause: number;

  products: TelegramSchedulerProduct[];
};

export type TelegramManualPostInput = {
  channelId: string;
  product: TelegramManualPostProduct;
  template: string;
  notes?: string;
};

const safeText = (
  value: unknown,
  fallback = '',
): string => {
  const text = String(value ?? '').trim();

  return text || fallback;
};

const normalizeTelegramTemplateTokens = (
  value: unknown,
): string =>
  safeText(value).replace(
    /\{telegram_details\}/g,
    '{telegram details}',
  );

const toPositiveInteger = (
  value: unknown,
  fallback: number,
): number => {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return fallback;
  }

  return Math.floor(parsed);
};

export const normalizeTelegramStartAt = (
  value: unknown,
): string | null => {
  const text = safeText(value);

  if (!text) {
    return null;
  }

  // Current TelegramPosts.tsx uses <input type="time">,
  // which produces values such as "14:30".
  // Convert that form value to the next local occurrence.
  const timeOnlyMatch =
    /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);

  if (timeOnlyMatch) {
    const hours = Number(timeOnlyMatch[1]);
    const minutes = Number(timeOnlyMatch[2]);

    const now = new Date();
    const scheduled = new Date(now);

    scheduled.setHours(
      hours,
      minutes,
      0,
      0,
    );

    if (
      scheduled.getTime() <=
      now.getTime()
    ) {
      scheduled.setDate(
        scheduled.getDate() + 1,
      );
    }

    return scheduled.toISOString();
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
};

const normalizeSchedulerProduct = (
  product: TelegramSchedulerProduct,
): TelegramSchedulerProduct => {
  return {
    id: safeText(product.id),

    name: safeText(
      product.name,
      'Unnamed product',
    ),

    description: safeText(
      product.description,
    ),

    price: Number(product.price),

    salePrice: Number(
      product.salePrice,
    ),

    imageUrl: safeText(
      product.imageUrl,
    ),

    category: safeText(
      product.category,
      'General',
    ),

    stock: Number(product.stock),

    barcode:
      safeText(product.barcode) ||
      undefined,
  };
};

export const buildTelegramCollectionStartRequest = (
  input: TelegramCollectionStartInput,
): TelegramCollectionStartRequest => {
  const frequency =
    normalizeTelegramFrequencyFloor(
      input.frequencyValue,
      input.frequencyUnit,
    );

  throwTelegramValidationError(
    validateTelegramCollectionName(
      input.name,
    ),
  );

  throwTelegramValidationError(
    validateTelegramChannel(
      input.channelId,
    ),
  );

  throwTelegramValidationError(
    validateTelegramTemplate(
      input.template,
    ),
  );

  throwTelegramValidationError(
    validateTelegramFrequency(
      frequency.value,
      frequency.unit,
    ),
  );

  throwTelegramValidationError(
    validateTelegramBatchSize(
      input.batchSize,
    ),
  );

  throwTelegramValidationError(
    validateTelegramRepeatMode(
      input.repeatMode,
    ),
  );

  throwTelegramValidationError(
    validateTelegramMaxFailures(
      input.maxFailuresBeforePause,
    ),
  );

  const rawStartAt = input.startAt ?? null;

  throwTelegramValidationError(
    validateTelegramStartAt(
      rawStartAt,
    ),
  );

  const products =
    input.products.map(
      normalizeSchedulerProduct,
    );

  throwTelegramValidationError(
    validateTelegramProducts(
      products,
    ),
  );

  if (
    !isTelegramBatchSize(
      input.batchSize,
    )
  ) {
    throw new Error(
      'Invalid Telegram batch size.',
    );
  }

  const batchSize =
    Number(
      input.batchSize,
    ) as TelegramCollectionBatchSize;

  const collectionId =
    safeText(
      input.collectionId ??
        input.id,
    ) ||
    undefined;

  return {
    ...(collectionId
      ? {
          collectionId,
        }
      : {}),

    name: safeText(
      input.name,
    ),

    channelId: safeText(
      input.channelId,
    ),

    category: safeText(
      input.category,
      'all',
    ),

    template: normalizeTelegramTemplateTokens(
      input.template,
    ),

    notes: safeText(
      input.notes,
    ),

    frequencyValue:
      frequency.value,

    frequencyUnit:
      frequency.unit,

    batchSize,

    startAt:
      normalizeTelegramStartAt(
        rawStartAt,
      ),

    repeatMode:
      input.repeatMode,

    maxFailuresBeforePause:
      toPositiveInteger(
        input.maxFailuresBeforePause,
        3,
      ),

    products,
  };
};

export const buildTelegramCollectionControlRequest = (
  collectionId: unknown,
): TelegramCollectionControlRequest => {
  const normalizedId =
    safeText(collectionId);

  if (!normalizedId) {
    throw new Error(
      'Telegram collection ID is required.',
    );
  }

  return {
    collectionId:
      normalizedId,
  };
};

export const buildTelegramManualPostRequest = (
  input: TelegramManualPostInput,
): TelegramManualProductPostRequest => {
  throwTelegramValidationError(
    validateTelegramChannel(
      input.channelId,
    ),
  );

  throwTelegramValidationError(
    validateTelegramTemplate(
      input.template,
    ),
  );

  const product = {
    id: safeText(
      input.product.id,
    ),

    name: safeText(
      input.product.name,
      'Unnamed product',
    ),

    price: Number(
      input.product.price,
    ),

    image: safeText(
      input.product.image,
    ),

    category: safeText(
      input.product.category,
      'General',
    ),

    stock: Number(
      input.product.stock,
    ),

    description:
      safeText(
        input.product.description,
      ) ||
      undefined,

    keywords:
      safeText(
        input.product.keywords,
      ) ||
      undefined,
  };

  if (!product.id) {
    throw new Error(
      'Telegram product ID is required.',
    );
  }

  if (!product.image) {
    throw new Error(
      'Telegram product image is required.',
    );
  }

  if (
    !Number.isFinite(
      product.price,
    ) ||
    product.price < 0
  ) {
    throw new Error(
      'Telegram product price is invalid.',
    );
  }

  if (
    !Number.isFinite(
      product.stock,
    ) ||
    product.stock < 0
  ) {
    throw new Error(
      'Telegram product stock is invalid.',
    );
  }

  return {
    channelId: safeText(
      input.channelId,
    ),

    product,

    template: normalizeTelegramTemplateTokens(
      input.template,
    ),

    notes: safeText(
      input.notes,
    ),
  };
};
