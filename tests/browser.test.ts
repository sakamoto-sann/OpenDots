import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { connect } from 'node:net';
import { Stagehand } from '@browserbasehq/stagehand';
import { createSnapshot } from '../src/browser/snapshot.js';
import { launchReaderBrowser, readPublicPage } from '../src/browser/reader.js';
import { browserFixture } from './helpers/browser.js';

// Only the fixture hostname is DNS-pinned to loopback; private URLs use real validation.
vi.mock('../src/browser/security.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/browser/security.js')>();
  return {
    ...original,
    validateUrl: async (input: string) =>
      new URL(input).hostname === 'public.example'
        ? { url: new URL(input), address: '127.0.0.1', family: 4 }
        : original.validateUrl(input),
  };
});
let fixture: Awaited<ReturnType<typeof browserFixture>>;
beforeEach(async () => {
  fixture = await browserFixture();
});
afterEach(async () => {
  await fixture.close();
});

it('rewrites static assets, blocks source scripts and refreshes, and validates resource URLs', async () => {
  const snapshot = await createSnapshot(
    fixture.url,
    new AbortController().signal,
  );
  try {
    const response = await fetch(snapshot.url);
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'none'",
    );
    const html = await response.text();
    expect(html).toContain('Public research page');
    expect(html).not.toMatch(/<script|http-equiv|onload=/);
    expect(html).toContain('/resource?url=');
    const origin = new URL(snapshot.url).origin;
    const css = await fetch(
      `${origin}/resource?url=${encodeURIComponent(new URL('/theme.css', fixture.url).href)}`,
    );
    expect(await css.text()).toContain('/resource?url=');
    const privateResponse = await fetch(
      `${origin}/resource?url=${encodeURIComponent(fixture.privateUrl)}`,
    );
    expect(privateResponse.status).toBe(502);
    const redirect = await fetch(
      `${origin}/resource?url=${encodeURIComponent(new URL('/redirect', fixture.url).href)}`,
    );
    expect(redirect.status).toBe(502);
    expect(fixture.counts().privateHits).toBe(0);
  } finally {
    await snapshot.close();
  }
});

it('rejects direct HTTP proxy requests and HTTPS CONNECT tunnels', async () => {
  const snapshot = await createSnapshot(
    fixture.url,
    new AbortController().signal,
  );
  try {
    const origin = new URL(snapshot.url);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = http.get(
        {
          hostname: origin.hostname,
          port: origin.port,
          path: fixture.privateUrl,
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
    });
    expect(status).toBe(403);
    const tunnel = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(origin.port), origin.hostname, () =>
        socket.write(
          'CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n',
        ),
      );
      socket.once('data', (data) => {
        resolve(data.toString());
        socket.destroy();
      });
      socket.once('error', reject);
    });
    expect(tunnel).toContain('403 Forbidden');
    expect(fixture.counts().privateHits).toBe(0);
  } finally {
    await snapshot.close();
  }
});

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1')(
  'Stagehand browser',
  () => {
    it('renders public text, styles and a JPEG with source scripts and private resources blocked', async () => {
      const result = await readPublicPage(
        fixture.url,
        AbortSignal.timeout(40_000),
      );
      expect(result.url).toBe(fixture.url);
      expect(result.title).toBe('Public fixture');
      expect(result.text).toContain('Static source evidence');
      expect(result.text).toContain('Fallback content');
      expect(result.text).not.toContain('script ran');
      expect(result.screenshot).toMatch(/^data:image\/jpeg;base64,/);
      expect(fixture.counts().cssHits).toBeGreaterThan(0);
      expect(fixture.counts().privateHits).toBe(0);
    }, 45_000);

    it('cannot bypass the snapshot gateway to navigate to another loopback service', async () => {
      const snapshot = await createSnapshot(
        fixture.url,
        new AbortController().signal,
      );
      const browser = await launchReaderBrowser(snapshot.proxy);
      let stagehand: Stagehand | undefined;
      try {
        stagehand = await Stagehand.create({
          browser,
          logging: { level: 'off' },
        });
        const page = await browser.context.newPage();
        const response = await page.goto(fixture.privateUrl, { timeout: 5000 });
        expect(response?.status()).toBe(403);
        expect(fixture.counts().privateHits).toBe(0);
      } finally {
        try {
          await stagehand?.close();
        } finally {
          try {
            await browser.close();
          } finally {
            await snapshot.close();
          }
        }
      }
    }, 30_000);
  },
);
