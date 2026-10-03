import { telegramImage, telegramUpload } from './telegram-media.js';
import { pageReviewSchema } from '../shared/page-review.js';
import type { ChatImage } from './codex-tool-gateway.js';
import { safeFailure } from './slack-channel.js';
import type { Platform } from './platform.js';

type Update = {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    from?: { id?: number; is_bot?: boolean };
    message?: {
      message_id?: number;
      message_thread_id?: number;
      chat?: { id?: number; type?: string };
    };
  };
  message?: {
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_size?: number }>;
    document?: { file_id: string; mime_type?: string; file_size?: number };
    caption_entities?: Array<{
      type: string;
      offset: number;
      length: number;
      user?: { id: number };
    }>;
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
> &
  Partial<Pick<Platform, 'computers'>>;

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
          {
            offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
          },
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
    if (update.callback_query) {
      const callback = update.callback_query,
        message = callback.message;
      const chatId = String(message?.chat?.id),
        senderId = String(callback.from?.id),
        topic = message?.message_thread_id;
      const group = ['group', 'supergroup'].includes(message?.chat?.type ?? '');
      if (
        callback.from?.is_bot ||
        !Number.isSafeInteger(callback.from?.id) ||
        !Number.isSafeInteger(message?.chat?.id) ||
        (group
          ? !this.platform.config.telegramGroupIds?.includes(chatId) ||
            ![
              userId,
              ...(this.platform.config.telegramGroupUserIds ?? []),
            ].includes(senderId)
          : message?.chat?.type !== 'private' ||
            chatId !== userId ||
            senderId !== userId)
      ) {
        await this.api(
          token,
          'answerCallbackQuery',
          { callback_query_id: callback.id, text: '承認できません。' },
          signal,
        );
        return;
      }
      const match = /^review:([ad]):([a-f0-9-]{36})$/.exec(callback.data ?? '');
      if (!match) return;
      const scope =
        (this.platform.config.telegramBackend === 'codex' ? 'codex:' : '') +
        (group
          ? `${botId}:${chatId}:${topic ?? 0}:${senderId}`
          : `${botId}:${chatId}`);
      let notice = '承認は期限切れ、処理済み、または権限がありません。';
      try {
        if (this.platform.store.settings().paused && match[1] === 'a') {
          notice = 'OpenDotsは停止中です。再開後に承認してください。';
          throw new Error('Paused');
        }
        const page = this.platform.workspace.resolveTelegramReview(
          match[2],
          scope,
          match[1] === 'a',
        );
        notice = page ? `保存しました: ${page.title}` : '保存を見送りました。';
        if (page)
          await telegramUpload(
            token,
            chatId,
            Buffer.from(page.content),
            'approved-page.md',
            false,
            signal,
            message?.message_id,
            topic,
          );
        await this.api(
          token,
          'editMessageReplyMarkup',
          {
            chat_id: chatId,
            message_id: message?.message_id,
            reply_markup: { inline_keyboard: [] },
          },
          signal,
        );
      } catch {
        /* Never expose draft/provider details to a forged callback. */
      }
      await this.api(
        token,
        'answerCallbackQuery',
        { callback_query_id: callback.id, text: notice },
        signal,
      );
      return;
    }
    const message = update.message;
    const hasImage = !!message?.photo?.length || !!message?.document;

    if (
      !(message?.text?.trim() || message?.caption?.trim() || hasImage) ||
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
    let text =
      message.text ?? message.caption ?? 'この画像を確認して説明してください。';
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
      const addressed = addressedText(
        {
          ...message,
          text,
          entities: message.entities ?? message.caption_entities,
        },
        botId,
        username,
      );
      if (addressed === undefined) return;
      text = addressed;
    } else if (
      message.chat?.type !== 'private' ||
      chatId !== userId ||
      senderId !== userId
    )
      return;
    if (!text.trim() && hasImage) text = 'この画像を確認して説明してください。';
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
    if (!group && senderId === userId && text.trim() === '/resume') {
      this.platform.store.updateSettings({ paused: false });
      await send('再開しました。');
      return;
    }
    if (!group && senderId === userId && text.trim() === '/pause') {
      this.platform.store.updateSettings({ paused: true });
      await send('停止しました。');
      return;
    }
    if (text.trim() === '/help') {
      await send(
        '写真と文章を送ってください。ページ作成・編集・Web調査・Computer操作を依頼できます。\n個人チャット: /computer start, /computer stop, /computer take, /computer release, /screenshot, /pause, /resume, /remember 内容, /memories。ページの事前確認を頼むと承認ボタンが届きます。',
      );
      return;
    }
    if (!group && senderId === userId && text.startsWith('/remember ')) {
      this.platform.store.saveMemory(text.slice(10, 5010));
      await send('メモリに保存しました。');
      return;
    }
    if (!group && senderId === userId && text.trim() === '/memories') {
      await send(
        this.platform.store
          .memories()
          .map((m) => m.text)
          .join('\n') || 'メモリは空です。',
      );
      return;
    }
    if (
      !group &&
      senderId === userId &&
      (text.startsWith('/computer ') ||
        text.trim() === '/screenshot' ||
        /^\/(click|type|key|scroll) /.test(text))
    ) {
      const computer = this.platform.computers;
      if (!computer) {
        await send('Computer接続が設定されていません。');
        return;
      }
      try {
        const human = /^\/(click|type|key|scroll) ([\s\S]+)$/.exec(text);
        if (human) {
          const [, action, value] = human;
          const coordinates = value.trim().split(/\s+/).map(Number);
          const input =
            action === 'click'
              ? { x: coordinates[0], y: coordinates[1] }
              : action === 'scroll'
                ? { deltaY: Number(value) }
                : action === 'key'
                  ? { key: value }
                  : { text: value };
          await computer.action(
            dotId,
            `human_${action}` as
              'human_click' | 'human_type' | 'human_key' | 'human_scroll',
            input,
            'owner',
            signal,
          );
          await send('操作しました。/screenshot で確認できます。');
          return;
        }
        const verb = text.split(' ')[1];
        if (text.trim() === '/screenshot') {
          const result = (await computer.action(
            dotId,
            'screenshot',
            {},
            'owner',
            signal,
          )) as { base64: string };
          await telegramUpload(
            token,
            chatId,
            Buffer.from(result.base64, 'base64'),
            'screen.png',
            true,
            signal,
          );
          return;
        }
        const result =
          verb === 'start'
            ? await computer.start(dotId)
            : verb === 'stop'
              ? await computer.stop(dotId)
              : verb === 'take' || verb === 'release'
                ? await computer.control(dotId, verb)
                : await computer.status(dotId);
        await send(`Computer: ${result.state}`);
      } catch {
        await send(
          'Computer操作に失敗しました。接続・権限・稼働状態を確認してください。',
        );
      }
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
      if (hasImage) {
        if (this.platform.config.telegramBackend !== 'codex') {
          await send(
            'このバックエンドでは写真入力が未対応です。ChatGPT OAuthへ切り替えてください。',
          );
          return;
        }
        const file =
          message.photo?.filter((p) => (p.file_size ?? 0) <= 5000000).at(-1) ??
          message.document;
        if (
          !file ||
          ('mime_type' in file &&
            !['image/png', 'image/jpeg'].includes(
              typeof file.mime_type === 'string' ? file.mime_type : '',
            ))
        ) {
          await send('5MB以下のJPEG／PNG画像を送ってください。');
          return;
        }
        const image = await telegramImage(token, file.file_id, signal);
        this.platform.workspace.saveTelegramImage(
          threadId,
          image.mime,
          image.bytes,
        );
      }
      const onImage = async (image: ChatImage) =>
        telegramUpload(
          token,
          chatId,
          image.bytes,
          'screenshot.png',
          true,
          signal,
          group ? message.message_id : undefined,
          topicId,
        );
      const onDocument = async (bytes: Uint8Array, filename: string) =>
        telegramUpload(
          token,
          chatId,
          bytes,
          filename,
          false,
          signal,
          group ? message.message_id : undefined,
          topicId,
        );
      const reviewPage = async (reviewThread: string, value: unknown) => {
        const draft = pageReviewSchema.parse(value),
          thread = this.platform.workspace.requireThread(reviewThread, dotId);
        if (
          !this.platform.workspace.canAccessSpace(thread.dotId, draft.spaceId)
        )
          throw new Error('Space denied');
        const id = this.platform.workspace.createTelegramReview(
          conversationKey,
          reviewThread,
          draft,
        );
        try {
          await onDocument(Buffer.from(draft.content), 'draft.md');
          await this.api(
            token,
            'sendMessage',
            {
              chat_id: chatId,
              text: `「${draft.title}」を保存しますか？`,
              ...(group
                ? { reply_parameters: { message_id: message.message_id } }
                : {}),
              ...(topicId ? { message_thread_id: topicId } : {}),
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: '承認して保存', callback_data: `review:a:${id}` },
                    { text: '見送る', callback_data: `review:d:${id}` },
                  ],
                ],
              },
            },
            signal,
          );
          return {
            status: 'pending',
            message:
              'Waiting for the user to press a review button. The draft is not saved; do not create it yourself.',
          };
        } catch (error) {
          this.platform.workspace.resolveTelegramReview(
            id,
            conversationKey,
            false,
          );
          throw error;
        }
      };
      reply = await this.platform.turn(threadId, text.slice(0, 12000), signal, {
        opendotsSource: 'telegram',
        ownerPrivate: !group && senderId === userId,
        onImage,
        onDocument,
        reviewPage,
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
