import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPARISON_SCHEMA_ID,
  compareFontProfiles,
  computeFormatAdjustments,
  rankFontCandidates,
} from '../src/compare.mjs';

function makeProfile(profileId, overrides = {}) {
  const width = {
    hangulEm: 1,
    jamoEm: 0.96,
    hanjaEm: 1,
    latinUpperEm: 0.68,
    latinLowerEm: 0.52,
    digitEm: 0.56,
    spaceEm: 0.30,
    punctuationEm: 0.42,
    bodyTextEm: 0.88,
    ...(overrides.width ?? {}),
  };
  const line = {
    lineAdvanceEm: 1.20,
    ascenderEm: 0.88,
    descenderEm: 0.22,
    baselineFromTopEm: 0.88,
    ...(overrides.line ?? {}),
  };
  const face = {
    family: `Family ${profileId}`,
    subfamily: 'Regular',
    fullName: `Family ${profileId} Regular`,
    postscriptName: `${profileId}-Regular`,
    weightClass: 400,
    widthClass: 5,
    italic: false,
    ...(overrides.face ?? {}),
  };
  const coverageSets = {
    ascii: { required: 95, mapped: 95, ratio: 1 },
    modernHangulSyllables: { required: 11172, mapped: 11172, ratio: 1 },
    ...(overrides.coverageSets ?? {}),
  };

  return {
    profileId,
    source: { sha256: `${profileId}-sha`, faceIndex: 0 },
    face,
    coverage: { sets: coverageSets },
    metrics: {
      advance: {
        groups: {
          hangul: { mean: width.hangulEm, unit: 'em' },
          latinUpper: { mean: width.latinUpperEm, unit: 'em' },
          latinLower: { mean: width.latinLowerEm, unit: 'em' },
        },
        spaces: {
          asciiSpace: { codePoint: 0x20, mapped: true, advanceEm: width.spaceEm },
        },
      },
      line: { preferred: { source: 'typo', ...line } },
    },
    layout: { samples: [] },
    hwpkit: { widthModel: width, lineModel: line },
  };
}

test('an identical profile has zero components and neutral adjustments', () => {
  const source = makeProfile('source');
  const result = compareFontProfiles(source, makeProfile('same'));

  assert.equal(result.eligible, true);
  assert.equal(result.distance, 0);
  assert.equal(result.score, 100);
  assert.deepEqual(result.components, {
    width: 0,
    space: 0,
    vertical: 0,
    style: 0,
  });
  assert.equal(result.adjustments.hwp.ratio, 100);
  assert.equal(result.adjustments.hwp.spacing, 0);
  assert.equal(result.adjustments.hwpx.ratio, 100);
  assert.equal(result.adjustments.hwpx.spacing, 0);
});

test('coverage is a hard gate and rejected candidates do not receive a rank', () => {
  const source = makeProfile('source');
  const incompatible = makeProfile('missing-hangul', {
    coverageSets: {
      modernHangulSyllables: { required: 11172, mapped: 10000, ratio: 10000 / 11172 },
    },
  });
  const ranked = rankFontCandidates(source, [incompatible, makeProfile('compatible')]);

  assert.equal(ranked.schemaId, COMPARISON_SCHEMA_ID);
  assert.deepEqual(ranked.candidates.map((candidate) => candidate.profileId), ['compatible']);
  assert.equal(ranked.candidates[0].rank, 1);
  assert.equal(ranked.rejected.length, 1);
  assert.equal(ranked.rejected[0].profileId, 'missing-hangul');
  assert.equal(ranked.rejected[0].rank, null);
  assert.equal(ranked.rejected[0].distance, null);
  assert.equal(ranked.rejected[0].score, 0);
  assert.deepEqual(ranked.rejected[0].rejectionReasons, [
    'coverage:modernHangulSyllables',
  ]);
});

test('distance and score do not depend on the other candidates in the set', () => {
  const source = makeProfile('source');
  const close = makeProfile('close', {
    width: { hangulEm: 0.99, bodyTextEm: 0.87, spaceEm: 0.305 },
  });
  const far = makeProfile('far', {
    width: { hangulEm: 0.78, bodyTextEm: 0.70, spaceEm: 0.50 },
    line: { lineAdvanceEm: 1.60, baselineFromTopEm: 1.05 },
  });

  const first = rankFontCandidates(source, [close, far]);
  const second = rankFontCandidates(source, [
    close,
    far,
    makeProfile('extra', {
      width: { hangulEm: 1.40, bodyTextEm: 1.20, spaceEm: 0.20 },
    }),
  ]);
  for (const id of ['close', 'far']) {
    const before = first.candidates.find((candidate) => candidate.profileId === id);
    const after = second.candidates.find((candidate) => candidate.profileId === id);
    assert.equal(after.distance, before.distance);
    assert.equal(after.score, before.score);
    assert.deepEqual(after.components, before.components);
  }
  assert.equal(first.candidates[0].profileId, 'close');
});

test('width, space, and vertical differences are reported separately', () => {
  const source = makeProfile('source');
  const candidate = makeProfile('different', {
    width: {
      hangulEm: 1.10,
      jamoEm: 1.04,
      bodyTextEm: 1.02,
      spaceEm: 0.45,
    },
    line: {
      lineAdvanceEm: 1.38,
      ascenderEm: 0.96,
      descenderEm: 0.28,
      baselineFromTopEm: 0.96,
    },
  });
  const result = compareFontProfiles(source, candidate);

  assert.ok(result.components.width > 0);
  assert.ok(result.components.space > result.components.width);
  assert.ok(result.components.vertical > 0);
  assert.equal(result.deltas.width.hangulEm.reference, 1);
  assert.equal(result.deltas.width.hangulEm.candidate, 1.1);
  assert.equal(result.deltas.space.spaceEm.candidate, 0.45);
  assert.equal(result.deltas.vertical.lineAdvanceEm.candidate, 1.38);
});

test('HWP and HWPX corrections use conservative automatic limits', () => {
  const source = makeProfile('source', {
    width: { hangulEm: 1, bodyTextEm: 0.9, spaceEm: 0.3 },
  });
  const candidate = makeProfile('extreme', {
    width: { hangulEm: 0.1, bodyTextEm: 0.1, spaceEm: 2 },
  });
  const adjustments = computeFormatAdjustments(source, candidate);

  for (const format of ['hwp', 'hwpx']) {
    assert.equal(adjustments[format].ratio, 105);
    assert.equal(adjustments[format].spacing, 2);
    assert.equal(adjustments[format].clamped.ratio, true);
    assert.equal(adjustments[format].clamped.spacing, true);
    assert.equal(Number.isInteger(adjustments[format].ratio), true);
    assert.equal(Number.isInteger(adjustments[format].spacing), true);
  }
});

test('callers can opt into wider but still fixed adjustment limits', () => {
  const source = makeProfile('source', {
    width: { hangulEm: 1, bodyTextEm: 0.9 },
  });
  const candidate = makeProfile('extreme', {
    width: { hangulEm: 0.1, bodyTextEm: 0.1 },
  });
  const adjustments = computeFormatAdjustments(source, candidate, {
    adjustmentLimits: {
      hwp: { ratio: [50, 200], spacing: [-50, 50] },
      hwpx: { ratio: [50, 200], spacing: [-50, 50] },
    },
  });

  assert.equal(adjustments.hwp.ratio, 200);
  assert.equal(adjustments.hwp.spacing, 50);
  assert.equal(adjustments.hwpx.ratio, 200);
  assert.equal(adjustments.hwpx.spacing, 50);
});

test('ranking uses profileId as a deterministic tie breaker', () => {
  const source = makeProfile('source');
  const ranked = rankFontCandidates(source, [makeProfile('zeta'), makeProfile('alpha')]);

  assert.deepEqual(
    ranked.candidates.map(({ profileId, rank }) => [profileId, rank]),
    [['alpha', 1], ['zeta', 2]],
  );
});

test('canonical analyzer fallback paths work when hwpkit models are absent', () => {
  const source = makeProfile('source');
  const candidate = makeProfile('fallback');
  delete source.hwpkit;
  delete candidate.hwpkit;

  const result = compareFontProfiles(source, candidate);
  assert.equal(result.eligible, true);
  assert.equal(result.components.width, 0);
  assert.equal(result.components.space, 0);
  assert.equal(result.components.vertical, 0);
});
