import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
function registrySpec(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('.') ||
    value.length > 300
  )
    return false;
  if (value.startsWith('npm:')) {
    const alias = /^npm:((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(value);
    return !!(alias && packageName.test(alias[1]) && registrySpec(alias[2]));
  }
  return /^[0-9A-Za-z.*+_~^<>=| -]+$/.test(value);
}
function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    throw new Error('Invalid registry URL.');
  }
}
function validateManifest(manifest) {
  for (const section of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, spec] of Object.entries(manifest[section] || {})) {
      if (!packageName.test(name) || !registrySpec(spec))
        throw new Error('Non-registry dependency denied.');
    }
  }
  function overrides(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const child of Object.values(value)) overrides(child);
    } else if (
      !registrySpec(value) &&
      !(
        typeof value === 'string' &&
        value.startsWith('$') &&
        packageName.test(value.slice(1))
      )
    ) {
      throw new Error('Non-registry override denied.');
    }
  }
  if (manifest.overrides) overrides(manifest.overrides);
}

export function prepareLockfile({ configuration, manifest, file, source }) {
  const registries = configuration
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:@[^:]+:)?registry\s*=/.test(l))
    .map((l) => l.slice(l.indexOf('=') + 1).trim());
  if (!configuration.split(/\r?\n/).some((l) => /^\s*registry\s*=/.test(l)))
    throw new Error('Build requires the existing Takumi guard registry.');
  const endpoint = registries[0].replace(/\/?$/, '/');
  const registry = parseUrl(endpoint);
  const ip = registry.hostname.split('.').map(Number);
  const localGuard =
    ip.length === 4 &&
    ip.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) &&
    ip[0] === 100 &&
    ip[1] >= 64 &&
    ip[1] <= 127;
  if (
    !localGuard ||
    registry.protocol !== 'http:' ||
    registry.port !== '4873' ||
    registry.pathname !== '/' ||
    registry.username ||
    registry.password ||
    registry.search ||
    registry.hash ||
    registries.some((v) => v.replace(/\/$/, '') !== endpoint.slice(0, -1))
  )
    throw new Error(
      'Build requires the existing Tailscale Takumi guard registry reachable from BuildKit.',
    );
  validateManifest(manifest);
  function rewrite(value) {
    const u = parseUrl(value);
    if (u.username || u.password || u.search || u.hash)
      throw new Error('Unexpected lockfile source.');
    if (u.origin === endpoint.slice(0, -1)) return value;
    if (
      u.protocol !== 'https:' ||
      !['registry.npmjs.org', 'npm.flatt.tech'].includes(u.host)
    )
      throw new Error('Non-registry lockfile source denied.');
    return endpoint.slice(0, -1) + u.pathname;
  }
  if (file === 'package-lock.json') {
    const lock = JSON.parse(source);
    if (lock.lockfileVersion !== 3 || !lock.packages)
      throw new Error('Unsupported npm lockfile.');
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (!name) continue;
      if (
        entry.link ||
        !entry.resolved ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity || '')
      )
        throw new Error('Dependency lacks a registry source and integrity.');
      entry.resolved = rewrite(entry.resolved);
    }
    return JSON.stringify(lock, null, 2) + '\n';
  }
  if (file === 'bun.lock') {
    // Bun's native parser decodes JSONC/JSON5 escapes before source validation.
    const lock = globalThis.Bun?.JSON5?.parse
      ? globalThis.Bun.JSON5.parse(source)
      : JSON.parse(source);
    if (lock.lockfileVersion !== 1 || !lock.packages)
      throw new Error('Unsupported Bun lockfile.');
    for (const workspace of Object.values(lock.workspaces || {}))
      validateManifest(workspace);
    for (const entry of Object.values(lock.packages)) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 4 ||
        !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry[3] || '')
      )
        throw new Error('Bun dependency lacks registry integrity.');
      const resolved = /^((?:@[^/]+\/)?[^@]+)@(.+)$/.exec(entry[0] || '');
      if (
        !resolved ||
        !packageName.test(resolved[1]) ||
        !registrySpec(resolved[2])
      )
        throw new Error('Non-registry Bun dependency denied.');
      if (entry[1]) entry[1] = rewrite(entry[1]);
      validateManifest(entry[2]);
    }
    function decoded(value) {
      if (typeof value === 'string') {
        if (/^https?:\/\//i.test(value)) return rewrite(value);
        if (/(?:git\+|git:|github:|file:|link:|workspace:)/i.test(value))
          throw new Error('Non-registry Bun source denied.');
        return value;
      }
      if (Array.isArray(value)) return value.map(decoded);
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, decoded(v)]),
        );
      return value;
    }
    return JSON.stringify(decoded(lock), null, 2) + '\n';
  }
  throw new Error('Unsupported lockfile.');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const file = process.argv[2];
  if (!['package-lock.json', 'bun.lock'].includes(file))
    throw new Error('Unsupported lockfile.');
  const source = prepareLockfile({
    configuration: fs.readFileSync('/root/.npmrc', 'utf8'),
    manifest: JSON.parse(fs.readFileSync('package.json', 'utf8')),
    file,
    source: fs.readFileSync(file, 'utf8'),
  });
  fs.writeFileSync(file, source);
}
