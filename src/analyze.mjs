import { createHash } from "node:crypto";
import path from "node:path";

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
} from "./constants.mjs";
import { describe, round } from "./stats.mjs";

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function corpusFingerprint(samples) {
  return sha256Text(
    samples
      .map((sample) => `${sample.id}\0${sample.normalization ?? "none"}\0${sample.text}`)
      .join("\0\0"),
  );
}

function valueOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function em(value, unitsPerEm) {
  return Number.isFinite(value) && unitsPerEm > 0 ? round(value / unitsPerEm) : null;
}

function codePointLabel(codePoint) {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
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

function table(font, name) {
  try {
    return font[name] ?? null;
  } catch {
    return null;
  }
}

function tableTags(font) {
  return new Set(Object.keys(font?.directory?.tables ?? {}));
}

function detectOutlineFormat(font) {
  const tags = tableTags(font);
  if (tags.has("glyf")) return "TrueType";
  if (tags.has("CFF2")) return "CFF2";
  if (tags.has("CFF ")) return "CFF";
  return "unknown";
}

function normalLineMetric(ascender, descender, lineGap, unitsPerEm) {
  const valid = [ascender, descender, lineGap].every(Number.isFinite);
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
  const lineAdvance = ascender - descender + lineGap;
  return {
    ascenderDu: ascender,
    descenderDu: descender,
    lineGapDu: lineGap,
    lineAdvanceDu: lineAdvance,
    ascenderEm: em(ascender, unitsPerEm),
    descenderEm: em(descender, unitsPerEm),
    lineGapEm: em(lineGap, unitsPerEm),
    lineAdvanceEm: em(lineAdvance, unitsPerEm),
    baselineFromTopEm: em(ascender, unitsPerEm),
    baselineFraction: round(lineAdvance === 0 ? null : ascender / lineAdvance),
  };
}

function windowsLineMetric(ascender, descender, unitsPerEm) {
  const valid = [ascender, descender].every(Number.isFinite);
  const height = valid ? ascender + descender : null;
  return {
    ascenderDu: valid ? ascender : null,
    descenderDu: valid ? descender : null,
    heightDu: height,
    ascenderEm: em(ascender, unitsPerEm),
    descenderEm: em(descender, unitsPerEm),
    heightEm: em(height, unitsPerEm),
  };
}

function extractLineMetrics(font, unitsPerEm, warnings) {
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
  let preferred = horizontal;
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

function rawMetrics(font) {
  const head = table(font, "head");
  const hhea = table(font, "hhea");
  const os2 = table(font, "OS/2");
  const post = table(font, "post");
  return {
    head: {
      unitsPerEm: valueOrNull(head?.unitsPerEm),
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

function createGlyphReader(font, unitsPerEm) {
  const characterSet = new Set(font.characterSet ?? []);
  const cache = new Map();

  function read(codePoint) {
    if (cache.has(codePoint)) return cache.get(codePoint);
    if (!characterSet.has(codePoint)) {
      const missing = { mapped: false, codePoint };
      cache.set(codePoint, missing);
      return missing;
    }
    try {
      const glyph = font.glyphForCodePoint(codePoint);
      if (!glyph || glyph.id === 0) {
        const missing = { mapped: false, codePoint };
        cache.set(codePoint, missing);
        return missing;
      }
      const advanceDu = valueOrNull(glyph.advanceWidth);
      const result = {
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
      const missing = {
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

function coverageFor(codePointSet, reader) {
  const missing = [];
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

function extractCoverage(reader) {
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

function advanceStats(codePointSet, reader) {
  const advances = [];
  for (const codePoint of codePointSet) {
    const glyph = reader.read(codePoint);
    if (glyph.mapped && Number.isFinite(glyph.advanceEm)) advances.push(glyph.advanceEm);
  }
  return describe(advances, { expected: codePointSet.length, unit: "em" });
}

function extractSpaces(reader) {
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
      ];
    }),
  );
}

function extractCodePointAdvances(reader) {
  const codePointSet = new Set([
    ...Object.values(ADVANCE_GROUPS)
      .filter((group) => group !== ADVANCE_GROUPS.modernHangulSyllables)
      .flat(),
    ...Object.values(SPACE_CODE_POINTS),
  ]);
  const result = {};
  for (const codePoint of [...codePointSet].sort((left, right) => left - right)) {
    const glyph = reader.read(codePoint);
    if (glyph.mapped && Number.isFinite(glyph.advanceEm)) {
      result[codePointLabel(codePoint)] = glyph.advanceEm;
    }
  }
  return result;
}

function buildHangulAdvanceModel(reader) {
  const valueCounts = new Map();
  const measured = [];
  for (const codePoint of COVERAGE_SETS.modernHangulSyllables) {
    const glyph = reader.read(codePoint);
    if (!glyph.mapped || !Number.isFinite(glyph.advanceEm)) continue;
    const value = round(glyph.advanceEm);
    measured.push([codePoint, value]);
    valueCounts.set(value, (valueCounts.get(value) ?? 0) + 1);
  }
  const rankedDefaults = [...valueCounts.entries()].sort(
    ([leftValue, leftCount], [rightValue, rightCount]) =>
      rightCount - leftCount || leftValue - rightValue,
  );
  const defaultEm = rankedDefaults[0]?.[0] ?? null;
  const exceptions = {};
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

function extractAdvanceMetrics(reader) {
  const groups = Object.fromEntries(
    Object.entries(ADVANCE_GROUPS).map(([name, codePointSet]) => [
      name,
      advanceStats(codePointSet, reader),
    ]),
  );
  return {
    unit: "em",
    groups,
    spaces: extractSpaces(reader),
    codePoints: extractCodePointAdvances(reader),
    hangulModel: buildHangulAdvanceModel(reader),
  };
}

function bboxRecord(glyphRecord, unitsPerEm) {
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
      rightSideBearingEm: em(glyphRecord.advanceDu - bbox.maxX, unitsPerEm),
    };
  } catch {
    return null;
  }
}

function extractInkMetrics(reader, unitsPerEm) {
  const records = [];
  for (const codePoint of HANGUL_INK_PROBES) {
    const record = bboxRecord(reader.read(codePoint), unitsPerEm);
    if (record) records.push(record);
  }
  const field = (name) => records.map((record) => record[name]);
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

function extractRepresentativeGlyphs(reader, unitsPerEm) {
  return Object.fromEntries(
    REPRESENTATIVE_GLYPHS.map((character) => {
      const glyph = reader.read(character.codePointAt(0));
      return [
        character,
        {
          codePoint: codePointLabel(character.codePointAt(0)),
          mapped: glyph.mapped,
          glyphId: glyph.mapped ? glyph.glyphId : null,
          advanceDu: glyph.mapped ? glyph.advanceDu : null,
          advanceEm: glyph.mapped ? glyph.advanceEm : null,
          bbox: bboxRecord(glyph, unitsPerEm),
        },
      ];
    }),
  );
}

function countSpaces(text) {
  const spaces = new Set(Object.values(SPACE_CODE_POINTS));
  return Array.from(text).reduce(
    (count, character) => count + (spaces.has(character.codePointAt(0)) ? 1 : 0),
    0,
  );
}

function shapeSample(font, sample, reader, unitsPerEm) {
  const characters = Array.from(sample.text);
  const missing = [];
  let unshapedAdvanceDu = 0;
  for (const character of characters) {
    const codePoint = character.codePointAt(0);
    const glyph = reader.read(codePoint);
    if (glyph.mapped && Number.isFinite(glyph.advanceDu)) unshapedAdvanceDu += glyph.advanceDu;
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
    };
  } catch (error) {
    return {
      id: sample.id,
      textSha256: sha256Text(sample.text),
      normalization: sample.normalization ?? "none",
      complete: false,
      codePointCount: characters.length,
      glyphCount: null,
      spaceCount: countSpaces(sample.text),
      missingCodePoints: [...new Set(missing)],
      advanceDu: null,
      advanceEm: null,
      advanceNoKerningDu: null,
      advanceNoKerningEm: null,
      advancePerCodePointEm: null,
      advanceNoKerningPerCodePointEm: null,
      unshapedAdvanceEm: em(unshapedAdvanceDu, unitsPerEm),
      kerningAdjustmentEm: null,
      shapingAdjustmentEm: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function layoutMetrics(font, samples, reader, unitsPerEm, corpusId) {
  const shapedSamples = samples.map((sample) => shapeSample(font, sample, reader, unitsPerEm));
  return {
    corpusId,
    corpusSha256: corpusFingerprint(samples),
    samples: shapedSamples,
  };
}

function meanAvailable(...values) {
  const available = values.filter(Number.isFinite);
  return available.length === 0
    ? null
    : round(available.reduce((sum, value) => sum + value, 0) / available.length);
}

function buildHwpkitProfile(coverage, advance, line, ink, layout) {
  const groups = advance.groups;
  const completeBodySamples = layout.samples.filter(
    (sample) =>
      sample.complete &&
      sample.normalization !== "NFD" &&
      Number.isFinite(sample.advanceNoKerningEm ?? sample.advanceEm) &&
      sample.codePointCount > 0,
  );
  const totalBodyAdvance = completeBodySamples.reduce(
    (sum, sample) => sum + (sample.advanceNoKerningEm ?? sample.advanceEm),
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

function variationAxes(font) {
  const axes = font.variationAxes ?? {};
  return Object.entries(axes)
    .map(([tag, axis]) => ({
      tag,
      name: axis.name ?? null,
      min: valueOrNull(axis.min),
      default: valueOrNull(axis.default),
      max: valueOrNull(axis.max),
    }))
    .sort((left, right) => left.tag.localeCompare(right.tag));
}

function faceMetadata(font, source, advance) {
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

function sourceMetadata(source) {
  const file = source.file ?? {};
  const face = source.face ?? {};
  return {
    fileName: file.fileName ?? path.basename(source.path ?? file.path ?? "font"),
    sizeBytes: valueOrNull(file.sizeBytes),
    sha256: file.sha256,
    container: file.container ?? "unknown",
    faceIndex: valueOrNull(face.index) ?? 0,
    faceCount: valueOrNull(face.count) ?? 1,
  };
}

export function analyzeFontSource(source, options = {}) {
  const { font } = source;
  if (!font) throw new Error("Font source does not contain a parsed font object");
  const warnings = [];
  const unitsPerEm = Number(font.unitsPerEm);
  if (!Number.isFinite(unitsPerEm) || unitsPerEm <= 0) {
    throw new Error(`Invalid unitsPerEm: ${font.unitsPerEm}`);
  }

  const sourceInfo = sourceMetadata(source);
  const customSamples = options.corpusSamples ?? [];
  const samples = [...DEFAULT_LAYOUT_SAMPLES, ...customSamples];
  const corpusId = customSamples.length > 0 ? `${CORPUS_ID}+custom` : CORPUS_ID;
  const reader = createGlyphReader(font, unitsPerEm);
  const coverage = extractCoverage(reader);
  const advance = extractAdvanceMetrics(reader);
  const line = extractLineMetrics(font, unitsPerEm, warnings);
  const ink = extractInkMetrics(reader, unitsPerEm);
  const glyphs = extractRepresentativeGlyphs(reader, unitsPerEm);
  const layout = layoutMetrics(font, samples, reader, unitsPerEm, corpusId);
  const face = faceMetadata(font, source, advance);

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
      raw: rawMetrics(font),
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

export function analyzeFontSources(sources, options = {}) {
  const fonts = [];
  const errors = [];
  for (const source of sources) {
    try {
      fonts.push(analyzeFontSource(source, options));
    } catch (error) {
      errors.push({
        stage: "analyze",
        fileName: path.basename(source.path ?? source.file?.path ?? "font"),
        faceIndex: source.face?.index ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  fonts.sort(
    (left, right) =>
      (left.face.fullName ?? "").localeCompare(right.face.fullName ?? "", "ko") ||
      left.source.sha256.localeCompare(right.source.sha256) ||
      left.source.faceIndex - right.source.faceIndex,
  );
  return { fonts, errors };
}

export function createCatalog(fonts, errors = []) {
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
