import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLockfile } from './guard-lock.mjs';
const configuration = 'registry=http://100.64.0.1:4873/\nignore-scripts=true\n';
const manifest = { dependencies: { fixture: '1.0.0' } };
const entry = {
  version: '1.0.0',
  resolved: 'https://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
  integrity: 'sha512-YWJj',
};
const source = JSON.stringify({
  lockfileVersion: 3,
  packages: { '': {}, 'node_modules/fixture': entry },
});
const options = { configuration, manifest, file: 'package-lock.json', source };
test('routes a pinned archive through the guard without changing version or integrity', () => {
  const result = JSON.parse(prepareLockfile(options)).packages[
    'node_modules/fixture'
  ];
  assert.deepEqual(result, {
    ...entry,
    resolved: 'http://100.64.0.1:4873/fixture/-/fixture-1.0.0.tgz',
  });
});
test('fails closed without a guard or when a public registry is supplied', () => {
  for (const configuration of [
    '',
    'registry=http://127.0.0.1:4873/',
    '@fixture:registry=http://100.64.0.1:4873/',
    'registry=https://registry.npmjs.org/',
    'registry=https://npm.flatt.tech/',
  ])
    assert.throws(() => prepareLockfile({ ...options, configuration }));
});
test('denies dependency protocols in both manifest and nested overrides', () => {
  for (const manifest of [
    { dependencies: { fixture: 'https://invalid.example/a.tgz' } },
    { overrides: { fixture: { child: 'github:owner/repo' } } },
  ])
    assert.throws(() => prepareLockfile({ ...options, manifest }));
});
test('denies credentials and third-party archives without exposing their values', () => {
  for (const resolved of [
    'https://invalid.example/a.tgz',
    'https://fixture-user:fixture-value@registry.npmjs.org/a.tgz',
  ]) {
    const source = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/fixture': { ...entry, resolved } },
    });
    assert.throws(() => prepareLockfile({ ...options, source }));
  }
});
test('requires archive integrity', () => {
  const source = JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/fixture': { resolved: entry.resolved } },
  });
  assert.throws(() => prepareLockfile({ ...options, source }));
});
test('keeps Bun version and integrity entries intact and denies Git sources', () => {
  const source =
    '{"packages":{"fixture":["fixture@1.0.0","",{},"sha512-YWJj"]}}';
  assert.equal(
    prepareLockfile({ ...options, file: 'bun.lock', source }),
    source,
  );
  assert.throws(() =>
    prepareLockfile({
      ...options,
      file: 'bun.lock',
      source: '{"fixture":"git+https://invalid.example/repo"}',
    }),
  );
});
