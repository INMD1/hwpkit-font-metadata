import assert from "node:assert/strict";
import test from "node:test";

import { analyzeFontSource, createCatalog } from "../src/analyze.mjs";
import { COVERAGE_SETS } from "../src/constants.mjs";

function fakeAdvance(codePoint) {
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 920;
  if (codePoint === 0x20 || codePoint === 0xa0) return 280;
  if (codePoint >= 0x30 && codePoint <= 0x39) return 550;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return 650;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return 530;
  return 1000;
}

function fakeFont() {
  const characterSet = [
    ...new Set([
      ...Object.values(COVERAGE_SETS).flat(),
      0xa0,
      0x2002,
      0x2003,
      0x2009,
      0x202f,
      0x3000,
    ]),
  ];
  const glyphForCodePoint = (codePoint) => {
    const advanceWidth = fakeAdvance(codePoint);
    return {
      id: codePoint + 1,
      advanceWidth,
      bbox: {
        minX: 40,
        minY: -80,
        maxX: advanceWidth - 40,
        maxY: 840,
      },
    };
  };
  return {
    familyName: "테스트 돋움",
    subfamilyName: "Regular",
    fullName: "테스트 돋움 Regular",
    postscriptName: "TestDotum-Regular",
    version: "Version 1.000",
    unitsPerEm: 1000,
    ascent: 1160,
    descent: -288,
    lineGap: 0,
    numGlyphs: 20000,
    characterSet,
    variationAxes: {},
    directory: { tables: { head: {}, hhea: {}, "OS/2": {}, glyf: {} } },
    head: {
      unitsPerEm: 1000,
      xMin: -50,
      yMin: -200,
      xMax: 1100,
      yMax: 1000,
      macStyle: { italic: false },
    },
    hhea: {
      ascent: 1160,
      descent: -288,
      lineGap: 0,
      advanceWidthMax: 1000,
    },
    "OS/2": {
      version: 4,
      usWeightClass: 400,
      usWidthClass: 5,
      typoAscender: 880,
      typoDescender: -120,
      typoLineGap: 0,
      winAscent: 1160,
      winDescent: 288,
      xAvgCharWidth: 920,
      fsSelection: { useTypoMetrics: true, italic: false, oblique: false },
      fsType: {
        noEmbedding: false,
        viewOnly: false,
        editable: true,
        noSubsetting: false,
        bitmapOnly: false,
      },
      vendorID: "TEST",
      panose: [2, 11, 5, 0, 0, 0, 0, 0, 0, 0],
    },
    post: { italicAngle: 0, isFixedPitch: 0 },
    glyphForCodePoint,
    layout(text) {
      const glyphs = Array.from(text, (character) =>
        glyphForCodePoint(character.codePointAt(0)),
      );
      return {
        glyphs,
        positions: glyphs.map((glyph) => ({ xAdvance: glyph.advanceWidth })),
      };
    },
  };
}

function fakeSource() {
  return {
    path: "/private/fonts/test-dotum.ttf",
    file: {
      fileName: "test-dotum.ttf",
      sizeBytes: 12345,
      sha256: "a".repeat(64),
      container: "ttf",
    },
    face: { index: 0, count: 1 },
    font: fakeFont(),
  };
}

test("analyzeFontSource creates an Hwpkit-ready Korean width model", () => {
  const profile = analyzeFontSource(fakeSource());

  assert.equal(profile.schemaId, "hwpkit.font-profile/v1");
  assert.equal(profile.profileId, `sha256:${"a".repeat(64)}#face=0`);
  assert.equal(profile.source.fileName, "test-dotum.ttf");
  assert.equal("path" in profile.source, false);
  assert.equal(profile.face.family, "테스트 돋움");
  assert.equal(profile.face.outlineFormat, "TrueType");
  assert.equal(profile.coverage.sets.modernHangulSyllables.ratio, 1);
  assert.equal(profile.metrics.advance.groups.modernHangulSyllables.mean, 0.92);
  assert.equal(profile.metrics.advance.hangulModel.defaultEm, 0.92);
  assert.deepEqual(profile.metrics.advance.hangulModel.exceptions, {});
  assert.equal(profile.metrics.advance.spaces.space.advanceEm, 0.28);
  assert.equal(profile.metrics.line.preferred.source, "OS/2.sTypo");
  assert.equal(profile.metrics.line.preferred.lineAdvanceEm, 1);
  assert.equal(profile.hwpkit.widthModel.hangulEm, 0.92);
  assert.equal(profile.hwpkit.widthModel.spaceEm, 0.28);
  assert.equal(profile.hwpkit.lineModel.lineAdvanceEm, 1);
  assert.equal(profile.hwpkit.visualModel.hangulInkHeightEm, 0.92);
  assert.equal(profile.hwpkit.confidence, "high");
});

test("analyzer records absent Hangul as missing instead of zero", () => {
  const source = fakeSource();
  source.font.characterSet = [0x20, 0x41];
  const profile = analyzeFontSource(source);

  const stats = profile.metrics.advance.groups.modernHangulSyllables;
  assert.equal(stats.measured, 0);
  assert.equal(stats.mean, null);
  assert.equal(profile.hwpkit.widthModel.hangulEm, null);
  assert.equal(profile.hwpkit.confidence, "low");
  assert.ok(profile.quality.warnings.includes("no-modern-hangul-coverage"));
});

test("catalog output is path-free and preserves partial errors", () => {
  const profile = analyzeFontSource(fakeSource());
  const catalog = createCatalog([profile], [{ stage: "open", fileName: "broken.ttf" }]);
  assert.equal(catalog.schemaId, "hwpkit.font-catalog/v1");
  assert.equal(catalog.fonts.length, 1);
  assert.equal(catalog.errors.length, 1);
  assert.equal(JSON.stringify(catalog).includes("/private/fonts"), false);
});

test("custom corpus changes the fingerprint without storing its text", () => {
  const secretText = "내부 문서 전용 표본 123";
  const profile = analyzeFontSource(fakeSource(), {
    corpusSamples: [{ id: "user:0123456789ab:1", normalization: "preserved", text: secretText }],
  });

  assert.equal(profile.generator.corpusId, "hwpkit-ko-layout-v1+custom");
  assert.equal(profile.layout.corpusId, "hwpkit-ko-layout-v1+custom");
  assert.equal(profile.layout.samples.at(-1).id, "user:0123456789ab:1");
  assert.equal(JSON.stringify(profile).includes(secretText), false);
});
