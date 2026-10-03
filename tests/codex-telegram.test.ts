import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexChat } from '../src/server/codex-chat.js';
import { CodexTelegramPlatform } from '../src/server/codex-telegram.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { telegramBackend } from '../src/server/platform-config.js';

let directory: string, executable: string;
const databases: Array<{ close(): void }> = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'opendots-codex-test-'));
  executable = join(directory, 'codex-fixture');
  writeFileSync(
    executable,
    `#!/usr/bin/env node
let data = '';
process.stdin.on('data', chunk => data += chunk);
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  if (!args.includes('--ignore-user-config') || !args.includes('--ephemeral') || !args.includes('shell_tool') || !args.includes('read-only') || process.env.TELEGRAM_BOT_TOKEN || process.env.BW_SESSION || process.env.OPENAI_API_KEY) process.exit(2);
  const input = JSON.parse(data), last = input.messages.at(-1).content;
  if (last === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 100); return; }
  if (last === 'fail') { console.log(JSON.stringify({ type: 'error', message: 'fixture-private-provider-detail' })); return; }
  if (last === 'tool') { console.log(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'forbidden' } })); return; }
  const text = '日本語:' + JSON.stringify(input.messages);
  const line = Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) + String.fromCharCode(10));
  const split = line.indexOf(Buffer.from('日')) + 1;
  process.stdout.write(line.subarray(0, split));
  setTimeout(() => {
    process.stdout.write(line.subarray(split));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  }, 10);
});
`,
    { mode: 0o700 },
  );
});
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function backend(path = ':memory:') {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(path, 'owner');
  databases.push(store, workspace);
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://unused.invalid',
    voiceName: 'marin',
    slackUsers: [],
    runtimeUrl: '',
    telegramBackend: 'codex',
    telegramCodexPath: executable,
  });
  return { runtime: new CodexTelegramPlatform(platform), workspace, store };
}

it('selects only an explicit supported backend', () => {
  expect(telegramBackend()).toBe('intelligence');
  expect(telegramBackend('codex')).toBe('codex');
  expect(() => telegramBackend('typo')).toThrow('TELEGRAM_BACKEND');
});
it('uses constrained ephemeral CLI settings, excludes credentials and decodes split Unicode', async () => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-only');
  vi.stubEnv('BW_SESSION', 'test-only');
  vi.stubEnv('OPENAI_API_KEY', 'test-only');
  const reply = await runCodexChat(
    {
      name: 'Dot',
      instructions: 'Be concise.',
      messages: [{ role: 'user', content: 'こんにちは' }],
    },
    new AbortController().signal,
    executable,
  );
  expect(reply).toContain('日本語:');
  expect(reply).toContain('こんにちは');
});
it('fails closed on tool activity and does not leak CLI provider details', async () => {
  for (const prompt of ['tool', 'fail']) {
    await expect(
      runCodexChat(
        {
          name: 'Dot',
          instructions: '',
          messages: [{ role: 'user', content: prompt }],
        },
        new AbortController().signal,
        executable,
      ),
    ).rejects.toThrow(
      prompt === 'tool' ? 'Unexpected tool activity' : 'Check login',
    );
  }
});
it('persists local history across reopening without Intelligence and isolates other conversations', async () => {
  const path = join(directory, 'history.sqlite');
  const f = backend(path),
    dot = f.workspace.dots()[0];
  const thread = await f.runtime.createConversation(dot.id, 'OAuth chat');
  await f.runtime.turn(
    thread.id,
    'Remember orange.',
    new AbortController().signal,
  );
  const second = await f.runtime.createConversation(dot.id, 'Other chat');
  const separate = await f.runtime.turn(
    second.id,
    'Hello',
    new AbortController().signal,
  );
  expect(separate).not.toContain('Remember orange');
  f.workspace.close();
  databases.splice(databases.indexOf(f.workspace), 1);
  const reopened = backend(path);
  const reply = await reopened.runtime.turn(
    thread.id,
    'What did I say?',
    new AbortController().signal,
  );
  expect(reply).toContain('Remember orange');
  expect(reopened.workspace.localTelegramHistory(thread.id)).toHaveLength(4);
  expect(() => reopened.workspace.localTelegramHistory('unknown')).toThrow(
    'owner',
  );
});
it('blocks overlapping turns, aborts a resistant process and saves no failed history', async () => {
  const f = backend(),
    thread = await f.runtime.createConversation(
      f.workspace.dots()[0].id,
      'Abort',
    );
  const controller = new AbortController();
  const first = f.runtime.turn(thread.id, 'hang', controller.signal);
  await expect(
    f.runtime.turn(thread.id, 'Other', new AbortController().signal),
  ).rejects.toThrow('busy');
  setTimeout(() => controller.abort(), 150);
  await expect(first).rejects.toThrow('cancelled');
  expect(f.workspace.localTelegramHistory(thread.id)).toEqual([]);
  await expect(
    f.runtime.turn(thread.id, 'fail', new AbortController().signal),
  ).rejects.toThrow('Check login');
  expect(f.workspace.localTelegramHistory(thread.id)).toEqual([]);
  f.store.updateSettings({ paused: true });
  await expect(
    f.runtime.turn(thread.id, 'Hello', new AbortController().signal),
  ).rejects.toThrow('paused');
});

it('cancels an in-flight turn when OpenDots is paused', async () => {
  const f = backend(),
    thread = await f.runtime.createConversation(
      f.workspace.dots()[0].id,
      'Pause',
    );
  const pending = f.runtime.turn(
    thread.id,
    'hang',
    new AbortController().signal,
  );
  setTimeout(() => f.store.updateSettings({ paused: true }), 150);
  await expect(pending).rejects.toThrow('cancelled');
  expect(f.workspace.localTelegramHistory(thread.id)).toEqual([]);
});

it('keeps background task runs out of the user conversation history', async () => {
  const f = backend(),
    thread = await f.runtime.createConversation(
      f.workspace.dots()[0].id,
      'Background',
    );
  await f.runtime.turn(
    thread.id,
    'Scheduled fixture',
    new AbortController().signal,
    { background: true },
  );
  expect(f.workspace.localTelegramHistory(thread.id)).toEqual([]);
});

it('rejects scheduled runs after the Dot research grant is revoked', async () => {
  const f = backend(),
    dot = f.workspace.dots()[0],
    thread = await f.runtime.createConversation(dot.id, 'Revoked task');
  f.workspace.updateDot(dot.id, { ...dot, researchAllowed: false });
  await expect(
    f.runtime.turn(
      thread.id,
      'Scheduled fixture',
      new AbortController().signal,
      { background: true },
    ),
  ).rejects.toThrow('Research disabled');
  expect(f.workspace.localTelegramHistory(thread.id)).toEqual([]);
});
