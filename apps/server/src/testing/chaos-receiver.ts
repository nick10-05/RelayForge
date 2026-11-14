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
  reset: () => void;
  close: () => Promise<void>;
};

export async function startChaosReceiver(port = 0): Promise<ChaosReceiver> {
  const requests: ReceivedRequest[] = [];
  const flakyCounts = new Map<string, number>();
  const sockets = new Set<Socket>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
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
        return; // never respond
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
      case 'flaky': {
        const failures = Number(arg) || 1;
        const keyHeader = headers['x-relayforge-delivery-id'];
        const key = typeof keyHeader === 'string' ? keyHeader : path;
        const seen = flakyCounts.get(key) ?? 0;
        flakyCounts.set(key, seen + 1);
        return send(seen < failures ? 500 : 200);
      }
      default:
        return send(404);
    }
  }

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    requestsTo: (prefix) => requests.filter((r) => r.path.startsWith(prefix)),
    reset: () => {
      requests.length = 0;
      flakyCounts.clear();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
