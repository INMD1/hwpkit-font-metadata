/**
 * Pairwise font-profile comparison and fallback recommendation.
 *
 * Distances in this module are deliberately candidate-set independent. Every
 * value is derived from a source/candidate pair and fixed weights; no min/max
 * or percentile normalization over the candidate list is performed.
 */

export const COMPARISON_SCHEMA_ID = "hwpkit.font-comparison/v1";
export const COMPARISON_SCHEMA_VERSION = "1.0.0";

export const DEFAULT_COMPONENT_WEIGHTS = Object.freeze({
  width: 0.62,
  space: 0.16,
  vertical: 0.17,
  style: 0.05,
});

export const DEFAULT_WIDTH_METRIC_WEIGHTS = Object.freeze({
  hangulEm: 0.30,
  jamoEm: 0.08,
  hanjaEm: 0.10,
  latinUpperEm: 0.10,
  latinLowerEm: 0.12,
  digitEm: 0.10,
  punctuationEm: 0.08,
  bodyTextEm: 0.12,
});

export const DEFAULT_VERTICAL_METRIC_WEIGHTS = Object.freeze({
  lineAdvanceEm: 0.45,
  ascenderEm: 0.20,
  descenderEm: 0.15,
  baselineFromTopEm: 0.20,
});

export const DEFAULT_STYLE_METRIC_WEIGHTS = Object.freeze({
  weightClass: 0.50,
  widthClass: 0.30,
  italic: 0.20,
});

export type AdjustmentLimitPair = readonly [number, number];

export interface AdjustmentLimits {
  ratio: AdjustmentLimitPair;
  spacing: AdjustmentLimitPair;
}

/**
 * Conservative automatic-correction bounds for HWP/HWPX integer percentages.
 * They intentionally sit well inside the formats' theoretical ranges: large
 * automatic corrections deform glyphs and are usually worse than choosing a
 * different fallback. Callers may explicitly widen these fixed bounds.
 */
export const DEFAULT_ADJUSTMENT_LIMITS: Readonly<Record<"hwp" | "hwpx", AdjustmentLimits>> = Object.freeze({
  hwp: Object.freeze({
    ratio: Object.freeze([95, 105] as const),
    spacing: Object.freeze([-2, 2] as const),
  }),
  hwpx: Object.freeze({
    ratio: Object.freeze([95, 105] as const),
    spacing: Object.freeze([-2, 2] as const),
  }),
});

export const DEFAULT_COMPARISON_OPTIONS = Object.freeze({
  coverageTolerance: 1e-6,
  minimumCoverageRatio: null as number | null,
  missingMetricPenalty: 1,
  spaceFrequency: 0.12,
  componentWeights: DEFAULT_COMPONENT_WEIGHTS,
  widthMetricWeights: DEFAULT_WIDTH_METRIC_WEIGHTS,
  verticalMetricWeights: DEFAULT_VERTICAL_METRIC_WEIGHTS,
  styleMetricWeights: DEFAULT_STYLE_METRIC_WEIGHTS,
  adjustmentLimits: DEFAULT_ADJUSTMENT_LIMITS,
});

const WIDTH_KEYS = Object.freeze(Object.keys(DEFAULT_WIDTH_METRIC_WEIGHTS)) as readonly string[];
const VERTICAL_KEYS = Object.freeze(Object.keys(DEFAULT_VERTICAL_METRIC_WEIGHTS)) as readonly string[];
const STYLE_KEYS = Object.freeze(Object.keys(DEFAULT_STYLE_METRIC_WEIGHTS)) as readonly (keyof typeof DEFAULT_STYLE_METRIC_WEIGHTS)[];

const GROUP_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  hangulEm: Object.freeze(["hangul", "modernHangul", "modernHangulSyllables"]),
  jamoEm: Object.freeze(["jamo", "hangulJamo", "modernHangulJamo", "compatibilityJamo"]),
  hanjaEm: Object.freeze(["hanja", "commonHanja", "cjk", "cjkIdeographs"]),
  latinUpperEm: Object.freeze(["latinUpper", "latinUppercase", "uppercaseLatin", "upper"]),
  latinLowerEm: Object.freeze(["latinLower", "latinLowercase", "lowercaseLatin", "lower"]),
  digitEm: Object.freeze(["digit", "digits", "decimalDigits"]),
  punctuationEm: Object.freeze(["punctuation", "punctuationMarks"]),
});

/** A font profile as produced by `analyzeFontSource`, consumed loosely here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FontProfileLike = Record<string, any>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function firstFinite(...values: unknown[]): number | undefined {
  return values.find(isFiniteNumber) as number | undefined;
}

function clamp(value: number, [minimum, maximum]: AdjustmentLimitPair): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits?: number): number;
function round<T>(value: T, digits?: number): T;
function round(value: unknown, digits = 6): unknown {
  if (!isFiniteNumber(value)) return value;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function compactObject<T extends Record<string, unknown>>(object: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function validateProfile(profile: unknown, label: string): asserts profile is FontProfileLike {
  if (!isObject(profile)) {
    throw new TypeError(`${label} must be a font profile object`);
  }
  if (typeof profile.profileId !== "string" || profile.profileId.trim() === "") {
    throw new TypeError(`${label}.profileId must be a non-empty string`);
  }
}

function validateNonNegativeWeights(weights: Record<string, unknown>, label: string): void {
  for (const [key, value] of Object.entries(weights)) {
    if (!isFiniteNumber(value) || value < 0) {
      throw new TypeError(`${label}.${key} must be a finite, non-negative number`);
    }
  }
}

function normalizeLimit(limit: unknown, fallback: AdjustmentLimitPair, label: string): AdjustmentLimitPair {
  const value = limit ?? fallback;
  if (
    !Array.isArray(value)
    || value.length !== 2
    || !isFiniteNumber(value[0])
    || !isFiniteNumber(value[1])
    || value[0] > value[1]
  ) {
    throw new TypeError(`${label} must be a [minimum, maximum] number pair`);
  }
  return Object.freeze([value[0], value[1]]) as AdjustmentLimitPair;
}

export interface ComparisonOptions {
  weights?: Partial<Record<string, number>>;
  componentWeights?: Partial<Record<string, number>>;
  widthMetricWeights?: Partial<Record<string, number>>;
  verticalMetricWeights?: Partial<Record<string, number>>;
  styleMetricWeights?: Partial<Record<string, number>>;
  requiredCoverageSets?: string[] | null;
  coverageTolerance?: number;
  minimumCoverageRatio?: number | null;
  missingMetricPenalty?: number;
  spaceFrequency?: number;
  adjustmentLimits?: {
    hwp?: { ratio?: unknown; spacing?: unknown };
    hwpx?: { ratio?: unknown; spacing?: unknown };
  };
}

interface NormalizedOptions {
  requiredCoverageSets: string[] | null;
  coverageTolerance: number;
  minimumCoverageRatio: number | null;
  missingMetricPenalty: number;
  spaceFrequency: number;
  componentWeights: Readonly<Record<string, number>>;
  widthMetricWeights: Readonly<Record<string, number>>;
  verticalMetricWeights: Readonly<Record<string, number>>;
  styleMetricWeights: Readonly<Record<string, number>>;
  adjustmentLimits: Readonly<Record<"hwp" | "hwpx", AdjustmentLimits>>;
}

function normalizeOptions(options: ComparisonOptions = {}): NormalizedOptions {
  if (!isObject(options)) {
    throw new TypeError("options must be an object");
  }

  const componentWeights = {
    ...DEFAULT_COMPONENT_WEIGHTS,
    ...(options.weights ?? {}),
    ...(options.componentWeights ?? {}),
  };
  const widthMetricWeights = {
    ...DEFAULT_WIDTH_METRIC_WEIGHTS,
    ...(options.widthMetricWeights ?? {}),
  };
  const verticalMetricWeights = {
    ...DEFAULT_VERTICAL_METRIC_WEIGHTS,
    ...(options.verticalMetricWeights ?? {}),
  };
  const styleMetricWeights = {
    ...DEFAULT_STYLE_METRIC_WEIGHTS,
    ...(options.styleMetricWeights ?? {}),
  };

  validateNonNegativeWeights(componentWeights, "componentWeights");
  validateNonNegativeWeights(widthMetricWeights, "widthMetricWeights");
  validateNonNegativeWeights(verticalMetricWeights, "verticalMetricWeights");
  validateNonNegativeWeights(styleMetricWeights, "styleMetricWeights");

  if (!Object.values(componentWeights).some((weight) => weight > 0)) {
    throw new TypeError("componentWeights must contain at least one positive weight");
  }

  if (
    options.requiredCoverageSets != null
    && !Array.isArray(options.requiredCoverageSets)
  ) {
    throw new TypeError("requiredCoverageSets must be an array of non-empty strings");
  }
  const requiredCoverageSets = options.requiredCoverageSets == null
    ? null
    : [...new Set(options.requiredCoverageSets)].sort();
  if (
    requiredCoverageSets !== null
    && !requiredCoverageSets.every((name) => typeof name === "string" && name.length > 0)
  ) {
    throw new TypeError("requiredCoverageSets must be an array of non-empty strings");
  }

  const coverageTolerance = options.coverageTolerance
    ?? DEFAULT_COMPARISON_OPTIONS.coverageTolerance;
  if (!isFiniteNumber(coverageTolerance) || coverageTolerance < 0) {
    throw new TypeError("coverageTolerance must be a finite, non-negative number");
  }

  const minimumCoverageRatio = options.minimumCoverageRatio
    ?? DEFAULT_COMPARISON_OPTIONS.minimumCoverageRatio;
  if (
    minimumCoverageRatio !== null
    && (!isFiniteNumber(minimumCoverageRatio)
      || minimumCoverageRatio < 0
      || minimumCoverageRatio > 1)
  ) {
    throw new TypeError("minimumCoverageRatio must be null or a number from 0 to 1");
  }

  const missingMetricPenalty = options.missingMetricPenalty
    ?? DEFAULT_COMPARISON_OPTIONS.missingMetricPenalty;
  if (!isFiniteNumber(missingMetricPenalty) || missingMetricPenalty < 0) {
    throw new TypeError("missingMetricPenalty must be a finite, non-negative number");
  }

  const spaceFrequency = options.spaceFrequency ?? DEFAULT_COMPARISON_OPTIONS.spaceFrequency;
  if (!isFiniteNumber(spaceFrequency) || spaceFrequency < 0 || spaceFrequency > 1) {
    throw new TypeError("spaceFrequency must be a number from 0 to 1");
  }

  const requestedLimits: Partial<Record<"hwp" | "hwpx", { ratio?: unknown; spacing?: unknown }>> =
    options.adjustmentLimits ?? {};
  const adjustmentLimits: Record<"hwp" | "hwpx", AdjustmentLimits> = {} as Record<"hwp" | "hwpx", AdjustmentLimits>;
  for (const format of ["hwp", "hwpx"] as const) {
    const requested = requestedLimits[format] ?? {};
    const fallback = DEFAULT_ADJUSTMENT_LIMITS[format];
    adjustmentLimits[format] = Object.freeze({
      ratio: normalizeLimit(requested.ratio, fallback.ratio, `${format}.ratio`),
      spacing: normalizeLimit(requested.spacing, fallback.spacing, `${format}.spacing`),
    });
  }

  return Object.freeze({
    requiredCoverageSets,
    coverageTolerance,
    minimumCoverageRatio,
    missingMetricPenalty,
    spaceFrequency,
    componentWeights: Object.freeze(componentWeights),
    widthMetricWeights: Object.freeze(widthMetricWeights),
    verticalMetricWeights: Object.freeze(verticalMetricWeights),
    styleMetricWeights: Object.freeze(styleMetricWeights),
    adjustmentLimits: Object.freeze(adjustmentLimits),
  });
}

function normalizeCoverageRatio(set: unknown): number | null {
  if (typeof set === "boolean") return set ? 1 : 0;
  if (isFiniteNumber(set)) return clamp(set, [0, 1]);
  if (!isObject(set)) return null;

  let ratio = set.ratio as unknown;
  if (!isFiniteNumber(ratio) && isFiniteNumber(set.mapped) && isFiniteNumber(set.required)) {
    ratio = set.required === 0 ? 1 : (set.mapped as number) / (set.required as number);
  }
  if (!isFiniteNumber(ratio)) return null;
  // Be tolerant of older metadata that represented ratios as percentages.
  if (ratio > 1 && ratio <= 100) ratio /= 100;
  return clamp(ratio, [0, 1]);
}

interface CoverageSetDetails {
  ratio: number | null;
  required: number | null;
  mapped: number | null;
}

function coverageSetDetails(set: unknown): CoverageSetDetails {
  const object = isObject(set) ? set : {};
  return {
    ratio: normalizeCoverageRatio(set),
    required: isFiniteNumber(object.required) ? object.required : null,
    mapped: isFiniteNumber(object.mapped) ? object.mapped : null,
  };
}

export interface CoverageCheckResult {
  passed: boolean;
  requiredSets: string[];
  checkedSets: Array<{
    set: string;
    requiredRatio: number;
    sourceRatio: number | null;
    candidateRatio: number | null;
    sourceMapped: number | null;
    candidateMapped: number | null;
    required: number | null;
    passed: boolean;
  }>;
  failures: Array<{
    set: string;
    reason: "missing" | "insufficient";
    requiredRatio: number;
    candidateRatio: number | null;
  }>;
}

/**
 * Enforce the coverage hard gate. By default, every character set covered by
 * the source must be covered to at least the same aggregate ratio by the
 * candidate. `requiredCoverageSets` can select a stricter explicit repertoire.
 */
export function checkCoverageCompatibility(
  reference: FontProfileLike,
  candidate: FontProfileLike,
  options: ComparisonOptions = {},
): CoverageCheckResult {
  validateProfile(reference, "reference");
  validateProfile(candidate, "candidate");
  const normalized = normalizeOptions(options);
  return checkCoverageInternal(reference, candidate, normalized);
}

function checkCoverageInternal(
  reference: FontProfileLike,
  candidate: FontProfileLike,
  options: NormalizedOptions,
): CoverageCheckResult {
  const referenceSets = reference.coverage?.sets ?? {};
  const candidateSets = candidate.coverage?.sets ?? {};
  const explicit = options.requiredCoverageSets !== null;
  const setNames = explicit
    ? (options.requiredCoverageSets as string[])
    : Object.keys(referenceSets)
      .filter((name) => (normalizeCoverageRatio(referenceSets[name]) ?? 0) > 0)
      .sort();

  const checkedSets: CoverageCheckResult["checkedSets"] = [];
  const failures: CoverageCheckResult["failures"] = [];
  for (const setName of setNames) {
    const source = coverageSetDetails(referenceSets[setName]);
    const target = coverageSetDetails(candidateSets[setName]);
    let requiredRatio = source.ratio;

    // An explicitly requested set absent from the source still means "require
    // complete support", unless the caller supplied a different minimum.
    if (requiredRatio === null || (explicit && requiredRatio === 0)) {
      requiredRatio = options.minimumCoverageRatio ?? 1;
    } else if (options.minimumCoverageRatio !== null) {
      requiredRatio = Math.max(requiredRatio, options.minimumCoverageRatio);
    }

    const passed = target.ratio !== null
      && target.ratio + options.coverageTolerance >= requiredRatio;
    const detail = {
      set: setName,
      requiredRatio: round(requiredRatio),
      sourceRatio: source.ratio === null ? null : round(source.ratio),
      candidateRatio: target.ratio === null ? null : round(target.ratio),
      sourceMapped: source.mapped,
      candidateMapped: target.mapped,
      required: source.required ?? target.required,
      passed,
    };
    checkedSets.push(detail);
    if (!passed) {
      failures.push({
        set: setName,
        reason: target.ratio === null ? "missing" : "insufficient",
        requiredRatio: detail.requiredRatio,
        candidateRatio: detail.candidateRatio,
      });
    }
  }

  return {
    passed: failures.length === 0,
    requiredSets: setNames,
    checkedSets,
    failures,
  };
}

function groupMean(profile: FontProfileLike, aliases: readonly string[]): number | undefined {
  const groups = profile.metrics?.advance?.groups ?? {};
  for (const alias of aliases) {
    const group = groups[alias];
    const value = firstFinite(group?.mean, group?.median, group?.p50);
    if (value !== undefined) return value;
  }
  return undefined;
}

function averageGroupMeans(profile: FontProfileLike, aliases: readonly string[]): number | undefined {
  const groups = profile.metrics?.advance?.groups ?? {};
  const values = aliases
    .map((alias) => firstFinite(groups[alias]?.mean, groups[alias]?.median, groups[alias]?.p50))
    .filter(isFiniteNumber);
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function bodyTextSampleMean(profile: FontProfileLike): number | undefined {
  const samples = Array.isArray(profile.layout?.samples) ? profile.layout.samples : [];
  const preferred = samples.find(
    (sample: FontProfileLike) => sample?.complete && /body|paragraph|korean/i.test(String(sample.id ?? "")),
  );
  if (isFiniteNumber(preferred?.advancePerCodePointEm)) {
    return preferred.advancePerCodePointEm;
  }
  const usable = samples
    .filter((sample: FontProfileLike) => sample?.complete && isFiniteNumber(sample.advancePerCodePointEm))
    .map((sample: FontProfileLike) => sample.advancePerCodePointEm as number);
  if (usable.length === 0) return undefined;
  return usable.reduce((sum: number, value: number) => sum + value, 0) / usable.length;
}

function extractWidthModel(profile: FontProfileLike): Record<string, number> {
  const direct = profile.hwpkit?.widthModel ?? {};
  const values: Record<string, number> = {};
  if (isFiniteNumber(direct.spaceEm)) values.spaceEm = direct.spaceEm;
  for (const key of WIDTH_KEYS) {
    if (isFiniteNumber(direct[key])) {
      values[key] = direct[key];
      continue;
    }
    if (key === "bodyTextEm") {
      const sampleMean = bodyTextSampleMean(profile);
      if (isFiniteNumber(sampleMean)) values[key] = sampleMean;
      continue;
    }
    if (key === "jamoEm") {
      const average = averageGroupMeans(profile, [
        "modernHangulJamo",
        "hangulJamo",
        "compatibilityJamo",
        "jamo",
      ]);
      if (isFiniteNumber(average)) values[key] = average;
      continue;
    }
    if (key === "punctuationEm") {
      const average = averageGroupMeans(profile, [
        "asciiPunctuation",
        "koreanPunctuation",
        "punctuation",
        "punctuationMarks",
      ]);
      if (isFiniteNumber(average)) values[key] = average;
      continue;
    }
    const aliases = GROUP_ALIASES[key];
    const mean = aliases ? groupMean(profile, aliases) : undefined;
    if (isFiniteNumber(mean)) values[key] = mean;
  }
  return values;
}

function extractSpaceAdvance(
  profile: FontProfileLike,
  widthModel: Record<string, number> = extractWidthModel(profile),
): number | undefined {
  if (isFiniteNumber(widthModel.spaceEm)) return widthModel.spaceEm;
  const spaces = profile.metrics?.advance?.spaces ?? {};
  const entries = Object.values(spaces) as FontProfileLike[];
  const asciiSpace = entries.find((space) => (
    space?.codePoint === 0x20 || space?.codePoint === "U+0020"
  ))
    ?? spaces.space
    ?? spaces.asciiSpace
    ?? spaces.regular;
  return firstFinite(asciiSpace?.advanceEm, asciiSpace?.mean, asciiSpace?.median);
}

function extractLineModel(profile: FontProfileLike): Record<string, number> {
  const direct = profile.hwpkit?.lineModel ?? {};
  const preferred = profile.metrics?.line?.preferred ?? {};
  const values: Record<string, number> = {};
  for (const key of VERTICAL_KEYS) {
    const value = firstFinite(direct[key], preferred[key]);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

interface StyleValues {
  weightClass?: number;
  widthClass?: number;
  italic?: boolean;
}

function extractStyle(profile: FontProfileLike): StyleValues {
  const face = profile.face ?? {};
  return compactObject({
    weightClass: firstFinite(face.weightClass, face.style?.weightClass),
    widthClass: firstFinite(face.widthClass, face.style?.widthClass),
    italic: typeof face.italic === "boolean"
      ? face.italic
      : (typeof face.style?.italic === "boolean" ? face.style.italic : undefined),
  }) as StyleValues;
}

function magnitude(value: number): number {
  return Math.abs(value);
}

/** Symmetric multiplicative difference: 0.1 means roughly a 10% mismatch. */
function fixedMetricDistance(referenceValue: number, candidateValue: number): number {
  const referenceMagnitude = magnitude(referenceValue);
  const candidateMagnitude = magnitude(candidateValue);
  if (referenceMagnitude === 0 && candidateMagnitude === 0) return 0;
  if (referenceMagnitude === 0 || candidateMagnitude === 0) {
    return Math.abs(candidateMagnitude - referenceMagnitude);
  }
  return Math.abs(Math.log(candidateMagnitude / referenceMagnitude));
}

function signedDelta(referenceValue: number, candidateValue: number): number {
  const referenceMagnitude = magnitude(referenceValue);
  const candidateMagnitude = magnitude(candidateValue);
  if (referenceMagnitude === 0) return candidateMagnitude - referenceMagnitude;
  return (candidateMagnitude / referenceMagnitude) - 1;
}

interface ComponentResult {
  distance: number | null;
  deltas: Record<string, { reference: number | null; candidate: number | null; relative: number | null }>;
  missing: string[];
  compared: string[];
}

function metricComponent(
  referenceValues: Record<string, number>,
  candidateValues: Record<string, number>,
  metricWeights: Readonly<Record<string, number>>,
  options: NormalizedOptions,
): ComponentResult {
  let weightedDistance = 0;
  let totalWeight = 0;
  const deltas: ComponentResult["deltas"] = {};
  const missing: string[] = [];
  const compared: string[] = [];

  for (const [key, weight] of Object.entries(metricWeights)) {
    if (weight <= 0 || !isFiniteNumber(referenceValues[key])) continue;
    totalWeight += weight;
    const referenceValue = referenceValues[key];
    const candidateValue = candidateValues[key];
    if (!isFiniteNumber(candidateValue)) {
      weightedDistance += weight * options.missingMetricPenalty;
      missing.push(key);
      deltas[key] = {
        reference: round(referenceValue),
        candidate: null,
        relative: null,
      };
      continue;
    }

    weightedDistance += weight * fixedMetricDistance(referenceValue, candidateValue);
    compared.push(key);
    deltas[key] = {
      reference: round(referenceValue),
      candidate: round(candidateValue),
      relative: round(signedDelta(referenceValue, candidateValue)),
    };
  }

  return {
    distance: totalWeight > 0 ? weightedDistance / totalWeight : null,
    deltas,
    missing,
    compared,
  };
}

function styleComponent(
  referenceStyle: StyleValues,
  candidateStyle: StyleValues,
  options: NormalizedOptions,
): ComponentResult {
  let weightedDistance = 0;
  let totalWeight = 0;
  const deltas: ComponentResult["deltas"] = {};
  const missing: string[] = [];
  const compared: string[] = [];
  const fixedScales: Record<string, number> = { weightClass: 900, widthClass: 8 };

  for (const key of STYLE_KEYS) {
    const weight = options.styleMetricWeights[key];
    const referenceValue = referenceStyle[key];
    if (weight <= 0 || referenceValue === undefined) continue;
    totalWeight += weight;
    const candidateValue = candidateStyle[key];
    if (candidateValue === undefined) {
      weightedDistance += weight * options.missingMetricPenalty;
      missing.push(key);
      deltas[key] = { reference: referenceValue as unknown as number, candidate: null, relative: null };
      continue;
    }

    const distance = key === "italic"
      ? (candidateValue === referenceValue ? 0 : 1)
      : Math.abs((candidateValue as number) - (referenceValue as number)) / fixedScales[key];
    weightedDistance += weight * distance;
    compared.push(key);
    deltas[key] = {
      reference: referenceValue as unknown as number,
      candidate: candidateValue as unknown as number,
      relative: round(distance),
    };
  }

  return {
    distance: totalWeight > 0 ? weightedDistance / totalWeight : null,
    deltas,
    missing,
    compared,
  };
}

function weightedTotal(
  components: Record<string, number | null>,
  componentWeights: Readonly<Record<string, number>>,
): number | null {
  let weightedDistance = 0;
  let totalWeight = 0;
  for (const [name, value] of Object.entries(components)) {
    const weight = componentWeights[name] ?? 0;
    if (weight <= 0 || !isFiniteNumber(value)) continue;
    weightedDistance += value * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedDistance / totalWeight : null;
}

function primaryWidth(
  referenceWidths: Record<string, number>,
  candidateWidths: Record<string, number>,
): { reference: number; candidate: number } | null {
  for (const key of ["hangulEm", "bodyTextEm", "latinLowerEm", "latinUpperEm", "digitEm"]) {
    if (
      isFiniteNumber(referenceWidths[key])
      && isFiniteNumber(candidateWidths[key])
      && magnitude(candidateWidths[key]) > 0
    ) {
      return { reference: magnitude(referenceWidths[key]), candidate: magnitude(candidateWidths[key]) };
    }
  }
  return null;
}

interface FormatAdjustment {
  ratio: number;
  spacing: number;
  rawRatio: number;
  rawSpacing: number;
  clamped: { ratio: boolean; spacing: boolean };
}

function adjustmentForFormat(
  referenceWidths: Record<string, number>,
  candidateWidths: Record<string, number>,
  referenceSpace: number | undefined,
  candidateSpace: number | undefined,
  limits: AdjustmentLimits,
  spaceFrequency: number,
): FormatAdjustment {
  const primary = primaryWidth(referenceWidths, candidateWidths);
  const rawRatio = primary ? (primary.reference / primary.candidate) * 100 : 100;
  const ratio = Math.round(clamp(rawRatio, limits.ratio));
  const appliedScale = ratio / 100;

  let rawSpacing = 0;
  if (
    isFiniteNumber(referenceWidths.bodyTextEm)
    && isFiniteNumber(candidateWidths.bodyTextEm)
  ) {
    rawSpacing = (
      magnitude(referenceWidths.bodyTextEm)
      - (magnitude(candidateWidths.bodyTextEm) * appliedScale)
    ) * 100;
  } else if (isFiniteNumber(referenceSpace) && isFiniteNumber(candidateSpace)) {
    // Character spacing applies to every character. Scale a whitespace-only
    // residual by a fixed body-text space frequency rather than over-correcting.
    rawSpacing = (
      magnitude(referenceSpace)
      - (magnitude(candidateSpace) * appliedScale)
    ) * spaceFrequency * 100;
  }
  const spacing = Math.round(clamp(rawSpacing, limits.spacing));

  return {
    ratio,
    spacing,
    rawRatio: round(rawRatio, 4),
    rawSpacing: round(rawSpacing, 4),
    clamped: {
      ratio: rawRatio < limits.ratio[0] || rawRatio > limits.ratio[1],
      spacing: rawSpacing < limits.spacing[0] || rawSpacing > limits.spacing[1],
    },
  };
}

export interface FormatAdjustments {
  hwp: FormatAdjustment;
  hwpx: FormatAdjustment;
}

/**
 * Produce bounded integer ratio/spacing values ready to map to HWP/HWPX
 * character properties. The source is the layout target; the candidate is the
 * replacement font.
 */
export function computeFormatAdjustments(
  reference: FontProfileLike,
  candidate: FontProfileLike,
  options: ComparisonOptions = {},
): FormatAdjustments {
  validateProfile(reference, "reference");
  validateProfile(candidate, "candidate");
  const normalized = normalizeOptions(options);
  return computeFormatAdjustmentsInternal(reference, candidate, normalized);
}

function computeFormatAdjustmentsInternal(
  reference: FontProfileLike,
  candidate: FontProfileLike,
  options: NormalizedOptions,
): FormatAdjustments {
  const referenceWidths = extractWidthModel(reference);
  const candidateWidths = extractWidthModel(candidate);
  const referenceSpace = extractSpaceAdvance(reference, referenceWidths);
  const candidateSpace = extractSpaceAdvance(candidate, candidateWidths);

  return {
    hwp: adjustmentForFormat(
      referenceWidths,
      candidateWidths,
      referenceSpace,
      candidateSpace,
      options.adjustmentLimits.hwp,
      options.spaceFrequency,
    ),
    hwpx: adjustmentForFormat(
      referenceWidths,
      candidateWidths,
      referenceSpace,
      candidateSpace,
      options.adjustmentLimits.hwpx,
      options.spaceFrequency,
    ),
  };
}

function summarizeFace(face: FontProfileLike = {}) {
  return compactObject({
    family: face.family,
    subfamily: face.subfamily,
    fullName: face.fullName,
    postscriptName: face.postscriptName,
    weightClass: firstFinite(face.weightClass, face.style?.weightClass),
    widthClass: firstFinite(face.widthClass, face.style?.widthClass),
    italic: typeof face.italic === "boolean"
      ? face.italic
      : (typeof face.style?.italic === "boolean" ? face.style.italic : undefined),
  });
}

export interface CompareResult {
  profileId: string;
  face: ReturnType<typeof summarizeFace>;
  eligible: boolean;
  rejectionReasons: string[];
  rank: number | null;
  distance: number | null;
  score: number;
  coverage: CoverageCheckResult;
  components: Record<string, number | null>;
  deltas: {
    width: ComponentResult["deltas"];
    space: ComponentResult["deltas"];
    vertical: ComponentResult["deltas"];
    style: ComponentResult["deltas"];
  };
  missingMetrics: {
    width: string[];
    space: string[];
    vertical: string[];
    style: string[];
  };
  adjustments: FormatAdjustments;
}

function compareInternal(
  reference: FontProfileLike,
  candidate: FontProfileLike,
  options: NormalizedOptions,
): CompareResult {
  const coverage = checkCoverageInternal(reference, candidate, options);
  const referenceWidths = extractWidthModel(reference);
  const candidateWidths = extractWidthModel(candidate);
  const referenceSpace = extractSpaceAdvance(reference, referenceWidths);
  const candidateSpace = extractSpaceAdvance(candidate, candidateWidths);
  const referenceLine = extractLineModel(reference);
  const candidateLine = extractLineModel(candidate);

  const width = metricComponent(
    referenceWidths,
    candidateWidths,
    options.widthMetricWeights,
    options,
  );
  const space = metricComponent(
    isFiniteNumber(referenceSpace) ? { spaceEm: referenceSpace } : {},
    isFiniteNumber(candidateSpace) ? { spaceEm: candidateSpace } : {},
    { spaceEm: 1 },
    options,
  );
  const vertical = metricComponent(
    referenceLine,
    candidateLine,
    options.verticalMetricWeights,
    options,
  );
  const style = styleComponent(extractStyle(reference), extractStyle(candidate), options);

  const rawComponents: Record<string, number | null> = {
    width: width.distance,
    space: space.distance,
    vertical: vertical.distance,
    style: style.distance,
  };
  const metricDistance = weightedTotal(rawComponents, options.componentWeights);
  if (metricDistance === null) {
    throw new TypeError("reference profile does not contain comparable metrics");
  }

  const eligible = coverage.passed;
  const distance = eligible ? round(metricDistance) : null;
  return {
    profileId: candidate.profileId,
    face: summarizeFace(candidate.face),
    eligible,
    rejectionReasons: coverage.failures.map((failure) => `coverage:${failure.set}`),
    rank: null,
    distance,
    score: eligible ? round(100 * Math.exp(-metricDistance), 4) : 0,
    coverage,
    components: Object.fromEntries(
      Object.entries(rawComponents).map(([name, value]) => [
        name,
        value === null ? null : round(value),
      ]),
    ),
    deltas: {
      width: width.deltas,
      space: space.deltas,
      vertical: vertical.deltas,
      style: style.deltas,
    },
    missingMetrics: {
      width: width.missing,
      space: space.missing,
      vertical: vertical.missing,
      style: style.missing,
    },
    adjustments: computeFormatAdjustmentsInternal(reference, candidate, options),
  };
}

/** Compare one candidate profile with a reference profile. */
export function compareFontProfiles(
  reference: FontProfileLike,
  candidate: FontProfileLike,
  options: ComparisonOptions = {},
): CompareResult {
  validateProfile(reference, "reference");
  validateProfile(candidate, "candidate");
  return compareInternal(reference, candidate, normalizeOptions(options));
}

function sourceSummary(profile: FontProfileLike) {
  const source = profile.source ?? {};
  return compactObject({
    profileId: profile.profileId,
    sha256: source.sha256 ?? profile.sha256,
    faceIndex: firstFinite(source.faceIndex, profile.faceIndex),
    face: summarizeFace(profile.face),
  });
}

export interface RankResult {
  schemaVersion: string;
  schemaId: string;
  source: ReturnType<typeof sourceSummary>;
  config: {
    requiredCoverageSets: string[] | null;
    coverageTolerance: number;
    minimumCoverageRatio: number | null;
    missingMetricPenalty: number;
    spaceFrequency: number;
    weights: {
      components: Record<string, number>;
      width: Record<string, number>;
      vertical: Record<string, number>;
      style: Record<string, number>;
    };
    adjustmentLimits: {
      hwp: { ratio: number[]; spacing: number[] };
      hwpx: { ratio: number[]; spacing: number[] };
    };
  };
  candidates: CompareResult[];
  rejected: CompareResult[];
  errors?: unknown[];
}

/**
 * Rank eligible fallback candidates by ascending fixed distance. Coverage
 * failures are returned separately and never receive a rank.
 */
export function rankFontCandidates(
  reference: FontProfileLike,
  candidates: FontProfileLike[],
  options: ComparisonOptions = {},
): RankResult {
  validateProfile(reference, "reference");
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array of font profiles");
  }
  candidates.forEach((candidate, index) => validateProfile(candidate, `candidates[${index}]`));
  const normalized = normalizeOptions(options);
  const rows = candidates.map((candidate) => compareInternal(reference, candidate, normalized));
  const eligible = rows
    .filter((row) => row.eligible)
    .sort((left, right) => (
      (left.distance as number) - (right.distance as number)
      || left.profileId.localeCompare(right.profileId, "en")
    ))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const rejected = rows
    .filter((row) => !row.eligible)
    .sort((left, right) => left.profileId.localeCompare(right.profileId, "en"));

  return {
    schemaVersion: COMPARISON_SCHEMA_VERSION,
    schemaId: COMPARISON_SCHEMA_ID,
    source: sourceSummary(reference),
    config: {
      requiredCoverageSets: normalized.requiredCoverageSets,
      coverageTolerance: normalized.coverageTolerance,
      minimumCoverageRatio: normalized.minimumCoverageRatio,
      missingMetricPenalty: normalized.missingMetricPenalty,
      spaceFrequency: normalized.spaceFrequency,
      weights: {
        components: { ...normalized.componentWeights },
        width: { ...normalized.widthMetricWeights },
        vertical: { ...normalized.verticalMetricWeights },
        style: { ...normalized.styleMetricWeights },
      },
      adjustmentLimits: {
        hwp: {
          ratio: [...normalized.adjustmentLimits.hwp.ratio],
          spacing: [...normalized.adjustmentLimits.hwp.spacing],
        },
        hwpx: {
          ratio: [...normalized.adjustmentLimits.hwpx.ratio],
          spacing: [...normalized.adjustmentLimits.hwpx.spacing],
        },
      },
    },
    candidates: eligible,
    rejected,
  };
}

// Short aliases for CLI/integration callers. The descriptive names above are
// the canonical API and are retained in stack traces and documentation.
export const compareProfiles = compareFontProfiles;
export const rankCandidates = rankFontCandidates;
