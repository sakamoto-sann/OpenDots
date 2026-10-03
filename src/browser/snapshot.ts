import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse, serialize, type DefaultTreeAdapterTypes } from 'parse5';
import valueParser from 'postcss-value-parser';
import { parseSrcset, stringifySrcset } from 'srcset';
import { readResource } from './transport.js';

const policy = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function cssSnapshot(css: string, resourceUrl: (url: string) => string) {
  const parsed = valueParser(css);
  let importing = false;
  parsed.walk((node) => {
    if (node.type === 'word' && node.value.toLowerCase() === '@import') {
      importing = true;
    } else if (node.type === 'string' && importing) {
      node.value = resourceUrl(node.value);
      importing = false;
    } else if (node.type === 'function' && node.value.toLowerCase() === 'url') {
      const url = valueParser
        .stringify(node.nodes)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      node.nodes = [
        {
          type: 'string',
          quote: '"',
          value: resourceUrl(url),
          sourceIndex: 0,
          sourceEndIndex: 0,
        },
      ];
      importing = false;
      return false;
    } else if (node.type !== 'space' && node.type !== 'comment') {
      importing = false;
    }
  });
  return parsed.toString();
}

function htmlSnapshot(html: string, sourceUrl: string, origin: string) {
  const document = parse(html, { scriptingEnabled: false });
  let base = sourceUrl;
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  function collect(node: DefaultTreeAdapterTypes.Node) {
    if ('tagName' in node) elements.push(node);
    if ('childNodes' in node) node.childNodes.forEach(collect);
  }
  collect(document);
  const declaredBase = elements
    .find((node) => node.tagName === 'base')
    ?.attrs.find((attr) => attr.name === 'href')?.value;
  if (declaredBase) {
    try {
      base = new URL(declaredBase, sourceUrl).href;
    } catch {
      /* Ignore invalid bases. */
    }
  }
  const resourceUrl = (url: string) => snapshotResourceUrl(url, base, origin);
  for (const node of elements) {
    // CSP blocks source scripts, but Chrome still treats scripting as enabled.
    // Show the fallback content that the previous script-disabled reader displayed.
    if (node.tagName === 'noscript' && node.parentNode) {
      const parent = node.parentNode;
      const index = parent.childNodes.indexOf(node);
      parent.childNodes.splice(index, 1, ...node.childNodes);
      for (const child of node.childNodes) child.parentNode = parent;
    }
    // Scripts, frames, refreshes, and source-provided policies cannot alter the renderer.
    if (
      ['script', 'iframe', 'frame', 'object', 'embed', 'base'].includes(
        node.tagName,
      ) ||
      (node.tagName === 'meta' &&
        node.attrs.some((attr) => attr.name === 'http-equiv'))
    ) {
      if (node.parentNode)
        node.parentNode.childNodes = node.parentNode.childNodes.filter(
          (child) => child !== node,
        );
      continue;
    }
    node.attrs = node.attrs.filter((attr) => !attr.name.startsWith('on'));
    for (const attr of node.attrs) {
      if (attr.name === 'style')
        attr.value = cssSnapshot(attr.value, resourceUrl);
      else if (attr.name === 'srcset') {
        attr.value = stringifySrcset(
          parseSrcset(attr.value).map((candidate) => ({
            ...candidate,
            url: resourceUrl(candidate.url),
          })),
        );
      } else if (
        ['src', 'poster', 'background'].includes(attr.name) ||
        (attr.name === 'href' &&
          ['link', 'image', 'use'].includes(node.tagName))
      ) {
        attr.value = resourceUrl(attr.value);
      }
    }
    if (node.tagName === 'style') {
      for (const child of node.childNodes)
        if ('value' in child)
          child.value = cssSnapshot(child.value, resourceUrl);
    }
  }
  return serialize(document);
}

function snapshotResourceUrl(input: string, base: string, origin: string) {
  if (input.startsWith('#') || /^data:/i.test(input)) return input;
  try {
    return `${origin}/resource?url=${encodeURIComponent(new URL(input, base).href)}`;
  } catch {
    return `${origin}/blocked`;
  }
}

/** Serves static source content while rejecting direct browser proxy traffic. */
export async function createSnapshot(sourceUrl: string, signal: AbortSignal) {
  const source = await readResource(sourceUrl, signal);
  if (source.status >= 400)
    throw new Error(`Source returned HTTP ${source.status}.`);
  signal.throwIfAborted();
  const type = source.headers['content-type'] ?? 'text/html';
  const decoded = new TextDecoder(
    type.match(/charset\s*=\s*["']?([\w-]+)/i)?.[1] ?? 'utf-8',
  ).decode(source.body);
  const html = /^(?:text\/html|application\/xhtml\+xml)/i.test(type)
    ? decoded
    : `<pre>${decoded.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`;
  let origin = '';
  let documentHtml = '';
  let count = 1;
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Security-Policy', policy);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.method !== 'GET' || !request.url?.startsWith('/')) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url, origin);
    if (url.pathname === '/document') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(documentHtml);
      return;
    }
    const target = url.searchParams.get('url');
    if (url.pathname !== '/resource' || !target || ++count > 50) {
      response.writeHead(403).end();
      return;
    }
    try {
      const resource = await readResource(target, signal);
      const type = resource.headers['content-type'] ?? '';
      if (
        resource.status >= 400 ||
        !/^(text\/css|image\/|font\/|application\/(?:font|x-font|vnd\.ms-fontobject|octet-stream))/i.test(
          type,
        )
      ) {
        response.writeHead(403).end();
        return;
      }
      if (/^text\/css/i.test(type)) {
        response.setHeader('Content-Type', 'text/css; charset=utf-8');
        response.end(
          cssSnapshot(resource.body.toString(), (input) =>
            snapshotResourceUrl(input, target, origin),
          ),
        );
      } else {
        response.setHeader('Content-Type', type);
        response.end(resource.body);
      }
    } catch {
      response.writeHead(502).end();
    }
  });
  server.on('connect', (_request, socket) =>
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'),
  );
  server.on('connection', (socket) => socket.on('error', () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  try {
    documentHtml = htmlSnapshot(html, sourceUrl, origin);
    signal.throwIfAborted();
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    url: `${origin}/document`,
    proxy: { server: origin, bypass: `<-loopback>;127.0.0.1:${port}` },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
