import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import { analyzeFontSource } from "../dist/src/analyze.js";
import { compareFontProfiles } from "../dist/src/compare.js";
import { loadFontSources } from "../dist/src/font-source.js";

const sansPath = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const serifPath = "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc";
const hasNotoCjk = existsSync(sansPath) && existsSync(serifPath);

async function koreanProfile(fontPath) {
  const loaded = await loadFontSources(fontPath);
  assert.deepEqual(loaded.errors, []);
  const source = loaded.sources.find((item) => /\bKR\b/i.test(item.face.familyName ?? ""));
  assert.ok(source, `Korean face missing from ${fontPath}`);
  return analyzeFontSource(source);
}

test(
  "Noto CJK TTC proves that Korean fonts can have different paragraph advances",
  { skip: hasNotoCjk ? false : "Noto CJK TTC system fonts are not installed" },
  async () => {
    const sans = await koreanProfile(sansPath);
    const serif = await koreanProfile(serifPath);

    assert.equal(sans.source.faceCount > 1, true);
    assert.equal(serif.source.faceCount > 1, true);
    assert.equal(sans.coverage.sets.modernHangulSyllables.mapped, 11_172);
    assert.equal(serif.coverage.sets.modernHangulSyllables.mapped, 11_172);
    assert.equal(sans.metrics.advance.groups.modernHangulSyllables.coverage, 1);
    assert.equal(serif.metrics.advance.groups.modernHangulSyllables.coverage, 1);

    const sansWidth = sans.hwpkit.widthModel.hangulEm;
    const serifWidth = serif.hwpkit.widthModel.hangulEm;
    assert.ok(Math.abs(sansWidth - serifWidth) > 0.02);

    const comparison = compareFontProfiles(sans, serif);
    assert.equal(comparison.eligible, true);
    assert.ok(comparison.components.width > 0);
    assert.equal(
      comparison.adjustments.hwp.rawRatio,
      Math.round((sansWidth / serifWidth) * 1_000_000) / 10_000,
    );
  },
);
