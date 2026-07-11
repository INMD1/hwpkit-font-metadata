import assert from "node:assert/strict";
import test from "node:test";

import { describe, quantile, round, safeRatio } from "../src/stats.mjs";

test("quantile interpolates values deterministically", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0.05), 1.15);
  assert.equal(quantile([], 0.5), null);
});

test("describe never turns missing measurements into zero-width glyphs", () => {
  assert.deepEqual(describe([], { expected: 4 }), {
    expected: 4,
    measured: 0,
    missing: 4,
    coverage: 0,
    unit: "em",
    min: null,
    p05: null,
    median: null,
    mean: null,
    p95: null,
    max: null,
    stddev: null,
    coefficientOfVariation: null,
  });
});

test("describe reports normalized distribution statistics", () => {
  const stats = describe([0.25, 0.5, 0.75, 1], { expected: 5 });
  assert.equal(stats.measured, 4);
  assert.equal(stats.missing, 1);
  assert.equal(stats.coverage, 0.8);
  assert.equal(stats.mean, 0.625);
  assert.equal(stats.median, 0.625);
  assert.equal(stats.min, 0.25);
  assert.equal(stats.max, 1);
});

test("round and safeRatio reject non-finite values", () => {
  assert.equal(round(0.123456789), 0.123457);
  assert.equal(round(Number.NaN), null);
  assert.equal(safeRatio(1, 0), null);
  assert.equal(safeRatio(3, 2), 1.5);
});
