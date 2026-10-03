import {
  localBrowser,
  Stagehand,
  type StagehandBrowser,
} from '@browserbasehq/stagehand';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createSnapshot } from './snapshot.js';

export async function launchReaderBrowser(proxy: {
  server: string;
  bypass: string;
}) {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    reservation.close((error) => (error ? reject(error) : resolve())),
  );
  return localBrowser.launch({
    port,
    headless: true,
    viewport: { width: 1200, height: 800 },
    acceptDownloads: false,
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
    chromiumSandbox: process.env.BROWSER_CHROMIUM_SANDBOX !== '0',
    args: ['--disable-dev-shm-usage'],
    // The Stagehand extension needs its own CDP control socket. Source content
    // has script/connect blocked by CSP; every other network port uses the denying proxy.
    proxy: { ...proxy, bypass: `${proxy.bypass};127.0.0.1:${port}` },
  });
}

export async function readPublicPage(url: string, signal: AbortSignal) {
  const snapshot = await createSnapshot(url, signal);
  let browser: StagehandBrowser | undefined;
  let stagehand: Stagehand | undefined;
  let closing: Promise<void> | undefined;
  const closeBrowser = () =>
    browser ? (closing ??= browser.close()) : Promise.resolve();
  const abort = () => {
    void closeBrowser().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    browser = await launchReaderBrowser(snapshot.proxy);
    signal.throwIfAborted();
    stagehand = await Stagehand.create({ browser, logging: { level: 'off' } });
    signal.throwIfAborted();
    const page = await browser.context.newPage();
    const response = await page.goto(snapshot.url, {
      waitUntil: 'load',
      timeout: 25_000,
    });
    if (!response || response.status() >= 400)
      throw new Error('Source rendering failed.');
    const text = (await page.locator('body').innerText()).slice(0, 30_000);
    const title = await page.title();
    const screenshot = Buffer.from(
      await page.screenshot({ type: 'jpeg', quality: 60, timeout: 5000 }),
    ).toString('base64');
    signal.throwIfAborted();
    return {
      url,
      title,
      text,
      screenshot: `data:image/jpeg;base64,${screenshot}`,
    };
  } finally {
    signal.removeEventListener('abort', abort);
    try {
      await stagehand?.close();
    } finally {
      try {
        await closeBrowser();
      } finally {
        await snapshot.close();
      }
    }
  }
}
