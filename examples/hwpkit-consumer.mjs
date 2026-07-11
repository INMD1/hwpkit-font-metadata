#!/usr/bin/env node

/**
 * font-catalog.json을 HwpEncoder/HwpxEncoder의 빠른 줄바꿈 계산에 연결하는 예제입니다.
 *
 * 이 파일은 runner/src 본체를 import하거나 수정하지 않습니다. 실제 통합 시에는
 * createHwpkitFontAdapter()가 반환하는 메서드를 encoder context에 주입하면 됩니다.
 */

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CATALOG_SCHEMA_ID = 'hwpkit.font-catalog/v1';
const PROFILE_SCHEMA_ID = 'hwpkit.font-profile/v1';
const PROFILE_ID_RE = /^sha256:[0-9a-f]{64}#face=\d+(?:@[A-Za-z0-9 ]{4}=[^,@]+(?:,[A-Za-z0-9 ]{4}=[^,@]+)*)?$/;

// 선택 profile에 일부 메트릭이 없을 때 현재 HwpEncoder/HwpxEncoder와 같은
// 보수적 계수로 돌아갑니다. 0을 넣으면 줄 수가 과소 계산되므로 금지합니다.
const HWP_ENCODER_FALLBACK_WIDTH_MODEL = Object.freeze({
  hangulEm: 1,
  jamoEm: 1,
  hanjaEm: 1,
  latinUpperEm: 0.65,
  latinLowerEm: 0.42,
  digitEm: 0.42,
  spaceEm: 0.32,
  punctuationEm: 0.42,
  bodyTextEm: 1,
});

const isFiniteNumber = (value) =>
  typeof value === 'number' && Number.isFinite(value);

const normalizedName = (value) =>
  typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase('en-US')
    : '';

const isBetween = (value, first, last) => value >= first && value <= last;

function assertFontProfile(profile, index = '?') {
  const at = `fonts[${index}]`;
  if (!profile || profile.schemaId !== PROFILE_SCHEMA_ID) {
    throw new TypeError(`${at}.schemaId must be ${PROFILE_SCHEMA_ID}`);
  }
  if (!PROFILE_ID_RE.test(profile.profileId ?? '')) {
    throw new TypeError(`${at}.profileId is not a v1 profile id`);
  }

}

/** JSON 파일을 읽고 encoder가 의존하는 v1 필수 필드만 빠르게 검증합니다. */
export async function loadFontCatalog(filePath) {
  const json = JSON.parse(await readFile(filePath, 'utf8'));
  if (json?.schemaId !== CATALOG_SCHEMA_ID || json?.schemaVersion !== '1.0.0') {
    throw new TypeError(
      `Unsupported catalog: expected ${CATALOG_SCHEMA_ID} schemaVersion 1.0.0`,
    );
  }
  if (!Array.isArray(json.fonts)) {
    throw new TypeError('font catalog must contain a fonts array');
  }
  json.fonts.forEach(assertFontProfile);
  return json;
}

function profileNames(profile) {
  const face = profile.face ?? {};
  return [
    face.family,
    face.subfamily,
    face.fullName,
    face.postscriptName,
    ...(Array.isArray(face.aliases) ? face.aliases : []),
  ].map(normalizedName).filter(Boolean);
}

function matchesSelector(profile, selector) {
  if (selector.profileId && profile.profileId !== selector.profileId) return false;
  if (selector.sha256 && profile.source?.sha256 !== selector.sha256) return false;
  if (
    selector.faceIndex !== undefined &&
    profile.source?.faceIndex !== selector.faceIndex
  ) return false;
  if (
    selector.weightClass !== undefined &&
    profile.face?.weightClass !== selector.weightClass
  ) return false;
  if (selector.italic !== undefined && profile.face?.italic !== selector.italic) {
    return false;
  }

  const requestedFamily = normalizedName(selector.family);
  if (requestedFamily) {
    const familyNames = [profile.face?.family, ...(profile.face?.aliases ?? [])]
      .map(normalizedName);
    if (!familyNames.includes(requestedFamily)) return false;
  }

  const requestedSubfamily = normalizedName(selector.subfamily);
  if (
    requestedSubfamily &&
    normalizedName(profile.face?.subfamily) !== requestedSubfamily
  ) return false;

  const requestedPostscriptName = normalizedName(selector.postscriptName);
  if (
    requestedPostscriptName &&
    normalizedName(profile.face?.postscriptName) !== requestedPostscriptName
  ) return false;

  if (selector.name) {
    const requestedName = normalizedName(selector.name);
    if (!profileNames(profile).includes(requestedName)) return false;
  }
  return true;
}

/**
 * profileId, SHA+faceIndex 또는 face 이름으로 한 face를 고릅니다.
 * 모호한 이름을 임의로 고르지 않으므로 TTC에서는 조건을 더 구체화하십시오.
 */
export function selectFontProfile(catalog, selector) {
  const normalizedSelector = typeof selector === 'string'
    ? (PROFILE_ID_RE.test(selector) ? { profileId: selector } : { name: selector })
    : selector;
  if (!normalizedSelector || typeof normalizedSelector !== 'object') {
    throw new TypeError('font selector must be a profile id, face name, or object');
  }

  const matches = catalog.fonts.filter((profile) =>
    matchesSelector(profile, normalizedSelector));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`No font profile matched ${JSON.stringify(normalizedSelector)}`);
  }

  const choices = matches.map((profile) =>
    `${profile.profileId} (${profile.face?.fullName ?? profile.face?.family ?? 'unnamed'})`);
  throw new Error(
    `Font selector is ambiguous; add subfamily, weightClass, or faceIndex:\n${choices.join('\n')}`,
  );
}

function isHangulSyllable(codePoint) {
  return isBetween(codePoint, 0xac00, 0xd7a3);
}

function isHangulJamo(codePoint) {
  return isBetween(codePoint, 0x1100, 0x11ff) ||
    isBetween(codePoint, 0x3130, 0x318f) ||
    isBetween(codePoint, 0xa960, 0xa97f) ||
    isBetween(codePoint, 0xd7b0, 0xd7ff);
}

function isHanja(codePoint) {
  return isBetween(codePoint, 0x3400, 0x4dbf) ||
    isBetween(codePoint, 0x4e00, 0x9fff) ||
    isBetween(codePoint, 0xf900, 0xfaff) ||
    isBetween(codePoint, 0x20000, 0x2fa1f) ||
    isBetween(codePoint, 0x30000, 0x323af);
}

function isZeroAdvanceCodePoint(codePoint) {
  if (codePoint === 0x200c || codePoint === 0x200d) return true;
  if (isBetween(codePoint, 0xfe00, 0xfe0f)) return true;
  if (isBetween(codePoint, 0xe0100, 0xe01ef)) return true;
  return /\p{Mark}/u.test(String.fromCodePoint(codePoint));
}

function classifyCodePoint(codePoint) {
  if (isHangulSyllable(codePoint)) return 'hangulEm';
  if (isHangulJamo(codePoint)) return 'jamoEm';
  if (isHanja(codePoint)) return 'hanjaEm';
  if (isBetween(codePoint, 0x41, 0x5a)) return 'latinUpperEm';
  if (isBetween(codePoint, 0x61, 0x7a)) return 'latinLowerEm';
  if (isBetween(codePoint, 0x30, 0x39)) return 'digitEm';
  if (/\p{White_Space}/u.test(String.fromCodePoint(codePoint))) return 'spaceEm';
  if (/\p{Punctuation}/u.test(String.fromCodePoint(codePoint))) {
    return 'punctuationEm';
  }
  return 'bodyTextEm';
}

function firstFinite(...values) {
  return values.find(isFiniteNumber);
}

function normalizedLineModel(profile) {
  const line = profile.hwpkit?.lineModel ?? {};
  const preferred = profile.metrics?.line?.preferred ?? {};
  const unitsPerEm = profile.metrics?.unitsPerEm;

  const rawHeight = firstFinite(
    preferred.lineHeightRaw,
    preferred.heightRaw,
    preferred.lineHeight,
  );
  const rawBaseline = firstFinite(
    preferred.baselineRaw,
    preferred.ascenderRaw,
    preferred.ascender,
  );
  const normalizedRawHeight = isFiniteNumber(rawHeight) && unitsPerEm > 0
    ? rawHeight / unitsPerEm
    : undefined;
  const normalizedRawBaseline = isFiniteNumber(rawBaseline) && unitsPerEm > 0
    ? rawBaseline / unitsPerEm
    : undefined;

  const lineHeightEm = firstFinite(
    line.lineAdvanceEm,
    line.lineHeightEm,
    line.preferredLineHeightEm,
    line.heightEm,
    preferred.lineHeightEm,
    preferred.lineAdvanceEm,
    preferred.heightEm,
    normalizedRawHeight,
    1.6,
  );
  const baselineEm = firstFinite(
    line.baselineFromTopEm,
    line.baselineEm,
    line.ascenderEm,
    preferred.baselineEm,
    preferred.baselineFromTopEm,
    preferred.ascenderEm,
    normalizedRawBaseline,
    Math.min(0.85, lineHeightEm),
  );
  return {
    lineHeightEm: Math.max(1, lineHeightEm),
    baselineEm: Math.max(0, Math.min(lineHeightEm, baselineEm)),
  };
}

function glyphAdvance(profile, codePoint) {
  const label = `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
  const glyphs = profile.metrics?.glyphs;
  if (glyphs && typeof glyphs === 'object') {
    const character = String.fromCodePoint(codePoint);
    const metric = glyphs[character] ?? glyphs[label];
    if (isFiniteNumber(metric?.advanceEm) && metric.advanceEm >= 0) {
      return metric.advanceEm;
    }
  }

  const codePointAdvance = profile.metrics?.advance?.codePoints?.[label];
  if (isFiniteNumber(codePointAdvance) && codePointAdvance >= 0) {
    return codePointAdvance;
  }

  if (isHangulSyllable(codePoint)) {
    const model = profile.metrics?.advance?.hangulModel;
    const exception = model?.exceptions?.[label];
    if (isFiniteNumber(exception) && exception >= 0) return exception;
    if (isFiniteNumber(model?.defaultEm) && model.defaultEm >= 0) {
      return model.defaultEm;
    }
  }
  return undefined;
}

/**
 * HWP/HWPX line cache가 공유할 폰트별 폭·세로 adapter를 만듭니다.
 * preferGlyphMetrics=false이면 제한된 probe 글리프 값 대신 항상 대표 widthModel을 씁니다.
 */
export function createHwpkitFontAdapter(
  profile,
  { preferGlyphMetrics = true, tabSize = 4 } = {},
) {
  assertFontProfile(profile);
  const measuredWidthModel = profile.hwpkit?.widthModel ?? {};
  const fallbackKeys = [];
  const widthModel = Object.freeze(Object.fromEntries(
    Object.entries(HWP_ENCODER_FALLBACK_WIDTH_MODEL).map(([key, fallback]) => {
      const measured = measuredWidthModel[key];
      if (isFiniteNumber(measured) && measured >= 0) return [key, measured];
      fallbackKeys.push(key);
      return [key, fallback];
    }),
  ));
  const lineModel = Object.freeze(normalizedLineModel(profile));
  const safeTabSize = Number.isInteger(tabSize) && tabSize > 0 ? tabSize : 4;

  function codePointWidthEm(codePoint) {
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new RangeError(`Invalid Unicode code point: ${codePoint}`);
    }
    if (codePoint === 0x0a || codePoint === 0x0d || codePoint < 0x20) {
      return codePoint === 0x09 ? widthModel.spaceEm * safeTabSize : 0;
    }
    if (isZeroAdvanceCodePoint(codePoint)) return 0;

    const exact = preferGlyphMetrics ? glyphAdvance(profile, codePoint) : undefined;
    if (isFiniteNumber(exact)) return exact;
    if (codePoint === 0x3000) return widthModel.hangulEm;
    return widthModel[classifyCodePoint(codePoint)];
  }

  function codePointWidthHwp(codePoint, fontHwp) {
    if (!isFiniteNumber(fontHwp) || fontHwp <= 0) {
      throw new RangeError('fontHwp must be a finite number > 0');
    }
    return Math.round(codePointWidthEm(codePoint) * fontHwp);
  }

  function textAdvanceHwp(text, fontHwp) {
    let width = 0;
    for (let offset = 0; offset < text.length;) {
      const codePoint = text.codePointAt(offset);
      width += codePointWidthHwp(codePoint, fontHwp);
      offset += codePoint > 0xffff ? 2 : 1;
    }
    return width;
  }

  /** 반환 위치는 HWP PARA_TEXT와 같은 UTF-16 code-unit offset입니다. */
  function lineStartPositionsHwp(text, fontHwp, availableWidthHwp) {
    if (!isFiniteNumber(availableWidthHwp) || availableWidthHwp <= 0) {
      throw new RangeError('availableWidthHwp must be a finite number > 0');
    }
    if (!text) return [0];

    const starts = [0];
    let currentWidth = 0;
    for (let offset = 0; offset < text.length;) {
      const codePoint = text.codePointAt(offset);
      const codeUnitLength = codePoint > 0xffff ? 2 : 1;
      if (codePoint === 0x0a || codePoint === 0x0d) {
        let nextOffset = offset + codeUnitLength;
        if (codePoint === 0x0d && text.charCodeAt(nextOffset) === 0x0a) {
          nextOffset += 1;
        }
        starts.push(nextOffset);
        currentWidth = 0;
        offset = nextOffset;
        continue;
      }

      const characterWidth = codePointWidthHwp(codePoint, fontHwp);
      if (currentWidth > 0 && currentWidth + characterWidth > availableWidthHwp) {
        starts.push(offset);
        currentWidth = characterWidth;
      } else {
        currentWidth += characterWidth;
      }
      offset += codeUnitLength;
    }
    return starts;
  }

  function lineAdvanceHwp(fontHwp, explicitLineSpacingPercent) {
    if (!isFiniteNumber(fontHwp) || fontHwp <= 0) {
      throw new RangeError('fontHwp must be a finite number > 0');
    }
    if (explicitLineSpacingPercent !== undefined) {
      if (!isFiniteNumber(explicitLineSpacingPercent) || explicitLineSpacingPercent <= 0) {
        throw new RangeError('line spacing percent must be a finite number > 0');
      }
      return Math.max(fontHwp, Math.round(fontHwp * explicitLineSpacingPercent / 100));
    }
    return Math.max(fontHwp, Math.round(fontHwp * lineModel.lineHeightEm));
  }

  function baselineHwp(fontHwp) {
    if (!isFiniteNumber(fontHwp) || fontHwp <= 0) {
      throw new RangeError('fontHwp must be a finite number > 0');
    }
    return Math.min(lineAdvanceHwp(fontHwp), Math.round(fontHwp * lineModel.baselineEm));
  }

  return Object.freeze({
    profileId: profile.profileId,
    source: Object.freeze({
      sha256: profile.source.sha256,
      faceIndex: profile.source.faceIndex,
    }),
    face: Object.freeze({ ...profile.face }),
    widthModel,
    lineModel,
    visualModel: Object.freeze({ ...(profile.hwpkit?.visualModel ?? {}) }),
    confidence: profile.hwpkit?.confidence ?? 'low',
    fallbackKeys: Object.freeze(fallbackKeys),
    codePointWidthEm,
    codePointWidthHwp,
    textAdvanceHwp,
    lineStartPositionsHwp,
    lineAdvanceHwp,
    baselineHwp,
  });
}

/** 문서 변환 시작 시 한 번 만들고 selector별 adapter를 캐시하는 resolver 예입니다. */
export function createFontMetricResolver(catalog, options) {
  const cache = new Map();
  return (selector) => {
    const key = typeof selector === 'string'
      ? selector
      : JSON.stringify(selector, Object.keys(selector).sort());
    if (!cache.has(key)) {
      const profile = selectFontProfile(catalog, selector);
      cache.set(key, createHwpkitFontAdapter(profile, options));
    }
    return cache.get(key);
  };
}

function linesFromStarts(text, starts) {
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? text.length;
    return text.slice(start, end).replace(/\r?\n$/, '');
  });
}

async function main(argv) {
  const [catalogPath, selector, text = '한글 ABC 123 문단입니다.', fontPtText = '10', widthPtText = '180'] = argv;
  if (!catalogPath || !selector) {
    console.error(
      'Usage: node examples/hwpkit-consumer.mjs <catalog.json> <profile-id-or-face-name> [text] [font-pt] [line-width-pt]',
    );
    process.exitCode = 2;
    return;
  }

  const fontPt = Number(fontPtText);
  const widthPt = Number(widthPtText);
  if (!(fontPt > 0) || !(widthPt > 0)) {
    throw new RangeError('font-pt and line-width-pt must be numbers > 0');
  }

  const catalog = await loadFontCatalog(catalogPath);
  const profile = selectFontProfile(catalog, selector);
  const adapter = createHwpkitFontAdapter(profile);
  const fontHwp = Math.round(fontPt * 100);
  const widthHwp = Math.round(widthPt * 100);
  const starts = adapter.lineStartPositionsHwp(text, fontHwp, widthHwp);

  process.stdout.write(`${JSON.stringify({
    profileId: adapter.profileId,
    face: adapter.face.fullName ?? adapter.face.family,
    fontPt,
    lineWidthPt: widthPt,
    estimatedAdvanceHwp: adapter.textAdvanceHwp(text, fontHwp),
    lineAdvanceHwp: adapter.lineAdvanceHwp(fontHwp),
    baselineHwp: adapter.baselineHwp(fontHwp),
    lineStartUtf16: starts,
    lines: linesFromStarts(text, starts),
    confidence: adapter.confidence,
    fallbackKeys: adapter.fallbackKeys,
  }, null, 2)}\n`);
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
