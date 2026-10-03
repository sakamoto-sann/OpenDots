import { safeFailure } from './slack-channel.js';
import type { Platform } from './platform.js';

type Update = {
  update_id: number;
  message?: {
    text?: string;
    message_id?: number;
    message_thread_id?: number;
    sender_chat?: { id?: number };
    entities?: Array<{
      type: string;
      offset: number;
      length: number;
      user?: { id: number };
    }>;
    reply_to_message?: { from?: { id?: number; is_bot?: boolean } };
    chat?: { id?: number; type?: string };
    from?: { id?: number; is_bot?: boolean };
  };
};

export type TelegramPlatform = Pick<
  Platform,
  'store' | 'workspace' | 'config' | 'createConversation' | 'turn'
>;

/** An allowlisted Telegram private/group-chat bridge using Bot API long polling. */
export class TelegramBot {
  private controller?: AbortController;
  private running?: Promise<void>;
  constructor(private readonly platform: TelegramPlatform) {}

  start() {
    const {
      telegramBotToken: token,
      telegramUserId: userId,
      telegramDotId,
    } = this.platform.config;
    if (!token && !userId) return;
    if (!token || !userId || !/^\d+$/.test(userId)) {
      console.error(
        'Telegram setup requires TELEGRAM_BOT_TOKEN and a numeric TELEGRAM_USER_ID.',
      );
      return;
    }
    if (
      this.platform.config.telegramGroupIds?.some(
        (id) => !/^-[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)),
      ) ||
      this.platform.config.telegramGroupUserIds?.some(
        (id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)),
      )
    ) {
      console.error(
        'Telegram group configuration requires numeric chat and user IDs.',
      );
      return;
    }
    const dotId = telegramDotId ?? this.platform.workspace.dots()[0]?.id;
    if (!dotId || !this.platform.workspace.dot(dotId)) {
      console.error('TELEGRAM_DOT_ID does not identify an existing Dot.');
      return;
    }
    if (this.running) return;
    this.controller = new AbortController();
    this.running = this.poll(
      token,
      userId,
      dotId,
      this.controller.signal,
    ).finally(() => {
      this.running = undefined;
      this.controller = undefined;
    });
  }

  async stop() {
    this.controller?.abort();
    await this.running;
  }

  private async poll(
    token: string,
    userId: string,
    dotId: string,
    signal: AbortSignal,
  ) {
    let botId: string | undefined;
    let offset: number | undefined;
    let username: string | undefined;
    while (!signal.aborted) {
      try {
        if (!botId) {
          const bot = await this.api<{ id: number; username?: string }>(
            token,
            'getMe',
            {},
            signal,
          );
          if (!Number.isSafeInteger(bot.id))
            throw new Error('Telegram bot ID is invalid.');
          botId = String(bot.id);
          username = bot.username;
          offset = this.platform.workspace.telegramOffset(botId);
        }
        const updates = await this.api<Update[]>(
          token,
          'getUpdates',
          { offset, timeout: 25, allowed_updates: ['message'] },
          signal,
        );
        for (const update of updates) {
          if (signal.aborted) break;
          if (!Number.isSafeInteger(update.update_id)) continue;
          try {
            await this.handle(
              update,
              token,
              userId,
              dotId,
              botId,
              username,
              signal,
            );
          } catch (error) {
            if (signal.aborted) break;
            // A delivery failure must not re-run a Dot turn with possible side effects.
            console.error(`Telegram update failed: ${safeFailure(error)}`);
          }
          offset = update.update_id + 1;
          this.platform.workspace.setTelegramOffset(botId, offset);
        }
      } catch (error) {
        if (signal.aborted) break;
        console.error(`Telegram polling failed: ${safeFailure(error)}`);
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          const timeout = setTimeout(finish, 2000);
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    }
  }

  private async handle(
    update: Update,
    token: string,
    userId: string,
    dotId: string,
    botId: string,
    username: string | undefined,
    signal: AbortSignal,
  ) {
    const message = update.message;
    if (
      !message?.text?.trim() ||
      message.from?.is_bot ||
      message.sender_chat ||
      !Number.isSafeInteger(message.from?.id) ||
      !Number.isSafeInteger(message.chat?.id)
    )
      return;
    const chatId = String(message.chat?.id);
    const senderId = String(message.from?.id);
    const group =
      message.chat?.type === 'group' || message.chat?.type === 'supergroup';
    let text = message.text;
    let topicId: number | undefined;
    if (group) {
      const users = [
        userId,
        ...(this.platform.config.telegramGroupUserIds ?? []),
      ];
      if (
        !this.platform.config.telegramGroupIds?.includes(chatId) ||
        !users.includes(senderId) ||
        !Number.isSafeInteger(message.message_id) ||
        message.message_id! <= 0
      )
        return;
      if (message.message_thread_id !== undefined) {
        if (
          !Number.isSafeInteger(message.message_thread_id) ||
          message.message_thread_id <= 0
        )
          return;
        topicId = message.message_thread_id;
      }
      const addressed = addressedText(message, botId, username);
      if (addressed === undefined) return;
      text = addressed;
    } else if (
      message.chat?.type !== 'private' ||
      chatId !== userId ||
      senderId !== userId
    )
      return;
    if (!text.trim()) return;
    const prefix =
      this.platform.config.telegramBackend === 'codex' ? 'codex:' : '';
    const conversationKey =
      prefix +
      (group
        ? `${botId}:${chatId}:${topicId ?? 0}:${senderId}`
        : `${botId}:${chatId}`);
    const send = (reply: string) =>
      this.send(
        token,
        chatId,
        reply,
        signal,
        group ? message.message_id : undefined,
        topicId,
      );
    if (text.trim() === '/start') {
      await send('OpenDots is ready. Send a message to talk with your Dot.');
      return;
    }
    if (this.platform.store.settings().paused) {
      await send('OpenDots is paused. Resume it in the app to continue.');
      return;
    }
    let reply: string;
    try {
      let threadId = this.platform.workspace.telegramThread(conversationKey);
      if (threadId) this.platform.workspace.requireThread(threadId, dotId);
      else {
        const thread = await this.platform.createConversation(
          dotId,
          'Telegram conversation',
        );
        this.platform.workspace.bindTelegramThread(
          conversationKey,
          thread.id,
          dotId,
        );
        threadId = thread.id;
      }
      reply = await this.platform.turn(threadId, text.slice(0, 12000), signal, {
        opendotsSource: 'telegram',
      });
    } catch (error) {
      if (signal.aborted) throw error;
      console.error(`Telegram turn failed: ${safeFailure(error)}`);
      reply =
        'I couldn’t complete that request. Please check OpenDots and try again.';
    }
    await send(reply);
  }

  private async send(
    token: string,
    chatId: string,
    text: string,
    signal: AbortSignal,
    replyTo?: number,
    topicId?: number,
  ) {
    const characters = Array.from(text);
    for (let i = 0; i < characters.length; i += 3500) {
      await this.api(
        token,
        'sendMessage',
        {
          chat_id: chatId,
          ...(replyTo === undefined
            ? {}
            : { reply_parameters: { message_id: replyTo } }),
          ...(topicId === undefined ? {} : { message_thread_id: topicId }),
          text: characters.slice(i, i + 3500).join(''),
        },
        signal,
      );
    }
  }

  private async api<T>(
    token: string,
    method: string,
    body: object,
    signal: AbortSignal,
  ): Promise<T> {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok)
      throw new Error(`Telegram API returned HTTP ${response.status}.`);
    const result = (await response.json()) as { ok?: boolean; result?: T };
    if (!result.ok || result.result === undefined)
      throw new Error('Telegram API rejected the request.');
    return result.result;
  }
}

/** Telegram entity offsets use UTF-16 units, matching JavaScript string slicing. */
function addressedText(
  message: NonNullable<Update['message']>,
  botId: string,
  username?: string,
) {
  const text = message.text ?? '';
  const ownEntities = (message.entities ?? []).filter((entity) => {
    if (
      !Number.isInteger(entity.offset) ||
      !Number.isInteger(entity.length) ||
      entity.offset < 0 ||
      entity.length <= 0 ||
      entity.offset + entity.length > text.length
    )
      return false;
    const value = text
      .slice(entity.offset, entity.offset + entity.length)
      .toLowerCase();
    return (
      (entity.type === 'mention' &&
        !!username &&
        value === `@${username.toLowerCase()}`) ||
      (entity.type === 'text_mention' && String(entity.user?.id) === botId) ||
      (entity.type === 'bot_command' &&
        !!username &&
        value === `/start@${username.toLowerCase()}`)
    );
  });
  const replying =
    message.reply_to_message?.from?.is_bot === true &&
    String(message.reply_to_message.from.id) === botId;
  if (!ownEntities.length && !replying) return undefined;
  let prompt = text;
  for (const entity of ownEntities.sort((a, b) => b.offset - a.offset)) {
    const replacement = entity.type === 'bot_command' ? '/start' : '';
    prompt =
      prompt.slice(0, entity.offset) +
      replacement +
      prompt.slice(entity.offset + entity.length);
  }
  return prompt.trim();
}
