const EPSILON = 1e-9;

const toSafeNumber = (value: number) => (Number.isFinite(value) ? value : 0);

const roundTo = (value: number, decimals = 2) => {
  const factor = 10 ** decimals;
  return Math.round((toSafeNumber(value) + EPSILON) * factor) / factor;
};

export const formatMoneyPrecise = (value: number) => {
  const rounded = roundTo(value, 2);
  return rounded.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
};

export const formatMoneyWhole = (value: number) => {
  const rounded = Math.round(toSafeNumber(value));
  return rounded.toLocaleString('en-IN', {
    maximumFractionDigits: 0,
  });
};

export const formatINRPrecise = (value: number) => `₹${formatMoneyPrecise(value)}`;

export const formatINRWhole = (value: number) => `₹${formatMoneyWhole(value)}`;

export const formatMoneyFixed2 = (value: number) => roundTo(value, 2).toFixed(2);
