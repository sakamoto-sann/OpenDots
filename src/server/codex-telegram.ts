import { randomUUID } from 'node:crypto';
import type { Platform } from './platform.js';
import { runCodexChat } from './codex-chat.js';
import type { TelegramPlatform } from './telegram-bot.js';

/** Text-only Telegram backend; other OpenDots surfaces retain their existing runtime. */
export class CodexTelegramPlatform implements TelegramPlatform {
  readonly store;
  readonly workspace;
  readonly config;
  private readonly busy = new Set<string>();
  constructor(platform: Platform) {
    this.store = platform.store;
    this.workspace = platform.workspace;
    this.config = platform.config;
  }
  async createConversation(dotId: string, title: string) {
    return this.workspace.bindThread(
      `local-chat:${randomUUID()}`,
      dotId,
      title,
    );
  }
  async turn(threadId: string, prompt: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const thread = this.workspace.requireThread(threadId);
    if (!threadId.startsWith('local-chat:'))
      throw new Error('This is not a local Telegram conversation.');
    const dot = this.workspace.dot(thread.dotId);
    if (!dot || this.store.settings().paused)
      throw new Error('OpenDots is paused or this Dot is unavailable.');
    if (this.busy.has(threadId))
      throw new Error('This conversation is busy. Retry shortly.');
    this.busy.add(threadId);
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const checkCurrent = () => {
      const current = this.workspace.dot(dot.id);
      if (
        this.store.settings().paused ||
        !current ||
        current.instructions !== dot.instructions ||
        current.name !== dot.name
      )
        controller.abort();
    };
    const watcher = setInterval(checkCurrent, 100);
    try {
      const history = this.workspace.localTelegramHistory(threadId);
      while (history.reduce((n, m) => n + m.content.length, 0) > 48_000)
        history.splice(0, 2);
      const reply = await runCodexChat(
        {
          name: dot.name,
          instructions: dot.instructions,
          messages: [
            ...history,
            { role: 'user', content: prompt.slice(0, 12000) },
          ],
        },
        combined,
        this.config.telegramCodexPath,
        this.config.telegramCodexModel,
      );
      checkCurrent();
      combined.throwIfAborted();
      this.workspace.saveLocalTelegramTurn(
        threadId,
        prompt.slice(0, 12000),
        reply,
      );
      return reply;
    } finally {
      clearInterval(watcher);
      this.busy.delete(threadId);
    }
  }
}
