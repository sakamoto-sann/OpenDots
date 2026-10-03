import { afterEach, expect, it, vi } from 'vitest';
import { TelegramBot } from '../src/server/telegram-bot.js';
import { Platform } from '../src/server/platform.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';

const databases: Array<{ close(): void }> = [];
const bots: TelegramBot[] = [];
afterEach(async () => {
  await Promise.all(bots.splice(0).map((bot) => bot.stop()));
  databases.splice(0).forEach((database) => database.close());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(failDelivery = false) {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  databases.push(store, workspace);
  const platform = new Platform(store, workspace, {
    baseUrl: 'https://unused.invalid',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
    telegramBotToken: 'fixture-token',
    telegramUserId: '123',
  });
  let conversationCount = 0;
  const create = vi
    .spyOn(platform, 'createConversation')
    .mockImplementation(async (dotId, title) =>
      workspace.bindThread(
        ++conversationCount === 1
          ? 'telegram-thread'
          : `telegram-thread-${conversationCount}`,
        dotId,
        title,
      ),
    );
  const turn = vi.spyOn(platform, 'turn').mockResolvedValue('Dot reply');
  const sent: Array<{
    chat_id: string;
    text: string;
    reply_parameters?: { message_id: number };
    message_thread_id?: number;
  }> = [];
  const offsets: Array<number | undefined> = [];
  let updates: object[] = [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const method = String(input).split('/').at(-1);
      const body = JSON.parse(String(init?.body));
      let result: unknown;
      if (method === 'getMe') result = { id: 321, username: 'OpenDotsBot' };
      else if (method === 'sendMessage') {
        if (failDelivery) throw new Error('fixture-secret-provider-error');
        sent.push(body);
        result = { message_id: sent.length };
      } else if (method === 'getUpdates') {
        offsets.push(body.offset);
        if (updates.length) {
          result = updates;
          updates = [];
        } else
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            );
          });
      } else throw new Error('Unexpected method.');
      return Response.json({ ok: true, result });
    },
  );
  vi.stubGlobal('fetch', fetcher);
  const start = () => {
    const bot = new TelegramBot(platform);
    bots.push(bot);
    bot.start();
    return bot;
  };
  const message = (update_id: number, id = 123, type = 'private') => ({
    update_id,
    message: { text: 'Hello', chat: { id, type }, from: { id, is_bot: false } },
  });
  return {
    workspace,
    config: platform.config,
    store,
    create,
    turn,
    sent,
    offsets,
    start,
    message,
    updates: (value: object[]) => {
      updates = value;
    },
  };
}

it('authorizes only the owner private chat and persists conversation and polling progress across restarts', async () => {
  const f = fixture();
  f.updates([
    f.message(1, 999),
    f.message(2, 123, 'group'),
    f.message(3),
    f.message(4),
  ]);
  const first = f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(5));
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.turn).toHaveBeenCalledTimes(2);
  expect(f.sent).toEqual([
    { chat_id: '123', text: 'Dot reply' },
    { chat_id: '123', text: 'Dot reply' },
  ]);
  expect(f.workspace.telegramThread('321:123')).toBe('telegram-thread');
  await first.stop();
  f.store.updateSettings({ paused: true });
  f.updates([f.message(5)]);
  f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(6));
  expect(f.offsets).toContain(5);
  expect(f.turn).toHaveBeenCalledTimes(2);
  expect(f.sent.at(-1)?.text).toContain('paused');
});

it('consumes failed deliveries without repeating agent actions or exposing provider errors', async () => {
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = fixture(true);
  f.updates([f.message(10)]);
  f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(11));
  expect(f.turn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(report.mock.calls)).not.toContain('fixture-secret');
  expect(JSON.stringify(report.mock.calls)).not.toContain('fixture-token');
});

function groupMessage(
  updateId: number,
  overrides: Record<string, unknown> = {},
) {
  const text = '🙂 @OpenDotsBot hello';
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      text,
      chat: { id: -100, type: 'supergroup' },
      from: { id: 123, is_bot: false },
      entities: [{ type: 'mention', offset: 3, length: 12 }],
      ...overrides,
    },
  };
}

it('requires both allowed group and user, and a genuine bot mention, addressed command or bot reply', async () => {
  const f = fixture();
  f.config.telegramGroupIds = ['-100'];
  f.updates([
    groupMessage(1, { chat: { id: -999, type: 'group' } }),
    groupMessage(2, { from: { id: 999, is_bot: false } }),
    groupMessage(3, { entities: [] }),
    groupMessage(4, {
      text: '@OtherBot hello',
      entities: [{ type: 'mention', offset: 0, length: 9 }],
    }),
    groupMessage(5, {
      entities: [],
      reply_to_message: { from: { id: 999, is_bot: true } },
    }),
    groupMessage(6, { from: { id: 123, is_bot: true } }),
    groupMessage(7, { sender_chat: { id: -100 } }),
    groupMessage(8, {
      entities: [],
      forward_origin: { sender_user: { id: 321, is_bot: true } },
    }),
    groupMessage(9),
    groupMessage(10, {
      text: 'Continue',
      entities: [],
      reply_to_message: { from: { id: 321, is_bot: true } },
    }),
    groupMessage(11, {
      text: '/start@OpenDotsBot',
      entities: [{ type: 'bot_command', offset: 0, length: 18 }],
    }),
    groupMessage(12, {
      text: '@OpenDotsBot',
      entities: [{ type: 'mention', offset: 0, length: 12 }],
    }),
  ]);
  f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(13));
  expect(f.turn).toHaveBeenCalledTimes(2);
  expect(f.turn.mock.calls.map((call) => call[1])).toEqual([
    '🙂  hello',
    'Continue',
  ]);
  expect(f.sent).toEqual([
    {
      chat_id: '-100',
      text: 'Dot reply',
      reply_parameters: { message_id: 109 },
    },
    {
      chat_id: '-100',
      text: 'Dot reply',
      reply_parameters: { message_id: 110 },
    },
    {
      chat_id: '-100',
      text: expect.stringContaining('ready'),
      reply_parameters: { message_id: 111 },
    },
  ]);
});

it('isolates private, group, topic and user histories, and preserves group topics across restarts', async () => {
  const f = fixture();
  f.config.telegramGroupIds = ['-100', '-200'];
  f.config.telegramGroupUserIds = ['456'];
  f.updates([
    f.message(1),
    groupMessage(2, { message_thread_id: 7 }),
    groupMessage(3, { message_thread_id: 7 }),
    groupMessage(4, { message_thread_id: 8 }),
    groupMessage(5, { chat: { id: -200, type: 'group' } }),
    groupMessage(6, { message_thread_id: 7, from: { id: 456, is_bot: false } }),
    f.message(7, 456),
  ]);
  const first = f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(8));
  expect(f.create).toHaveBeenCalledTimes(5);
  expect(f.turn).toHaveBeenCalledTimes(6);
  const privateThread = f.workspace.telegramThread('321:123');
  const groupThread = f.workspace.telegramThread('321:-100:7:123');
  expect(groupThread).toBeDefined();
  expect(
    new Set([
      privateThread,
      groupThread,
      f.workspace.telegramThread('321:-100:8:123'),
      f.workspace.telegramThread('321:-200:0:123'),
      f.workspace.telegramThread('321:-100:7:456'),
    ]).size,
  ).toBe(5);
  expect(f.sent[1]).toEqual({
    chat_id: '-100',
    text: 'Dot reply',
    reply_parameters: { message_id: 102 },
    message_thread_id: 7,
  });
  await first.stop();
  f.updates([groupMessage(8, { message_thread_id: 7 })]);
  f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(9));
  expect(f.create).toHaveBeenCalledTimes(5);
  expect(f.turn.mock.calls.at(-1)?.[0]).toBe(groupThread);
});

it('respects pause in addressed group messages without starting a conversation', async () => {
  const f = fixture();
  f.config.telegramGroupIds = ['-100'];
  f.store.updateSettings({ paused: true });
  f.updates([groupMessage(1, { message_thread_id: 7 })]);
  f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(2));
  expect(f.create).not.toHaveBeenCalled();
  expect(f.turn).not.toHaveBeenCalled();
  expect(f.sent[0]).toEqual({
    chat_id: '-100',
    text: expect.stringContaining('paused'),
    reply_parameters: { message_id: 101 },
    message_thread_id: 7,
  });
});

it('keeps OAuth conversation bindings separate from Intelligence bindings', async () => {
  const f = fixture();
  const cloud = f.workspace.bindThread(
    'existing-cloud',
    f.workspace.dots()[0].id,
    'Cloud',
  );
  f.workspace.bindTelegramThread('321:123', cloud.id, cloud.dotId);
  f.config.telegramBackend = 'codex';
  f.updates([f.message(1)]);
  f.start();
  await vi.waitFor(() => expect(f.workspace.telegramOffset('321')).toBe(2));
  expect(f.workspace.telegramThread('321:123')).toBe('existing-cloud');
  expect(f.workspace.telegramThread('codex:321:123')).toBe('telegram-thread');
  expect(f.turn).toHaveBeenCalledWith(
    'telegram-thread',
    'Hello',
    expect.any(AbortSignal),
    { opendotsSource: 'telegram' },
  );
});
