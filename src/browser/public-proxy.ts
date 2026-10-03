import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { validateUrl } from './security.js';
/** Pins each upstream connection to a public address, including HTTPS redirects/subresources. */
export async function publicProxy() {
  const server = createServer(async (req, res) => {
    try {
      const target = await validateUrl(req.url ?? '');
      if (target.url.protocol !== 'http:') throw new Error();
      const headers: import('node:http').OutgoingHttpHeaders = {
        ...req.headers,
        host: target.url.host,
      };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = request(
        {
          hostname: target.address,
          family: target.family,
          port: 80,
          path: target.url.pathname + target.url.search,
          method: req.method,
          headers,
          timeout: 30000,
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstream.on('timeout', () => upstream.destroy());
      req.pipe(upstream);
    } catch {
      res.writeHead(502);
      res.end();
    }
  });
  server.on('connect', async (req, client, head) => {
    try {
      const target = await validateUrl(`https://${req.url}/`);
      if (target.url.port && target.url.port !== '443') throw new Error();
      const upstream = connect({
        host: target.address,
        family: target.family,
        port: 443,
      });
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Proxy unavailable');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}
