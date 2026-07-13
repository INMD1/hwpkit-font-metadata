export const PACKAGE_NAME = "@hwpkit/font-metadata";
export const PACKAGE_VERSION = "0.1.0";
export const SCHEMA_VERSION = "1.0.0";
export const PROFILE_SCHEMA_ID = "hwpkit.font-profile/v1";
export const CATALOG_SCHEMA_ID = "hwpkit.font-catalog/v1";
export const COMPARISON_SCHEMA_ID = "hwpkit.font-comparison/v1";
export const CORPUS_ID = "hwpkit-ko-layout-v1";

export const FONT_EXTENSIONS = new Set([
  ".ttf",
  ".otf",
  ".ttc",
  ".otc",
  ".woff",
  ".woff2",
]);

export function codePointRange(start: number, end: number): number[] {
  const result: number[] = [];
  for (let codePoint = start; codePoint <= end; codePoint += 1) {
    result.push(codePoint);
  }
  return result;
}

export function codePoints(text: string): number[] {
  return Array.from(text, (character) => character.codePointAt(0) as number);
}

export function uniqueCodePoints(text: string): number[] {
  return [...new Set(codePoints(text))];
}

const MODERN_CHOSEONG = codePointRange(0x1100, 0x1112);
const MODERN_JUNGSEONG = codePointRange(0x1161, 0x1175);
const MODERN_JONGSEONG = codePointRange(0x11a8, 0x11c2);

export const COVERAGE_SETS = Object.freeze({
  modernHangulSyllables: codePointRange(0xac00, 0xd7a3),
  modernHangulJamo: [
    ...MODERN_CHOSEONG,
    ...MODERN_JUNGSEONG,
    ...MODERN_JONGSEONG,
  ],
  compatibilityJamo: codePointRange(0x3131, 0x318e),
  hangulJamoExtendedA: codePointRange(0xa960, 0xa97c),
  // U+D7C7..U+D7CA are unassigned and must not count against a font.
  hangulJamoExtendedB: [
    ...codePointRange(0xd7b0, 0xd7c6),
    ...codePointRange(0xd7cb, 0xd7fb),
  ],
  basicLatinPrintable: codePointRange(0x20, 0x7e),
  commonHanja: uniqueCodePoints(
    "韓國漢字文書年月日人大小中學校會社民法令第條項號金木水火土山川天地上下左右前後東西南北姓名住所電話時間分秒一二三四五六七八九十百千萬億圓元家國市道區洞面里父母子女兄弟先生生年本籍同意",
  ),
  koreanPunctuation: uniqueCodePoints(
    "、。·‥…―—～〈〉《》「」『』【】〔〕（）［］｛｝！？：；，．“”‘’「」『』",
  ),
});

const ASCII_PUNCTUATION = codePoints("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

export const ADVANCE_GROUPS = Object.freeze({
  modernHangulSyllables: COVERAGE_SETS.modernHangulSyllables,
  modernHangulJamo: COVERAGE_SETS.modernHangulJamo,
  compatibilityJamo: COVERAGE_SETS.compatibilityJamo,
  latinUppercase: codePointRange(0x41, 0x5a),
  latinLowercase: codePointRange(0x61, 0x7a),
  digits: codePointRange(0x30, 0x39),
  asciiPunctuation: ASCII_PUNCTUATION,
  koreanPunctuation: COVERAGE_SETS.koreanPunctuation,
  commonHanja: COVERAGE_SETS.commonHanja,
});

export const SPACE_CODE_POINTS = Object.freeze({
  space: 0x0020,
  noBreakSpace: 0x00a0,
  enSpace: 0x2002,
  emSpace: 0x2003,
  thinSpace: 0x2009,
  narrowNoBreakSpace: 0x202f,
  ideographicSpace: 0x3000,
});

export const REPRESENTATIVE_GLYPHS = Object.freeze([
  "가",
  "각",
  "간",
  "갇",
  "갈",
  "감",
  "갑",
  "값",
  "강",
  "개",
  "고",
  "과",
  "광",
  "귀",
  "규",
  "그",
  "기",
  "까",
  "꽉",
  "나",
  "넣",
  "뼈",
  "뿔",
  "사",
  "아",
  "안",
  "않",
  "어",
  "워",
  "위",
  "의",
  "자",
  "한",
  "힣",
  "ㄱ",
  "ㅏ",
  "A",
  "M",
  "W",
  "a",
  "m",
  "0",
  "1",
  " ",
  "·",
  "。",
]);

export interface LayoutSample {
  id: string;
  normalization: string;
  text: string;
}

export const DEFAULT_LAYOUT_SAMPLES: readonly LayoutSample[] = Object.freeze([
  {
    id: "ko-body",
    normalization: "NFC",
    text: "한글 문서의 글꼴이 달라지면 문단 너비와 줄바꿈 위치가 달라질 수 있습니다.",
  },
  {
    id: "ko-mixed",
    normalization: "NFC",
    text: "Hwpkit 2026은 HWP/HWPX 문서를 DOCX로 정확하게 변환합니다.",
  },
  {
    id: "ko-punctuation",
    normalization: "NFC",
    text: "제1조(목적) ‘한글 문서’의 폭·공백·문장부호를 측정한다… 정말일까?",
  },
  {
    id: "ko-spacing",
    normalization: "NFC",
    text: "가 나 다 라 마 바 사 아 자 차 카 타 파 하  123  ABC abc",
  },
  {
    id: "ko-jamo-nfd",
    normalization: "NFD",
    text: "한글 자모 조합의 폭도 별도로 확인합니다.".normalize("NFD"),
  },
]);

export function evenlySpacedCodePoints(start: number, end: number, count: number): number[] {
  if (count <= 1) return [start];
  const result: number[] = [];
  const span = end - start;
  for (let index = 0; index < count; index += 1) {
    result.push(Math.round(start + (span * index) / (count - 1)));
  }
  return [...new Set(result)];
}

export const HANGUL_INK_PROBES = Object.freeze([
  ...new Set([
    ...evenlySpacedCodePoints(0xac00, 0xd7a3, 256),
    ...REPRESENTATIVE_GLYPHS
      .map((character) => character.codePointAt(0) as number)
      .filter((codePoint) => codePoint >= 0xac00 && codePoint <= 0xd7a3),
  ]),
]);
