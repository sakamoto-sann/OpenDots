import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { z } from 'zod';
import { codexToolGateway } from '../src/server/codex-tool-gateway.js';
const invoke = (socketPath: string, path: string, body: unknown) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const r = request({ socketPath, path, method: 'POST' }, (response) => {
      let text = '';
      response.on('data', (c) => (text += c));
      response.on('end', () => resolve(JSON.parse(text)));
    });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
it('exposes a scoped catalog, validates arguments and rechecks revocation after execution', async () => {
  const directory = await mkdtemp('/tmp/opendots-gateway-test-');
  let allowed = true,
    calls = 0;
  const gateway = await codexToolGateway(
    directory,
    [
      {
        name: 'read_fixture',
        description: 'Fixture reader',
        parameters: z.object({ id: z.string() }).strict(),
        execute: async () => {
          calls++;
          return 'safe-result';
        },
      },
    ],
    new AbortController().signal,
    () => {
      if (!allowed) throw new Error('Revoked');
    },
  );
  try {
    const list = await invoke(directory + '/tools.sock', '/list', {});
    expect(JSON.stringify(list)).toContain('read_fixture');
    const result = await invoke(directory + '/tools.sock', '/call', {
      name: 'read_fixture',
      arguments: { id: 'one' },
    });
    expect(JSON.stringify(result)).toContain('safe-result');
    expect(calls).toBe(1);
    const invalid = await invoke(directory + '/tools.sock', '/call', {
      name: 'read_fixture',
      arguments: { id: 'one', extra: 'denied' },
    });
    expect(invalid.isError).toBe(true);
    expect(calls).toBe(1);
    allowed = false;
    await invoke(directory + '/tools.sock', '/call', {
      name: 'read_fixture',
      arguments: { id: 'two' },
    });
    expect(calls).toBe(1);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true });
  }
});
it('returns screenshots as image content and sends them through the trusted delivery callback', async () => {
  const directory = await mkdtemp('/tmp/opendots-gateway-image-');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let sent = false;
  const gateway = await codexToolGateway(
    directory,
    [
      {
        name: 'computer_screenshot',
        parameters: z.object({}),
        execute: async () => ({
          base64: png.toString('base64'),
          url: 'https://example.com',
        }),
      },
    ],
    new AbortController().signal,
    () => {},
    async (image) => {
      sent = image.bytes.length === 8;
    },
  );
  try {
    const result = await invoke(directory + '/tools.sock', '/call', {
      name: 'computer_screenshot',
      arguments: {},
    });
    expect((result.content as Array<{ type: string }>)[0].type).toBe('image');
    expect(sent).toBe(true);
  } finally {
    await gateway.close();
    await rm(directory, { recursive: true });
  }
});
