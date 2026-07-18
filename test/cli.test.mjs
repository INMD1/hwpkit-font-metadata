import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  HELP,
  main,
  mergeFontCatalogs,
  parseAnalyze,
  parseCompare,
} from "../dist/bin/hwpkit-font-meta.js";

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

test("CLI help documents the merge command and default result-folder output", () => {
  assert.match(HELP, /hwpkit-font-meta merge/);
  assert.match(HELP, /result\/analyze-<timestamp>\.json/);
  assert.match(HELP, /result\/merged-<timestamp>\.json/);
});

test("merge arguments default to scanning ./result and accept -o/--compact", () => {
  const defaulted = parseMerge([]);
  assert.deepEqual(defaulted.inputs, ["result"]);
  assert.equal(defaulted.output, null);
  assert.equal(defaulted.pretty, true);

  const explicit = parseMerge(["a.json", "some-dir", "--compact", "-o", "merged.json"]);
  assert.deepEqual(explicit.inputs, ["a.json", "some-dir"]);
  assert.equal(explicit.output, "merged.json");
  assert.equal(explicit.pretty, false);

  assert.throws(() => parseMerge(["--not-a-real-option"]), /Unknown merge option/);
});

test("mergeFontCatalogs de-duplicates by profileId and skips non-catalog documents", () => {
  const shared = fakeFontProfile({ profileId: "sha256:aaa#face=0", fullName: "Shared", sha256: "aaa" });
  const first = fakeCatalog(
    [shared, fakeFontProfile({ profileId: "sha256:bbb#face=0", fullName: "Only In First", sha256: "bbb" })],
    [{ stage: "parse", fileName: "broken.ttf", code: null, message: "bad" }],
  );
  const second = fakeCatalog([
    // Same profileId as `shared`, but a different object identity: the first
    // occurrence across input files must win.
    fakeFontProfile({ profileId: "sha256:aaa#face=0", fullName: "Shared (stale copy)", sha256: "aaa" }),
    fakeFontProfile({ profileId: "sha256:ccc#face=0", fullName: "Only In Second", sha256: "ccc" }),
  ]);
  const notACatalog = { schemaId: "hwpkit.font-comparison/v1", candidates: [] };

  const { catalog, stats } = mergeFontCatalogs([
    { path: "first.json", document: first },
    { path: "second.json", document: second },
    { path: "comparison.json", document: notACatalog },
  ]);

  assert.equal(catalog.fonts.length, 3);
  assert.deepEqual(
    catalog.fonts.map((font) => font.profileId).sort(),
    ["sha256:aaa#face=0", "sha256:bbb#face=0", "sha256:ccc#face=0"],
  );
  const merged = catalog.fonts.find((font) => font.profileId === "sha256:aaa#face=0");
  assert.equal(merged.face.fullName, "Shared", "first file's copy of a duplicate profile wins");
  assert.equal(catalog.errors.length, 1);
  assert.equal(stats.catalogFiles, 2);
  assert.deepEqual(stats.skippedFiles, ["comparison.json"]);
  assert.equal(stats.duplicateFontCount, 1);
});

test("mergeFontCatalogs throws when no hwpkit.font-catalog/v1 document is found", () => {
  assert.throws(
    () => mergeFontCatalogs([{ path: "comparison.json", document: { schemaId: "hwpkit.font-comparison/v1" } }]),
    /No hwpkit\.font-catalog\/v1 document found/,
  );
});

test("merge command writes to ./result by default and combines files on disk", async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "hwpkit-merge-"));
  const originalCwd = process.cwd();
  try {
    await writeFile(
      path.join(workingDirectory, "a.json"),
      JSON.stringify(fakeCatalog([fakeFontProfile({ profileId: "sha256:aaa#face=0", fullName: "A", sha256: "aaa" })])),
    );
    await writeFile(
      path.join(workingDirectory, "b.json"),
      JSON.stringify(fakeCatalog([fakeFontProfile({ profileId: "sha256:bbb#face=0", fullName: "B", sha256: "bbb" })])),
    );

    process.chdir(workingDirectory);
    await main(["merge", "a.json", "b.json"]);

    const resultFiles = await readdir(path.join(workingDirectory, "result"));
    assert.equal(resultFiles.length, 1);
    assert.match(resultFiles[0], /^merged-\d{8}-\d{9}\.json$/);

    const written = JSON.parse(
      await readFile(path.join(workingDirectory, "result", resultFiles[0]), "utf8"),
    );
    assert.deepEqual(
      written.fonts.map((font) => font.profileId).sort(),
      ["sha256:aaa#face=0", "sha256:bbb#face=0"],
    );
  } finally {
    process.chdir(originalCwd);
    await rm(workingDirectory, { recursive: true, force: true });
  }
});
