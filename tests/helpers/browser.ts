import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function browserFixture() {
  let privateHits = 0;
  let cssHits = 0;
  let origin = '';
  const server = createServer((request, response) => {
    if (request.url === '/private') {
      privateHits++;
      response.end('private data');
    } else if (request.url === '/redirect') {
      response.writeHead(302, { Location: `${origin}/private` }).end();
    } else if (request.url === '/theme.css') {
      cssHits++;
      response.setHeader('Content-Type', 'text/css');
      response.end(
        'body { color: rgb(10, 20, 30); background-image: url("/pixel.svg"); }',
      );
    } else if (request.url === '/pixel.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
      );
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><head><title>Public fixture</title>
        <meta http-equiv="refresh" content="0;url=${origin}/private">
        <link rel="stylesheet" href="/theme.css"></head><body onload="location.href='${origin}/private'">
        <h1>Public research page</h1><p>Static source evidence</p><noscript>Fallback content</noscript>
        <script>fetch('${origin}/private');document.body.innerHTML='script ran';</script>
        <img src="/pixel.svg" srcset="/pixel.svg 1x, /pixel.svg 2x">
        <img src="${origin}/private"><img src="/redirect"></body></html>`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  return {
    url: `http://public.example:${port}/`,
    privateUrl: `${origin}/private`,
    counts: () => ({ privateHits, cssHits }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
