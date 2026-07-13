import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { create as createFont } from "fontkit";
import type { Font, FontCollection } from "fontkit";

export const SUPPORTED_FONT_EXTENSIONS = Object.freeze([
  ".otc",
  ".otf",
  ".ttc",
  ".ttf",
  ".woff",
  ".woff2",
]);

const SUPPORTED_EXTENSION_SET = new Set(SUPPORTED_FONT_EXTENSIONS);

export interface FontErrorRecord {
  path: string;
  stage: string;
  code: string;
  message: string;
  faceIndex?: number;
  face?: string;
  availableFaces?: Array<{
    index: number;
    postscriptName: string | null;
    fullName: string | null;
    familyName: string | null;
  }>;
}

export interface FaceDescriptor {
  index: number;
  count: number;
  postscriptName: string | null;
  fullName: string | null;
  familyName: string | null;
  subfamilyName: string | null;
}

export interface FontFileInfo {
  fileName: string;
  sizeBytes: number;
  sha256: string;
  container: string;
  /** Absolute path. Non-enumerable so it never leaks into JSON output. */
  readonly path?: string;
}

export interface FontSource {
  file: FontFileInfo;
  face: FaceDescriptor;
  /** Live fontkit object. Non-enumerable so JSON.stringify/spread stay safe. */
  readonly font: Font;
}

export interface DiscoverResult {
  files: string[];
  errors: FontErrorRecord[];
}

export interface LoadResult {
  files: string[];
  sources: FontSource[];
  errors: FontErrorRecord[];
}

export interface DiscoverOptions {
  cwd?: string;
}

export interface LoadOptions {
  face?: string | number | null;
  cwd?: string;
}

export type FontInputs = string | Iterable<string> | null | undefined;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorRecord(
  stage: string,
  filePath: string,
  error: unknown,
  fallbackCode: string,
  details: Record<string, unknown> = {},
): FontErrorRecord {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : fallbackCode;

  return {
    path: filePath,
    stage,
    code,
    message,
    ...details,
  } as FontErrorRecord;
}

function sortErrors(errors: FontErrorRecord[]): FontErrorRecord[] {
  return errors.sort((left, right) => {
    return (
      compareText(left.path ?? "", right.path ?? "") ||
      compareText(left.stage ?? "", right.stage ?? "") ||
      compareText(left.code ?? "", right.code ?? "") ||
      compareText(left.message ?? "", right.message ?? "")
    );
  });
}

function inputList(inputs: FontInputs): string[] {
  if (inputs == null) return [];
  if (typeof inputs === "string") return [inputs];
  if (Array.isArray(inputs)) return inputs;
  if (typeof (inputs as Iterable<string>)[Symbol.iterator] === "function") {
    return [...(inputs as Iterable<string>)];
  }
  return [inputs as unknown as string];
}

export function isSupportedFontFile(filePath: unknown): boolean {
  if (typeof filePath !== "string") return false;
  return SUPPORTED_EXTENSION_SET.has(path.extname(filePath).toLowerCase());
}

/**
 * Recursively resolves font files from a mix of file and directory inputs.
 *
 * Results use real, absolute paths so repeated inputs and symlink aliases are
 * de-duplicated. A problem with one input or directory entry is returned in
 * `errors` without preventing other files from being discovered.
 */
export async function discoverFontFiles(
  inputs: FontInputs,
  { cwd = process.cwd() }: DiscoverOptions = {},
): Promise<DiscoverResult> {
  const errors: FontErrorRecord[] = [];
  const roots = new Set<string>();

  for (const input of inputList(inputs)) {
    if (typeof input !== "string" || input.trim() === "") {
      errors.push(
        errorRecord(
          "discover",
          typeof input === "string" ? input : String(input),
          new TypeError("Font input must be a non-empty path string"),
          "INVALID_FONT_INPUT",
        ),
      );
      continue;
    }

    roots.add(path.resolve(cwd, input));
  }

  const discovered = new Map<string, string>();
  const visitedDirectories = new Set<string>();

  async function walk(candidatePath: string, explicitInput: boolean): Promise<void> {
    let stats;
    try {
      stats = await fs.stat(candidatePath);
    } catch (error) {
      errors.push(errorRecord("stat", candidatePath, error, "FONT_INPUT_STAT_ERROR"));
      return;
    }

    if (stats.isDirectory()) {
      let realDirectory;
      try {
        realDirectory = await fs.realpath(candidatePath);
      } catch (error) {
        errors.push(errorRecord("realpath", candidatePath, error, "FONT_INPUT_REALPATH_ERROR"));
        return;
      }

      if (visitedDirectories.has(realDirectory)) return;
      visitedDirectories.add(realDirectory);

      let entries;
      try {
        entries = await fs.readdir(realDirectory, { withFileTypes: true });
      } catch (error) {
        errors.push(errorRecord("readdir", candidatePath, error, "FONT_DIRECTORY_READ_ERROR"));
        return;
      }

      entries.sort((left, right) => compareText(left.name, right.name));
      for (const entry of entries) {
        await walk(path.join(realDirectory, entry.name), false);
      }
      return;
    }

    if (!stats.isFile()) {
      if (explicitInput) {
        errors.push(
          errorRecord(
            "discover",
            candidatePath,
            new Error("Font input is neither a regular file nor a directory"),
            "UNSUPPORTED_FONT_INPUT_TYPE",
          ),
        );
      }
      return;
    }

    let realFile;
    try {
      realFile = await fs.realpath(candidatePath);
    } catch (error) {
      errors.push(errorRecord("realpath", candidatePath, error, "FONT_INPUT_REALPATH_ERROR"));
      return;
    }

    if (!isSupportedFontFile(candidatePath) && !isSupportedFontFile(realFile)) {
      if (explicitInput) {
        errors.push(
          errorRecord(
            "discover",
            candidatePath,
            new Error(
              `Unsupported font extension; expected one of ${SUPPORTED_FONT_EXTENSIONS.join(", ")}`,
            ),
            "UNSUPPORTED_FONT_EXTENSION",
          ),
        );
      }
      return;
    }

    discovered.set(realFile, realFile);
  }

  for (const root of [...roots].sort(compareText)) {
    await walk(root, true);
  }

  return {
    files: [...discovered.values()].sort(compareText),
    errors: sortErrors(errors),
  };
}

function magicString(buffer: Buffer): string {
  return buffer.subarray(0, 4).toString("latin1");
}

export function detectFontContainer(buffer: Buffer, filePath = ""): string {
  const magic = magicString(buffer);
  const extension = path.extname(filePath).toLowerCase();

  if (magic === "ttcf") return extension === ".otc" ? "otc" : "ttc";
  if (magic === "wOFF") return "woff";
  if (magic === "wOF2") return "woff2";
  if (magic === "OTTO") return "otf";
  if (magic === "\u0000\u0001\u0000\u0000" || magic === "true") return "ttf";
  if (SUPPORTED_EXTENSION_SET.has(extension)) return extension.slice(1);
  return "unknown";
}

function readableName(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString();
  }
  return String(value);
}

function describeFace(font: Font, index: number, count: number): FaceDescriptor {
  return {
    index,
    count,
    postscriptName: readableName(font.postscriptName),
    fullName: readableName(font.fullName),
    familyName: readableName(font.familyName),
    subfamilyName: readableName(font.subfamilyName),
  };
}

function normalizedFaceSelector(face: unknown): string | null {
  if (face == null) return null;
  const selector = String(face).trim();
  return selector === "" ? null : selector;
}

function matchesFace(face: FaceDescriptor, selector: string | null): boolean {
  if (selector == null) return true;
  if (/^\d+$/.test(selector)) return face.index === Number(selector);

  const expected = selector.toLowerCase();
  return [face.postscriptName, face.fullName, face.familyName]
    .filter((name): name is string => name != null)
    .some((name) => name.toLowerCase() === expected);
}

interface FileDetails {
  sizeBytes: number;
  sha256: string;
  container: string;
}

function makeSource(
  font: Font,
  filePath: string,
  fileDetails: FileDetails,
  faceDetails: FaceDescriptor,
): FontSource {
  const file: FontFileInfo = {
    fileName: path.basename(filePath),
    sizeBytes: fileDetails.sizeBytes,
    sha256: fileDetails.sha256,
    container: fileDetails.container,
  };

  // The absolute path is useful while loading and reporting CLI errors, but it
  // is machine-specific and should not leak into portable metadata JSON.
  Object.defineProperty(file, "path", {
    value: filePath,
    enumerable: false,
    writable: false,
  });

  const source = { file, face: faceDetails } as FontSource;

  // Analysis needs the live fontkit object. Keeping it non-enumerable makes
  // JSON.stringify and object spread safe without a custom serializer.
  Object.defineProperty(source, "font", {
    value: font,
    enumerable: false,
    writable: false,
  });

  return source;
}

interface LoadedFile {
  sources: FontSource[];
  errors: FontErrorRecord[];
}

async function loadOneFontFile(filePath: string, faceSelector: string | null): Promise<LoadedFile> {
  const errors: FontErrorRecord[] = [];
  let buffer: Buffer;

  try {
    buffer = await fs.readFile(filePath);
  } catch (error) {
    return {
      sources: [],
      errors: [errorRecord("read", filePath, error, "FONT_FILE_READ_ERROR")],
    };
  }

  const fileDetails: FileDetails = {
    sizeBytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    container: detectFontContainer(buffer, filePath),
  };

  let opened: Font | FontCollection;
  try {
    opened = createFont(buffer);
  } catch (error) {
    return {
      sources: [],
      errors: [errorRecord("parse", filePath, error, "FONT_PARSE_ERROR")],
    };
  }

  let fonts: Font[];
  try {
    const collectionFonts = (opened as FontCollection).fonts;
    fonts = Array.isArray(collectionFonts) ? collectionFonts : [opened as Font];
  } catch (error) {
    return {
      sources: [],
      errors: [errorRecord("faces", filePath, error, "FONT_COLLECTION_ERROR")],
    };
  }

  const describedFaces: Array<{ font: Font; face: FaceDescriptor }> = [];
  for (let index = 0; index < fonts.length; index += 1) {
    try {
      describedFaces.push({
        font: fonts[index],
        face: describeFace(fonts[index], index, fonts.length),
      });
    } catch (error) {
      errors.push(
        errorRecord("face", filePath, error, "FONT_FACE_ERROR", {
          faceIndex: index,
        }),
      );
    }
  }

  const selected = describedFaces.filter(({ face }) => matchesFace(face, faceSelector));
  if (faceSelector != null && selected.length === 0) {
    errors.push(
      errorRecord(
        "select-face",
        filePath,
        new Error(`No font face matched "${faceSelector}"`),
        "FONT_FACE_NOT_FOUND",
        {
          face: faceSelector,
          availableFaces: describedFaces.map(({ face }) => ({
            index: face.index,
            postscriptName: face.postscriptName,
            fullName: face.fullName,
            familyName: face.familyName,
          })),
        },
      ),
    );
  }

  return {
    sources: selected.map(({ font, face }) => makeSource(font, filePath, fileDetails, face)),
    errors,
  };
}

/**
 * Discovers and opens all font faces from the supplied paths.
 *
 * `face` is a string selector. A decimal string selects a collection index;
 * otherwise it must exactly match a PostScript, full, or family name without
 * regard to case. When omitted, every face in TTC/OTC collections is returned.
 */
export async function loadFontSources(inputs: FontInputs, options: LoadOptions = {}): Promise<LoadResult> {
  const { face = null, cwd = process.cwd() } = options;
  const discovery = await discoverFontFiles(inputs, { cwd });
  const sources: FontSource[] = [];
  const errors: FontErrorRecord[] = [...discovery.errors];
  const selector = normalizedFaceSelector(face);

  // Deliberately process one file at a time. Besides keeping memory bounded for
  // large CJK collections, this guarantees each file is read and hashed once.
  for (const filePath of discovery.files) {
    const loaded = await loadOneFontFile(filePath, selector);
    sources.push(...loaded.sources);
    errors.push(...loaded.errors);
  }

  return {
    files: discovery.files,
    sources,
    errors: sortErrors(errors),
  };
}

// This name is convenient for callers that already think in terms of a list of
// files; directories are still accepted so the behavior remains unsurprising.
export const loadFontFiles = loadFontSources;
