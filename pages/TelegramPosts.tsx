import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDebouncedValue } from '../src/hooks/useDebouncedValue';
import { Clock3, FolderPlus, Image as ImageIcon, Pause, Play, Plus, Save, Search, Send, Square, Trash2, X } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from '../components/ui';
import { getFriendlyErrorMessage } from '../services/errorMessages';
import { formatCurrency } from '../services/numberFormat';
import { loadData, updateTelegramProfileState } from '../services/storage';
import {
  createTelegramProductPost,
} from '../services/telegram';
import {
  Product,
  StoreProfile,
  TelegramCollectionFrequencyUnit,
  TelegramCollectionRepeatMode,
  TelegramLiveCollection,
  TelegramPostCollection,
  TelegramPostMode,
  TelegramSchedulerProduct,
} from '../types';
import { formatDateTimeDisplay } from '../src/utils/dateFormat';
import { useTelegramCollections } from '../src/hooks/useTelegramCollections';
import { useTelegramActivity } from '../src/hooks/useTelegramActivity';
import {
  toTelegramManualPostProduct,
  toTelegramSchedulerProducts,
} from '../services/telegramProductMapper';

const DEFAULT_TEMPLATE = `New arrival: {product_name}

Price: {price}
{telegram details}

Order now while stock lasts!`;

const TELEGRAM_MESSAGE_BOARD_BG = '/telegram/message-board-bg.jpg';

const TELEGRAM_FREQUENCY_UNITS = [
  'seconds',
  'minutes',
  'hours',
] as const;

const TELEGRAM_BATCH_OPTIONS = [
  1,
  2,
  4,
  6,
  8,
] as const;

const DEFAULT_FREQUENCY_VALUE = 1;
const MIN_SECONDS_FREQUENCY_VALUE = 5;

const DEFAULT_FREQUENCY_UNIT:
  TelegramCollectionFrequencyUnit =
    'minutes';
const DEFAULT_REPEAT_MODE: TelegramCollectionRepeatMode = 'loop';

const TELEGRAM_DEBUG_LOGS_ENABLED =
  String(
    (import.meta as any).env?.VITE_DEBUG_TELEGRAM_LOGS || 'false',
  ).toLowerCase() === 'true';

const DEFAULT_MAX_FAILURES_BEFORE_PAUSE = 5;
const DEFAULT_BATCH_SIZE = 2;

const TELEGRAM_CHANNEL_REQUIRED_MESSAGE =
  'Telegram Channel ID is required. Save a channel ID for this collection first.';

const safeText = (value: unknown, fallback = '') => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const normalizeTelegramChannelNames = (
  value: unknown,
): Record<string, string> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value)
  ) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(
      value as Record<string, unknown>,
    )
      .map(([channelId, name]) => [
        safeText(channelId),
        safeText(name),
      ])
      .filter(
        ([channelId, name]) =>
          Boolean(channelId && name),
      ),
  );
};

const toNonNegativeNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, parsed);
};

const normalizeTelegramFrequencyUnit = (
  value: unknown,
): TelegramCollectionFrequencyUnit => {
  const normalized =
    safeText(value).toLowerCase();

  return TELEGRAM_FREQUENCY_UNITS.includes(
    normalized as TelegramCollectionFrequencyUnit,
  )
    ? (normalized as TelegramCollectionFrequencyUnit)
    : DEFAULT_FREQUENCY_UNIT;
};

const normalizeTelegramFrequencyValue = (
  value: unknown,
  unit:
    TelegramCollectionFrequencyUnit =
      DEFAULT_FREQUENCY_UNIT,
) => {
  const parsed = Number(value);

  if (
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return unit === 'seconds'
      ? MIN_SECONDS_FREQUENCY_VALUE
      : DEFAULT_FREQUENCY_VALUE;
  }

  const integerValue =
    Math.max(
      1,
      Math.floor(parsed),
    );

  return unit === 'seconds'
    ? Math.max(
        MIN_SECONDS_FREQUENCY_VALUE,
        integerValue,
      )
    : integerValue;
};

const normalizeTelegramBatchSize = (
  value: unknown,
) => {
  const parsed = Number(value);

  return TELEGRAM_BATCH_OPTIONS.includes(
    parsed as
      | 1
      | 2
      | 4
      | 6
      | 8,
  )
    ? parsed
    : DEFAULT_BATCH_SIZE;
};

const formatDateTime = (value?: string) => {
  if (!value) {
    return 'Not yet';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Not yet';
  }

  return formatDateTimeDisplay(date);
};

const getProductImageUrl = (product?: Product | null) => {
  if (!product) {
    return '';
  }

  const imageObj = Array.isArray((product as any).images)
    ? (product as any).images[0]
    : null;

  return String(
    (product as any).thumbnailImage ||
      product.image ||
      (product as any).imageSrc ||
      (Array.isArray((product as any).galleryImages)
        ? (product as any).galleryImages[0]
        : '') ||
      imageObj?.src ||
      imageObj?.url ||
      '',
  ).trim();
};

const getProductName = (product?: Product | null) =>
  safeText(product?.name, 'Unnamed product');

const getProductCategory = (product?: Product | null) =>
  safeText(product?.category, 'General');

const getProductBarcode = (product?: Product | null) =>
  safeText(product?.barcode, '-');

const isProductInStock = (
  product?: Product | null,
) =>
  toNonNegativeNumber(
    product?.stock,
  ) > 0;

const normalizeTelegramKeywords = (
  value: unknown,
) =>
  safeText(value).replace(
    /^keywords\s*:\s*/i,
    '',
  );

const getProductTelegramKeywords = (product?: Product | null) =>
  normalizeTelegramKeywords(
    (product as any)?.telegramKeywords,
  );

const getTelegramDescription = (product?: Product | null) => {
  if (!product) {
    return '';
  }

  const description = safeText(product.description);
  const keywords = getProductTelegramKeywords(product);

  if (!keywords) {
    return description;
  }

  return [description, keywords]
    .filter(Boolean)
    .join('\n');
};

const sanitizeTelegramTemplate = (value?: string | null) => {
  const raw = safeText(value, DEFAULT_TEMPLATE).replace(
    /\{telegram_details\}/g,
    '{telegram details}',
  );

  const hasTelegramDetailsToken =
    raw.includes(
      '{telegram details}',
    );

  const withTelegramDetails = hasTelegramDetailsToken
    ? raw
    : raw.replace(
        /Price:\s*\{price\}/i,
        'Price: {price}\n{telegram details}',
      );

  return (
    withTelegramDetails
      .replace(/\n{3,}/g, '\n\n')
      .trim() || DEFAULT_TEMPLATE
  );
};

const toTelegramTimeInputValue = (value: unknown): string => {
  const text = safeText(value);

  if (!text) {
    return '';
  }

  const timeOnlyMatch = text.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/);

  if (timeOnlyMatch) {
    return `${timeOnlyMatch[1]}:${timeOnlyMatch[2]}`;
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  const hours = String(parsed.getHours()).padStart(2, '0');
  const minutes = String(parsed.getMinutes()).padStart(2, '0');

  return `${hours}:${minutes}`;
};

const normalizeCollections = (
  profile?: StoreProfile | null,
): TelegramPostCollection[] =>
  Array.isArray(profile?.telegramCollections)
    ? profile!.telegramCollections!.map((collection) => ({
        ...collection,

        category: safeText(
          collection.category,
          'all',
        ),

        channelId: safeText(
          collection.channelId,
        ),

        template: sanitizeTelegramTemplate(
          collection.template,
        ),

        notes: safeText(
          collection.notes,
        ),

        postMode:
          collection.postMode === 'out_of_stock' ||
          collection.postMode === 'filtered'
            ? collection.postMode
            : 'selected',

        queuedProductIds: Array.isArray(
          collection.queuedProductIds,
        )
          ? collection.queuedProductIds.filter(Boolean)
          : [],

        frequencyUnit:
          normalizeTelegramFrequencyUnit(
            collection.frequencyUnit,
          ),

        frequencyValue:
          normalizeTelegramFrequencyValue(
            collection.frequencyValue,
            normalizeTelegramFrequencyUnit(
              collection.frequencyUnit,
            ),
          ),

        batchSize:
          normalizeTelegramBatchSize(
            (collection as any).batchSize,
          ),
        startAt:
          safeText(
            (collection as any).startAt,
          ) || null,

        repeatMode: safeText(
          collection.repeatMode,
          DEFAULT_REPEAT_MODE,
        ) as TelegramCollectionRepeatMode,

        maxFailuresBeforePause:
          toNonNegativeNumber(
            collection.maxFailuresBeforePause,
            DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
          ) || DEFAULT_MAX_FAILURES_BEFORE_PAUSE,

        createdAt: safeText(
          collection.createdAt,
          new Date().toISOString(),
        ),

        updatedAt: safeText(
          collection.updatedAt,
          new Date().toISOString(),
        ),
}))
    : [];

export default function TelegramPosts() {
  const messageEditorRef =
    useRef<HTMLTextAreaElement | null>(
      null,
    );

  const [products, setProducts] =
    useState<Product[]>([]);

  const [profile, setProfile] =
    useState<StoreProfile | null>(null);

  const [postMode, setPostMode] =
    useState<TelegramPostMode>('selected');

  const [searchTerm, setSearchTerm] =
    useState('');
  const settledSearchTerm = useDebouncedValue(searchTerm);

  const [categoryFilter, setCategoryFilter] =
    useState('all');

  const [sortOption, setSortOption] =
    useState<
      | 'name-asc'
      | 'stock-desc'
      | 'stock-asc'
      | 'price-desc'
      | 'price-asc'
    >('name-asc');

  const [queueSearchTerm, setQueueSearchTerm] =
    useState('');
  const settledQueueSearchTerm = useDebouncedValue(queueSearchTerm);

  const [
    collectionProductSearchTerm,
    setCollectionProductSearchTerm,
  ] = useState('');

  const settledCollectionProductSearchTerm = useDebouncedValue(collectionProductSearchTerm);

  const [
    queuedProductIds,
    setQueuedProductIds,
  ] = useState<string[]>([]);

  const [
    previewProductId,
    setPreviewProductId,
  ] = useState('');

  const [
    telegramChannelId,
    setTelegramChannelId,
  ] = useState('');

  const [
    telegramChannels,
    setTelegramChannels,
  ] = useState<string[]>([]);

  const [
    telegramChannelNames,
    setTelegramChannelNames,
  ] = useState<Record<string, string>>({});

  const [
    telegramTemplate,
    setTelegramTemplate,
  ] = useState(DEFAULT_TEMPLATE);

  const [
    telegramNotes,
    setTelegramNotes,
  ] = useState('');

  const [
    telegramCollections,
    setTelegramCollections,
  ] = useState<TelegramPostCollection[]>([]);

const [
    activeCollectionId,
    setActiveCollectionId,
  ] = useState('');

  const [
    collectionName,
    setCollectionName,
  ] = useState('');

  const [
    collectionValidationMessage,
    setCollectionValidationMessage,
  ] = useState('');

  const [
    collectionChannelId,
    setCollectionChannelId,
  ] = useState('');

  const [
    collectionCategory,
    setCollectionCategory,
  ] = useState('all');

  const [
    frequencyValue,
    setFrequencyValue,
  ] = useState(
    String(DEFAULT_FREQUENCY_VALUE),
  );

  const [
    frequencyUnit,
    setFrequencyUnit,
  ] = useState<TelegramCollectionFrequencyUnit>(
    DEFAULT_FREQUENCY_UNIT,
  );

  const [batchSize, setBatchSize] =
    useState(
      String(DEFAULT_BATCH_SIZE),
    );

  const [
    startTimeInput,
    setStartTimeInput,
  ] = useState('');

const [
    repeatMode,
    setRepeatMode,
  ] = useState<TelegramCollectionRepeatMode>(
    DEFAULT_REPEAT_MODE,
  );

  const [
    maxFailuresBeforePause,
    setMaxFailuresBeforePause,
  ] = useState(
    String(
      DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
    ),
  );

  const [
    isSavingSettings,
    setIsSavingSettings,
  ] = useState(false);

  const [
    isSavingCollection,
    setIsSavingCollection,
  ] = useState(false);

  const [
    isSending,
    setIsSending,
  ] = useState(false);

const {
    collections:
      runningCollections,
start:
      startTelegramCollection,

    pause:
      pauseTelegramCollection,

    resume:
      resumeTelegramCollection,

    stop:
      stopTelegramCollection,
  
    isActionPending,
} = useTelegramCollections();

  const {
    selectedCollectionId:
      selectedActivityCollectionId,

    activity:
      selectedCollectionActivity,

    loading:
      isActivityLoading,

    loadActivity:
      loadTelegramActivity,
  } = useTelegramActivity();

const [
    selectedChannelId,
    setSelectedChannelId,
  ] = useState('');

  const [
    channelNameDraft,
    setChannelNameDraft,
  ] = useState('');

  const [
    isSavingChannelName,
    setIsSavingChannelName,
  ] = useState(false);

  const [
    newChannelId,
    setNewChannelId,
  ] = useState('');

  const [
    isCollectionModalOpen,
    setIsCollectionModalOpen,
  ] = useState(false);

  const [notice, setNotice] =
    useState<{
      type:
        | 'success'
        | 'error'
        | 'info';
      message: string;
    } | null>(null);

  const [
    expandedCategory,
    setExpandedCategory,
  ] = useState('');

  const [
    telegramContactNumbers,
    setTelegramContactNumbers,
  ] = useState<string[]>(['']);

  const [
    telegramAddressLink,
    setTelegramAddressLink,
  ] = useState('');

  const [
    telegramCustomDetails,
    setTelegramCustomDetails,
  ] = useState<
    Array<{
      label: string;
      value: string;
      hideKey: boolean;
    }>
  >([
    {
      label: 'Details1',
      value: '',
      hideKey: false,
    },
  ]);

  const refreshFromStore = () => {
    const data = loadData();
    const safeProfile = data.profile;

    const collections =
      normalizeCollections(
        safeProfile,
      );
setProducts(
      Array.isArray(data.products)
        ? data.products
        : [],
    );

    setProfile(safeProfile);

    setTelegramCollections(
      collections,
    );
setTelegramChannelId(
      safeText(
        safeProfile?.telegramChannelId,
      ),
    );

    const normalizedChannels =
      Array.from(
        new Set(
          [
            ...(Array.isArray(
              safeProfile?.telegramChannels,
            )
              ? safeProfile!
                  .telegramChannels!
              : []),

            ...collections.map(
              (collection) =>
                safeText(
                  collection.channelId,
                ),
            ),

            safeText(
              safeProfile?.telegramChannelId,
            ),
          ]
            .map((channelId) =>
              safeText(channelId),
            )
            .filter(Boolean),
        ),
      );

    setTelegramChannels(
      normalizedChannels,
    );

    setTelegramChannelNames(
      normalizeTelegramChannelNames(
        safeProfile?.telegramChannelNames,
      ),
    );

    setSelectedChannelId(
      (current) => {
        if (
          current &&
          normalizedChannels.includes(
            current,
          )
        ) {
          return current;
        }

        return (
          normalizedChannels[0] ||
          ''
        );
      },
    );

    setTelegramTemplate(
      sanitizeTelegramTemplate(
        safeProfile?.telegramTemplate,
      ),
    );

    setTelegramNotes(
      safeText(
        safeProfile?.telegramNotes,
      ),
    );

    const storedActiveCollectionId =
      safeText(
        safeProfile?.telegramActiveCollectionId,
      );

    const selectedCollection =
      collections.find(
        (collection) =>
          collection.id ===
          storedActiveCollectionId,
      ) || null;

    setActiveCollectionId(
      selectedCollection?.id || '',
    );

    setCollectionName(
      selectedCollection?.name || '',
    );

    setCollectionChannelId(
      selectedCollection?.channelId ||
        safeText(
          safeProfile?.telegramChannelId,
        ),
    );

    setCollectionCategory(
      selectedCollection?.category ||
        'all',
    );

    setFrequencyValue(
      String(
        selectedCollection?.frequencyValue ||
          DEFAULT_FREQUENCY_VALUE,
      ),
    );

    setFrequencyUnit(
      (selectedCollection?.frequencyUnit ||
        DEFAULT_FREQUENCY_UNIT) as TelegramCollectionFrequencyUnit,
    );

    setBatchSize(
      String(
        (selectedCollection as any)
          ?.batchSize ||
          DEFAULT_BATCH_SIZE,
      ),
    );
    setStartTimeInput(
      safeText(
        (selectedCollection as any)
          ?.startAt,
      ),
    );

    setRepeatMode(
      (selectedCollection?.repeatMode ||
        DEFAULT_REPEAT_MODE) as TelegramCollectionRepeatMode,
    );

    setMaxFailuresBeforePause(
      String(
        selectedCollection?.maxFailuresBeforePause ||
          DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
      ),
    );

    if (selectedCollection) {
      setTelegramChannelId(
        selectedCollection.channelId ||
          safeText(
            safeProfile?.telegramChannelId,
          ),
      );

      setCollectionChannelId(
        selectedCollection.channelId ||
          safeText(
            safeProfile?.telegramChannelId,
          ),
      );

      setTelegramTemplate(
        sanitizeTelegramTemplate(
          selectedCollection.template ||
            safeProfile?.telegramTemplate,
        ),
      );

      setTelegramNotes(
        selectedCollection.notes ||
          safeText(
            safeProfile?.telegramNotes,
          ),
      );

      setPostMode(
        selectedCollection.postMode,
      );

      setQueuedProductIds(
        selectedCollection.queuedProductIds ||
          [],
      );
      setPreviewProductId(
        safeText(
          selectedCollection
            .queuedProductIds?.[0],
        ),
      );

      setCategoryFilter(
        selectedCollection.category ||
          'all',
      );
    } else {
      setFrequencyValue(
        String(
          DEFAULT_FREQUENCY_VALUE,
        ),
      );

      setFrequencyUnit(
        DEFAULT_FREQUENCY_UNIT,
      );

      setBatchSize(
        String(
          DEFAULT_BATCH_SIZE,
        ),
      );

      setStartTimeInput('');


      setRepeatMode(
        DEFAULT_REPEAT_MODE,
      );

      setMaxFailuresBeforePause(
        String(
          DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
        ),
      );
      setPreviewProductId('');
    }
  };

  useEffect(() => {
    refreshFromStore();

    window.addEventListener(
      'storage',
      refreshFromStore,
    );

    window.addEventListener(
      'local-storage-update',
      refreshFromStore,
    );

    return () => {
      window.removeEventListener(
        'storage',
        refreshFromStore,
      );

      window.removeEventListener(
        'local-storage-update',
        refreshFromStore,
      );
    };
  }, []);

  const filterCategories =
    useMemo(
      () => [
        'all',

        ...Array.from(
          new Set(
            products
              .map((product) =>
                getProductCategory(
                  product,
                ),
              )
              .filter(
                Boolean,
              ) as string[],
          ),
        ).sort((a, b) =>
          a.localeCompare(b),
        ),
      ],

      [products],
    );

  const productCategoryGroups =
    useMemo(
      () =>
        filterCategories
          .filter(
            (category) =>
              category !== 'all',
          )
          .map((category) => ({
            category,

            products: products
              .filter(
                (product) =>
                  getProductCategory(
                    product,
                  ) === category &&
                  isProductInStock(
                    product,
                  ),
              )
              .sort(
                (left, right) =>
                  getProductName(
                    left,
                  ).localeCompare(
                    getProductName(
                      right,
                    ),
                  ),
              ),
          }))
          .filter(
            (group) =>
              group.products.length >
              0,
          ),

      [filterCategories, products],
    );

  useEffect(() => {
    if (!isCollectionModalOpen) {
      return;
    }

    if (
      productCategoryGroups.length ===
      0
    ) {
      if (expandedCategory) {
        setExpandedCategory('');
      }

      return;
    }

    if (
      !expandedCategory ||
      !productCategoryGroups.some(
        (group) =>
          group.category ===
          expandedCategory,
      )
    ) {
      setExpandedCategory(
        productCategoryGroups[0]
          .category,
      );
    }
  }, [
    expandedCategory,
    isCollectionModalOpen,
    productCategoryGroups,
  ]);

  const filteredProducts =
    useMemo(() => {
      const next =
        products.filter(
          (product) => {
            const haystack = [
              product.name,
              product.barcode,
              product.category,
              (product as any)
                .locationZone,
              (product as any)
                .locationRow,
              (product as any)
                .locationRack,
              (product as any)
                .locationShelf,
            ]
              .map((value) =>
                safeText(
                  value,
                ).toLowerCase(),
              )
              .join(' ');

            const matchesSearch =
              haystack.includes(
                settledSearchTerm
                  .trim()
                  .toLowerCase(),
              );

            const matchesCategory =
              categoryFilter ===
                'all' ||
              getProductCategory(
                product,
              ) ===
                categoryFilter;

            return (
              matchesSearch &&
              matchesCategory
            );
          },
        );

      next.sort(
        (left, right) => {
          if (
            sortOption ===
            'stock-desc'
          ) {
            return (
              toNonNegativeNumber(
                right.stock,
              ) -
              toNonNegativeNumber(
                left.stock,
              )
            );
          }

          if (
            sortOption ===
            'stock-asc'
          ) {
            return (
              toNonNegativeNumber(
                left.stock,
              ) -
              toNonNegativeNumber(
                right.stock,
              )
            );
          }

          if (
            sortOption ===
            'price-desc'
          ) {
            return (
              toNonNegativeNumber(
                right.sellPrice ||
                  right.buyPrice,
              ) -
              toNonNegativeNumber(
                left.sellPrice ||
                  left.buyPrice,
              )
            );
          }

          if (
            sortOption ===
            'price-asc'
          ) {
            return (
              toNonNegativeNumber(
                left.sellPrice ||
                  left.buyPrice,
              ) -
              toNonNegativeNumber(
                right.sellPrice ||
                  right.buyPrice,
              )
            );
          }

          return getProductName(
            left,
          ).localeCompare(
            getProductName(right),
          );
        },
      );

      return next;
    }, [
      products,
      settledSearchTerm,
      categoryFilter,
      sortOption,
    ]);

  const queuedProducts =
    useMemo(() => {
      const queueSet =
        new Set(
          queuedProductIds,
        );

      return queuedProductIds
        .map((id) =>
          products.find(
            (product) =>
              product.id === id,
          ),
        )
        .filter(
          (
            product,
          ): product is Product =>
            Boolean(
              product &&
                queueSet.has(
                  product.id,
                ),
            ),
        );
    }, [
      products,
      queuedProductIds,
    ]);

  const queueFilteredProducts =
    useMemo(() => {
      const needle =
        settledQueueSearchTerm
          .trim()
          .toLowerCase();

      if (!needle) {
        return queuedProducts;
      }

      return queuedProducts.filter(
        (product) => {
          const haystack =
            `${getProductName(
              product,
            )} ${getProductBarcode(
              product,
            )} ${getProductCategory(
              product,
            )}`.toLowerCase();

          return haystack.includes(
            needle,
          );
        },
      );
    }, [
      settledQueueSearchTerm,
      queuedProducts,
    ]);

  const filteredOutOfStockProducts =
    useMemo(() => {
      return filteredProducts.filter(
        (product) =>
          toNonNegativeNumber(
            product.stock,
          ) <= 0,
      );
    }, [filteredProducts]);

  const resolveProductsForPostMode =
    (
      mode: TelegramPostMode,
    ) => {
      if (mode === 'filtered') {
        return filteredProducts;
      }

      if (mode === 'out_of_stock') {
        return filteredOutOfStockProducts;
      }

      return queuedProducts;
    };

  const resolveQueuedIdsForPostMode =
    (
      mode: TelegramPostMode,
    ) => {
      if (mode === 'selected') {
        return queuedProductIds.filter(Boolean);
      }

      return Array.from(
        new Set(
          resolveProductsForPostMode(mode)
            .map((product) =>
              safeText(product.id),
            )
            .filter(Boolean),
        ),
      );
    };

  const resolveCollectionCategoryForPostMode =
    (
      mode: TelegramPostMode,
    ) => {
      if (mode === 'selected') {
        return (
          collectionCategory ||
          categoryFilter ||
          'all'
        );
      }

      return (
        categoryFilter ||
        collectionCategory ||
        'all'
      );
    };

  const getPostModeEmptyMessage = (
    mode: TelegramPostMode,
  ) => {
    if (mode === 'filtered') {
      return 'No products match the current page filters.';
    }

    if (mode === 'out_of_stock') {
      return 'No out-of-stock products match the current page filters.';
    }

    return 'Add at least one product before saving or starting a collection.';
  };

  const targetProducts =
    useMemo(() => {
      return resolveProductsForPostMode(
        postMode,
      );
    }, [
      filteredOutOfStockProducts,
      filteredProducts,
      postMode,
      queuedProducts,
    ]);

  const collectionProducts =
    queuedProducts;

  const expandedProductCategoryGroup =
    productCategoryGroups.find(
      (group) =>
        group.category ===
        expandedCategory,
    ) ||
    productCategoryGroups[0] ||
    null;

  const filteredExpandedCategoryProducts =
    useMemo(() => {
      const sourceProducts =
        expandedProductCategoryGroup?.products ||
        [];

      const searchValue =
        safeText(
          settledCollectionProductSearchTerm,
        ).toLowerCase();

      if (!searchValue) {
        return sourceProducts;
      }

      return sourceProducts.filter(
        (product) => {
          const haystack = [
            safeText(product.name),
            safeText(product.category),
            safeText(product.barcode),
            safeText(
              product.telegramDetails,
            ),
            safeText(
              product.telegramDescription,
            ),
          ]
            .join(' ')
            .toLowerCase();

          return haystack.includes(
            searchValue,
          );
        },
      );
    }, [
      expandedProductCategoryGroup,
      settledCollectionProductSearchTerm,
    ]);

  const addableExpandedCategoryProductIds =
    filteredExpandedCategoryProducts
      .map((product) => product.id)
      .filter(
        (id) =>
          !queuedProductIds.includes(
            id,
          ),
      );

  const previewProduct =
    products.find(
      (product) =>
        product.id ===
        previewProductId,
    ) ||
    targetProducts[0] ||
    queuedProducts[0] ||
    filteredProducts[0] ||
    null;

  const activeCollection =
    telegramCollections.find(
      (collection) =>
        collection.id ===
        activeCollectionId,
    ) || null;

  const categoryCollections =
    telegramCollections.filter(
      (collection) =>
        collection.category ===
          categoryFilter ||
        (categoryFilter ===
          'all' &&
          collection.category ===
            'all'),
    );

  const failedProducts =
    selectedCollectionActivity.filter(
      (entry) => entry.error,
    );

  const ownedRunningCollectionIds =
    useMemo(() => {
      return new Set(
        telegramCollections
          .map((collection) =>
            safeText(
              collection.id,
            ),
          )
          .filter(Boolean),
      );
    }, [telegramCollections]);

  const visibleRunningCollections =
    runningCollections.filter(
      (collection) => {
        const status =
          safeText(
            collection.status,
          ).toLowerCase();

        if (
          status === 'stopped' ||
          status === 'completed'
        ) {
          return false;
        }

        const backendCollectionId =
          safeText(
            collection.collectionId ||
              collection.id,
          );

        return (
          Boolean(
            backendCollectionId,
          ) &&
          ownedRunningCollectionIds.has(
            backendCollectionId,
          )
        );
      },
    );

  const hiddenForeignRunningCollectionsCount =
    Math.max(
      0,
      runningCollections.length -
        visibleRunningCollections.length,
    );

  const livePostedCount =
    visibleRunningCollections.reduce(
      (sum, entry) =>
        sum +
        toNonNegativeNumber(
          entry.sentCount,
        ),
      0,
    );

  const savedChannels =
    useMemo(
      () =>
        Array.from(
          new Set(
            [
              ...telegramChannels,

              ...telegramCollections.map(
                (collection) =>
                  safeText(
                    collection.channelId,
                  ),
              ),

              safeText(
                telegramChannelId,
              ),
            ]
              .map((channelId) =>
                safeText(
                  channelId,
                ),
              )
              .filter(Boolean),
          ),
        ),

      [
        telegramChannels,
        telegramCollections,
        telegramChannelId,
      ],
    );

  const hasSavedChannel =
    savedChannels.length > 0;

  const getChannelDisplayName = (
    channelId: string,
  ) => {
    const id = safeText(channelId);

    return safeText(
      telegramChannelNames[id],
      id,
    );
  };

  const selectedChannelDisplayName =
    getChannelDisplayName(
      selectedChannelId,
    );

  useEffect(() => {
    const channelId =
      safeText(
        selectedChannelId ||
          savedChannels[0],
      );

    setChannelNameDraft(
      channelId
        ? safeText(
            telegramChannelNames[channelId],
            channelId,
          )
        : '',
    );
  }, [
    savedChannels,
    selectedChannelId,
    telegramChannelNames,
  ]);

  const selectedChannelCollections =
    useMemo(
      () =>
        telegramCollections
          .filter(
            (collection) =>
              safeText(
                collection.channelId,
              ) ===
              safeText(
                selectedChannelId,
              ),
          )
          .sort(
            (left, right) =>
              left.name.localeCompare(
                right.name,
              ),
          ),

      [
        selectedChannelId,
        telegramCollections,
      ],
    );

  const activeChannelSavedCollections =
    useMemo(
      () =>
        telegramCollections
          .filter(
            (collection) =>
              safeText(
                collection.channelId,
              ) ===
              safeText(
                selectedChannelId,
              ),
          )
          .sort(
            (left, right) =>
              left.name.localeCompare(
                right.name,
              ),
          ),

      [
        selectedChannelId,
        telegramCollections,
      ],
    );

  const activeChannelRunningCollections =
    useMemo(
      () =>
        visibleRunningCollections
          .filter(
            (collection) =>
              safeText(
                collection.channelId,
              ) ===
              safeText(
                selectedChannelId,
              ),
          )
          .sort(
            (left, right) =>
              left.name.localeCompare(
                right.name,
              ),
          ),

      [
        selectedChannelId,
        visibleRunningCollections,
      ],
    );

  const runningCollectionsBySavedId =
    useMemo(() => {
      const next = new Map<
        string,
        TelegramLiveCollection
      >();

      visibleRunningCollections.forEach(
        (collection) => {
          const backendCollectionId =
            safeText(
              collection.collectionId ||
                collection.id,
            );

          if (
            backendCollectionId
          ) {
            next.set(
              backendCollectionId,
              collection,
            );
          }
        },
      );

      return next;
    }, [
      visibleRunningCollections,
    ]);

  const runningCollectionsByChannel =
    useMemo(() => {
      const groups =
        new Map<
          string,
          TelegramLiveCollection[]
        >();

      visibleRunningCollections.forEach(
        (collection) => {
          const channelId =
            safeText(
              collection.channelId,
              'Unassigned channel',
            );

          const current =
            groups.get(channelId) ||
            [];

          current.push(
            collection,
          );

          groups.set(
            channelId,
            current,
          );
        },
      );

      return Array.from(
        groups.entries(),
      )
        .map(
          ([
            channelId,
            collections,
          ]) => ({
            channelId,

            collections:
              collections.sort(
                (left, right) =>
                  left.name.localeCompare(
                    right.name,
                  ),
              ),
          }),
        )
        .sort(
          (left, right) =>
            left.channelId.localeCompare(
              right.channelId,
            ),
        );
    }, [
      visibleRunningCollections,
    ]);

  useEffect(() => {
    if (
      !savedChannels.length
    ) {
      if (
        selectedChannelId
      ) {
        setSelectedChannelId('');
      }

      return;
    }

    if (
      !savedChannels.includes(
        selectedChannelId,
      )
    ) {
      setSelectedChannelId(
        savedChannels[0],
      );
    }
  }, [
    savedChannels,
    selectedChannelId,
  ]);

  const buildCaption = (
    product: Product | null,
  ) => {
    if (!product) {
      return '';
    }

    const replacements: Record<
      string,
      string
    > = {
      '{product_name}':
        getProductName(product),

      '{price}':
        formatCurrency(
          toNonNegativeNumber(
            product.sellPrice ||
              product.buyPrice,
          ),
        ),

      '{barcode}':
        getProductBarcode(product),

      '{category}':
        getProductCategory(
          product,
        ),

      '{stock}':
        String(
          toNonNegativeNumber(
            product.stock,
          ),
        ),

      '{keywords}':
        getProductTelegramKeywords(
          product,
        ),

      '{telegram details}':
        getTelegramDescription(
          product,
        ),

      '{telegram_details}':
        getTelegramDescription(
          product,
        ),
    };

    let output =
      telegramTemplate ||
      DEFAULT_TEMPLATE;

    Object.entries(
      replacements,
    ).forEach(
      ([token, value]) => {
        output = output
          .split(token)
          .join(value);
      },
    );

    return output;
  };

  const buildMessageBoardText = (
    product: Product | null,
  ) => {
    const customValues =
      telegramCustomDetails
        .filter(
          (entry) =>
            entry.label.trim() ||
            entry.value.trim(),
        )
        .reduce<
          Record<string, string>
        >((acc, entry) => {
          const label =
            entry.label.trim();

          if (!label) {
            return acc;
          }

          acc[`{${label}}`] =
            entry.hideKey
              ? entry.value.trim()
              : `${label} : ${entry.value.trim()}`;

          return acc;
        }, {});

    const replacements: Record<
      string,
      string
    > = {
      ...customValues,

      '{product_name}':
        product
          ? getProductName(
              product,
            )
          : '{product_name}',

      '{price}':
        product
          ? formatCurrency(
              toNonNegativeNumber(
                product.sellPrice ||
                  product.buyPrice,
              ),
            )
          : '{price}',

      '{category}':
        product
          ? getProductCategory(
              product,
            )
          : '{category}',

      '{stock}':
        product
          ? String(
              toNonNegativeNumber(
                product.stock,
              ),
            )
          : '{stock}',

      '{telegram details}':
        product
          ? getTelegramDescription(
              product,
            )
          : '',

      '{telegram_details}':
        product
          ? getTelegramDescription(
              product,
            )
          : '',
    };

    let message =
      telegramTemplate.trim();

    Object.entries(
      replacements,
    ).forEach(
      ([token, value]) => {
        message = message
          .split(token)
          .join(value);
      },
    );

    return message
      .replace(
        /\n{3,}/g,
        '\n\n',
      )
      .trim();
  };

  const messageBoardContacts =
    telegramContactNumbers
      .map((value) =>
        value.trim(),
      )
      .filter(Boolean);

  const buildSchedulerProducts = (
    rows: Product[],
  ): TelegramSchedulerProduct[] =>
    toTelegramSchedulerProducts(
      rows,
    );

  const compactTemplateTokens = [
    '{product_name}',
    '{price}',
    '{category}',
    '{stock}',
    '{telegram details}',
    '{barcode}',
    '{keywords}',
  ];

  const insertTemplateToken =
    (token: string) => {
      const textarea =
        messageEditorRef.current;

      const currentValue =
        telegramTemplate ||
        DEFAULT_TEMPLATE;

      if (!textarea) {
        setTelegramTemplate(
          `${currentValue}${currentValue.endsWith('\n') ? '' : '\n'}${token}`,
        );
        return;
      }

      textarea.focus();

      const start =
        textarea.selectionStart ??
        currentValue.length;
      const end =
        textarea.selectionEnd ??
        currentValue.length;
      textarea.setRangeText(
        token,
        start,
        end,
        'end',
      );
      setTelegramTemplate(
        textarea.value,
      );
    };

  const resolveFrequencyValue =
    () => {
      return normalizeTelegramFrequencyValue(
        frequencyValue,
        frequencyUnit,
      );
    };

  const resolveMaxFailuresBeforePause =
    () => {
      return DEFAULT_MAX_FAILURES_BEFORE_PAUSE;
    };

  const resolveBatchSize =
    () => {
      return normalizeTelegramBatchSize(
        batchSize,
      );
    };

  const getResolvedTelegramChannelId =
    () =>
      safeText(
        telegramChannelId,
      ).trim();

  const requireTelegramChannelId =
    () => {
      const channelId =
        getResolvedTelegramChannelId();

      if (!channelId) {
        throw new Error(
          TELEGRAM_CHANNEL_REQUIRED_MESSAGE,
        );
      }

      return channelId;
    };

  const requireSavedCollectionChannelId =
    (
      value?: string | null,
    ) => {
      const channelId =
        safeText(value).trim() ||
        requireTelegramChannelId();

      if (!channelId) {
        throw new Error(
          TELEGRAM_CHANNEL_REQUIRED_MESSAGE,
        );
      }

      return channelId;
    };

  const persistTelegramProfile =
    async (
      nextValues: {
        telegramChannelId?: string;
        telegramChannels?: string[];
        telegramChannelNames?: Record<string, string>;
        telegramTemplate?: string;
        telegramNotes?: string;
        telegramCollections?: TelegramPostCollection[];
        telegramActiveCollectionId?: string;
      },

      options?: {
        successMessage?: string;
        suppressNotice?: boolean;
      },
    ) => {
      if (!profile) {
        return null;
      }

      const nextProfile: StoreProfile =
        {
          ...profile,

          telegramChannelId:
            nextValues.telegramChannelId ??
            telegramChannelId.trim(),

          telegramChannels:
            nextValues.telegramChannels ??
            telegramChannels,

          telegramChannelNames:
            nextValues.telegramChannelNames ??
            telegramChannelNames,

          telegramTemplate:
            nextValues.telegramTemplate ??
            (
              telegramTemplate.trim() ||
              DEFAULT_TEMPLATE
            ),

          telegramNotes:
            nextValues.telegramNotes ??
            telegramNotes.trim(),

          telegramCollections:
            nextValues.telegramCollections ??
            telegramCollections,
telegramActiveCollectionId:
            nextValues.telegramActiveCollectionId ??
            activeCollectionId,
        };

      const saved =
        await updateTelegramProfileState(
          {
            telegramChannelId:
              nextProfile.telegramChannelId,

            telegramChannels:
              nextProfile.telegramChannels,

            telegramChannelNames:
              nextProfile.telegramChannelNames,

            telegramTemplate:
              nextProfile.telegramTemplate,

            telegramNotes:
              nextProfile.telegramNotes,

            telegramCollections:
              nextProfile.telegramCollections,
telegramActiveCollectionId:
              nextProfile.telegramActiveCollectionId,
          },
        );

      setProfile(saved);

      setTelegramChannels(
        Array.isArray(
          saved.telegramChannels,
        )
          ? saved.telegramChannels
              .map((channelId) =>
                safeText(
                  channelId,
                ),
              )
              .filter(Boolean)
          : [],
      );

      setTelegramCollections(
        normalizeCollections(
          saved,
        ),
      );

      setTelegramChannelNames(
        normalizeTelegramChannelNames(
          saved.telegramChannelNames,
        ),
      );
return saved;
    };

  const addTelegramChannel =
    async () => {
      const channelId =
        safeText(
          newChannelId,
        );

      if (!channelId) {
        setNotice({
          type: 'error',

          message:
            'Channel ID is required.',
        });

        return;
      }

      if (
        hasSavedChannel &&
        !savedChannels.includes(
          channelId,
        )
      ) {
        setNotice({
          type: 'error',

          message:
            'Only one Telegram channel can be added.',
        });

        return;
      }

      const nextChannels =
        Array.from(
          new Set([
            ...savedChannels,
            channelId,
          ]),
        );

      try {
        const saved =
          await persistTelegramProfile(
            {
              telegramChannels:
                nextChannels,

              telegramChannelId:
                safeText(
                  telegramChannelId,
                ) || channelId,
            },

            {
              suppressNotice:
                true,
            },
          );

        if (saved) {
          setTelegramChannelId(
            (current) =>
              current ||
              channelId,
          );

          setSelectedChannelId(
            channelId,
          );

          setNewChannelId('');

          setNotice({
            type: 'success',

            message:
              'Channel added.',
          });
        }
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            getFriendlyErrorMessage(
              error,
              'telegram.channel_add',
            ),
        });
      }
    };

  const saveSelectedChannelName =
    async () => {
      const previousChannelId =
        safeText(
          selectedChannelId ||
            savedChannels[0],
        );

      if (!previousChannelId) {
        setNotice({
          type: 'error',

          message:
            'Select a Telegram channel first.',
        });

        return;
      }

      const nextChannelId =
        channelNameDraft.trim();

      if (!nextChannelId) {
        setNotice({
          type: 'error',

          message:
            'Channel name is required.',
        });

        return;
      }

      if (
        nextChannelId !== previousChannelId &&
        savedChannels.includes(
          nextChannelId,
        )
      ) {
        setNotice({
          type: 'error',

          message:
            'That Telegram channel already exists.',
        });

        return;
      }

      const renameChannelId = (
        value: unknown,
      ) =>
        safeText(value) ===
        previousChannelId
          ? nextChannelId
          : safeText(value);

      const nextChannels =
        Array.from(
          new Set(
            savedChannels
              .map(renameChannelId)
              .filter(Boolean),
          ),
        );

      const nextCollections =
        telegramCollections.map(
          (collection) => ({
            ...collection,
            channelId:
              renameChannelId(
                collection.channelId,
              ),
          }),
        );

      const nextNames = {
        ...telegramChannelNames,
      };

      delete nextNames[
        previousChannelId
      ];
      delete nextNames[
        nextChannelId
      ];

      setIsSavingChannelName(true);
      setNotice(null);

      try {
        const saved =
          await persistTelegramProfile({
            telegramChannelId:
              renameChannelId(
                telegramChannelId,
              ) || nextChannelId,

            telegramChannels:
              nextChannels,

            telegramChannelNames:
              nextNames,

            telegramCollections:
              nextCollections,

            telegramActiveCollectionId:
              activeCollectionId,
          });

        if (saved) {
          setTelegramChannelId(
            renameChannelId(
              telegramChannelId,
            ) || nextChannelId,
          );

          setTelegramChannels(
            nextChannels,
          );

          setTelegramCollections(
            nextCollections,
          );

          setSelectedChannelId(
            nextChannelId,
          );

          setCollectionChannelId(
            (current) =>
              renameChannelId(
                current,
              ) || nextChannelId,
          );

          setChannelNameDraft(
            nextChannelId,
          );

          setTelegramChannelNames(
            normalizeTelegramChannelNames(
              saved.telegramChannelNames,
            ),
          );

          setNotice({
            type: 'success',

            message:
              'Channel renamed.',
          });
        }
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            getFriendlyErrorMessage(
              error,
              'telegram.channel_name',
            ),
        });
      } finally {
        setIsSavingChannelName(
          false,
        );
      }
    };

  const addProductToQueue = (
    productId: string,
  ) => {
    setQueuedProductIds(
      (current) =>
        current.includes(
          productId,
        )
          ? current
          : [
              ...current,
              productId,
            ],
    );
    setPreviewProductId(productId);
  };

  const addProductsToQueue = (
    productIds: string[],
  ) => {
    setQueuedProductIds(
      (current) => {
        const next = new Set(
          current,
        );

        productIds.forEach((id) => {
          if (id) {
            next.add(id);
          }
        });

        return Array.from(next);
      },
    );
  };

  const removeProductFromQueue =
    (productId: string) => {
      setQueuedProductIds(
        (current) =>
          current.filter(
            (id) =>
            id !== productId,
          ),
      );
      setPreviewProductId((current) =>
        current === productId
          ? ''
          : current,
      );
    };

  const clearQueue = () => {
    setQueuedProductIds([]);
    setPreviewProductId('');
  };

  const loadCollection = (
    collectionId: string,
  ) => {
    const collection =
      telegramCollections.find(
        (item) =>
          item.id ===
          collectionId,
      );

    setActiveCollectionId(
      collection?.id || '',
    );

    setCollectionName(
      collection?.name || '',
    );

    setCollectionChannelId(
      collection?.channelId ||
        safeText(
          profile?.telegramChannelId,
        ),
    );

    setCollectionCategory(
      collection?.category ||
        'all',
    );

    if (!collection) {
      setFrequencyValue(
        String(
          DEFAULT_FREQUENCY_VALUE,
        ),
      );

      setFrequencyUnit(
        DEFAULT_FREQUENCY_UNIT,
      );

      setBatchSize(
        String(
          DEFAULT_BATCH_SIZE,
        ),
      );

      setStartTimeInput('');


      setRepeatMode(
        DEFAULT_REPEAT_MODE,
      );

      setMaxFailuresBeforePause(
        String(
          DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
        ),
      );

      return;
    }

    setTelegramChannelId(
      collection.channelId,
    );

    setTelegramTemplate(
      collection.template ||
        DEFAULT_TEMPLATE,
    );

    setTelegramNotes(
      collection.notes,
    );

    setPostMode(
      collection.postMode ===
        'filtered' ||
        collection.postMode ===
          'out_of_stock'
        ? collection.postMode
        : 'selected',
    );

    setQueuedProductIds(
      collection.queuedProductIds ||
        [],
    );

    setCategoryFilter(
      collection.category ||
        'all',
    );

    setFrequencyValue(
      String(
        collection.frequencyValue ||
          DEFAULT_FREQUENCY_VALUE,
      ),
    );

    setFrequencyUnit(
      (collection.frequencyUnit ||
        DEFAULT_FREQUENCY_UNIT) as TelegramCollectionFrequencyUnit,
    );

    setBatchSize(
      String(
        (collection as any)
          .batchSize ||
          DEFAULT_BATCH_SIZE,
      ),
    );
    setStartTimeInput(
      safeText(
        (collection as any)
          .startAt,
      ),
    );

    setRepeatMode(
      (collection.repeatMode ||
        DEFAULT_REPEAT_MODE) as TelegramCollectionRepeatMode,
    );

    setMaxFailuresBeforePause(
      String(
        collection.maxFailuresBeforePause ||
          DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
      ),
    );

    void persistTelegramProfile(
      {
        telegramActiveCollectionId:
          collection.id,
      },

      {
        suppressNotice: true,
      },
    );
  };

  const saveTelegramSettings =
    async () => {
      setIsSavingSettings(true);

      setNotice(null);

      try {
        const channelId =
          requireTelegramChannelId();

        const saved =
          await persistTelegramProfile(
            {
              telegramChannelId:
                channelId,

              telegramChannels:
                Array.from(
                  new Set([
                    ...savedChannels,
                    channelId,
                  ]),
                ),

              telegramTemplate:
                telegramTemplate.trim() ||
                DEFAULT_TEMPLATE,

              telegramNotes:
                telegramNotes.trim(),
            },
          );

        if (saved) {
          setTelegramChannelId(
            safeText(
              saved.telegramChannelId,
            ),
          );

          setTelegramTemplate(
            safeText(
              saved.telegramTemplate,
              DEFAULT_TEMPLATE,
            ),
          );

          setTelegramNotes(
            safeText(
              saved.telegramNotes,
            ),
          );

          setNotice({
            type: 'success',

            message:
              'Telegram default settings saved.',
          });
        }
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            getFriendlyErrorMessage(
              error,
              'telegram.settings',
            ),
        });
      } finally {
        setIsSavingSettings(
          false,
        );
      }
    };

  const saveCollection =
    async () => {
      const trimmedName =
        collectionName.trim();
      const trimmedStartTime =
        startTimeInput.trim();

      if (!trimmedName) {
        setCollectionValidationMessage(
          'Collection name is required.',
        );
        setNotice({
          type: 'error',

          message:
            'Collection name is required.',
        });

        return;
      }

      const resolvedQueuedIds =
        resolveQueuedIdsForPostMode(
          postMode,
        );


      setIsSavingCollection(
        true,
      );

      setCollectionValidationMessage(
        '',
      );
      setNotice(null);

      try {
        const channelId =
          safeText(
            collectionChannelId,
          ).trim() ||
          requireTelegramChannelId();

        const now =
          new Date().toISOString();

        const nextCollection: TelegramPostCollection =
          {
            id:
              activeCollection?.id ||
              `telegram-collection-${Date.now()}`,

            name: trimmedName,

            category:
              resolveCollectionCategoryForPostMode(
                postMode,
              ),

            channelId,

            template:
              telegramTemplate.trim() ||
              DEFAULT_TEMPLATE,

            notes:
              telegramNotes.trim(),

            postMode,

            queuedProductIds:
              resolvedQueuedIds,

            frequencyValue:
              resolveFrequencyValue(),

            frequencyUnit,

            batchSize:
              resolveBatchSize(),
          startAt:
            trimmedStartTime ||
            null,

            repeatMode,

            maxFailuresBeforePause:
              resolveMaxFailuresBeforePause(),

            createdAt:
              activeCollection?.createdAt ||
              now,

            updatedAt: now,
};

        const nextCollections =
          activeCollection
            ? telegramCollections.map(
                (collection) =>
                  collection.id ===
                  activeCollection.id
                    ? nextCollection
                    : collection,
              )
            : [
                nextCollection,
                ...telegramCollections,
              ].sort(
                (left, right) =>
                  left.name.localeCompare(
                    right.name,
                  ),
              );

        const saved =
          await persistTelegramProfile(
            {
              telegramChannelId:
                channelId,

              telegramChannels:
                Array.from(
                  new Set([
                    ...savedChannels,
                    channelId,
                  ]),
                ),

              telegramCollections:
                nextCollections,

              telegramActiveCollectionId:
                nextCollection.id,
            },
          );

        if (saved) {
          setActiveCollectionId(
            nextCollection.id,
          );

          setCollectionName(
            nextCollection.name,
          );

          setCollectionChannelId(
            nextCollection.channelId,
          );

          setCollectionCategory(
            nextCollection.category,
          );

          setNotice({
            type: 'success',

            message:
              activeCollection
                ? 'Collection updated.'
                : 'Collection created.',
          });
        }
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            getFriendlyErrorMessage(
              error,
              'telegram.collection_save',
            ),
        });
      } finally {
        setIsSavingCollection(
          false,
        );
      }
    };

  const deleteCollectionById =
    async (
      collectionId: string,
    ) => {
      const targetCollection =
        telegramCollections.find(
          (collection) =>
            collection.id ===
            collectionId,
        );

      if (!targetCollection) {
        return;
      }

      setIsSavingCollection(
        true,
      );

      setNotice(null);

      try {
        const nextCollections =
          telegramCollections.filter(
            (collection) =>
              collection.id !==
              targetCollection.id,
          );

        await persistTelegramProfile({
          telegramCollections:
            nextCollections,

          telegramActiveCollectionId:
            '',
        });

        if (
          activeCollection?.id ===
          targetCollection.id
        ) {
          setActiveCollectionId('');

          setCollectionName('');

          setCollectionChannelId(
            safeText(
              selectedChannelId ||
                profile?.telegramChannelId,
            ),
          );

          setCollectionCategory(
            categoryFilter,
          );
        }

        setNotice({
          type: 'success',

          message:
            'Collection removed.',
        });
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            getFriendlyErrorMessage(
              error,
              'telegram.collection_delete',
            ),
        });
      } finally {
        setIsSavingCollection(
          false,
        );
      }
    };

  const deleteCollection =
    async () => {
      if (!activeCollection) {
        return;
      }

      await deleteCollectionById(
        activeCollection.id,
      );
    };

  const createFreshCollectionDraft =
    (
      preferredChannelId?: string,
    ) => {
      setActiveCollectionId('');

      setCollectionName('');
      setCollectionValidationMessage('');
      setPostMode('selected');
      setQueuedProductIds([]);
      setPreviewProductId('');
      setQueueSearchTerm('');
      setCollectionProductSearchTerm('');

      const nextChannelId =
        safeText(
          preferredChannelId ||
            selectedChannelId ||
            telegramChannelId,
        ).trim();

      setCollectionChannelId(
        nextChannelId,
      );

      setTelegramChannelId(
        nextChannelId,
      );

      setCollectionCategory(
        categoryFilter,
      );

      setFrequencyValue(
        String(
          DEFAULT_FREQUENCY_VALUE,
        ),
      );

      setFrequencyUnit(
        DEFAULT_FREQUENCY_UNIT,
      );

      setBatchSize(
        String(
          DEFAULT_BATCH_SIZE,
        ),
      );

      setStartTimeInput('');


      setRepeatMode(
        DEFAULT_REPEAT_MODE,
      );

      setMaxFailuresBeforePause(
        String(
          DEFAULT_MAX_FAILURES_BEFORE_PAUSE,
        ),
      );
    };

  const openCollectionModal =
    (
      channelId?: string,
      collectionId?: string,
    ) => {
      const resolvedChannelId =
        safeText(
          channelId ||
            selectedChannelId ||
            telegramChannelId,
        );

      if (collectionId) {
        loadCollection(
          collectionId,
        );
      } else {
        createFreshCollectionDraft(
          resolvedChannelId,
        );
      }

      if (resolvedChannelId) {
        setSelectedChannelId(
          resolvedChannelId,
        );

        setCollectionChannelId(
          resolvedChannelId,
        );

        setTelegramChannelId(
          resolvedChannelId,
        );
      }

      setCollectionValidationMessage('');
      setIsCollectionModalOpen(
        true,
      );
    };

  const ensureCollectionSaved =
    async () => {
      const trimmedName =
        collectionName.trim();
      const trimmedStartTime =
        startTimeInput.trim();

      if (!trimmedName) {
        setCollectionValidationMessage(
          'Collection name is required.',
        );
        throw new Error(
          'Collection name is required.',
        );
      }

      const resolvedQueuedIds =
        resolveQueuedIdsForPostMode(
          postMode,
        );

      if (!resolvedQueuedIds.length) {
        const message =
          getPostModeEmptyMessage(
            postMode,
          );
        setCollectionValidationMessage(
          message,
        );
        throw new Error(message);
      }


      const channelId =
        safeText(
          collectionChannelId,
        ).trim() ||
        requireTelegramChannelId();

      const now =
        new Date().toISOString();

      const nextCollection: TelegramPostCollection =
        {
          id:
            activeCollection?.id ||
            `telegram-collection-${Date.now()}`,

          name:
            trimmedName,

          category:
            resolveCollectionCategoryForPostMode(
              postMode,
            ),

          channelId,

          template:
            telegramTemplate.trim() ||
            DEFAULT_TEMPLATE,

          notes:
            telegramNotes.trim(),

          postMode,

          queuedProductIds:
            resolvedQueuedIds,

          frequencyValue:
            resolveFrequencyValue(),

          frequencyUnit,

          batchSize:
            resolveBatchSize(),
          startAt:
            trimmedStartTime ||
            null,

          repeatMode,

          maxFailuresBeforePause:
            resolveMaxFailuresBeforePause(),

          createdAt:
            activeCollection?.createdAt ||
            now,

          updatedAt:
            now,
};

      const nextCollections =
        activeCollection
          ? telegramCollections.map(
              (collection) =>
                collection.id ===
                activeCollection.id
                  ? nextCollection
                  : collection,
            )
          : [
              nextCollection,
              ...telegramCollections,
            ].sort(
              (left, right) =>
                left.name.localeCompare(
                  right.name,
                ),
            );

      const saved =
        await persistTelegramProfile({
          telegramChannelId:
            channelId,

          telegramChannels:
            Array.from(
              new Set([
                ...savedChannels,
                channelId,
              ]),
            ),

          telegramCollections:
            nextCollections,

          telegramActiveCollectionId:
            nextCollection.id,
        });

      if (!saved) {
        throw new Error(
          'Collection could not be saved.',
        );
      }

      setActiveCollectionId(
        nextCollection.id,
      );

      setCollectionName(
        nextCollection.name,
      );

      setCollectionChannelId(
        nextCollection.channelId,
      );

      setCollectionCategory(
        nextCollection.category,
      );

      return nextCollection;
    };

  const loadActivityForCollection =
    async (id: string) => {
      try {
        await loadTelegramActivity(
          id,
        );
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            error instanceof Error
              ? error.message
              : 'Backend not reachable',
        });
      }
    };

  const handleCollectionAction =
    async (
      action:
        | 'pause'
        | 'resume'
        | 'stop',

      collection:
        TelegramLiveCollection,

      handler:
        () => Promise<unknown>,

      successMessage:
        string,
    ) => {
      const collectionId =
        safeText(
          collection.collectionId ||
            collection.id,
        );

      if (
        TELEGRAM_DEBUG_LOGS_ENABLED
      ) {
        console.log(
          'telegram.collection.control',
          {
            action,

            collectionId,

            collectionName:
              collection.name,

            status:
              collection.status,

            hasCollectionId:
              Boolean(
                collectionId,
              ),
          },
        );
      }

      if (!collectionId) {
        setNotice({
          type: 'error',

          message:
            'Collection ID missing. Refresh live collections and try again.',
        });

        return;
      }
try {
        await handler();

        setNotice({
          type: 'success',

          message:
            successMessage,
        });
if (
          selectedActivityCollectionId ===
          collectionId
        ) {
          await loadActivityForCollection(
            collectionId,
          );
        }
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            error instanceof Error
              ? error.message
              : 'Backend not reachable',
        });
      }
    };

  const getSavedCollectionProducts =
    (
      collection:
        TelegramPostCollection,
    ) => {
      const queueSet =
        new Set(
          collection.queuedProductIds ||
            [],
        );

      return (
        collection.queuedProductIds ||
        []
      )
        .map((id) =>
          products.find(
            (product) =>
              product.id === id,
          ),
        )
        .filter(
          (
            product,
          ): product is Product =>
            Boolean(
              product &&
                queueSet.has(
                  product.id,
                ),
            ),
        );
    };

  const startSavedCollectionRun =
    async (
      collection:
        TelegramPostCollection,
    ) => {
      const collectionProductsToSend =
        getSavedCollectionProducts(
          collection,
        );

      if (
        !collectionProductsToSend.length
      ) {
        setNotice({
          type: 'error',

          message:
            'Add at least one product before starting a collection.',
        });

        return;
      }

      const missingImageProduct =
        collectionProductsToSend.find(
          (product) =>
            !getProductImageUrl(
              product,
            ),
        );

      if (missingImageProduct) {
        setNotice({
          type: 'error',

          message:
            'Product missing image.',
        });

        return;
      }
setActiveCollectionId(
        collection.id,
      );

      setNotice({
        type: 'info',

        message:
          `Starting ${collection.name}...`,
      });

      try {
        console.log(
          'startSavedCollectionRun.try',
          collection.id,
        );

        const channelId =
          requireSavedCollectionChannelId(
            collection.channelId,
          );

        const schedulerProducts =
          buildSchedulerProducts(
            collectionProductsToSend,
          );

        await startTelegramCollection({
          id: collection.id,

          collectionId:
            collection.id,

          name:
            collection.name,

          channelId:
            channelId,

          template:
            collection.template,

          notes:
            collection.notes,

          category:
            collection.category,

          frequencyValue:
            collection.frequencyValue ||
            DEFAULT_FREQUENCY_VALUE,

          frequencyUnit:
            (collection.frequencyUnit ||
              DEFAULT_FREQUENCY_UNIT) as TelegramCollectionFrequencyUnit,

          batchSize:
            (collection as any)
              .batchSize ||
            DEFAULT_BATCH_SIZE,
          startAt:
            (collection as any)
              .startAt ??
            null,

          repeatMode:
            (collection.repeatMode ||
              DEFAULT_REPEAT_MODE) as TelegramCollectionRepeatMode,

          maxFailuresBeforePause:
            collection.maxFailuresBeforePause ||
            DEFAULT_MAX_FAILURES_BEFORE_PAUSE,

          postMode:
            'selected',

          products:
            schedulerProducts,
        });
setNotice({
          type: 'success',

          message:
            'Collection started',
        });
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            error instanceof Error
              ? error.message
              : 'Backend not reachable',
        });

        console.log(
          'startSavedCollectionRun.catch',
          error instanceof Error
            ? error.message
            : 'Backend not reachable',
        );
      }
    };

  const startCollectionRun =
    async () => {
      const resolvedCollectionProducts =
        resolveProductsForPostMode(
          postMode,
        );

      if (
        !resolvedCollectionProducts.length
      ) {
        setNotice({
          type: 'error',

          message:
            getPostModeEmptyMessage(
              postMode,
            ),
        });

        return;
      }

      const missingImageProduct =
        resolvedCollectionProducts.find(
          (product) =>
            !getProductImageUrl(
              product,
            ),
        );

      if (missingImageProduct) {
        setNotice({
          type: 'error',

          message:
            'Product missing image.',
        });

        return;
      }
      setNotice({
        type: 'info',

        message:
          'Starting Telegram collection...',
      });

      try {
        const savedCollection =
          await ensureCollectionSaved();

        const schedulerProducts =
          buildSchedulerProducts(
            resolvedCollectionProducts,
          );

        await startTelegramCollection({
          id:
            savedCollection.id,

          collectionId:
            savedCollection.id,

          name:
            savedCollection.name,

          channelId:
            savedCollection.channelId,

          template:
            savedCollection.template,

          notes:
            savedCollection.notes,

          category:
            savedCollection.category,

          frequencyValue:
            savedCollection.frequencyValue ||
            DEFAULT_FREQUENCY_VALUE,

          frequencyUnit:
            (savedCollection.frequencyUnit ||
              DEFAULT_FREQUENCY_UNIT) as TelegramCollectionFrequencyUnit,

          batchSize:
            (savedCollection as any)
              .batchSize ||
            DEFAULT_BATCH_SIZE,
          startAt:
            (savedCollection as any)
              .startAt ??
            null,

          repeatMode:
            (savedCollection.repeatMode ||
              DEFAULT_REPEAT_MODE) as TelegramCollectionRepeatMode,

          maxFailuresBeforePause:
            savedCollection.maxFailuresBeforePause ||
            DEFAULT_MAX_FAILURES_BEFORE_PAUSE,

          postMode:
            'selected',

          products:
            schedulerProducts,
        });
setNotice({
          type: 'success',

          message:
            'Collection started',
        });
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            error instanceof Error
              ? error.message
              : 'Backend not reachable',
        });
      }
    };

  const sendPosts =
    async () => {
      if (
        !targetProducts.length
      ) {
        setNotice({
          type: 'error',

          message:
            'No products are ready to post for the current mode.',
        });

        return;
      }

      const missingImageProduct =
        targetProducts.find(
          (product) =>
            !getProductImageUrl(
              product,
            ),
        );

      if (missingImageProduct) {
        setNotice({
          type: 'error',

          message:
            'Product missing image.',
        });

        return;
      }

      setIsSending(true);

      setNotice({
        type: 'info',

        message:
          'Sending Telegram posts...',
      });

      let successCount = 0;

      const failures: string[] =
        [];

      try {
        const channelId =
          requireTelegramChannelId();

        for (
          const product
          of targetProducts
        ) {
          try {
            await createTelegramProductPost({
              channelId,

              product:
                toTelegramManualPostProduct(
                  product,
                ),

              template:
                telegramTemplate.trim() ||
                DEFAULT_TEMPLATE,

              notes:
                telegramNotes.trim(),
            });

            successCount += 1;
          } catch (error) {
            failures.push(
              `${getProductName(
                product,
              )}: ${getFriendlyErrorMessage(
                error,
                'telegram.post',
              )}`,
            );
          }
        }

if (
          !failures.length
        ) {
          setNotice({
            type: 'success',

            message:
              `${successCount} Telegram post${
                successCount === 1
                  ? ''
                  : 's'
              } sent successfully.`,
          });
        } else {
          setNotice({
            type: 'error',

            message:
              `${successCount} sent, ${failures.length} failed. ${failures
                .slice(0, 3)
                .join(' | ')}`,
          });
        }
      } catch (error) {
        setNotice({
          type: 'error',

          message:
            getFriendlyErrorMessage(
              error,
              'telegram.post_batch',
            ),
        });
      } finally {
        setIsSending(false);
      }
    };

  const unsavedGlobalSettings =
    telegramChannelId !==
      safeText(
        profile?.telegramChannelId,
      ) ||
    telegramTemplate !==
      safeText(
        profile?.telegramTemplate,
        DEFAULT_TEMPLATE,
      ) ||
    telegramNotes !==
      safeText(
        profile?.telegramNotes,
      );

  const noticeClassName =
    notice?.type === 'error'
      ? 'border-red-200 bg-red-50 text-red-700'
      : notice?.type ===
          'success'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : 'border-slate-200 bg-slate-50 text-slate-700';

  const getCollectionValidationMessage =
    () => {
      const trimmedName =
        collectionName.trim();

      if (!trimmedName) {
        return 'Collection name is required.';
      }

      return '';
    };

  /*
   * ONE PRODUCT ROW COMPONENT / STYLE.
   *
   * This is intentionally reused in:
   *
   * 1. Available products
   * 2. Products already in collection
   *
   * Product visual structure therefore stays:
   *
   * Photo | Name | Sale Price | Telegram Details | Action
   *
   * Only action state changes.
   */
  const renderCollectionProductRow =
    (
      product: Product,
      index: number,
      total: number,
      context: 'available' | 'queued' =
        'available',
    ) => {
      const isQueued =
        queuedProductIds.includes(
          product.id,
        );
      const isPreviewActive =
        context === 'queued' &&
        previewProduct?.id ===
          product.id;

      const productImage =
        getProductImageUrl(
          product,
        );

      const telegramDetails =
        getTelegramDescription(
          product,
        ) ||
        'No telegram details saved.';

      const formattedPrice =
        formatCurrency(
          toNonNegativeNumber(
            product.sellPrice ||
              product.buyPrice,
          ),
        );

      return (
        <div
          key={product.id}
          onClick={() => {
            if (context === 'queued') {
              setPreviewProductId(
                product.id,
              );
            }
          }}
          className={`
            grid
            grid-cols-[40px_minmax(0,1.4fr)_62px_minmax(0,1.1fr)_30px]
            items-center
            gap-2
            px-2.5
            py-2.5
            transition-colors
            ${
              context === 'queued'
                ? 'cursor-pointer'
                : ''
            }
            ${
              isPreviewActive
                ? 'bg-slate-50'
                : 'hover:bg-slate-50'
            }
            ${
              index !== total - 1
                ? 'border-b border-slate-100'
                : ''
            }
          `}
        >
          {/* PHOTO */}
          <div
            className="
              flex
              h-10
              w-10
              shrink-0
              items-center
              justify-center
              overflow-hidden
              rounded-lg
              border
              border-slate-200
              bg-slate-50
            "
          >
            {productImage ? (
              <img
                src={
                  productImage
                }
                alt={getProductName(
                  product,
                )}
                loading="lazy"
                decoding="async"
                className="
                  h-full
                  w-full
                  object-contain
                  p-1
                "
              />
            ) : (
              <ImageIcon className="h-4 w-4 text-slate-300" />
            )}
          </div>

          {/* NAME */}
          <div className="min-w-0">
            <p
              className="
                truncate
                text-[12px]
                font-semibold
                leading-4
                text-slate-900
              "
              title={getProductName(
                product,
              )}
            >
              {getProductName(
                product,
              )}
            </p>
          </div>

          {/* SALE PRICE */}
          <div className="min-w-0">
            <p
              className="
                whitespace-nowrap
                text-[12px]
                font-semibold
                leading-4
                text-emerald-700
              "
            >
              {formattedPrice}
            </p>
          </div>

          {/* TELEGRAM DETAILS */}
          <div className="min-w-0">
            <p
              className="
                truncate
                text-[11px]
                leading-4
                text-slate-500
              "
              title={
                telegramDetails
              }
            >
              {telegramDetails}
            </p>
          </div>

          {/* ACTION */}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (isQueued) {
                removeProductFromQueue(
                  product.id,
                );
                return;
              }

              addProductToQueue(
                product.id,
              );
            }}
            className={`
              flex
              h-7
              w-7
              shrink-0
              items-center
              justify-center
              rounded-md
              border
              transition-colors
              ${
                isQueued
                  ? `
                    border-rose-200
                    bg-white
                    text-rose-600
                    hover:bg-rose-50
                  `
                  : `
                    border-slate-200
                    bg-white
                    text-slate-700
                    hover:border-slate-300
                    hover:bg-slate-50
                  `
              }
            `}
            title={
              isQueued
                ? 'Remove product'
                : 'Add product'
            }
          >
            {isQueued ? (
              <X className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      );
    };

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 pb-20 md:pb-0">
      {notice && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${noticeClassName}`}
        >
          {notice.message}
        </div>
      )}

      {/* TELEGRAM CHANNEL */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <CardTitle className="text-base uppercase tracking-wide text-slate-700">
              Telegram Channels
            </CardTitle>
          </div>

          <div className="w-full max-w-xl">
            {hasSavedChannel ? (
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div>
                  <Input
                    value={
                      channelNameDraft
                    }
                    onChange={(
                      event,
                    ) =>
                      setChannelNameDraft(
                        event.target
                          .value,
                      )
                    }
                    placeholder={
                      selectedChannelId ||
                      savedChannels[0]
                    }
                  />

                  <div className="mt-1 truncate text-xs text-slate-500">
                    {selectedChannelId ||
                      savedChannels[0]}
                  </div>
                </div>

                <Button
                  type="button"
                  onClick={() =>
                    void saveSelectedChannelName()
                  }
                  disabled={
                    isSavingChannelName
                  }
                >
                  <Save className="mr-2 h-4 w-4" />
                  {isSavingChannelName
                    ? 'Saving...'
                    : 'Rename'}
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  value={
                    newChannelId
                  }
                  onChange={(
                    event,
                  ) =>
                    setNewChannelId(
                      event.target
                        .value,
                    )
                  }
                  placeholder="@stockflow_offers"
                />

              <Button
                type="button"
                onClick={() =>
                  void addTelegramChannel()
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                Add Channel
              </Button>
              </div>
            )}
          </div>
        </CardHeader>
      </Card>

      {/* CHANNEL SELECTOR */}
      {savedChannels.length >
        0 && (
        <Card className="shadow-sm">
          <CardContent className="pt-6">
            <div className="flex flex-wrap gap-2">
              {savedChannels.map(
                (channelId) => (
                  <button
                    key={
                      channelId
                    }
                    type="button"
                    onClick={() =>
                      setSelectedChannelId(
                        channelId,
                      )
                    }
                    className={`rounded-lg border px-4 py-2 text-sm font-semibold transition ${
                      selectedChannelId ===
                      channelId
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className="block">
                      {getChannelDisplayName(
                        channelId,
                      )}
                    </span>

                    {getChannelDisplayName(
                      channelId,
                    ) !== channelId && (
                      <span className="block text-[11px] font-medium opacity-75">
                        {channelId}
                      </span>
                    )}
                  </button>
                ),
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* SAVED COLLECTIONS */}
      <Card className="shadow-sm">
        <CardContent className="space-y-5 pt-6">
          {savedChannels.length ===
          0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-sm text-muted-foreground">
              No Telegram
              channels added yet.
              Add a channel ID to
              start creating
              collections.
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-lg font-bold text-slate-950">
                    {
                      selectedChannelDisplayName ||
                      selectedChannelId
                    }
                  </div>

                  <div className="mt-1 text-sm text-slate-600">
                    {
                      activeChannelSavedCollections.length
                    }{' '}
                    saved
                    collection
                    {activeChannelSavedCollections.length ===
                    1
                      ? ''
                      : 's'}{' '}
                    •{' '}
                    {
                      activeChannelRunningCollections.length
                    }{' '}
                    running
                  </div>
                </div>

                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    openCollectionModal(
                      selectedChannelId,
                    )
                  }
                >
                  <FolderPlus className="mr-2 h-4 w-4" />
                  Add Collection
                </Button>
              </div>

              <div className="space-y-2">
                {activeChannelSavedCollections.length >
                0 ? (
                  activeChannelSavedCollections.map(
                    (
                      collection,
                    ) => {
                      const liveCollection =
                        runningCollectionsBySavedId.get(
                          collection.id,
                        );

                      const normalizedStatus =
                        safeText(
                          liveCollection?.status,
                        ).toLowerCase();

                      const isRunning =
                        normalizedStatus ===
                        'running';

                      const isPaused =
                        normalizedStatus ===
                        'paused';

                      const actionCollectionId =
                        safeText(
                          liveCollection?.collectionId ||
                            liveCollection?.id ||
                            collection.id,
                        );

                      return (
                        <div
                          key={
                            collection.id
                          }
                          className="rounded-xl border border-slate-200 bg-white px-4 py-3"
                        >
                          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <div className="truncate font-semibold text-slate-950">
                                  {
                                    collection.name
                                  }
                                </div>

                                <span
                                  className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                    isRunning
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                      : isPaused
                                        ? 'border-amber-200 bg-amber-50 text-amber-700'
                                        : 'border-slate-200 bg-slate-50 text-slate-600'
                                  }`}
                                >
                                  {isRunning
                                    ? 'Running'
                                    : isPaused
                                      ? 'Paused'
                                      : 'Saved'}
                                </span>
                              </div>

                              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-600">
                                <span>
                                  {collection.category ===
                                  'all'
                                    ? 'All categories'
                                    : collection.category}
                                </span>

                                <span>
                                  {
                                    collection
                                      .queuedProductIds
                                      .length
                                  }{' '}
                                  queued
                                </span>

                                <span>
                                  {collection.frequencyValue ||
                                    DEFAULT_FREQUENCY_VALUE}{' '}
                                  {collection.frequencyUnit ||
                                    DEFAULT_FREQUENCY_UNIT}
                                </span>

                                <span>
                                  Batch{' '}
                                  {(collection as any)
                                    .batchSize ||
                                    DEFAULT_BATCH_SIZE}
                                </span>

                                {liveCollection && (
                                  <span>
                                    Sent{' '}
                                    {
                                      liveCollection.sentCount
                                    }
                                  </span>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-2">
                              {!isRunning &&
                                !isPaused && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    onClick={() =>
                                      void startSavedCollectionRun(
                                        collection,
                                      )
                                    }
                                    disabled={isActionPending(collection.id)}
                                  >
                                    <Play className="mr-2 h-4 w-4" />
                                    Start
                                  </Button>
                                )}

                              {isRunning &&
                                liveCollection && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void handleCollectionAction(
                                        'pause',
                                        liveCollection,
                                        () =>
                                          pauseTelegramCollection(
                                            actionCollectionId,
                                          ),
                                        'Collection paused',
                                      )
                                    }
                                    disabled={
                                      isActionPending(actionCollectionId)
                                    }
                                  >
                                    <Pause className="mr-2 h-4 w-4" />
                                    Pause
                                  </Button>
                                )}

                              {isPaused &&
                                liveCollection && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void handleCollectionAction(
                                        'resume',
                                        liveCollection,
                                        () =>
                                          resumeTelegramCollection(
                                            actionCollectionId,
                                          ),
                                        'Collection resumed',
                                      )
                                    }
                                    disabled={
                                      isActionPending(actionCollectionId)
                                    }
                                  >
                                    <Play className="mr-2 h-4 w-4" />
                                    Start
                                  </Button>
                                )}

                              {(isRunning ||
                                isPaused) &&
                                liveCollection && (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void handleCollectionAction(
                                        'stop',
                                        liveCollection,
                                        () =>
                                          stopTelegramCollection(
                                            actionCollectionId,
                                          ),
                                        'Collection stopped',
                                      )
                                    }
                                    disabled={
                                      isActionPending(actionCollectionId)
                                    }
                                  >
                                    <Square className="mr-2 h-4 w-4" />
                                    Stop
                                  </Button>
                                )}

                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  openCollectionModal(
                                    selectedChannelId,
                                    collection.id,
                                  )
                                }
                              >
                                Edit
                              </Button>

                              {liveCollection && (
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    void loadActivityForCollection(
                                      actionCollectionId,
                                    )
                                  }
                                  disabled={
                                    isActivityLoading &&
                                    selectedActivityCollectionId ===
                                      actionCollectionId
                                  }
                                >
                                  View
                                  Activity
                                </Button>
                              )}

                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="text-rose-600"
                                onClick={() =>
                                  void deleteCollectionById(
                                    collection.id,
                                  )
                                }
                                disabled={
                                  isSavingCollection
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    },
                  )
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-muted-foreground">
                    No collections
                    saved for this
                    channel yet.
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* RUNNING COLLECTIONS */}
      <Card className="shadow-sm">
        <CardHeader className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle className="text-base uppercase tracking-wide text-slate-700">
              Running Collections
            </CardTitle>

            <p className="text-sm text-muted-foreground">
              Live collection
              activity for the
              currently selected
              Telegram channel.
            </p>
          </div>

          <div className="flex items-center gap-3 text-sm text-slate-600">
            <span>
              {
                savedChannels.length
              }{' '}
              channels
            </span>

            <span>
              {
                visibleRunningCollections.length
              }{' '}
              live collections
            </span>

            <span>
              {livePostedCount}{' '}
              posts sent
            </span>
          </div>
        </CardHeader>

        <CardContent className="space-y-6">
          {hiddenForeignRunningCollectionsCount >
            0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Hidden{' '}
              {
                hiddenForeignRunningCollectionsCount
              }{' '}
              live collection
              {hiddenForeignRunningCollectionsCount ===
              1
                ? ''
                : 's'}{' '}
              that do not belong
              to this store
              profile.
            </div>
          )}

          {savedChannels.length >
            0 &&
          selectedChannelId ? (
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div>
                <div className="text-lg font-bold text-slate-950">
                  {
                    selectedChannelDisplayName ||
                    selectedChannelId
                  }
                </div>

                <div className="mt-1 text-sm text-slate-600">
                  {
                    activeChannelSavedCollections.length
                  }{' '}
                  saved
                  collection
                  {activeChannelSavedCollections.length ===
                  1
                    ? ''
                    : 's'}{' '}
                  •{' '}
                  {
                    activeChannelRunningCollections.length
                  }{' '}
                  currently running
                </div>
              </div>

              <div className="mt-4 space-y-4">
                {activeChannelRunningCollections.length >
                0 ? (
                  activeChannelRunningCollections.map(
                    (
                      collection,
                    ) => {
                      const backendCollectionId =
                        safeText(
                          collection.collectionId ||
                            collection.id,
                        );

                      const normalizedStatus =
                        safeText(
                          collection.status,
                        ).toLowerCase();

                      const isRunning =
                        normalizedStatus ===
                        'running';

                      const isPaused =
                        normalizedStatus ===
                        'paused';

                      return (
                        <div
                          key={
                            collection.id
                          }
                          className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                        >
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div className="space-y-2">
                              <div className="text-lg font-bold text-slate-950">
                                {
                                  collection.name
                                }
                              </div>

                              <div className="text-sm text-slate-600">
                                {collection.category ===
                                'all'
                                  ? 'All categories'
                                  : collection.category}{' '}
                                •{' '}
                                {
                                  collection.frequencyValue
                                }{' '}
                                {
                                  collection.frequencyUnit
                                }
                              </div>

                              <div className="inline-flex rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-700">
                                {
                                  collection.status
                                }
                              </div>
                            </div>

                            <div className="flex flex-wrap gap-2">
                              {isRunning && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    void handleCollectionAction(
                                      'pause',
                                      collection,
                                      () =>
                                        pauseTelegramCollection(
                                          backendCollectionId,
                                        ),
                                      'Collection paused',
                                    )
                                  }
                                  disabled={
                                    isActionPending(backendCollectionId)
                                  }
                                >
                                  <Pause className="mr-2 h-4 w-4" />
                                  Pause
                                </Button>
                              )}

                              {isPaused && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() =>
                                    void handleCollectionAction(
                                      'resume',
                                      collection,
                                      () =>
                                        resumeTelegramCollection(
                                          backendCollectionId,
                                        ),
                                      'Collection resumed',
                                    )
                                  }
                                  disabled={
                                    isActionPending(backendCollectionId)
                                  }
                                >
                                  <Play className="mr-2 h-4 w-4" />
                                  Resume
                                </Button>
                              )}

                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  void handleCollectionAction(
                                    'stop',
                                    collection,
                                    () =>
                                      stopTelegramCollection(
                                        backendCollectionId,
                                      ),
                                    'Collection stopped',
                                  )
                                }
                                disabled={
                                  isActionPending(backendCollectionId)
                                }
                              >
                                <Square className="mr-2 h-4 w-4" />
                                Stop
                              </Button>

                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  openCollectionModal(
                                    selectedChannelId,
                                    backendCollectionId,
                                  )
                                }
                              >
                                Edit Setup
                              </Button>

                              <Button
                                type="button"
                                size="sm"
                                onClick={() =>
                                  void loadActivityForCollection(
                                    backendCollectionId,
                                  )
                                }
                                disabled={
                                  isActivityLoading &&
                                  selectedActivityCollectionId ===
                                    backendCollectionId
                                }
                              >
                                View
                                Activity
                              </Button>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-5">
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Products
                              </div>

                              <div className="mt-1 font-bold text-slate-900">
                                {
                                  collection.productsCount
                                }
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Cursor
                              </div>

                              <div className="mt-1 font-bold text-slate-900">
                                {
                                  collection.currentCursor
                                }
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Sent
                              </div>

                              <div className="mt-1 font-bold text-slate-900">
                                {
                                  collection.sentCount
                                }
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Failed
                              </div>

                              <div className="mt-1 font-bold text-slate-900">
                                {
                                  collection.failedCount
                                }
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Repeat
                              </div>

                              <div className="mt-1 font-bold text-slate-900">
                                {collection.repeatMode ||
                                  'loop'}
                              </div>
                            </div>
                          </div>

                          <div className="mt-4 grid gap-3 md:grid-cols-2">
                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Last Posted
                                Product
                              </div>

                              <div className="mt-1 font-semibold text-slate-900">
                                {collection.lastPostedProduct ||
                                  'Not yet'}
                              </div>

                              <div className="mt-1 text-xs text-slate-500">
                                {formatDateTime(
                                  collection.lastPostedAt,
                                )}
                              </div>
                            </div>

                            <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
                              <div className="text-xs uppercase tracking-wide text-slate-500">
                                Next Post
                                Time
                              </div>

                              <div className="mt-1 font-semibold text-slate-900">
                                {formatDateTime(
                                  collection.nextPostAt,
                                )}
                              </div>

                              <div className="mt-1 text-xs text-slate-500">
                                Max
                                failures
                                before pause:{' '}
                                {collection.maxFailuresBeforePause ||
                                  DEFAULT_MAX_FAILURES_BEFORE_PAUSE}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    },
                  )
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-muted-foreground">
                    No collections
                    are running on
                    this channel
                    right now.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-muted-foreground">
              Add a channel first
              to start organizing
              Telegram
              collections.
            </div>
          )}
        </CardContent>
      </Card>

      {/* COLLECTION MODAL */}
      {isCollectionModalOpen && (
        <div className="fixed inset-0 z-[120] flex items-stretch justify-center bg-black/40 p-2 sm:p-4">
          <div className="flex h-[calc(100vh-1rem)] w-full max-w-[min(1600px,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl sm:h-[calc(100vh-2rem)] sm:max-w-[min(1680px,calc(100vw-2rem))]">
            {/* MODAL HEADER */}
            <div className="border-b border-slate-200 px-6 py-4">
              <div className="grid gap-3 xl:grid-cols-[minmax(220px,1.15fr)_220px_170px_180px_140px_180px_minmax(240px,1fr)_auto] xl:items-end">
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Collection Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    value={collectionName}
                    onChange={(event) => {
                      setCollectionName(event.target.value);
                      if (
                        collectionValidationMessage &&
                        event.target.value.trim()
                      ) {
                        setCollectionValidationMessage('');
                      }
                    }}
                    placeholder="Collection name"
                    className="h-10"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Channel
                  </Label>

                  {savedChannels.length > 0 ? (
                    <Select
                      value={collectionChannelId}
                      onChange={(event) => {
                        setCollectionChannelId(event.target.value);
                        if (
                          collectionValidationMessage &&
                          event.target.value.trim()
                        ) {
                          setCollectionValidationMessage('');
                        }
                      }}
                      className="h-10"
                    >
                      {savedChannels.map((channelId) => (
                        <option key={channelId} value={channelId}>
                          {getChannelDisplayName(channelId)}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      value={collectionChannelId}
                      onChange={(event) => {
                        setCollectionChannelId(event.target.value);
                        if (
                          collectionValidationMessage &&
                          event.target.value.trim()
                        ) {
                          setCollectionValidationMessage('');
                        }
                      }}
                      placeholder="@stockflow_offers"
                      className="h-10"
                    />
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Start Time
                  </Label>
                  <Input
                    type="time"
                    value={toTelegramTimeInputValue(startTimeInput)}
                    onChange={(event) => {
                      setStartTimeInput(event.target.value);
                      if (
                        collectionValidationMessage &&
                        collectionName.trim()
                      ) {
                        setCollectionValidationMessage('');
                      }
                    }}
                    className="h-10"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Post Mode
                  </Label>
                  <Select
                    value={postMode}
                    onChange={(event) => {
                      setPostMode(
                        event.target
                          .value as TelegramPostMode,
                      );
                    }}
                    className="h-10"
                  >
                    <option value="selected">
                      Selected Products
                    </option>
                    <option value="filtered">
                      Filtered Products
                    </option>
                    <option value="out_of_stock">
                      Out of Stock
                    </option>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Batch
                  </Label>
                  <Select
                    value={batchSize}
                    onChange={(event) =>
                      setBatchSize(
                        event.target.value,
                      )
                    }
                    className="h-10"
                  >
                    {TELEGRAM_BATCH_OPTIONS.map(
                      (option) => (
                        <option
                          key={option}
                          value={String(option)}
                        >
                          {option} products
                        </option>
                      ),
                    )}
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Repeat
                  </Label>
                  <Select
                    value={repeatMode}
                    onChange={(event) =>
                      setRepeatMode(
                        event.target
                          .value as TelegramCollectionRepeatMode,
                      )
                    }
                    className="h-10"
                  >
                    <option value="once">
                      Once
                    </option>
                    <option value="loop">
                      Loop
                    </option>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs font-medium text-slate-600">
                    Frequency
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_132px]">
                    <Input
                      type="number"
                      min={
                        frequencyUnit ===
                        'seconds'
                          ? MIN_SECONDS_FREQUENCY_VALUE
                          : 1
                      }
                      step="1"
                      value={
                        frequencyValue
                      }
                      onChange={(
                        event,
                      ) =>
                        setFrequencyValue(
                          event.target
                            .value,
                        )
                      }
                      className="h-10"
                    />

                    <Select
                      value={
                        frequencyUnit
                      }
                      onChange={(
                        event,
                      ) =>
                        setFrequencyUnit(
                          event.target
                            .value as TelegramCollectionFrequencyUnit,
                        )
                      }
                      className="h-10"
                    >
                      <option value="seconds">
                        Seconds
                      </option>
                      <option value="minutes">
                        Minutes
                      </option>
                      <option value="hours">
                        Hours
                      </option>
                    </Select>
                  </div>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-10 w-10 shrink-0 self-start xl:self-end"
                  onClick={() =>
                    setIsCollectionModalOpen(
                      false,
                    )
                  }
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              {collectionValidationMessage ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                  {collectionValidationMessage}
                </div>
              ) : null}

            </div>

            {/* THREE COLUMN MODAL BODY */}
            <div
              className="
                grid
                min-h-0
                flex-1
                gap-5
                overflow-hidden
                px-4
                py-4
                sm:px-6
                sm:py-5
                xl:grid-cols-[minmax(340px,1.02fr)_minmax(380px,1.08fr)_minmax(360px,0.98fr)]
                2xl:grid-cols-[minmax(360px,1.02fr)_minmax(420px,1.08fr)_minmax(390px,0.98fr)]
              "
            >
              {/* ========================================= */}
              {/* LEFT — COLLECTION / AVAILABLE PRODUCTS */}
              {/* ========================================= */}
              <div className="flex min-h-0 flex-col gap-4 pr-1">
                {/* CATEGORY + PRODUCTS */}
                <div className="flex min-h-0 flex-1 flex-col gap-3">
                  {/* CATEGORY TABS */}
                  <div className="shrink-0">
                    <div className="flex gap-2 overflow-x-auto pb-1 pr-1">
                    {productCategoryGroups.length >
                    0 ? (
                      productCategoryGroups.map(
                        (
                          group,
                        ) => {
                          const isActive =
                            expandedProductCategoryGroup?.category ===
                            group.category;

                          return (
                            <button
                              key={
                                group.category
                              }
                              type="button"
                              onClick={() =>
                                setExpandedCategory(
                                  group.category,
                                )
                              }
                              className={`shrink-0 rounded-full border px-3 py-1.5 text-left text-xs font-semibold transition-colors ${
                                isActive
                                  ? 'border-slate-950 bg-slate-950 text-white'
                                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'
                              }`}
                            >
                              {
                                group.category
                              }

                              <span
                                className={`ml-1 ${
                                  isActive
                                    ? 'text-white/70'
                                    : 'text-slate-400'
                                }`}
                              >
                                {
                                  group
                                    .products
                                    .length
                                }
                              </span>
                            </button>
                          );
                        },
                      )
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
                        No categories
                        found.
                      </div>
                    )}
                    </div>
                  </div>

                  {/* AVAILABLE PRODUCT TABLE */}
                  <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 px-3 py-2.5">
                      <div className="truncate text-sm font-semibold text-slate-950">
                        {expandedProductCategoryGroup?.category ||
                          'Products'}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        <div className="text-xs text-slate-500">
                          {expandedProductCategoryGroup?.products
                            .length ||
                            0}{' '}
                          items
                        </div>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-xs"
                          onClick={() =>
                            addProductsToQueue(
                              addableExpandedCategoryProductIds,
                            )
                          }
                          disabled={
                            addableExpandedCategoryProductIds.length ===
                            0
                          }
                        >
                          Add all
                        </Button>
                      </div>
                    </div>

                    <div className="shrink-0 border-b border-slate-100 px-3 py-2.5">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <Input
                          value={
                            collectionProductSearchTerm
                          }
                          onChange={(
                            event,
                          ) =>
                            setCollectionProductSearchTerm(
                              event
                                .target
                                .value,
                            )
                          }
                          placeholder="Search products in this category..."
                          className="h-10 pl-9"
                        />
                      </div>
                    </div>

                    {expandedProductCategoryGroup ? (
                      <div className="min-h-0 flex-1 overflow-y-auto">
                        {filteredExpandedCategoryProducts.length >
                        0 ? (
                          filteredExpandedCategoryProducts.map(
                          (
                            product,
                            index,
                          ) =>
                            renderCollectionProductRow(
                              product,
                              index,
                              filteredExpandedCategoryProducts.length,
                            ),
                          )
                        ) : (
                          <div className="px-4 py-8 text-center text-sm text-slate-500">
                            No products match
                            this search.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="px-4 py-8 text-center text-sm text-slate-500">
                        Select a
                        category to
                        see products.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ========================================= */}
              {/* MIDDLE — PRODUCTS IN COLLECTION */}
              {/* ========================================= */}
              <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
                {/* SELECTED HEADER */}
                <div className="flex shrink-0 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <Label className="whitespace-nowrap text-xs font-medium text-slate-600">
                      Products In
                      Collection
                    </Label>

                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-slate-100 px-2 text-xs font-bold text-slate-700">
                      {
                        queuedProducts.length
                      }
                    </span>
                  </div>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 px-3"
                    onClick={
                      clearQueue
                    }
                    disabled={
                      queuedProducts.length ===
                      0
                    }
                  >
                    Clear
                  </Button>
                </div>

                {/* SELECTED PRODUCTS */}
                <div className="flex min-h-[240px] flex-[1.2] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm xl:min-h-[300px]">
                  {queuedProducts.length >
                  0 ? (
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {queuedProducts.map(
                        (
                          product,
                          index,
                        ) =>
                            renderCollectionProductRow(
                              product,
                              index,
                              queuedProducts.length,
                              'queued',
                            ),
                      )}
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white px-4 py-8 text-center text-sm leading-6 text-slate-500">
                      {postMode ===
                      'selected'
                        ? 'Add products from the category list.'
                        : postMode ===
                            'filtered'
                          ? 'Filtered mode uses the current page search and category filters when you save or start.'
                          : 'Out of Stock mode uses the current page filters and only products with zero stock when you save or start.'}
                    </div>
                  )}
                </div>

                <div className="hidden min-h-0 shrink overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
                  <div className="grid gap-3 md:grid-cols-2">
                  <div className="flex min-h-[132px] flex-col rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <Label className="text-xs font-medium text-slate-600">
                      Post Mode
                    </Label>
                    <Select
                      value={postMode}
                      onChange={(event) => {
                        setPostMode(
                          event.target
                            .value as TelegramPostMode,
                        );
                        if (
                          collectionValidationMessage
                        ) {
                          setCollectionValidationMessage(
                            '',
                          );
                        }
                      }}
                      className="h-10"
                    >
                      <option value="selected">
                        Selected Products
                      </option>
                      <option value="filtered">
                        Filtered Products
                      </option>
                      <option value="out_of_stock">
                        Out of Stock
                      </option>
                    </Select>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {postMode ===
                      'selected'
                        ? 'Choose products manually for this collection.'
                        : postMode ===
                            'filtered'
                          ? 'Use the current search and category filters.'
                          : 'Use the current filters and only zero-stock items.'}
                    </p>
                  </div>

                  <div className="flex min-h-[132px] flex-col rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <Label className="text-xs font-medium text-slate-600">
                      Repeat
                    </Label>
                    <Select
                      value={repeatMode}
                      onChange={(event) =>
                        setRepeatMode(
                          event.target
                            .value as TelegramCollectionRepeatMode,
                        )
                      }
                      className="h-10"
                    >
                      <option value="once">
                        Once
                      </option>
                      <option value="loop">
                        Loop
                      </option>
                    </Select>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      {repeatMode ===
                      'once'
                        ? 'Post the collection once, then complete.'
                        : 'Restart from the beginning after the last product.'}
                    </p>
                  </div>

                  <div className="flex min-h-[118px] flex-col rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <Label className="text-xs font-medium text-slate-600">
                      Batch
                    </Label>
                    <Select
                      value={batchSize}
                      onChange={(event) =>
                        setBatchSize(
                          event.target.value,
                        )
                      }
                      className="h-10"
                    >
                      {TELEGRAM_BATCH_OPTIONS.map(
                        (option) => (
                          <option
                            key={option}
                            value={String(
                              option,
                            )}
                          >
                            {option} products
                          </option>
                        ),
                      )}
                    </Select>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      Posts this many products in one cycle.
                    </p>
                  </div>

                  <div className="flex min-h-[132px] flex-col rounded-lg border border-slate-100 bg-slate-50/70 p-3 md:col-span-2">
                    <Label className="text-xs font-medium text-slate-600">
                      Frequency
                    </Label>

                    <div className="mt-1 grid gap-2 sm:grid-cols-[minmax(0,1fr)_132px]">
                      <Input
                        type="number"
                        min={
                          frequencyUnit ===
                          'seconds'
                            ? MIN_SECONDS_FREQUENCY_VALUE
                            : 1
                        }
                        step="1"
                        value={
                          frequencyValue
                        }
                        onChange={(
                          event,
                        ) =>
                          setFrequencyValue(
                            event.target
                              .value,
                          )
                        }
                        className="h-10"
                      />

                      <Select
                        value={
                          frequencyUnit
                        }
                        onChange={(
                          event,
                        ) =>
                          setFrequencyUnit(
                            event.target
                              .value as TelegramCollectionFrequencyUnit,
                          )
                        }
                        className="h-10"
                      >
                        <option value="seconds">
                          Seconds
                        </option>

                        <option value="minutes">
                          Minutes
                        </option>

                        <option value="hours">
                          Hours
                        </option>
                      </Select>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      Choose how often the next batch should be posted.
                    </p>
                  </div>

                  <div className="flex min-h-[118px] flex-col rounded-lg border border-slate-100 bg-slate-50/70 p-3">
                    <Label className="text-xs font-medium text-slate-600">
                      Max Failures Before Pause
                    </Label>
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={
                        maxFailuresBeforePause
                      }
                      onChange={(event) => {
                        setMaxFailuresBeforePause(
                          event.target.value,
                        );
                        if (
                          collectionValidationMessage
                        ) {
                          setCollectionValidationMessage(
                            '',
                          );
                        }
                      }}
                      className="h-10"
                    />
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      Pause after this many consecutive failures.
                    </p>
                  </div>
                  </div>
                </div>

                {/* MODAL ACTIONS */}
                <div className="grid shrink-0 grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-10"
                    onClick={() =>
                      setIsCollectionModalOpen(
                        false,
                      )
                    }
                  >
                    Cancel
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    className="h-10 border-slate-300 font-semibold text-slate-900"
                    onClick={() =>
                      void saveCollection()
                    }
                    disabled={
                      isSavingCollection
                    }
                  >
                    {isSavingCollection
                      ? 'Saving...'
                      : activeCollection
                        ? 'Update Collection'
                        : 'Save Collection'}
                  </Button>
                </div>
              </div>

              {/* ========================================= */}
              {/* RIGHT — PREVIEW */}
              {/* ========================================= */}
              <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
                <Label className="shrink-0 text-xs font-medium text-slate-600">
                  Preview
                </Label>

                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                  <div className="space-y-3">
                    <div
                      className="relative overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-sm"
                      style={{
                        backgroundImage:
                          `linear-gradient(
                            180deg,
                            rgba(2,6,23,0.18),
                            rgba(2,6,23,0.66)
                          ), url('${TELEGRAM_MESSAGE_BOARD_BG}')`,

                        backgroundSize:
                          'cover',

                        backgroundPosition:
                          'center',
                      }}
                    >
                      <div className="relative flex justify-center p-4">
                        <div className="w-full max-w-[340px] overflow-hidden rounded-xl border border-white/75 bg-white shadow-lg">
                          {/* TELEGRAM HEADER */}
                          <div className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2">
                            <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 bg-white">
                              {profile?.logoImage ? (
                                <img
                                  src={
                                    profile.logoImage
                                  }
                                  alt={
                                    profile.storeName ||
                                    'Store'
                                  }
                                  className="h-full w-full object-cover"
                                />
                              ) : (
                                <span className="text-[10px] font-bold text-slate-900">
                                  {safeText(
                                    profile?.storeName,
                                    'SF',
                                  )
                                    .slice(
                                      0,
                                      2,
                                    )
                                    .toUpperCase()}
                                </span>
                              )}
                            </div>

                            <div className="min-w-0">
                              <div className="truncate text-xs font-bold text-slate-950">
                                {safeText(
                                  profile?.storeName,
                                  selectedChannelId ||
                                    'Telegram Channel',
                                )}
                              </div>

                              <div className="truncate text-[10px] text-slate-500">
                                {selectedChannelDisplayName ||
                                  selectedChannelId ||
                                  'Message preview'}
                              </div>
                            </div>
                          </div>

                          {/* PRODUCT IMAGE */}
                          {previewProduct &&
                          getProductImageUrl(
                            previewProduct,
                          ) ? (
                            <div className="flex h-52 w-full items-center justify-center bg-white">
                              <img
                                src={getProductImageUrl(
                                  previewProduct,
                                )}
                                alt={getProductName(
                                  previewProduct,
                                )}
                                className="max-h-full max-w-full object-contain"
                                loading="lazy"
                                decoding="async"
                              />
                            </div>
                          ) : (
                            <div className="flex h-52 w-full items-center justify-center bg-white/10 text-sm text-white/70">
                              Product image
                              preview
                            </div>
                          )}

                          {/* MESSAGE CONTENT */}
                          <div className="space-y-2 px-3 py-3 text-slate-950">
                            <div className="whitespace-pre-wrap text-[13px] font-medium leading-5 text-slate-900">
                              {buildMessageBoardText(
                                previewProduct,
                              ) || 'Write your Telegram message...'}
                            </div>

                            {(messageBoardContacts.length >
                              0 ||
                              telegramAddressLink.trim()) && (
                              <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
                                {messageBoardContacts.length >
                                  0 && (
                                  <div>
                                    {messageBoardContacts.join(
                                      ' | ',
                                    )}
                                  </div>
                                )}

                                {telegramAddressLink.trim() && (
                                  <div className="break-all">
                                    {telegramAddressLink.trim()}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="flex min-h-[220px] shrink-0 flex-col rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-slate-950">
                            Message Editor
                          </div>
                        </div>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-8 px-3 text-xs"
                          onClick={() =>
                            setTelegramTemplate(
                              DEFAULT_TEMPLATE,
                            )
                          }
                        >
                          Reset
                        </Button>
                      </div>

                      <div className="mt-3 flex flex-wrap gap-2">
                        {compactTemplateTokens.map(
                          (token) => (
                            <button
                              key={token}
                              type="button"
                              onClick={() =>
                                insertTemplateToken(
                                  token,
                                )
                              }
                              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700 transition hover:border-slate-300 hover:bg-slate-100"
                            >
                              {token}
                            </button>
                          ),
                        )}
                      </div>

                      <div className="mt-3 min-h-0 flex-1">
                        <textarea
                          ref={messageEditorRef}
                          value={telegramTemplate}
                          onChange={(event) =>
                            setTelegramTemplate(
                              event.target.value,
                            )
                          }
                          placeholder="Write your Telegram message..."
                          className="min-h-[190px] w-full resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-[13px] leading-5 text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
