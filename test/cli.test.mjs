import assert from "node:assert/strict";
import test from "node:test";

import {
  HELP,
  parseAnalyze,
  parseCompare,
} from "../bin/hwpkit-font-meta.mjs";

test("CLI help documents both analyzer and comparison commands", () => {
  assert.match(HELP, /analyze <font-or-directory/);
  assert.match(HELP, /compare --source/);
  assert.match(HELP, /--source-face/);
  assert.match(HELP, /--max-file-size-mib/);
});

test("analyze arguments support directories, a TTC face, corpus, and safety limits", () => {
  const options = parseAnalyze([
    "fonts",
    "font.ttc",
    "--face",
    "NotoSansCJKkr-Regular",
    "--corpus",
    "body.txt",
    "--max-files",
    "12",
    "--max-file-size-mib",
    "64",
    "--compact",
    "--strict",
    "-o",
    "catalog.json",
  ]);

  assert.deepEqual(options.inputs, ["fonts", "font.ttc"]);
  assert.equal(options.face, "NotoSansCJKkr-Regular");
  assert.deepEqual(options.corpora, ["body.txt"]);
  assert.equal(options.maxFiles, 12);
  assert.equal(options.maxFileSizeMiB, 64);
  assert.equal(options.pretty, false);
  assert.equal(options.strict, true);
  assert.equal(options.output, "catalog.json");
});

test("compare arguments accept a candidate list followed by more options", () => {
  const options = parseCompare([
    "--source",
    "source.ttc",
    "--source-face",
    "1",
    "--candidates",
    "first.ttf",
    "candidate-dir",
    "--candidate-face",
    "Regular",
    "--top",
    "5",
    "-o",
    "comparison.json",
  ]);

  assert.equal(options.source, "source.ttc");
  assert.equal(options.sourceFace, "1");
  assert.deepEqual(options.candidates, ["first.ttf", "candidate-dir"]);
  assert.equal(options.candidateFace, "Regular");
  assert.equal(options.top, 5);
  assert.equal(options.output, "comparison.json");
});

test("CLI argument validation rejects unknown and unsafe numeric options", () => {
  assert.throws(
    () => parseAnalyze(["font.ttf", "--not-a-real-option"]),
    /Unknown analyze option/,
  );
  assert.throws(
    () => parseAnalyze(["font.ttf", "--max-files", "0"]),
    /positive integer/,
  );
  assert.throws(
    () => parseCompare(["--source", "font.ttf"]),
    /requires --candidates/,
  );
});
