import { serve, type HttpBindings } from '@hono/node-server';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { readPublicPage } from './reader.js';

const secret = process.env.BROWSER_SECRET;
if (!secret || secret.length < 24)
  throw new Error('BROWSER_SECRET must be at least 24 characters.');
const app = new Hono<{ Bindings: HttpBindings }>();
app.use('*', bodyLimit({ maxSize: 16_384 }));
app.use('*', async (c, next) => {
  const supplied = Buffer.from(
    c.req.header('authorization')?.replace(/^Bearer /, '') ?? '',
  );
  const expected = Buffer.from(secret);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return c.json({ error: 'Unauthorized' }, 401);
  await next();
});
let busy = false;
app.post('/browse', async (c) => {
  const parsed = z
    .object({ url: z.string().url().max(2048) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ error: 'A valid URL is required.' }, 400);
  if (busy) return c.json({ error: 'Browser is busy. Retry shortly.' }, 429);
  busy = true;
  const controller = new AbortController();
  const abort = () => {
    controller.abort(new Error('Browser request cancelled.'));
  };
  const disconnected = () => {
    if (!c.env.outgoing.writableFinished) abort();
  };
  c.req.raw.signal.addEventListener('abort', abort, { once: true });
  c.env.outgoing.on('close', disconnected);
  const deadline = setTimeout(abort, 40_000);
  try {
    return c.json(await readPublicPage(parsed.data.url, controller.signal));
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'Browser failed.',
      },
      502,
    );
  } finally {
    clearTimeout(deadline);
    c.req.raw.signal.removeEventListener('abort', abort);
    c.env.outgoing.off('close', disconnected);
    busy = false;
  }
});
app.get('/health', (c) => c.json({ ok: true }));
serve({
  fetch: app.fetch,
  hostname: process.env.BROWSER_HOST ?? '127.0.0.1',
  port: Number(process.env.BROWSER_PORT ?? 4311),
});
