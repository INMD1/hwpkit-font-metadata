import { createHash } from "node:crypto";
import path from "node:path";

import type { Font, Glyph } from "fontkit";

import {
  ADVANCE_GROUPS,
  CATALOG_SCHEMA_ID,
  CORPUS_ID,
  COVERAGE_SETS,
  DEFAULT_LAYOUT_SAMPLES,
  HANGUL_INK_PROBES,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PROFILE_SCHEMA_ID,
  REPRESENTATIVE_GLYPHS,
  SCHEMA_VERSION,
  SPACE_CODE_POINTS,
} from "./constants.js";
import type { LayoutSample } from "./constants.js";
import { describe, round } from "./stats.js";
import type { Summary } from "./stats.js";
import type { FontSource } from "./font-source.js";

/**
 * fontkit's published types cover the documented API but not every raw sfnt
 * table property this module reads (head/post/directory, and OS/2 subfields
 * beyond what @types/fontkit declares). Those are accessed through this
 * loosely typed view instead of widening the public Font type everywhere.
 */
interface RawFont extends Font {
  head?: {
    xMin?: number;
    yMin?: number;
    xMax?: number;
    yMax?: number;
    macStyle?: { italic?: boolean };
  };
  post?: {
    italicAngle?: number;
    underlinePosition?: number;
    underlineThickness?: number;
    isFixedPitch?: boolean;
  };
  directory?: { tables?: Record<string, unknown> };
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function corpusFingerprint(samples: readonly LayoutSample[]): string {
  return sha256Text(
    samples
      .map((sample) => `${sample.id}\0${sample.normalization ?? "none"}\0${sample.text}`)
      .join("\0\0"),
  );
}

function valueOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function em(value: number | null | undefined, unitsPerEm: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && unitsPerEm > 0
    ? round(value / unitsPerEm)
    : null;
}

function codePointLabel(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = typeof value === "string" ? value.trim() : "";
    const key = normalized.toLocaleLowerCase("en-US");
    if (normalized && !seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function table<K extends keyof RawFont>(font: RawFont, name: K): RawFont[K] | null {
  try {
    return font[name] ?? null;
  } catch {
    return null;
  }
}

function tableTags(font: RawFont): Set<string> {
  return new Set(Object.keys(font?.directory?.tables ?? {}));
}

function detectOutlineFormat(font: RawFont): string {
  const tags = tableTags(font);
  if (tags.has("glyf")) return "TrueType";
  if (tags.has("CFF2")) return "CFF2";
  if (tags.has("CFF ")) return "CFF";
  return "unknown";
}

interface NormalLineMetric {
  ascenderDu: number | null;
  descenderDu: number | null;
  lineGapDu: number | null;
  lineAdvanceDu: number | null;
  ascenderEm: number | null;
  descenderEm: number | null;
  lineGapEm: number | null;
  lineAdvanceEm: number | null;
  baselineFromTopEm: number | null;
  baselineFraction: number | null;
}

function normalLineMetric(
  ascender: number | null | undefined,
  descender: number | null | undefined,
  lineGap: number | null | undefined,
  unitsPerEm: number,
): NormalLineMetric {
  const valid = [ascender, descender, lineGap].every((value) => Number.isFinite(value));
  if (!valid) {
    return {
      ascenderDu: null,
      descenderDu: null,
      lineGapDu: null,
      lineAdvanceDu: null,
      ascenderEm: null,
      descenderEm: null,
      lineGapEm: null,
      lineAdvanceEm: null,
      baselineFromTopEm: null,
      baselineFraction: null,
    };
  }
  const lineAdvance = (ascender as number) - (descender as number) + (lineGap as number);
  return {
    ascenderDu: ascender as number,
    descenderDu: descender as number,
    lineGapDu: lineGap as number,
    lineAdvanceDu: lineAdvance,
    ascenderEm: em(ascender, unitsPerEm),
    descenderEm: em(descender, unitsPerEm),
    lineGapEm: em(lineGap, unitsPerEm),
    lineAdvanceEm: em(lineAdvance, unitsPerEm),
    baselineFromTopEm: em(ascender, unitsPerEm),
    baselineFraction: round(lineAdvance === 0 ? null : (ascender as number) / lineAdvance),
  };
}

interface WindowsLineMetric {
  ascenderDu: number | null;
  descenderDu: number | null;
  heightDu: number | null;
  ascenderEm: number | null;
  descenderEm: number | null;
  heightEm: number | null;
}

function windowsLineMetric(
  ascender: number | null | undefined,
  descender: number | null | undefined,
  unitsPerEm: number,
): WindowsLineMetric {
  const valid = [ascender, descender].every((value) => Number.isFinite(value));
  const height = valid ? (ascender as number) + (descender as number) : null;
  return {
    ascenderDu: valid ? (ascender as number) : null,
    descenderDu: valid ? (descender as number) : null,
    heightDu: height,
    ascenderEm: em(ascender, unitsPerEm),
    descenderEm: em(descender, unitsPerEm),
    heightEm: em(height, unitsPerEm),
  };
}

interface LineMetrics {
  useTypoMetrics: boolean;
  typo: NormalLineMetric;
  hhea: NormalLineMetric;
  windows: WindowsLineMetric;
  engine: NormalLineMetric;
  preferred: NormalLineMetric & { source: string };
  headBounds: {
    xMinDu: number | null;
    yMinDu: number | null;
    xMaxDu: number | null;
    yMaxDu: number | null;
    xMinEm: number | null;
    yMinEm: number | null;
    xMaxEm: number | null;
    yMaxEm: number | null;
  };
}

function extractLineMetrics(font: RawFont, unitsPerEm: number, warnings: string[]): LineMetrics {
  const head = table(font, "head");
  const hhea = table(font, "hhea");
  const os2 = table(font, "OS/2");
  const engine = normalLineMetric(font.ascent, font.descent, font.lineGap, unitsPerEm);
  const typo = normalLineMetric(
    os2?.typoAscender,
    os2?.typoDescender,
    os2?.typoLineGap,
    unitsPerEm,
  );
  const horizontal = normalLineMetric(
    hhea?.ascent,
    hhea?.descent,
    hhea?.lineGap,
    unitsPerEm,
  );
  const windows = windowsLineMetric(os2?.winAscent, os2?.winDescent, unitsPerEm);
  const useTypoMetrics = Boolean(os2?.fsSelection?.useTypoMetrics);

  let source = "hhea";
  let preferred: NormalLineMetric = horizontal;
  if (useTypoMetrics && typo.lineAdvanceEm !== null) {
    source = "OS/2.sTypo";
    preferred = typo;
  } else if (horizontal.lineAdvanceEm === null && engine.lineAdvanceEm !== null) {
    source = "fontkit-engine";
    preferred = engine;
  } else if (horizontal.lineAdvanceEm === null && typo.lineAdvanceEm !== null) {
    source = "OS/2.sTypo-fallback";
    preferred = typo;
  }

  if (horizontal.lineAdvanceEm === null) warnings.push("missing-hhea-line-metrics");
  if (typo.lineAdvanceEm === null) warnings.push("missing-os2-typo-line-metrics");

  return {
    useTypoMetrics,
    typo,
    hhea: horizontal,
    windows,
    engine,
    preferred: { source, ...preferred },
    headBounds: {
      xMinDu: valueOrNull(head?.xMin),
      yMinDu: valueOrNull(head?.yMin),
      xMaxDu: valueOrNull(head?.xMax),
      yMaxDu: valueOrNull(head?.yMax),
      xMinEm: em(head?.xMin, unitsPerEm),
      yMinEm: em(head?.yMin, unitsPerEm),
      xMaxEm: em(head?.xMax, unitsPerEm),
      yMaxEm: em(head?.yMax, unitsPerEm),
    },
  };
}

function rawMetrics(font: RawFont) {
  const head = table(font, "head");
  const hhea = table(font, "hhea");
  const os2 = table(font, "OS/2");
  const post = table(font, "post");
  return {
    head: {
      unitsPerEm: valueOrNull(font.unitsPerEm),
      xMin: valueOrNull(head?.xMin),
      yMin: valueOrNull(head?.yMin),
      xMax: valueOrNull(head?.xMax),
      yMax: valueOrNull(head?.yMax),
    },
    hhea: {
      ascender: valueOrNull(hhea?.ascent),
      descender: valueOrNull(hhea?.descent),
      lineGap: valueOrNull(hhea?.lineGap),
      advanceWidthMax: valueOrNull(hhea?.advanceWidthMax),
    },
    os2: {
      version: valueOrNull(os2?.version),
      typoAscender: valueOrNull(os2?.typoAscender),
      typoDescender: valueOrNull(os2?.typoDescender),
      typoLineGap: valueOrNull(os2?.typoLineGap),
      winAscent: valueOrNull(os2?.winAscent),
      winDescent: valueOrNull(os2?.winDescent),
      xAvgCharWidth: valueOrNull(os2?.xAvgCharWidth),
      weightClass: valueOrNull(os2?.usWeightClass),
      widthClass: valueOrNull(os2?.usWidthClass),
      useTypoMetrics: Boolean(os2?.fsSelection?.useTypoMetrics),
      embedding: os2?.fsType
        ? {
            noEmbedding: Boolean(os2.fsType.noEmbedding),
            viewOnly: Boolean(os2.fsType.viewOnly),
            editable: Boolean(os2.fsType.editable),
            noSubsetting: Boolean(os2.fsType.noSubsetting),
            bitmapOnly: Boolean(os2.fsType.bitmapOnly),
          }
        : null,
      vendorId: os2?.vendorID ?? null,
      panose: Array.isArray(os2?.panose) ? [...os2.panose] : null,
    },
    post: {
      italicAngle: valueOrNull(post?.italicAngle),
      underlinePosition: valueOrNull(post?.underlinePosition),
      underlineThickness: valueOrNull(post?.underlineThickness),
      isFixedPitch: Boolean(post?.isFixedPitch),
    },
  };
}

interface MappedGlyph {
  mapped: true;
  codePoint: number;
  glyph: Glyph;
  glyphId: number;
  advanceDu: number | null;
  advanceEm: number | null;
}

interface MissingGlyph {
  mapped: false;
  codePoint: number;
  error?: string;
}

type GlyphRecord = MappedGlyph | MissingGlyph;

interface GlyphReader {
  read(codePoint: number): GlyphRecord;
  characterSet: Set<number>;
}

function createGlyphReader(font: RawFont, unitsPerEm: number): GlyphReader {
  const characterSet = new Set(font.characterSet ?? []);
  const cache = new Map<number, GlyphRecord>();

  function read(codePoint: number): GlyphRecord {
    const cached = cache.get(codePoint);
    if (cached) return cached;
    if (!characterSet.has(codePoint)) {
      const missing: GlyphRecord = { mapped: false, codePoint };
      cache.set(codePoint, missing);
      return missing;
    }
    try {
      const glyph = font.glyphForCodePoint(codePoint);
      if (!glyph || glyph.id === 0) {
        const missing: GlyphRecord = { mapped: false, codePoint };
        cache.set(codePoint, missing);
        return missing;
      }
      const advanceDu = valueOrNull(glyph.advanceWidth);
      const result: GlyphRecord = {
        mapped: true,
        codePoint,
        glyph,
        glyphId: glyph.id,
        advanceDu,
        advanceEm: em(advanceDu, unitsPerEm),
      };
      cache.set(codePoint, result);
      return result;
    } catch (error) {
      const missing: GlyphRecord = {
        mapped: false,
        codePoint,
        error: error instanceof Error ? error.message : String(error),
      };
      cache.set(codePoint, missing);
      return missing;
    }
  }

  return { read, characterSet };
}

interface CoverageSetResult {
  required: number;
  mapped: number;
  missing: number;
  ratio: number | null;
  missingSamples: string[];
}

function coverageFor(codePointSet: readonly number[], reader: GlyphReader): CoverageSetResult {
  const missing: string[] = [];
  let mapped = 0;
  for (const codePoint of codePointSet) {
    if (reader.read(codePoint).mapped) mapped += 1;
    else if (missing.length < 24) missing.push(codePointLabel(codePoint));
  }
  const required = codePointSet.length;
  return {
    required,
    mapped,
    missing: required - mapped,
    ratio: round(required === 0 ? null : mapped / required),
    missingSamples: missing,
  };
}

interface Coverage {
  sets: Record<string, CoverageSetResult>;
  missingSamples: string[];
}

function extractCoverage(reader: GlyphReader): Coverage {
  const sets = Object.fromEntries(
    Object.entries(COVERAGE_SETS).map(([name, codePointSet]) => [
      name,
      coverageFor(codePointSet, reader),
    ]),
  );
  const missingSamples = [...new Set(Object.values(sets).flatMap((set) => set.missingSamples))]
    .slice(0, 64);
  return { sets, missingSamples };
}

function advanceStats(codePointSet: readonly number[], reader: GlyphReader): Summary {
  const advances: number[] = [];
  for (const codePoint of codePointSet) {
    const glyph = reader.read(codePoint);
    if (glyph.mapped && Number.isFinite(glyph.advanceEm)) advances.push(glyph.advanceEm as number);
  }
  return describe(advances, { expected: codePointSet.length, unit: "em" });
}

function extractSpaces(reader: GlyphReader) {
  return Object.fromEntries(
    Object.entries(SPACE_CODE_POINTS).map(([name, codePoint]) => {
      const glyph = reader.read(codePoint);
      return [
        name,
        {
          codePoint: codePointLabel(codePoint),
          mapped: glyph.mapped,
          glyphId: glyph.mapped ? glyph.glyphId : null,
          advanceDu: glyph.mapped ? glyph.advanceDu : null,
          advanceEm: glyph.mapped ? glyph.advanceEm : null,
        },
      ] as const;
    }),
  );
}

function extractCodePointAdvances(reader: GlyphReader): Record<string, number> {
  const codePointSet = new Set<number>([
    ...Object.values(ADVANCE_GROUPS)
      .filter((group) => group !== ADVANCE_GROUPS.modernHangulSyllables)
      .flat(),
    ...Object.values(SPACE_CODE_POINTS),
  ]);
  const result: Record<string, number> = {};
  for (const codePoint of [...codePointSet].sort((left, right) => left - right)) {
    const glyph = reader.read(codePoint);
    if (glyph.mapped && Number.isFinite(glyph.advanceEm)) {
      result[codePointLabel(codePoint)] = glyph.advanceEm as number;
    }
  }
  return result;
}

function buildHangulAdvanceModel(reader: GlyphReader) {
  const valueCounts = new Map<number, number>();
  const measured: Array<[number, number]> = [];
  for (const codePoint of COVERAGE_SETS.modernHangulSyllables) {
    const glyph = reader.read(codePoint);
    if (!glyph.mapped || !Number.isFinite(glyph.advanceEm)) continue;
    const value = round(glyph.advanceEm) as number;
    measured.push([codePoint, value]);
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  }
  const rankedDefaults = [...valueCounts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue - rightValue,
  );
  const defaultEm = rankedDefaults[0]?.[0] ?? null;
  const exceptions: Record<string, number> = {};
  if (defaultEm !== null) {
    for (const [codePoint, value] of measured) {
      if (value !== defaultEm) exceptions[codePointLabel(codePoint)] = value;
    }
  }
  return {
    encoding: "constant-plus-exceptions-v1",
    start: "U+AC00",
    end: "U+D7A3",
    defaultEm,
    defaultCount: rankedDefaults[0]?.[1] ?? 0,
    measured: measured.length,
    exceptions,
  };
}

function extractAdvanceMetrics(reader: GlyphReader) {
  const groups = Object.fromEntries(
    Object.entries(ADVANCE_GROUPS).map(([name, codePointSet]) => [
      name,
      advanceStats(codePointSet, reader),
    ]),
  ) as Record<keyof typeof ADVANCE_GROUPS, Summary>;
  return {
    unit: "em",
    groups,
    spaces: extractSpaces(reader),
    codePoints: extractCodePointAdvances(reader),
    hangulModel: buildHangulAdvanceModel(reader),
  };
}

interface BBoxRecord {
  minXEm: number | null;
  minYEm: number | null;
  maxXEm: number | null;
  maxYEm: number | null;
  widthEm: number | null;
  heightEm: number | null;
  leftSideBearingEm: number | null;
  rightSideBearingEm: number | null;
}

function bboxRecord(glyphRecord: GlyphRecord, unitsPerEm: number): BBoxRecord | null {
  if (!glyphRecord.mapped) return null;
  try {
    const bbox = glyphRecord.glyph.bbox;
    if (!bbox) return null;
    const width = bbox.maxX - bbox.minX;
    const height = bbox.maxY - bbox.minY;
    return {
      minXEm: em(bbox.minX, unitsPerEm),
      minYEm: em(bbox.minY, unitsPerEm),
      maxXEm: em(bbox.maxX, unitsPerEm),
      maxYEm: em(bbox.maxY, unitsPerEm),
      widthEm: em(width, unitsPerEm),
      heightEm: em(height, unitsPerEm),
      leftSideBearingEm: em(bbox.minX, unitsPerEm),
      rightSideBearingEm: em((glyphRecord.advanceDu ?? 0) - bbox.maxX, unitsPerEm),
    };
  } catch {
    return null;
  }
}

function extractInkMetrics(reader: GlyphReader, unitsPerEm: number) {
  const records: BBoxRecord[] = [];
  for (const codePoint of HANGUL_INK_PROBES) {
    const record = bboxRecord(reader.read(codePoint), unitsPerEm);
    if (record) records.push(record);
  }
  const field = (name: keyof BBoxRecord) => records.map((record) => record[name]);
  return {
    probeSet: "hangul-balanced-v1",
    expected: HANGUL_INK_PROBES.length,
    measured: records.length,
    width: describe(field("widthEm"), {
      expected: HANGUL_INK_PROBES.length,
      unit: "em",
    }),
    height: describe(field("heightEm"), {
      expected: HANGUL_INK_PROBES.length,
      unit: "em",
    }),
    leftSideBearing: describe(field("leftSideBearingEm"), {
      expected: HANGUL_INK_PROBES.length,
      unit: "em",
    }),
    rightSideBearing: describe(field("rightSideBearingEm"), {
      expected: HANGUL_INK_PROBES.length,
      unit: "em",
    }),
    top: describe(field("maxYEm"), {
      expected: HANGUL_INK_PROBES.length,
      unit: "em",
    }),
    bottom: describe(field("minYEm"), {
      expected: HANGUL_INK_PROBES.length,
      unit: "em",
    }),
  };
}

function extractRepresentativeGlyphs(reader: GlyphReader, unitsPerEm: number) {
  return Object.fromEntries(
    REPRESENTATIVE_GLYPHS.map((character) => {
      const glyph = reader.read(character.codePointAt(0) as number);
      return [
        character,
        {
          codePoint: codePointLabel(character.codePointAt(0) as number),
          mapped: glyph.mapped,
          glyphId: glyph.mapped ? glyph.glyphId : null,
          advanceDu: glyph.mapped ? glyph.advanceDu : null,
          advanceEm: glyph.mapped ? glyph.advanceEm : null,
          bbox: bboxRecord(glyph, unitsPerEm),
        },
      ] as const;
    }),
  );
}

function countSpaces(text: string): number {
  const spaces = new Set<number>(Object.values(SPACE_CODE_POINTS));
  return Array.from(text).reduce(
    (count, character) => count + (spaces.has(character.codePointAt(0) as number) ? 1 : 0),
    0,
  );
}

function shapeSample(font: Font, sample: LayoutSample, reader: GlyphReader, unitsPerEm: number) {
  const characters = Array.from(sample.text);
  const missing: string[] = [];
  let unshapedAdvanceDu = 0;
  for (const character of characters) {
    const codePoint = character.codePointAt(0) as number;
    const glyph = reader.read(codePoint);
    if (glyph.mapped && Number.isFinite(glyph.advanceDu)) unshapedAdvanceDu += glyph.advanceDu as number;
    else if (missing.length < 24) missing.push(codePointLabel(codePoint));
  }

  try {
    const run = font.layout(sample.text);
    const runWithoutKerning = font.layout(sample.text, { kern: false });
    const advanceDu = run.positions.reduce(
      (sum, position) => sum + (Number.isFinite(position.xAdvance) ? position.xAdvance : 0),
      0,
    );
    const advanceWithoutKerningDu = runWithoutKerning.positions.reduce(
      (sum, position) => sum + (Number.isFinite(position.xAdvance) ? position.xAdvance : 0),
      0,
    );
    return {
      id: sample.id,
      textSha256: sha256Text(sample.text),
      normalization: sample.normalization ?? "none",
      complete: missing.length === 0,
      codePointCount: characters.length,
      glyphCount: run.glyphs.length,
      spaceCount: countSpaces(sample.text),
      missingCodePoints: [...new Set(missing)],
      advanceDu,
      advanceEm: em(advanceDu, unitsPerEm),
      advanceNoKerningDu: advanceWithoutKerningDu,
      advanceNoKerningEm: em(advanceWithoutKerningDu, unitsPerEm),
      advancePerCodePointEm: em(
        characters.length === 0 ? null : advanceDu / characters.length,
        unitsPerEm,
      ),
      advanceNoKerningPerCodePointEm: em(
        characters.length === 0 ? null : advanceWithoutKerningDu / characters.length,
        unitsPerEm,
      ),
      unshapedAdvanceEm: em(unshapedAdvanceDu, unitsPerEm),
      kerningAdjustmentEm: em(advanceDu - advanceWithoutKerningDu, unitsPerEm),
      shapingAdjustmentEm: em(advanceDu - unshapedAdvanceDu, unitsPerEm),
      error: undefined as string | undefined,
    };
  } catch (error) {
    return {
      id: sample.id,
      textSha256: sha256Text(sample.text),
      normalization: sample.normalization ?? "none",
      complete: false,
      codePointCount: characters.length,
      glyphCount: null as number | null,
      spaceCount: countSpaces(sample.text),
      missingCodePoints: [...new Set(missing)],
      advanceDu: null as number | null,
      advanceEm: null as number | null,
      advanceNoKerningDu: null as number | null,
      advanceNoKerningEm: null as number | null,
      advancePerCodePointEm: null as number | null,
      advanceNoKerningPerCodePointEm: null as number | null,
      unshapedAdvanceEm: em(unshapedAdvanceDu, unitsPerEm),
      kerningAdjustmentEm: null as number | null,
      shapingAdjustmentEm: null as number | null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type ShapedSample = ReturnType<typeof shapeSample>;

function layoutMetrics(
  font: Font,
  samples: readonly LayoutSample[],
  reader: GlyphReader,
  unitsPerEm: number,
  corpusId: string,
) {
  const shapedSamples = samples.map((sample) => shapeSample(font, sample, reader, unitsPerEm));
  return {
    corpusId,
    corpusSha256: corpusFingerprint(samples),
    samples: shapedSamples,
  };
}

function meanAvailable(...values: Array<number | null | undefined>): number | null {
  const available = values.filter((value): value is number => Number.isFinite(value));
  return available.length === 0
    ? null
    : round(available.reduce((sum, value) => sum + value, 0) / available.length);
}

function buildHwpkitProfile(
  coverage: Coverage,
  advance: ReturnType<typeof extractAdvanceMetrics>,
  line: LineMetrics,
  ink: ReturnType<typeof extractInkMetrics>,
  layout: ReturnType<typeof layoutMetrics>,
) {
  const groups = advance.groups;
  const completeBodySamples = layout.samples.filter(
    (sample) =>
      sample.complete &&
      sample.normalization !== "NFD" &&
      Number.isFinite(sample.advanceNoKerningEm ?? sample.advanceEm) &&
      sample.codePointCount > 0,
  );
  const totalBodyAdvance = completeBodySamples.reduce(
    (sum, sample) => sum + (sample.advanceNoKerningEm ?? sample.advanceEm ?? 0),
    0,
  );
  const totalBodyCharacters = completeBodySamples.reduce(
    (sum, sample) => sum + sample.codePointCount,
    0,
  );
  const modernHangulRatio = coverage.sets.modernHangulSyllables.ratio ?? 0;
  const modernJamoRatio = coverage.sets.modernHangulJamo.ratio ?? 0;
  const latinRatio = coverage.sets.basicLatinPrintable.ratio ?? 0;
  const punctuationRatio = coverage.sets.koreanPunctuation.ratio ?? 0;
  const hasSpace = advance.spaces.space.mapped;
  const hasLineMetrics = Number.isFinite(line.preferred.lineAdvanceEm);
  const confidence =
    modernHangulRatio === 1 &&
    modernJamoRatio === 1 &&
    latinRatio >= 0.95 &&
    punctuationRatio >= 0.95 &&
    hasSpace &&
    hasLineMetrics
      ? "high"
      : modernHangulRatio >= 0.95 && latinRatio >= 0.8 && hasLineMetrics
        ? "medium"
        : "low";

  return {
    units: "em",
    widthModel: {
      hangulEm: groups.modernHangulSyllables.median,
      jamoEm: meanAvailable(
        groups.modernHangulJamo.mean,
        groups.compatibilityJamo.mean,
      ),
      hanjaEm: groups.commonHanja.mean,
      latinUpperEm: groups.latinUppercase.mean,
      latinLowerEm: groups.latinLowercase.mean,
      digitEm: groups.digits.mean,
      spaceEm: advance.spaces.space.advanceEm,
      punctuationEm: meanAvailable(
        groups.asciiPunctuation.mean,
        groups.koreanPunctuation.mean,
      ),
      bodyTextEm: totalBodyCharacters > 0 ? round(totalBodyAdvance / totalBodyCharacters) : null,
    },
    lineModel: {
      source: line.preferred.source,
      lineAdvanceEm: line.preferred.lineAdvanceEm,
      ascenderEm: line.preferred.ascenderEm,
      descenderEm: line.preferred.descenderEm,
      lineGapEm: line.preferred.lineGapEm,
      baselineFromTopEm: line.preferred.baselineFromTopEm,
    },
    visualModel: {
      probeSet: ink.probeSet,
      hangulInkWidthEm: ink.width.mean,
      hangulInkHeightEm: ink.height.mean,
      hangulTopEm: ink.top.median,
      hangulBottomEm: ink.bottom.median,
      leftSideBearingEm: ink.leftSideBearing.mean,
      rightSideBearingEm: ink.rightSideBearing.mean,
    },
    confidence,
  };
}

interface VariationAxis {
  tag: string;
  name: string | null;
  min: number | null;
  default: number | null;
  max: number | null;
}

function variationAxes(font: Font): VariationAxis[] {
  const axes = font.variationAxes ?? {};
  return Object.entries(axes)
    .filter((entry): entry is [string, NonNullable<(typeof axes)[string]>] => entry[1] != null)
    .map(([tag, axis]) => ({
      tag,
      name: axis.name ?? null,
      min: valueOrNull(axis.min),
      default: valueOrNull(axis.default),
      max: valueOrNull(axis.max),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

function faceMetadata(font: RawFont, source: FontSource, advance: ReturnType<typeof extractAdvanceMetrics>) {
  const os2 = table(font, "OS/2");
  const head = table(font, "head");
  const post = table(font, "post");
  const axes = variationAxes(font);
  const family = font.familyName ?? source.face?.familyName ?? null;
  const subfamily = font.subfamilyName ?? source.face?.subfamilyName ?? null;
  const fullName = font.fullName ?? source.face?.fullName ?? null;
  const postscriptName = font.postscriptName ?? source.face?.postscriptName ?? null;
  const italic = Boolean(
    os2?.fsSelection?.italic || head?.macStyle?.italic || Number(post?.italicAngle) !== 0,
  );
  const oblique = Boolean(os2?.fsSelection?.oblique);
  const latinVariation = meanAvailable(
    advance.groups.latinUppercase.coefficientOfVariation,
    advance.groups.latinLowercase.coefficientOfVariation,
    advance.groups.digits.coefficientOfVariation,
  );
  return {
    family,
    subfamily,
    fullName,
    postscriptName,
    aliases: uniqueStrings([family, fullName, postscriptName]),
    version: font.version ?? null,
    weightClass: valueOrNull(os2?.usWeightClass),
    widthClass: valueOrNull(os2?.usWidthClass),
    italic,
    oblique,
    monospace: Boolean(post?.isFixedPitch) || latinVariation === 0,
    glyphCount: valueOrNull(font.numGlyphs),
    outlineFormat: detectOutlineFormat(font),
    variable: axes.length > 0,
    axes,
  };
}

function sourceMetadata(source: FontSource) {
  const file = source.file ?? ({} as FontSource["file"]);
  const face = source.face ?? ({} as FontSource["face"]);
  return {
    fileName: file.fileName ?? path.basename(file.path ?? "font"),
    sizeBytes: valueOrNull(file.sizeBytes),
    sha256: file.sha256,
    container: file.container ?? "unknown",
    faceIndex: valueOrNull(face.index) ?? 0,
    faceCount: valueOrNull(face.count) ?? 1,
  };
}

export interface AnalyzeOptions {
  corpusSamples?: LayoutSample[];
}

export function analyzeFontSource(source: FontSource, options: AnalyzeOptions = {}) {
  const { font } = source;
  if (!font) throw new Error("Font source does not contain a parsed font object");
  const rawFont = font as RawFont;
  const warnings: string[] = [];
  const unitsPerEm = Number(font.unitsPerEm);
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) {
    throw new Error(`Invalid unitsPerEm: ${font.unitsPerEm}`);
  }

  const sourceInfo = sourceMetadata(source);
  const customSamples = options.corpusSamples ?? [];
  const samples: LayoutSample[] = [...DEFAULT_LAYOUT_SAMPLES, ...customSamples];
  const corpusId = customSamples.length > 0 ? `${CORPUS_ID}+custom` : CORPUS_ID;
  const reader = createGlyphReader(rawFont, unitsPerEm);
  const coverage = extractCoverage(reader);
  const advance = extractAdvanceMetrics(reader);
  const line = extractLineMetrics(rawFont, unitsPerEm, warnings);
  const ink = extractInkMetrics(reader, unitsPerEm);
  const glyphs = extractRepresentativeGlyphs(reader, unitsPerEm);
  const layout = layoutMetrics(font, samples, reader, unitsPerEm, corpusId);
  const face = faceMetadata(rawFont, source, advance);

  if ((coverage.sets.modernHangulSyllables.ratio ?? 0) < 1) {
    warnings.push(
      coverage.sets.modernHangulSyllables.ratio === 0
        ? "no-modern-hangul-coverage"
        : "partial-modern-hangul-coverage",
    );
  }
  if (!advance.spaces.space.mapped) warnings.push("missing-u+0020-space");
  if (face.variable) warnings.push("variable-font-default-instance-only");
  for (const sample of layout.samples) {
    if (sample.error) warnings.push(`layout-failed:${sample.id}`);
  }

  const variationSuffix = face.axes.length
    ? `@${face.axes.map((axis) => `${axis.tag}=${axis.default}`).join(",")}`
    : "";
  const profileId = `sha256:${sourceInfo.sha256}#face=${sourceInfo.faceIndex}${variationSuffix}`;
  const hwpkit = buildHwpkitProfile(coverage, advance, line, ink, layout);

  return {
    schemaVersion: SCHEMA_VERSION,
    schemaId: PROFILE_SCHEMA_ID,
    profileId,
    generator: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      parser: `fontkit@2.0.4`,
      shaper: `fontkit@2.0.4`,
      corpusId: layout.corpusId,
      corpusSha256: layout.corpusSha256,
    },
    source: sourceInfo,
    face,
    coverage,
    metrics: {
      unitsPerEm,
      raw: rawMetrics(rawFont),
      line,
      advance,
      ink,
      glyphs,
    },
    layout,
    hwpkit,
    quality: {
      status: warnings.length === 0 ? "ok" : "warning",
      warnings: [...new Set(warnings)],
    },
  };
}

export type FontProfile = ReturnType<typeof analyzeFontSource>;

export interface AnalyzeError {
  stage: string;
  fileName: string;
  faceIndex: number | null;
  message: string;
}

export function analyzeFontSources(sources: readonly FontSource[], options: AnalyzeOptions = {}) {
  const fonts: FontProfile[] = [];
  const errors: AnalyzeError[] = [];
  for (const source of sources) {
    try {
      fonts.push(analyzeFontSource(source, options));
    } catch (error) {
      errors.push({
        stage: "analyze",
        fileName: path.basename(source.file?.path ?? "font"),
        faceIndex: source.face?.index ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  sortFontProfiles(fonts);
  return { fonts, errors };
}

export function createCatalog(fonts: FontProfile[], errors: unknown[] = []) {
  return {
    schemaVersion: SCHEMA_VERSION,
    schemaId: CATALOG_SCHEMA_ID,
    generator: {
      name: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      parser: "fontkit@2.0.4",
      shaper: "fontkit@2.0.4",
      corpusId: fonts[0]?.generator?.corpusId ?? CORPUS_ID,
      corpusSha256: fonts[0]?.generator?.corpusSha256 ?? null,
    },
    fonts,
    errors,
  };
}

export const internal = {
  codePointLabel,
  corpusFingerprint,
  createGlyphReader,
  normalLineMetric,
  shapeSample,
};
