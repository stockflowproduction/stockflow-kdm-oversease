const EPSILON = 1e-9;

export const INR_SYMBOL = '';
export const DISPLAY_FALLBACK = '\u2014';
export const GST_FALLBACK = 'GST details not added';
export const CONTACT_FALLBACK = 'Contact not added';
export const LOCATION_FALLBACK = 'Location not added';

const MONEY_FORMATTER = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const WHOLE_MONEY_FORMATTER = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const MOJIBAKE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¹|Ã¢â€šÂ¹|â‚¹|₹/g, INR_SYMBOL],
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢|Ã¢â‚¬Â¢|Ã‚Â·/g, ' â€¢ '],
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â|Ã¢â‚¬â€|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â/g, DISPLAY_FALLBACK],
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢|Ã¢â€ â€™/g, ' -> '],
  [/ÃƒÂ¢Ã…â€œÃ¢â‚¬Â¢/g, 'Ã—'],
  [/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦/g, '...'],
  [/Ã‚+/g, ''],
];

export const toSafeNumber = (value: unknown) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

export const normalizeMoney = (value: unknown) => {
  const safe = toSafeNumber(value);
  return Math.round((safe + Number.EPSILON) * 100) / 100;
};

export const roundByHalfRule = (value: unknown) => {
  const normalized = normalizeMoney(value);
  const sign = normalized < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(normalized) + 0.5);
};

const roundTo = (value: unknown, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((toSafeNumber(value) + EPSILON) * factor) / factor;
};

export const sanitizeDisplayText = (value: unknown, fallback = DISPLAY_FALLBACK): string => {
  const input = String(value ?? '').trim();
  if (!input) return fallback;

  let next = input;
  MOJIBAKE_REPLACEMENTS.forEach(([pattern, replacement]) => {
    next = next.replace(pattern, replacement);
  });

  next = next
    .replace(/\s*â€¢\s*/g, ' â€¢ ')
    .replace(/\s*->\s*/g, ' -> ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!next || next === '?' || next.toLowerCase() === 'undefined' || next.toLowerCase() === 'null') {
    return fallback;
  }
  return next;
};

const cleanOptionalText = (value: unknown) => {
  const cleaned = sanitizeDisplayText(value, '');
  const normalized = cleaned.toLowerCase();
  if (!cleaned || cleaned === DISPLAY_FALLBACK) return '';
  if (normalized === 'na' || normalized === 'n/a' || normalized === 'none' || normalized === 'not added') return '';
  return cleaned;
};

export const formatOptionalText = (value: unknown, fallback = DISPLAY_FALLBACK) => cleanOptionalText(value) || fallback;
export const formatGstText = (value: unknown) => cleanOptionalText(value) || GST_FALLBACK;
export const formatContactText = (value: unknown) => cleanOptionalText(value) || CONTACT_FALLBACK;
export const formatLocationText = (value: unknown) => cleanOptionalText(value) || LOCATION_FALLBACK;

export const joinDisplayParts = (...parts: Array<unknown>) => {
  const cleaned = parts.map((part) => cleanOptionalText(part)).filter(Boolean);
  return cleaned.length ? cleaned.join(' â€¢ ') : DISPLAY_FALLBACK;
};

export const formatMoneyPrecise = (value: unknown) => MONEY_FORMATTER.format(roundTo(value, 2));

export const formatMoneyWhole = (value: unknown) => WHOLE_MONEY_FORMATTER.format(roundByHalfRule(value));

export const roundMoneyWhole = (value: unknown) => roundByHalfRule(value);

export const formatCurrency = (value: unknown) => `${INR_SYMBOL}${formatMoneyPrecise(value)}`;

export const formatCurrencyWhole = (value: unknown) => `${INR_SYMBOL}${formatMoneyWhole(value)}`;

export const formatINRPrecise = (value: unknown) => formatCurrency(value);

export const formatINRWhole = (value: unknown) => formatCurrencyWhole(value);

export const formatMoneyFixed2 = (value: unknown) => roundTo(value, 2).toFixed(2);

export const formatMoneyRounded = (value: unknown) => formatMoneyWhole(value);

