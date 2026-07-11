import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SUPPORTED_FONT_EXTENSIONS,
  detectFontContainer,
  discoverFontFiles,
  isSupportedFontFile,
  loadFontSources,
} from '../src/font-source.mjs';

const STANDALONE_FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/Library/Fonts/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
];

const NOTO_TTC_CANDIDATES = [
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
  '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
];

async function firstExistingFile(candidates) {
  for (const candidate of candidates) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch {
      // Try the next platform-specific candidate.
    }
  }
  return null;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hwpkit-font-source-'));
  t.after(async () => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const standaloneFont = await firstExistingFile(STANDALONE_FONT_CANDIDATES);
const notoTtc = await firstExistingFile(NOTO_TTC_CANDIDATES);

test('recognizes every supported font extension case-insensitively', () => {
  assert.deepEqual(SUPPORTED_FONT_EXTENSIONS, [
    '.otc',
    '.otf',
    '.ttc',
    '.ttf',
    '.woff',
    '.woff2',
  ]);

  for (const extension of SUPPORTED_FONT_EXTENSIONS) {
    assert.equal(isSupportedFontFile(`font${extension}`), true);
    assert.equal(isSupportedFontFile(`font${extension.toUpperCase()}`), true);
  }
  assert.equal(isSupportedFontFile('font.txt'), false);
  assert.equal(isSupportedFontFile(null), false);
});

test('discovers directories recursively with deterministic sorting and de-duplication', async (t) => {
  const directory = await temporaryDirectory(t);
  const nested = path.join(directory, 'nested');
  await fs.mkdir(nested);

  const first = path.join(nested, 'a.ttf');
  const second = path.join(directory, 'B.otf');
  const third = path.join(directory, 'Z.WOFF2');
  await Promise.all([
    fs.writeFile(first, 'first'),
    fs.writeFile(second, 'second'),
    fs.writeFile(third, 'third'),
    fs.writeFile(path.join(nested, 'ignored.txt'), 'ignored'),
  ]);

  // A supported-extension symlink to an already discovered file must not add
  // another result.
  await fs.symlink(first, path.join(directory, 'alias.ttf'));

  const result = await discoverFontFiles([directory, first, directory]);
  const expected = await Promise.all([first, second, third].map((file) => fs.realpath(file)));
  expected.sort();

  assert.deepEqual(result.files, expected);
  assert.deepEqual(result.errors, []);
});

test('collects independent discovery errors and ignores unrelated directory files', async (t) => {
  const directory = await temporaryDirectory(t);
  const unsupported = path.join(directory, 'notes.txt');
  const missing = path.join(directory, 'missing.ttf');
  await fs.writeFile(unsupported, 'not a font');

  const result = await discoverFontFiles([missing, unsupported, 42, directory]);

  assert.deepEqual(result.files, []);
  assert.equal(result.errors.length, 3);
  assert.deepEqual(
    new Set(result.errors.map((error) => error.code)),
    new Set(['ENOENT', 'UNSUPPORTED_FONT_EXTENSION', 'INVALID_FONT_INPUT']),
  );
  assert.ok(result.errors.every((error) => typeof error.message === 'string'));
});

test('detects containers by their signatures with an extension fallback', () => {
  assert.equal(detectFontContainer(Buffer.from('ttcf'), 'collection.ttc'), 'ttc');
  assert.equal(detectFontContainer(Buffer.from('ttcf'), 'collection.otc'), 'otc');
  assert.equal(detectFontContainer(Buffer.from('wOFF'), 'font.bin'), 'woff');
  assert.equal(detectFontContainer(Buffer.from('wOF2'), 'font.bin'), 'woff2');
  assert.equal(detectFontContainer(Buffer.from('OTTO'), 'font.bin'), 'otf');
  assert.equal(detectFontContainer(Buffer.from([0, 1, 0, 0]), 'font.bin'), 'ttf');
  assert.equal(detectFontContainer(Buffer.from('bad!'), 'font.TTF'), 'ttf');
});

test(
  'loads a standalone font with portable file metadata and a non-JSON font object',
  { skip: standaloneFont == null ? 'No standalone system font is installed' : false },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const fixture = path.join(directory, 'Fixture.TTF');
    await fs.copyFile(standaloneFont, fixture);

    const bytes = await fs.readFile(fixture);
    const result = await loadFontSources([fixture, fixture]);

    assert.deepEqual(result.errors, []);
    assert.equal(result.files.length, 1);
    assert.equal(result.sources.length, 1);

    const [source] = result.sources;
    assert.equal(source.file.path, await fs.realpath(fixture));
    assert.equal(source.file.fileName, 'Fixture.TTF');
    assert.equal(source.file.sizeBytes, bytes.byteLength);
    assert.equal(
      source.file.sha256,
      createHash('sha256').update(bytes).digest('hex'),
    );
    assert.equal(source.file.container, 'ttf');
    assert.equal(source.face.index, 0);
    assert.equal(source.face.count, 1);
    assert.equal(typeof source.font.layout, 'function');

    const json = JSON.parse(JSON.stringify(source));
    assert.equal(Object.hasOwn(json, 'font'), false);
    assert.equal(Object.hasOwn(json.file, 'path'), false);
    assert.equal(json.file.sha256, source.file.sha256);
  },
);

test(
  'supports case-insensitive name and numeric-string face selectors',
  { skip: standaloneFont == null ? 'No standalone system font is installed' : false },
  async (t) => {
    const directory = await temporaryDirectory(t);
    const fixture = path.join(directory, 'font.ttf');
    await fs.copyFile(standaloneFont, fixture);

    const initial = await loadFontSources(fixture);
    const familySelector = initial.sources[0].face.familyName.toUpperCase();

    const byName = await loadFontSources(fixture, { face: familySelector });
    assert.equal(byName.sources.length, 1);
    assert.deepEqual(byName.errors, []);

    const byIndex = await loadFontSources(fixture, { face: '0' });
    assert.equal(byIndex.sources.length, 1);
    assert.deepEqual(byIndex.errors, []);

    const missing = await loadFontSources(fixture, { face: 'not-a-real-face' });
    assert.deepEqual(missing.sources, []);
    assert.equal(missing.errors.length, 1);
    assert.equal(missing.errors[0].code, 'FONT_FACE_NOT_FOUND');
    assert.equal(missing.errors[0].stage, 'select-face');
  },
);

test(
  'keeps loading valid files when another font file is corrupt',
  { skip: standaloneFont == null ? 'No standalone system font is installed' : false },
  async (t) => {
    const directory = await temporaryDirectory(t);
    await Promise.all([
      fs.copyFile(standaloneFont, path.join(directory, 'good.ttf')),
      fs.writeFile(path.join(directory, 'bad.otf'), 'not an OpenType font'),
    ]);

    const result = await loadFontSources(directory);

    assert.equal(result.files.length, 2);
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].file.fileName, 'good.ttf');
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].path, path.join(directory, 'bad.otf'));
    assert.equal(result.errors[0].stage, 'parse');
    assert.equal(result.errors[0].code, 'FONT_PARSE_ERROR');
  },
);

test(
  'loads every Noto TTC face and can select the Korean face by name',
  { skip: notoTtc == null ? 'No Noto CJK TTC is installed' : false },
  async () => {
    const all = await loadFontSources(notoTtc);
    assert.deepEqual(all.errors, []);
    assert.ok(all.sources.length > 1);
    assert.deepEqual(
      all.sources.map((source) => source.face.index),
      all.sources.map((_, index) => index),
    );
    assert.ok(all.sources.every((source) => source.face.count === all.sources.length));
    assert.equal(new Set(all.sources.map((source) => source.file.sha256)).size, 1);

    const korean = all.sources.find((source) => /\bKR\b/i.test(source.face.familyName ?? ''));
    assert.ok(korean, 'the collection should contain a Korean face');
    assert.ok(korean.face.postscriptName);

    const selected = await loadFontSources(notoTtc, {
      face: korean.face.postscriptName.toLowerCase(),
    });
    assert.deepEqual(selected.errors, []);
    assert.equal(selected.sources.length, 1);
    assert.equal(selected.sources[0].face.index, korean.face.index);
    assert.match(selected.sources[0].face.familyName, /\bKR\b/i);
  },
);
