import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');
const codes = ['th', 'ms', 'en'];

const catalogues = Object.fromEntries(
  codes.map((code) => [code, JSON.parse(fs.readFileSync(path.join(localesDir, `${code}.json`), 'utf8'))]),
);

function flatten(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? flatten(value, full) : [[full, value]];
  });
}

const keysByCode = Object.fromEntries(
  codes.map((code) => [code, new Map(flatten(catalogues[code]))]),
);

test('every language has exactly the same set of keys', () => {
  const reference = [...keysByCode.th.keys()].sort();

  for (const code of codes) {
    const actual = [...keysByCode[code].keys()].sort();
    const missing = reference.filter((key) => !keysByCode[code].has(key));
    const extra = actual.filter((key) => !keysByCode.th.has(key));

    assert.deepEqual(missing, [], `${code}.json is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${code}.json has keys no other language has: ${extra.join(', ')}`);
  }
});

test('no translation is blank', () => {
  for (const code of codes) {
    for (const [key, value] of keysByCode[code]) {
      assert.equal(typeof value, 'string', `${code}.json:${key} should be a string`);
      assert.notEqual(value.trim(), '', `${code}.json:${key} is empty`);
    }
  }
});

test('placeholders match across languages', () => {
  const placeholders = (value) => (value.match(/\{(\w+)\}/g) ?? []).sort().join(',');

  for (const [key, thaiValue] of keysByCode.th) {
    for (const code of ['ms', 'en']) {
      assert.equal(
        placeholders(keysByCode[code].get(key)),
        placeholders(thaiValue),
        `${code}.json:${key} does not use the same {placeholders} as Thai`,
      );
    }
  }
});

test('translations are not copied straight from another language', () => {
  // Catches the classic "forgot to translate this one" mistake. Short shared
  // tokens like "OK" are legitimately identical, so only check longer strings.
  const suspicious = [];
  for (const [key, thaiValue] of keysByCode.th) {
    if (thaiValue.length < 8) continue;
    if (keysByCode.ms.get(key) === thaiValue) suspicious.push(`ms:${key}`);
    if (keysByCode.en.get(key) === thaiValue) suspicious.push(`en:${key}`);
  }
  assert.deepEqual(suspicious, [], `untranslated strings: ${suspicious.join(', ')}`);
});

test('Thai strings actually contain Thai script', () => {
  const thaiPattern = /[\u0e00-\u0e7f]/;
  const latinOnly = [];
  for (const [key, value] of keysByCode.th) {
    if (key.startsWith('lang.')) continue;
    if (!thaiPattern.test(value)) latinOnly.push(key);
  }
  assert.deepEqual(latinOnly, [], `Thai catalogue has non-Thai values: ${latinOnly.join(', ')}`);
});
