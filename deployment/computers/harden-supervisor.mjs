import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Fail closed if the pinned upstream contract changes. Only child authentication
// and the Node computer health probe change; ownership and volumes stay upstream.
export function hardenSupervisorEnvironment(source) {
  const before =
    'const computerToken = env.COMPUTER_TOKEN?.trim() || undefined;';
  if (source.split(before).length !== 2)
    throw new Error(
      'Pinned OpenBot environment contract changed; review before building.',
    );
  return `import { createHmac } from "node:crypto";\n${source.replace(
    before,
    `const master = env.COMPUTER_TOKEN?.trim();
  if (!master || master.length < 24) throw new Error("COMPUTER_TOKEN must contain at least 24 characters.");
  const computerToken = createHmac("sha256", master).update("opendots-computer:" + botId).digest("hex");`,
  )}`;
}
export function hardenSupervisorHealth(source) {
  const before = '`bun -e "const r = await fetch(';
  if (
    source.split(before).length !== 2 ||
    !source.includes('const COMPUTER_HEALTHCHECK =')
  )
    throw new Error(
      'Pinned OpenBot health contract changed; review before building.',
    );
  return source.replace(before, '`node -e "const r = await fetch(');
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const path = process.argv[2];
  if (!path) throw new Error('Pass the pinned supervisor environment.ts path.');
  await writeFile(
    path,
    hardenSupervisorEnvironment(await readFile(path, 'utf8')),
  );
  const healthPath = process.argv[3];
  if (healthPath)
    await writeFile(
      healthPath,
      hardenSupervisorHealth(await readFile(healthPath, 'utf8')),
    );
}
