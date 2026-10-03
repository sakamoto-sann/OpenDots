import { expect, it, vi } from 'vitest';
import { telegramImage, telegramUpload } from '../src/server/telegram-media.js';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
it('downloads only a bounded authenticated Telegram image without following redirects', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: { file_path: 'photos/test.png', file_size: 8 },
      }),
    )
    .mockResolvedValueOnce(new Response(png));
  const image = await telegramImage(
    'fixture',
    'photo-id',
    new AbortController().signal,
    transport,
  );
  expect(transport.mock.calls.map((call) => call[0])).toEqual([
    'https://api.telegram.org/botfixture/getFile',
    'https://api.telegram.org/file/botfixture/photos/test.png',
  ]);
  expect(image.mime).toBe('image/png');
  expect(image.bytes).toEqual(png);
  expect(
    transport.mock.calls.every((call) => call[1].redirect === 'error'),
  ).toBe(true);
});
it('rejects traversal, oversized images and non-image bytes', async () => {
  for (const result of [
    { file_path: '../secret.png' },
    { file_path: 'photos/file.png', file_size: 5000001 },
  ]) {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ ok: true, result }));
    await expect(
      telegramImage('fixture', 'id', new AbortController().signal, fetcher),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  }
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ ok: true, result: { file_path: 'documents/file.png' } }),
    )
    .mockResolvedValueOnce(new Response('not an image'));
  await expect(
    telegramImage('fixture', 'id', new AbortController().signal, fetcher),
  ).rejects.toThrow('PNG');
});
it('uploads binary output directly into the requested chat, reply and forum topic', async () => {
  const transport = vi
    .fn()
    .mockResolvedValue(Response.json({ ok: true, result: { message_id: 7 } }));
  await telegramUpload(
    'fixture',
    '-100',
    png,
    'screen.png',
    true,
    new AbortController().signal,
    11,
    4,
    transport,
  );
  const [url, options] = transport.mock.calls[0];
  expect(url).toContain('/sendPhoto');
  const form = options.body as FormData;
  expect(form.get('chat_id')).toBe('-100');
  expect(form.get('message_thread_id')).toBe('4');
  expect(JSON.parse(form.get('reply_parameters') as string)).toEqual({
    message_id: 11,
  });
  expect(form.get('photo')).toBeInstanceOf(Blob);
});

it('enforces the streamed limit even when metadata understates the file size', async () => {
  const transport = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        ok: true,
        result: { file_path: 'photos/large.png', file_size: 8 },
      }),
    )
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(5000001));
            controller.close();
          },
        }),
      ),
    );
  await expect(
    telegramImage('fixture', 'id', new AbortController().signal, transport),
  ).rejects.toThrow('too large');
});
