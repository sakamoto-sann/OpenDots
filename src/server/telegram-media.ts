import type { ChatImage } from './codex-tool-gateway.js';
export const telegramImageLimit = 5_000_000;
export async function telegramImage(
  token: string,
  fileId: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<ChatImage> {
  const response = await transport(
    `https://api.telegram.org/bot${token}/getFile`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal,
      redirect: 'error',
    },
  );
  if (!response.ok) throw new Error('Telegram file lookup failed');
  const result = (await response.json()) as {
    ok?: boolean;
    result?: { file_path?: string; file_size?: number };
  };
  const path = result.result?.file_path;
  if (
    !result.ok ||
    !path ||
    !/^[-a-zA-Z0-9_/.]+$/.test(path) ||
    path.split('/').some((p) => p === '..') ||
    (result.result?.file_size ?? 0) > telegramImageLimit
  )
    throw new Error('Unsupported Telegram image');
  const file = await transport(
    `https://api.telegram.org/file/bot${token}/${path}`,
    { signal, redirect: 'error' },
  );
  if (
    !file.ok ||
    !file.body ||
    Number(file.headers.get('content-length')) > telegramImageLimit
  )
    throw new Error('Telegram image download failed');
  const reader = file.body.getReader(),
    chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.length;
      if (count > telegramImageLimit)
        throw new Error('Telegram image too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  const mime = bytes
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? 'image/jpeg'
      : undefined;
  if (!mime) throw new Error('Only PNG and JPEG images are supported');
  return { mime, bytes };
}
export async function telegramUpload(
  token: string,
  chatId: string,
  bytes: Uint8Array,
  filename: string,
  photo: boolean,
  signal: AbortSignal,
  replyTo?: number,
  topicId?: number,
  transport: typeof fetch = fetch,
) {
  if (bytes.length > 5_000_000)
    throw new Error('Telegram output file too large');
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append(
    photo ? 'photo' : 'document',
    new Blob([new Uint8Array(bytes)]),
    filename.replace(/[^\w.-]/g, '_').slice(0, 100),
  );
  if (replyTo !== undefined)
    form.append('reply_parameters', JSON.stringify({ message_id: replyTo }));
  if (topicId !== undefined) form.append('message_thread_id', String(topicId));
  const response = await transport(
    `https://api.telegram.org/bot${token}/${photo ? 'sendPhoto' : 'sendDocument'}`,
    { method: 'POST', body: form, signal, redirect: 'error' },
  );
  if (!response.ok || !((await response.json()) as { ok?: boolean }).ok)
    throw new Error('Telegram file delivery failed');
}
