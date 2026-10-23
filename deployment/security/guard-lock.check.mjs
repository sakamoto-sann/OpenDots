import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
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
    'registry=http://100.128.0.1:4873/',
    'registry=http://100.64.0.1:1234/',
    '@fixture:registry=http://100.64.0.1:4873/',
    'registry=https://registry.npmjs.org/',
    'registry=https://npm.flatt.tech/',
  ])
    assert.throws(
      () => prepareLockfile({ ...options, configuration }),
      /guard registry/,
    );
});
test('denies dependency protocols in both manifest and nested overrides', () => {
  for (const manifest of [
    { dependencies: { fixture: 'https://invalid.example/a.tgz' } },
    { dependencies: { fixture: '.' } },
    { overrides: { fixture: { child: 'github:owner/repo' } } },
  ])
    assert.throws(
      () => prepareLockfile({ ...options, manifest }),
      /Non-registry/,
    );
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
    assert.throws(
      () => prepareLockfile({ ...options, source }),
      (error) =>
        /source|registry|integrity/.test(error.message) &&
        !error.message.includes('fixture-value'),
    );
  }
});
test('requires archive integrity', () => {
  const source = JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/fixture': { resolved: entry.resolved } },
  });
  assert.throws(
    () => prepareLockfile({ ...options, source }),
    (error) =>
      /source|registry|integrity/.test(error.message) &&
      !error.message.includes('fixture-value'),
  );
});
test('validates decoded Bun tuples, archive routing and integrity', () => {
  const lock = {
    lockfileVersion: 1,
    packages: {
      fixture: [
        'fixture@1.0.0',
        'HTTPS://registry.npmjs.org/fixture/-/fixture-1.0.0.tgz',
        {},
        'sha512-YWJj',
      ],
    },
  };
  const result = JSON.parse(
    prepareLockfile({
      ...options,
      file: 'bun.lock',
      source: JSON.stringify(lock),
    }),
  );
  assert.deepEqual(result.packages.fixture, [
    'fixture@1.0.0',
    'http://100.64.0.1:4873/fixture/-/fixture-1.0.0.tgz',
    {},
    'sha512-YWJj',
  ]);
  for (const tuple of [
    ['fixture@1.0.0', '', {}],
    ['fixture@git+https://invalid.example/repo', '', {}, 'sha512-YWJj'],
    ['fixture@1.0.0', 'HTTPS://invalid.example/a.tgz', {}, 'sha512-YWJj'],
    ['fixture@1.0.0', '', { dependencies: { child: '.' } }, 'sha512-YWJj'],
  ])
    assert.throws(
      () =>
        prepareLockfile({
          ...options,
          file: 'bun.lock',
          source: JSON.stringify({
            lockfileVersion: 1,
            packages: { fixture: tuple },
          }),
        }),
      /registry|source|integrity/,
    );
  const escaped = JSON.stringify({
    ...lock,
    packages: {
      fixture: [
        'fixture@1.0.0',
        'https://invalid.example/a.tgz',
        {},
        'sha512-YWJj',
      ],
    },
  }).replaceAll('/', String.raw`\/`);
  assert.throws(
    () => prepareLockfile({ ...options, file: 'bun.lock', source: escaped }),
    /registry|source/,
  );
});
test('rejects legacy npm trees and rewrites Takumi archive URLs', () => {
  assert.throws(
    () =>
      prepareLockfile({
        ...options,
        source: source.replace('"lockfileVersion":3', '"lockfileVersion":2'),
      }),
    /Unsupported/,
  );
  const result = JSON.parse(
    prepareLockfile({
      ...options,
      source: source.replace('registry.npmjs.org', 'npm.flatt.tech'),
    }),
  );
  assert.equal(
    result.packages['node_modules/fixture'].resolved,
    'http://100.64.0.1:4873/fixture/-/fixture-1.0.0.tgz',
  );
});

test('public CA snapshot excludes every explicitly distrusted root', () => {
  const expected = [
    '7dd78d5f4f13459a83dff9abbba62edbaf6f2d102bf257fd712f4d9f2746ed8d',
    '86a1ecba089c4a8d3bbe2734c612ba341d813e043cf9e8a862cd5c57a36bbe6b',
    'd7a7a0fb5d7e2731d771e9484ebcdef71d5f0c3e0a2948782bc83ee0ea699ef4',
    'f2edaaff3d9b701fb4d14c9f285f8c0bad90fc3bcc1fa07d47f4718edaba34a5',
  ];
  const fingerprint = (pem) =>
    new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
  const roots = fs
    .readFileSync(new URL('./ca.pem', import.meta.url), 'utf8')
    .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  assert.ok(roots.length > 100);
  const hashes = new Set(roots.map(fingerprint));
  for (const hash of expected) {
    assert.equal(hashes.has(hash), false);
    assert.equal(
      fingerprint(
        fs.readFileSync(
          new URL('./distrust/' + hash + '.pem', import.meta.url),
        ),
      ),
      hash,
    );
  }
});
