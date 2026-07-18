#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { analyzeFontSources, createCatalog } from "../src/analyze.js";
import { rankFontCandidates } from "../src/compare.js";
import { PACKAGE_VERSION } from "../src/constants.js";
import { discoverFontFiles, loadFontSources } from "../src/font-source.js";
import type { FontErrorRecord } from "../src/font-source.js";
import type { LayoutSample } from "../src/constants.js";

const DEFAULT_MAX_FILES = 256;
const DEFAULT_MAX_FILE_SIZE_MIB = 512;
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;
const MAX_CORPUS_CODE_POINTS = 20_000;
const MAX_CORPUS_SAMPLES = 128;

// Where JSON output goes when -o/--output is not given. See HOWTO/03-output-and-merge.md.
const RESULT_DIR = "result";

export const HELP = `Hwpkit Korean font metadata analyzer

Usage:
  hwpkit-font-meta analyze <font-or-directory...> [options]
  hwpkit-font-meta compare --source <font> --candidates <font-or-directory...> [options]
  hwpkit-font-meta merge [json-or-directory...] [options]

Analyze options:
  -o, --output <file>       Write JSON to a file (default: ./result/analyze-<timestamp>.json)
      --face <name|index>   Analyze one face from a TTC/OTC collection
      --corpus <text-file>  Add real document text (repeatable)
      --compact             Emit compact JSON
      --strict              Exit non-zero when any input failed

Compare options:
      --source <font>       Source/original font (required)
      --source-face <face>  Source TTC/OTC face name or index
      --candidates <paths>  Candidate files/directories; values continue to next option
      --candidate <path>    Add one candidate path (repeatable)
      --candidate-face <f>  Filter candidate TTC/OTC faces
      --top <count>         Keep only the best eligible candidates
  -o, --output <file>       Write JSON to a file (default: ./result/compare-<timestamp>.json)
      --corpus <text-file>  Compare using additional real document text
      --compact             Emit compact JSON
      --strict              Exit non-zero when any input failed

Merge options:
  merge combines several "analyze" catalog JSON files into one. With no
  arguments it merges every *.json file under ./result. Files that are not
  an hwpkit.font-catalog/v1 document (e.g. a "compare" result) are skipped,
  and faces with a duplicate profileId are kept only once.
  -o, --output <file>       Write JSON to a file (default: ./result/merged-<timestamp>.json)
      --compact             Emit compact JSON

Safety options:
      --max-files <count>           Maximum number of font files (default: 256)
      --max-file-size-mib <count>   Maximum bytes per font in MiB (default: 512)

Other:
  -h, --help                Show this help
  -v, --version             Show the package version

Any -o/--output value may be "-" to force stdout instead of a file.
`;

interface BaseOptions {
  output: string | null;
  corpora: string[];
  pretty: boolean;
  strict: boolean;
  maxFiles: number;
  maxFileSizeMiB: number;
}

export interface AnalyzeCliOptions extends BaseOptions {
  inputs: string[];
  face: string | null;
}

export interface CompareCliOptions extends BaseOptions {
  source: string | null;
  sourceFace: string | null;
  candidates: string[];
  candidateFace: string | null;
  top: number | null;
}

function optionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseCommonOption(args: string[], index: number, options: BaseOptions): number | null {
  const arg = args[index];
  if (arg === "-o" || arg === "--output") {
    options.output = optionValue(args, index, arg);
    return 1;
  }
  if (arg === "--corpus") {
    options.corpora.push(optionValue(args, index, arg));
    return 1;
  }
  if (arg === "--compact") {
    options.pretty = false;
    return 0;
  }
  if (arg === "--strict") {
    options.strict = true;
    return 0;
  }
  if (arg === "--max-files") {
    options.maxFiles = positiveInteger(optionValue(args, index, arg), arg);
    return 1;
  }
  if (arg === "--max-file-size-mib") {
    options.maxFileSizeMiB = positiveInteger(optionValue(args, index, arg), arg);
    return 1;
  }
  return null;
}

function baseOptions(): BaseOptions {
  return {
    output: null,
    corpora: [],
    pretty: true,
    strict: false,
    maxFiles: DEFAULT_MAX_FILES,
    maxFileSizeMiB: DEFAULT_MAX_FILE_SIZE_MIB,
  };
}

export function parseAnalyze(args: string[]): AnalyzeCliOptions {
  const options: AnalyzeCliOptions = { ...baseOptions(), inputs: [], face: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const consumed = parseCommonOption(args, index, options);
    if (consumed !== null) {
      index += consumed;
      continue;
    }
    if (arg === "--face") {
      options.face = optionValue(args, index, arg);
      index += 1;
    } else if (arg === "--") {
      options.inputs.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown analyze option: ${arg}`);
    } else {
      options.inputs.push(arg);
    }
  }
  if (options.inputs.length === 0) {
    throw new Error("analyze requires at least one font file or directory");
  }
  return options;
}

export function parseCompare(args: string[]): CompareCliOptions {
  const options: CompareCliOptions = {
    ...baseOptions(),
    source: null,
    sourceFace: null,
    candidates: [],
    candidateFace: null,
    top: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const consumed = parseCommonOption(args, index, options);
    if (consumed !== null) {
      index += consumed;
      continue;
    }
    if (arg === "--source") {
      options.source = optionValue(args, index, arg);
      index += 1;
    } else if (arg === "--source-face") {
      options.sourceFace = optionValue(args, index, arg);
      index += 1;
    } else if (arg === "--candidate") {
      options.candidates.push(optionValue(args, index, arg));
      index += 1;
    } else if (arg === "--candidates") {
      let cursor = index + 1;
      while (cursor < args.length && !args[cursor].startsWith("-")) {
        options.candidates.push(args[cursor]);
        cursor += 1;
      }
      if (cursor === index + 1) throw new Error("--candidates requires at least one path");
      index = cursor - 1;
    } else if (arg === "--candidate-face") {
      options.candidateFace = optionValue(args, index, arg);
      index += 1;
    } else if (arg === "--top") {
      options.top = positiveInteger(optionValue(args, index, arg), arg);
      index += 1;
    } else if (arg === "--") {
      options.candidates.push(...args.slice(index + 1));
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown compare option: ${arg}`);
    } else {
      options.candidates.push(arg);
    }
  }
  if (!options.source) throw new Error("compare requires --source <font>");
  if (options.candidates.length === 0) {
    throw new Error("compare requires --candidates <font-or-directory...>");
  }
  return options;
}

interface PortableErrorInput {
  path?: string;
  fileName?: string;
  message?: string;
  stage?: string;
  code?: string | null;
  faceIndex?: number | null;
  face?: string;
}

interface PortableError {
  stage: string;
  fileName: string;
  code: string | null;
  message: string;
  faceIndex?: number;
  face?: string;
}

function portableError(error: PortableErrorInput): PortableError {
  const inputPath = error?.path ?? error?.fileName ?? "font";
  const fileName = path.basename(String(inputPath));
  const rawMessage = error?.message ?? String(error);
  const message = typeof rawMessage === "string" && String(inputPath)
    ? rawMessage.split(String(inputPath)).join(fileName)
    : String(rawMessage);
  const result: PortableError = {
    stage: error?.stage ?? "unknown",
    fileName,
    code: error?.code ?? null,
    message,
  };
  if (Number.isInteger(error?.faceIndex)) result.faceIndex = error.faceIndex as number;
  if (error?.face != null) result.face = String(error.face);
  return result;
}

interface DiscoverWithLimitsResult {
  files: string[];
  errors: PortableError[];
}

async function discoverWithLimits(inputs: string[], options: BaseOptions): Promise<DiscoverWithLimitsResult> {
  const discovery = await discoverFontFiles(inputs);
  const errors: PortableError[] = discovery.errors.map(portableError);
  const accepted: string[] = [];
  const maximumBytes = options.maxFileSizeMiB * 1024 * 1024;

  for (const filePath of discovery.files) {
    if (accepted.length >= options.maxFiles) {
      errors.push({
        stage: "limit",
        fileName: path.basename(filePath),
        code: "FONT_FILE_COUNT_LIMIT",
        message: `Skipped because --max-files is ${options.maxFiles}`,
      });
      continue;
    }
    try {
      const details = await stat(filePath);
      if (details.size > maximumBytes) {
        errors.push({
          stage: "limit",
          fileName: path.basename(filePath),
          code: "FONT_FILE_SIZE_LIMIT",
          message: `Font is ${details.size} bytes; limit is ${maximumBytes} bytes`,
        });
      } else {
        accepted.push(filePath);
      }
    } catch (error) {
      errors.push(
        portableError({
          stage: "stat",
          path: filePath,
          code: (error as NodeJS.ErrnoException)?.code ?? null,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  return { files: accepted, errors };
}

interface LoadWithLimitsResult {
  files: string[];
  sources: Awaited<ReturnType<typeof loadFontSources>>["sources"];
  errors: PortableError[];
}

async function loadWithLimits(
  inputs: string[],
  options: BaseOptions,
  face: string | null,
): Promise<LoadWithLimitsResult> {
  const limited = await discoverWithLimits(inputs, options);
  const loaded = await loadFontSources(limited.files, { face });
  return {
    files: limited.files,
    sources: loaded.sources,
    errors: [...limited.errors, ...loaded.errors.map(portableError)],
  };
}

function codePointSlice(text: string, maximum: number): string {
  return Array.from(text).slice(0, maximum).join("");
}

interface CorpusSample extends LayoutSample {
  sourceSha256: string;
}

async function loadCorpusSamples(corpusPaths: string[]): Promise<CorpusSample[]> {
  const samples: CorpusSample[] = [];
  const uniquePaths = [...new Set(corpusPaths.map((item) => path.resolve(item)))].sort();
  let remainingCodePoints = MAX_CORPUS_CODE_POINTS;

  for (const corpusPath of uniquePaths) {
    const details = await stat(corpusPath);
    if (!details.isFile()) throw new Error(`Corpus is not a file: ${corpusPath}`);
    if (details.size > MAX_CORPUS_BYTES) {
      throw new Error(
        `Corpus ${path.basename(corpusPath)} exceeds ${MAX_CORPUS_BYTES} bytes`,
      );
    }
    const content = (await readFile(corpusPath, "utf8")).replace(/\r\n?/g, "\n");
    const sourceSha256 = createHash("sha256").update(content, "utf8").digest("hex");
    const lines = content
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const selectedLines = lines.length > 0 ? lines : [content];

    for (let lineIndex = 0; lineIndex < selectedLines.length; lineIndex += 1) {
      if (samples.length >= MAX_CORPUS_SAMPLES || remainingCodePoints <= 0) break;
      const text = codePointSlice(selectedLines[lineIndex], Math.min(2_000, remainingCodePoints));
      if (!text) continue;
      remainingCodePoints -= Array.from(text).length;
      samples.push({
        id: `user:${sourceSha256.slice(0, 12)}:${lineIndex + 1}`,
        normalization: "preserved",
        text,
        sourceSha256,
      });
    }
  }
  return samples;
}

async function writeJson(
  value: unknown,
  outputPath: string | null,
  pretty: boolean,
  protectedInputs: string[] = [],
): Promise<void> {
  const payload = `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
  if (!outputPath || outputPath === "-") {
    process.stdout.write(payload);
    return;
  }

  const destination = path.resolve(outputPath);
  if (protectedInputs.some((input) => path.resolve(input) === destination)) {
    throw new Error(`Refusing to overwrite input font: ${destination}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function reportSummary(kind: string, output: string | null, errorCount: number): void {
  if (!output || output === "-") return;
  process.stderr.write(`${kind}: wrote ${output} (${errorCount} input error(s))\n`);
}

async function runAnalyze(options: AnalyzeCliOptions): Promise<void> {
  const corpusSamples = await loadCorpusSamples(options.corpora);
  const loaded = await loadWithLimits(options.inputs, options, options.face);
  const analyzed = analyzeFontSources(loaded.sources, { corpusSamples });
  const errors = [...loaded.errors, ...analyzed.errors.map(portableError)];
  const catalog = createCatalog(analyzed.fonts, errors);

  if (catalog.fonts.length === 0) {
    throw new Error(`No font face was analyzed (${errors.length} input error(s))`);
  }
  const outputPath = options.output ?? defaultOutputPath("analyze");
  await writeJson(catalog, outputPath, options.pretty, loaded.files);
  reportSummary("analyze", outputPath, errors.length);
  if (options.strict && errors.length > 0) process.exitCode = 2;
}

async function runCompare(options: CompareCliOptions): Promise<void> {
  const corpusSamples = await loadCorpusSamples(options.corpora);
  const sourceLoaded = await loadWithLimits([options.source as string], options, options.sourceFace);
  if (sourceLoaded.sources.length !== 1) {
    throw new Error(
      `Source resolved to ${sourceLoaded.sources.length} faces; use --source-face to select one`,
    );
  }
  const candidateLoaded = await loadWithLimits(
    options.candidates,
    options,
    options.candidateFace,
  );
  const sourceAnalyzed = analyzeFontSources(sourceLoaded.sources, { corpusSamples });
  const candidatesAnalyzed = analyzeFontSources(candidateLoaded.sources, { corpusSamples });
  const sourceProfile = sourceAnalyzed.fonts[0];
  const candidates = candidatesAnalyzed.fonts.filter(
    (profile) => profile.profileId !== sourceProfile.profileId,
  );
  if (candidates.length === 0) throw new Error("No distinct candidate font face was analyzed");

  const result = rankFontCandidates(sourceProfile, candidates);
  if (options.top !== null) result.candidates = result.candidates.slice(0, options.top);
  const errors = [
    ...sourceLoaded.errors,
    ...candidateLoaded.errors,
    ...sourceAnalyzed.errors.map(portableError),
    ...candidatesAnalyzed.errors.map(portableError),
  ];
  if (errors.length > 0) result.errors = errors;
  const outputPath = options.output ?? defaultOutputPath("compare");
  await writeJson(
    result,
    outputPath,
    options.pretty,
    [...sourceLoaded.files, ...candidateLoaded.files],
  );
  reportSummary("compare", outputPath, errors.length);
  if (options.strict && errors.length > 0) process.exitCode = 2;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  if (args[0] === "-v" || args[0] === "--version") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }

  const command = args.shift();
  if (command === "analyze") await runAnalyze(parseAnalyze(args));
  else if (command === "compare") await runCompare(parseCompare(args));
  else if (command === "merge") await runMerge(parseMerge(args));
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`hwpkit-font-meta: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
