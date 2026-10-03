import { readFileSync, closeSync } from 'node:fs';
import {
  localBrowser,
  Stagehand,
  type StagehandBrowser,
  type Page,
} from '@browserbasehq/stagehand';
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  realpath,
  stat,
  lstat,
} from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer as reservePort } from 'node:net';
import {
  computerInputs,
  type ComputerAction,
} from '../shared/computer-types.js';
import { publicProxy } from '../browser/public-proxy.js';
import { validateUrl } from '../browser/security.js';

export async function startComputer() {
  const credential = readFileSync(3, 'utf8').trim(),
    botId = process.env.COMPUTER_BOT_ID;
  closeSync(3);
  if (!credential || credential.length < 24 || !botId)
    throw new Error('Computer identity required');
  if (
    process.platform !== 'linux' ||
    process.pid !== 1 ||
    process.env.OPENDOTS_COMPUTER_CONTAINER !== '1'
  )
    throw new Error('This computer service must run in its isolated container');
  const root = '/workspace';
  await mkdir(root, { recursive: true });
  await mkdir('/profiles', { recursive: true });
  await mkdir('/workspace/downloads', { recursive: true });
  const proxy = await publicProxy();
  const manifest = JSON.parse(
    await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.resolve('@browserbasehq/stagehand'))),
        'extension/manifest.json',
      ),
      'utf8',
    ),
  ) as { key?: string };
  const extensionDirectory = resolve(
    dirname(fileURLToPath(import.meta.resolve('@browserbasehq/stagehand'))),
    'extension',
  );
  const extensionId = createHash('sha256')
    .update(
      manifest.key ? Buffer.from(manifest.key, 'base64') : extensionDirectory,
    )
    .digest()
    .subarray(0, 16)
    .toString('hex')
    .replace(/[0-9a-f]/g, (letter) =>
      String.fromCharCode(97 + parseInt(letter, 16)),
    );

  let browser: StagehandBrowser | undefined,
    stagehand: Stagehand | undefined,
    page: Page | undefined,
    snapshotId = Date.now(),
    refs: Record<string, string> = {},
    busy = false,
    retiring = false,
    holder: 'bot' | 'human' = 'bot',
    resumeSnapshotRequired = true;
  let controlRequest: { id: string; status: string } | undefined;
  const control = () => ({
    holder,
    requested: !!controlRequest,
    transitioning: false,
    resumeSnapshotRequired,
    request: controlRequest,
  });
  const current = async () => {
    const reservation = reservePort();
    await new Promise<void>((done, fail) => {
      reservation.once('error', fail);
      reservation.listen(0, '127.0.0.1', done);
    });
    const address = reservation.address();
    if (!address || typeof address === 'string')
      throw new Error('Browser port unavailable');
    const port = address.port;
    await new Promise<void>((done) => reservation.close(() => done()));
    browser ??= await localBrowser.launch({
      port,
      executablePath:
        process.env.BROWSER_EXECUTABLE_PATH ?? '/usr/bin/chromium',
      chromiumSandbox: false,
      headless: true,
      userDataDir: '/profiles',
      preserveUserDataDir: true,
      proxy: { server: proxy.url, bypass: `<-loopback>;127.0.0.1:${port}` },
      ignoreDefaultArgs: ['--remote-allow-origins=*'],
      args: [
        '--disable-quic',
        '--disable-dev-shm-usage',
        `--remote-allow-origins=chrome-extension://${extensionId}`,
      ],
      viewport: { width: 1280, height: 800 },
      acceptDownloads: true,
      downloadsPath: '/workspace/downloads',
    });
    stagehand ??= await Stagehand.create({
      browser,
      logging: { level: 'off' },
    });
    const pages = await browser.context.pages();
    const latest = pages.at(-1);
    if (latest && latest.pageId !== page?.pageId) {
      page = latest;
      invalidate();
    }
    if (!page) page = await browser.context.newPage('about:blank');
    return page;
  };
  const invalidate = () => {
    snapshotId++;
    refs = {};
    resumeSnapshotRequired = true;
  };
  const confined = async (path: string, writing = false) => {
    const candidate = resolve(root, path);
    if (
      relative(root, candidate).startsWith('..') ||
      (candidate === root && writing)
    )
      throw new Error('Path denied');
    const actual = await realpath(writing ? dirname(candidate) : candidate);
    if (actual !== root && !actual.startsWith(root + '/'))
      throw new Error('Path denied');
    if (writing) {
      try {
        if ((await lstat(candidate)).isSymbolicLink())
          throw new Error('Path denied');
        const existing = await realpath(candidate);
        if (!existing.startsWith(root + '/')) throw new Error('Path denied');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return candidate;
  };
  const auth = (value: string | undefined) => {
    const a = Buffer.from(value ?? ''),
      b = Buffer.from('Bearer ' + credential);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/health') return reply(200, { ok: true });
    if (
      !auth(req.headers.authorization) ||
      req.headers['x-openbot-bot-id'] !== botId
    )
      return reply(401, { error: 'Unauthorized' });
    if (req.url === '/control' && req.method === 'GET')
      return reply(200, control());
    if (busy || retiring)
      return reply(409, { error: 'Computer busy; refresh before retrying' });
    busy = true;
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1100000) throw new Error('Input limit');
        chunks.push(chunk);
      }
      const input = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString('utf8'))
        : {};
      if (req.url?.startsWith('/control/')) {
        if (req.method !== 'POST') return reply(405, {});
        if (req.url === '/control/request') {
          controlRequest = { id: randomUUID(), status: 'waiting' };
        } else {
          if (!controlRequest || input.requestId !== controlRequest.id)
            return reply(409, {});
          if (req.url === '/control/take') {
            holder = 'human';
            controlRequest.status = 'taken';
            invalidate();
          } else if (req.url === '/control/release') {
            holder = 'bot';
            controlRequest.status = 'released';
            invalidate();
          } else return reply(404, {});
        }
        return reply(200, control());
      }
      const action = req.url
        ?.slice(1)
        .replace('files/', 'files_')
        .replace('human/', 'human_') as ComputerAction;
      if (!Object.hasOwn(computerInputs, action)) return reply(404, {});
      if (
        req.method !==
        (['read', 'screenshot'].includes(action) ? 'GET' : 'POST')
      )
        return reply(405, {});
      const parsed = computerInputs[action].parse(input) as Record<
        string,
        unknown
      >;
      if (
        action.startsWith('human_')
          ? holder !== 'human'
          : holder !== 'bot' &&
            !(
              req.headers['x-opendots-actor'] === 'owner' &&
              ['read', 'screenshot'].includes(action)
            )
      )
        return reply(409, { error: 'Control is held by the other actor' });
      if (action.startsWith('files_')) {
        const path = await confined(
          String(parsed.path),
          action === 'files_write',
        );
        if (action === 'files_list')
          return reply(200, {
            files: await readdir(path, { withFileTypes: true }).then((items) =>
              items.map((item) => ({
                name: item.name,
                directory: item.isDirectory(),
              })),
            ),
          });
        if (action === 'files_read') {
          if ((await stat(path)).size > 100000) throw new Error('File limit');
          return reply(200, { contents: await readFile(path, 'utf8') });
        }
        await writeFile(path, String(parsed.contents), {
          flag: parsed.append ? 'a' : 'w',
          mode: 0o600,
        });
        return reply(200, { written: true });
      }
      if (action === 'exec') {
        const before = new Set(await readdir('/proc'));
        const retire = () => {
          if (retiring) return;
          retiring = true;
          // Exiting the container's main process lets Docker terminate its entire
          // PID namespace, including descendants that escaped the shell group.
          setTimeout(() => process.exit(1), 200);
        };
        const result = await new Promise<{
          stdout: string;
          stderr: string;
          exitCode: number;
        }>((resolve, reject) => {
          let stdout = '',
            stderr = '',
            size = 0,
            failure: Error | undefined;
          const child = spawn('/bin/sh', ['-c', String(parsed.command)], {
            cwd: root,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              PATH: process.env.PATH,
              HOME: process.env.HOME,
              LANG: 'C.UTF-8',
            },
          });
          const kill = () => {
            try {
              if (child.pid) process.kill(-child.pid, 'SIGKILL');
            } catch {
              /* Already exited. */
            }
          };
          const fail = () => {
            failure ??= new Error(
              'Command cancelled, failed or exceeded its limit',
            );
            kill();
            retire();
            child.stdout.destroy();
            child.stderr.destroy();
            reject(failure);
          };
          const timeout = setTimeout(fail, Number(parsed.timeoutMs));
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          const receive = (chunk: string, error: boolean) => {
            size += Buffer.byteLength(chunk);
            if (size > 100000) fail();
            else if (error) stderr += chunk;
            else stdout += chunk;
          };
          child.stdout.on('data', (chunk) => receive(chunk, false));
          child.stderr.on('data', (chunk) => receive(chunk, true));
          child.once('error', fail);
          req.once('aborted', fail);
          res.once('close', () => {
            if (!res.writableEnded) fail();
          });
          child.once('close', async (code) => {
            clearTimeout(timeout);
            kill();
            try {
              const after = await readdir('/proc');
              if (
                after.some(
                  (pid) =>
                    /^\d+$/.test(pid) &&
                    !before.has(pid) &&
                    pid !== String(child.pid),
                )
              ) {
                fail();
                return;
              }
            } catch {
              fail();
              return;
            }
            if (failure || code === null)
              reject(failure ?? new Error('Command failed'));
            else resolve({ stdout, stderr, exitCode: code });
          });
        });
        return reply(200, result);
      }
      const target = await current();
      if (action === 'navigate') {
        await validateUrl(String(parsed.url));
        invalidate();
        await target.goto(String(parsed.url), { timeout: 30000 });
        return reply(200, {
          url: await target.url(),
          title: await target.title(),
        });
      }
      if (action === 'read')
        return reply(200, {
          url: await target.url(),
          title: await target.title(),
          text: await target.evaluate(() =>
            document.body.innerText.slice(0, 60000),
          ),
          links: await target.evaluate(() =>
            Array.from(document.querySelectorAll('a[href]'))
              .map((link) => ({
                title: (link.textContent ?? '').trim().slice(0, 200),
                url: (link as HTMLAnchorElement).href,
              }))
              .filter((link) => /^https?:\/\//.test(link.url))
              .slice(0, 60),
          ),
        });
      if (action === 'snapshot') {
        // Snapshot input values are not exported. Clear them temporarily without firing events.
        await target.evaluate(() => {
          const values: Array<
            [HTMLInputElement | HTMLTextAreaElement, string]
          > = [];
          document.querySelectorAll('input,textarea').forEach((node) => {
            const field = node as HTMLInputElement | HTMLTextAreaElement;
            if (
              !['submit', 'button', 'checkbox', 'radio', 'hidden'].includes(
                (field as HTMLInputElement).type,
              )
            ) {
              values.push([field, field.value]);
              field.value = '';
            }
          });
          (
            window as unknown as { __opendotsValues: unknown }
          ).__opendotsValues = values;
        });
        let snapshot;
        try {
          snapshot = await target.snapshot();
        } finally {
          await target.evaluate(() => {
            const state = window as unknown as {
              __opendotsValues?: Array<
                [HTMLInputElement | HTMLTextAreaElement, string]
              >;
            };
            state.__opendotsValues?.forEach(([field, value]) => {
              if (field.isConnected) field.value = value;
            });
            delete state.__opendotsValues;
          });
        }
        snapshotId++;
        refs = snapshot.xpathMap;
        resumeSnapshotRequired = false;
        return reply(200, {
          url: await target.url(),
          title: await target.title(),
          snapshotId,
          snapshot: snapshot.formattedTree,
          refs: Object.keys(refs),
          elements: Object.keys(refs).map((ref) => ({
            ref,
            role: 'element',
            name: ref,
          })),
        });
      }
      if (action === 'screenshot') {
        await target.evaluate(() => {
          const style = document.createElement('style');
          style.id = 'opendots-secret-mask';
          style.textContent =
            'input[type=password],input[autocomplete="one-time-code"],input[name*=token i],input[name*=secret i]{visibility:hidden!important}';
          document.head.append(style);
        });
        let screenshot: { base64: string; mimeType: string; url: string };
        try {
          screenshot = {
            base64: Buffer.from(await target.screenshot()).toString('base64'),
            mimeType: 'image/png',
            url: await target.url(),
          };
        } finally {
          await target.evaluate(() =>
            document.getElementById('opendots-secret-mask')?.remove(),
          );
        }
        return reply(200, screenshot);
      }
      if (action === 'click' || action === 'type') {
        if (
          resumeSnapshotRequired ||
          parsed.snapshotId !== snapshotId ||
          !refs[String(parsed.ref)]
        )
          return reply(409, {
            error: 'Take a fresh snapshot before using refs',
          });
        const locator = target.locator('xpath=' + refs[String(parsed.ref)]);
        invalidate();
        if (action === 'click') await locator.click();
        else {
          await locator.fill(String(parsed.text));
          if (parsed.submit) await target.keyPress('Enter');
        }
      } else if (action === 'key' || action === 'human_key')
        await target.keyPress(String(parsed.key));
      else if (action === 'scroll' || action === 'human_scroll')
        await target.scroll(640, 400, 0, Number(parsed.deltaY));
      else if (action === 'human_click')
        await target.click(Number(parsed.x), Number(parsed.y));
      else if (action === 'human_type') await target.type(String(parsed.text));
      invalidate();
      return reply(200, { ok: true });
    } catch {
      reply(400, {
        error: 'Computer action failed; check the request and current state',
      });
    } finally {
      busy = false;
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(process.env.PORT ?? 4100), '0.0.0.0', resolve);
  });
  const close = async () => {
    server.closeAllConnections();
    server.close();
    await stagehand?.close();
    await browser?.close();
    proxy.close();
  };
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  return { close };
}
