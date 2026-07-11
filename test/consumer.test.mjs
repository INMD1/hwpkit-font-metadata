import assert from "node:assert/strict";
import test from "node:test";

import {
  createHwpkitFontAdapter,
  selectFontProfile,
} from "../examples/hwpkit-consumer.mjs";

function profile(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    schemaId: "hwpkit.font-profile/v1",
    profileId: `sha256:${"a".repeat(64)}#face=0`,
    source: { sha256: "a".repeat(64), faceIndex: 0 },
    face: {
      family: "테스트체",
      subfamily: "Regular",
      fullName: "테스트체 Regular",
      postscriptName: "Test-Regular",
      aliases: ["테스트체"],
    },
    metrics: {
      unitsPerEm: 1000,
      advance: {
        codePoints: { "U+3000": 1 },
        hangulModel: {
          defaultEm: 0.92,
          exceptions: { "U+D7A3": 0.94 },
        },
      },
      line: { preferred: { lineAdvanceEm: 1.4, baselineFromTopEm: 1.1 } },
    },
    hwpkit: {
      widthModel: {
        hangulEm: 0.92,
        jamoEm: 0.92,
        hanjaEm: 1,
        latinUpperEm: 0.65,
        latinLowerEm: 0.52,
        digitEm: 0.55,
        spaceEm: 0.25,
        punctuationEm: 0.4,
        bodyTextEm: 1,
      },
      lineModel: { lineAdvanceEm: 1.4, baselineFromTopEm: 1.1 },
      confidence: "high",
    },
    ...overrides,
  };
}

test("consumer adapter uses exact Hangul exceptions and measured ideographic space", () => {
  const adapter = createHwpkitFontAdapter(profile());

  assert.equal(adapter.codePointWidthEm("가".codePointAt(0)), 0.92);
  assert.equal(adapter.codePointWidthEm("힣".codePointAt(0)), 0.94);
  assert.equal(adapter.codePointWidthEm(0x3000), 1);
  assert.equal(adapter.codePointWidthEm(0x0301), 0);
  assert.equal(adapter.codePointWidthHwp("한".codePointAt(0), 1000), 920);
  assert.equal(adapter.lineAdvanceHwp(1000), 1400);
  assert.equal(adapter.baselineHwp(1000), 1100);
  assert.deepEqual(adapter.fallbackKeys, []);
});

test("consumer adapter preserves the current encoder fallback for a non-Korean font", () => {
  const low = profile({
    hwpkit: {
      widthModel: {
        hangulEm: null,
        spaceEm: 0.3,
      },
      lineModel: {},
      confidence: "low",
    },
    metrics: { unitsPerEm: 1000, advance: {}, line: {} },
  });
  const adapter = createHwpkitFontAdapter(low, { preferGlyphMetrics: false });

  assert.equal(adapter.codePointWidthEm("한".codePointAt(0)), 1);
  assert.equal(adapter.codePointWidthEm(0x20), 0.3);
  assert.ok(adapter.fallbackKeys.includes("hangulEm"));
  assert.equal(adapter.confidence, "low");
});

test("profile selection rejects ambiguous collection names", () => {
  const first = profile();
  const second = profile({
    profileId: `sha256:${"b".repeat(64)}#face=1`,
    source: { sha256: "b".repeat(64), faceIndex: 1 },
  });
  const catalog = { fonts: [first, second] };

  assert.throws(() => selectFontProfile(catalog, "테스트체"), /ambiguous/);
  assert.equal(selectFontProfile(catalog, first.profileId), first);
});
