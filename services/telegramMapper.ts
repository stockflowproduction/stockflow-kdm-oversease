import type {
  TelegramCollectionActivityItem,
  TelegramCollectionActivityRecord,
  TelegramCollectionFrequencyUnit,
  TelegramCollectionRepeatMode,
  TelegramCollectionStatus,
  TelegramLiveCollection,
  TelegramRuntimeCollection,
  TelegramSchedulerProduct,
} from '../types';

type UnknownRecord = Record<string, unknown>;

const isRecord = (
  value: unknown,
): value is UnknownRecord => {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
};

const safeText = (
  value: unknown,
  fallback = '',
): string => {
  const text =
    String(value ?? '').trim();

  return text || fallback;
};

const optionalText = (
  value: unknown,
): string | undefined => {
  const text = safeText(value);

  return text || undefined;
};

const nullableText = (
  value: unknown,
): string | null => {
  const text = safeText(value);

  return text || null;
};

const toNonNegativeNumber = (
  value: unknown,
  fallback = 0,
): number => {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return fallback;
  }

  return parsed;
};

const toNonNegativeInteger = (
  value: unknown,
  fallback = 0,
): number => {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed < 0
  ) {
    return fallback;
  }

  return Math.floor(parsed);
};

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

export const normalizeTelegramFrequencyUnit = (
  value: unknown,
): TelegramCollectionFrequencyUnit => {
  const normalized =
    safeText(value).toLowerCase();

  if (normalized === 'seconds') {
    return 'seconds';
  }

  if (normalized === 'hours') {
    return 'hours';
  }

  return 'minutes';
};

export const normalizeTelegramRepeatMode = (
  value: unknown,
): TelegramCollectionRepeatMode => {
  const normalized =
    safeText(value).toLowerCase();

  return normalized === 'once'
    ? 'once'
    : 'loop';
};

export const normalizeTelegramCollectionStatus = (
  value: unknown,
): TelegramCollectionStatus => {
  const normalized =
    safeText(value).toLowerCase();

  switch (normalized) {
    case 'running':
    case 'active':
      return 'running';

    case 'paused':
      return 'paused';

    case 'stopped':
    case 'cancelled':
    case 'canceled':
      return 'stopped';

    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';

    case 'failed':
    case 'error':
      return 'failed';

    default:
      return 'failed';
  }
};

const normalizeFrequencyValue = (
  value: unknown,
  unit: TelegramCollectionFrequencyUnit,
): number => {
  const parsed = Number(value);

  if (
    Number.isFinite(parsed) &&
    parsed > 0
  ) {
    return parsed;
  }

  return unit === 'seconds'
    ? 5
    : 1;
};

export const mapTelegramSchedulerProduct = (
  value: unknown,
): TelegramSchedulerProduct => {
  const entry =
    isRecord(value)
      ? value
      : {};

  const price =
    toNonNegativeNumber(
      entry.price ??
        entry.buyPrice,
      0,
    );

  const salePrice =
    toNonNegativeNumber(
      entry.salePrice ??
        entry.sellPrice ??
        entry.price ??
        entry.buyPrice,
      price,
    );

  return {
    id: safeText(
      entry.id ??
        entry.productId,
    ),

    name: safeText(
      entry.name ??
        entry.productName,
      'Unnamed product',
    ),

    description: safeText(
      entry.description,
    ),

    price,

    salePrice,

    imageUrl: safeText(
      entry.imageUrl ??
        entry.image,
    ),

    category: safeText(
      entry.category,
      'all',
    ),

    stock: toNonNegativeNumber(
      entry.stock,
      0,
    ),

    barcode:
      optionalText(
        entry.barcode,
      ),
  };
};

export const mapTelegramCollectionActivityRecord = (
  value: unknown,
): TelegramCollectionActivityRecord => {
  const entry =
    isRecord(value)
      ? value
      : {};

  return {
    timestamp: safeText(
      entry.timestamp ??
        entry.postedAt ??
        entry.createdAt ??
        entry.updatedAt,
    ),

    collectionId: safeText(
      entry.collectionId ??
        entry.id,
    ),

    collectionName: safeText(
      entry.collectionName ??
        entry.name,
    ),

    event: safeText(
      entry.event ??
        entry.status,
    ),

    productId: safeText(
      entry.productId,
    ),

    productName: safeText(
      entry.productName ??
        entry.lastPostedProductName,
    ),

    maskedChannelId: safeText(
      entry.maskedChannelId,
    ),

    telegramMessageId: safeText(
      entry.telegramMessageId ??
        entry.messageId,
    ),

    errorCode: safeText(
      entry.errorCode ??
        entry.code,
    ),

    errorMessage: safeText(
      entry.errorMessage ??
        entry.error ??
        entry.message,
    ),
  };
};

export const mapTelegramCollectionActivityItem = (
  value: unknown,
): TelegramCollectionActivityItem => {
  const entry =
    isRecord(value)
      ? value
      : {};

  const canonical =
    mapTelegramCollectionActivityRecord(
      entry,
    );

  const id =
    safeText(
      entry.id ??
        entry._id,
    ) ||
    [
      canonical.collectionId ||
        'activity',
      canonical.timestamp ||
        'unknown-time',
      canonical.event ||
        'event',
      canonical.productId ||
        'no-product',
    ].join('-');

  return {
    id,

    collectionId:
      canonical.collectionId ||
      undefined,

    collectionName:
      canonical.collectionName ||
      undefined,

    timestamp:
      canonical.timestamp ||
      undefined,

    event:
      canonical.event ||
      undefined,

    productId:
      canonical.productId ||
      undefined,

    productName:
      canonical.productName ||
      undefined,

    maskedChannelId:
      canonical.maskedChannelId ||
      undefined,

    telegramMessageId:
      canonical.telegramMessageId ||
      undefined,

    errorCode:
      canonical.errorCode ||
      undefined,

    errorMessage:
      canonical.errorMessage ||
      undefined,

    // Temporary legacy compatibility.
    status:
      canonical.event ||
      undefined,

    error:
      canonical.errorMessage ||
      undefined,

    postedAt:
      canonical.timestamp ||
      undefined,

    createdAt:
      optionalText(
        entry.createdAt,
      ) ??
      (
        canonical.timestamp ||
        undefined
      ),

    updatedAt:
      optionalText(
        entry.updatedAt,
      ),
  };
};

export const mapTelegramRuntimeCollection = (
  value: unknown,
  fallbackIndex = 0,
): TelegramRuntimeCollection => {
  const entry =
    isRecord(value)
      ? value
      : {};

  const rawProducts =
    Array.isArray(entry.products)
      ? entry.products
      : [];

  const products =
    rawProducts.map(
      mapTelegramSchedulerProduct,
    );

  const rawActivity =
    Array.isArray(entry.activity)
      ? entry.activity
      : [];

  const activity =
    rawActivity.map(
      mapTelegramCollectionActivityRecord,
    );

  const frequencyUnit =
    normalizeTelegramFrequencyUnit(
      entry.frequencyUnit ??
        (
          isRecord(entry.frequency)
            ? entry.frequency.unit
            : undefined
        ),
    );

  const frequencyValue =
    normalizeFrequencyValue(
      entry.frequencyValue ??
        (
          isRecord(entry.frequency)
            ? entry.frequency.value
            : undefined
        ),
      frequencyUnit,
    );

  const productCursor =
    toNonNegativeInteger(
      entry.productCursor ??
        entry.currentCursor ??
        entry.cursor,
      0,
    );

  const id =
    safeText(
      entry.id ??
        entry.collectionId ??
        entry._id,
    ) ||
    `telegram-collection-${fallbackIndex}`;

  return {
    ownerStoreId:
      optionalText(
        entry.ownerStoreId,
      ),

    id,

    name: safeText(
      entry.name ??
        entry.collectionName,
      'Unnamed collection',
    ),

    channelId: safeText(
      entry.channelId ??
        entry.channel,
    ),

    category: safeText(
      entry.category,
      'all',
    ),

    template: safeText(
      entry.template,
    ),

    notes: safeText(
      entry.notes,
    ),

    products,

    productsCount:
      toNonNegativeInteger(
        entry.productsCount ??
          entry.productCount ??
          products.length,
        products.length,
      ),

    batchSize:
      toPositiveInteger(
        entry.batchSize,
        2,
      ),

    productCursor,

    status:
      normalizeTelegramCollectionStatus(
        entry.status,
      ),

    frequencyValue,

    frequencyUnit,

    repeatMode:
      normalizeTelegramRepeatMode(
        entry.repeatMode,
      ),

    startAt:
      nullableText(
        entry.startAt,
      ),

    nextRunAt:
      nullableText(
        entry.nextRunAt ??
          entry.nextPostAt,
      ),

    lastRunAt:
      nullableText(
        entry.lastRunAt ??
          entry.lastPostedAt,
      ),

    lastPostedProductName:
      safeText(
        entry.lastPostedProductName ??
          entry.lastPostedProduct,
      ),

    lastTelegramMessageId:
      safeText(
        entry.lastTelegramMessageId ??
          entry.telegramMessageId,
      ),

    sentCount:
      toNonNegativeInteger(
        entry.sentCount ??
          entry.postedCount ??
          entry.successCount,
        0,
      ),

    failedCount:
      toNonNegativeInteger(
        entry.failedCount ??
          entry.failureCount,
        0,
      ),

    consecutiveFailures:
      toNonNegativeInteger(
        entry.consecutiveFailures,
        0,
      ),

    maxFailuresBeforePause:
      toPositiveInteger(
        entry.maxFailuresBeforePause,
        3,
      ),

    activity,

    createdAt:
      safeText(
        entry.createdAt,
      ),

    updatedAt:
      safeText(
        entry.updatedAt,
      ),

    startedAt:
      nullableText(
        entry.startedAt,
      ),

    stoppedAt:
      nullableText(
        entry.stoppedAt,
      ),
  };
};

export const mapTelegramLiveCollection = (
  value: unknown,
  fallbackIndex = 0,
): TelegramLiveCollection => {
  const runtime =
    mapTelegramRuntimeCollection(
      value,
      fallbackIndex,
    );

  return {
    id: runtime.id,
    collectionId: runtime.id,

    name: runtime.name,
    channelId: runtime.channelId,
    category: runtime.category,

    status: runtime.status,

    productsCount:
      runtime.productsCount,

    currentCursor:
      runtime.productCursor,

    productCursor:
      runtime.productCursor,

    sentCount:
      runtime.sentCount,

    failedCount:
      runtime.failedCount,

    consecutiveFailures:
      runtime.consecutiveFailures,

    lastPostedProduct:
      runtime.lastPostedProductName ||
      undefined,

    lastPostedProductName:
      runtime.lastPostedProductName ||
      undefined,

    lastTelegramMessageId:
      runtime.lastTelegramMessageId ||
      undefined,

    lastPostedAt:
      runtime.lastRunAt ||
      undefined,

    nextPostAt:
      runtime.nextRunAt ||
      undefined,
startAt:
      runtime.startAt,

    lastRunAt:
      runtime.lastRunAt,

    nextRunAt:
      runtime.nextRunAt,

    frequencyValue:
      runtime.frequencyValue,

    frequencyUnit:
      runtime.frequencyUnit,

    batchSize:
      runtime.batchSize,

    repeatMode:
      runtime.repeatMode,

    maxFailuresBeforePause:
      runtime.maxFailuresBeforePause,

    createdAt:
      runtime.createdAt ||
      undefined,

    updatedAt:
      runtime.updatedAt ||
      undefined,

    startedAt:
      runtime.startedAt,

    stoppedAt:
      runtime.stoppedAt,
  };
};

export const extractTelegramCollectionRows = (
  value: unknown,
): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  if (
    Array.isArray(value.collections)
  ) {
    return value.collections;
  }

  if (Array.isArray(value.data)) {
    return value.data;
  }

  if (Array.isArray(value.items)) {
    return value.items;
  }

  return [];
};

export const extractTelegramCollectionRow = (
  value: unknown,
): unknown | null => {
  if (!isRecord(value)) {
    return null;
  }

  if (
    isRecord(value.collection)
  ) {
    return value.collection;
  }

  if (
    isRecord(value.data)
  ) {
    return value.data;
  }

  return value;
};

export const extractTelegramActivityRows = (
  value: unknown,
): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }

  if (!isRecord(value)) {
    return [];
  }

  if (
    Array.isArray(value.activity)
  ) {
    return value.activity;
  }

  if (Array.isArray(value.data)) {
    return value.data;
  }

  if (Array.isArray(value.items)) {
    return value.items;
  }

  return [];
};
