// A deliberately unreliable webhook receiver for engine tests (design §4.10).
// Behaviour is chosen by path:
//   /ok                    200
//   /status/:code          that status code
//   /retry-after/:seconds  429 with Retry-After
//   /slow/:ms              200 after a delay
//   /hang                  never answers (connection held until close())
//   /reset                 destroys the TCP connection without a response
//   /big/:bytes            200 with a body of that many bytes
//   /redirect              302 → /ok (RelayForge must not follow it)
//   /binary                200 with NUL bytes in the body
//   /flaky/:n              500 for the first n requests per delivery, then 200
//                          (keyed by X-RelayForge-Delivery-Id, else the path)
//   /busy/:n               like flaky, but 429 + Retry-After: 1 (a rate-limited receiver;
//                          RelayForge honours the header, so retries come ~1 s apart)
//
// Options bound memory and sockets when it runs publicly (chaos-cli.ts, the demo service);
// tests use the defaults (unbounded, /hang forever).
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type ReceivedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  at: number;
};

export type ChaosReceiver = {
  url: string;
  requests: ReceivedRequest[];
  /** Requests whose path starts with `prefix`. */
  requestsTo: (prefix: string) => ReceivedRequest[];
  /** Requests received since start/reset, including ones dropped by maxRequests. */
  total: () => number;
  reset: () => void;
  close: () => Promise<void>;
};

export type ChaosOptions = {
  /** Interface to bind (default 127.0.0.1; 0.0.0.0 in a container). */
  host?: string;
  /** Larger request bodies get 413 and aren't stored. Default: unlimited. */
  maxBodyBytes?: number;
  /** Keep only the most recent N requests in memory. Default: all. */
  maxRequests?: number;
  /** /hang answers 504 after this long instead of never. Default: never. */
  hangMs?: number;
};

export async function startChaosReceiver(
  port = 0,
  { host = '127.0.0.1', maxBodyBytes, maxRequests, hangMs }: ChaosOptions = {},
): Promise<ChaosReceiver> {
  const requests: ReceivedRequest[] = [];
  let total = 0;
  const flakyCounts = new Map<string, number>();
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (maxBodyBytes !== undefined && size > maxBodyBytes) {
        tooLarge = true; // stop buffering; keep reading so the 413 can be sent cleanly
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
        res.end('chaos:413');
        return;
      }
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      total++;
      if (maxRequests !== undefined && requests.length >= maxRequests) requests.shift();
      requests.push({
        method: req.method ?? 'GET',
        path,
        headers: req.headers,
        body: Buffer.concat(chunks),
        at: Date.now(),
      });
      respond(path, req.headers, res);
    });
  });

  function respond(path: string, headers: IncomingHttpHeaders, res: ServerResponse) {
    const [, mode = '', arg = ''] = path.split('/');
    const send = (status: number, extra: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'text/plain', ...extra });
      res.end(`chaos:${status}`);
    };
    switch (mode) {
      case 'ok':
        return send(200);
      case 'status':
        return send(Number(arg) || 500);
      case 'retry-after':
        return send(429, { 'retry-after': arg || '1' });
      case 'slow':
        setTimeout(() => send(200), Number(arg) || 100);
        return;
      case 'hang':
        if (hangMs !== undefined) setTimeout(() => send(504), hangMs);
        return; // otherwise never respond
      case 'reset':
        res.socket?.destroy();
        return;
      case 'big': {
        const body = Buffer.alloc(Number(arg) || 10_000, 'x');
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
        res.end(body);
        return;
      }
      case 'redirect':
        return send(302, { location: '/ok' });
      case 'binary': {
        // 200 with NUL bytes in the body, like a gzip or protobuf reply.
        const body = Buffer.from([0x00, 0x1f, 0x8b, 0x00, 0x41, 0x00]);
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(body);
        return;
      }
      case 'flaky':
      case 'busy': {
        const failures = Number(arg) || 1;
        const keyHeader = headers['x-relayforge-delivery-id'];
        const key = typeof keyHeader === 'string' ? keyHeader : path;
        const seen = flakyCounts.get(key) ?? 0;
        flakyCounts.set(key, seen + 1);
        if (seen >= failures) return send(200);
        return mode === 'busy' ? send(429, { 'retry-after': '1' }) : send(500);
      }
      default:
        return send(404);
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    total: () => total,
    requests,
    requestsTo: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    reset: () => {
      requests.length = 0;
      total = 0;
      flakyCounts.clear();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
