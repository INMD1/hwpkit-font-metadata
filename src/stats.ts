const DEFAULT_PRECISION = 6;

export function round(value: number | null | undefined, precision = DEFAULT_PRECISION): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function safeRatio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

export function quantile(sortedValues: number[], probability: number): number | null {
  if (sortedValues.length === 0) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const position = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const fraction = position - lowerIndex;
  return (
    sortedValues[lowerIndex] * (1 - fraction) +
    sortedValues[upperIndex] * fraction
  );
}

export interface DescribeOptions {
  expected?: number;
  unit?: string;
}

export interface Summary {
  expected: number;
  measured: number;
  missing: number;
  coverage: number | null;
  unit: string;
  min: number | null;
  p05: number | null;
  median: number | null;
  mean: number | null;
  p95: number | null;
  max: number | null;
  stddev: number | null;
  coefficientOfVariation: number | null;
}

export function describe(
  values: Array<number | null | undefined>,
  { expected = values.length, unit = "em" }: DescribeOptions = {},
): Summary {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value)).sort((left, right) => left - right);
  const measured = finiteValues.length;
  const missing = Math.max(0, expected - measured);
  const coverage = expected > 0 ? measured / expected : null;

  if (measured === 0) {
    return {
      expected,
      measured,
      missing,
      coverage: round(coverage),
      unit,
      min: null,
      p05: null,
      median: null,
      mean: null,
      p95: null,
      max: null,
      stddev: null,
      coefficientOfVariation: null,
    };
  }

  const mean = finiteValues.reduce((sum, value) => sum + value, 0) / measured;
  const variance =
    finiteValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / measured;
  const stddev = Math.sqrt(variance);

  return {
    expected,
    measured,
    missing,
    coverage: round(coverage),
    unit,
    min: round(finiteValues[0]),
    p05: round(quantile(finiteValues, 0.05)),
    median: round(quantile(finiteValues, 0.5)),
    mean: round(mean),
    p95: round(quantile(finiteValues, 0.95)),
    max: round(finiteValues.at(-1)),
    stddev: round(stddev),
    coefficientOfVariation: round(mean === 0 ? null : stddev / Math.abs(mean)),
  };
}

export function median(values: Array<number | null | undefined>): number | null {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value)).sort((left, right) => left - right);
  return quantile(finiteValues, 0.5);
}
