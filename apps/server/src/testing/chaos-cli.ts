// Runs the chaos receiver as a standalone process: load tests, demos, and the public demo
// service (same Docker image, start command `node apps/server/src/testing/chaos-cli.ts`).
//   node apps/server/src/testing/chaos-cli.ts 4100        (local)
//   PORT=8080 HOST=0.0.0.0 node apps/server/src/testing/chaos-cli.ts   (container)
// Public-safe limits: 1 MB request bodies, last 1,000 requests kept, /hang gives up after 60 s.
// Prints request counts every 5 s. Not used by the test suite.
import { startChaosReceiver } from './chaos-receiver.ts';

const port = Number(process.argv[2] ?? process.env['PORT'] ?? 4100);
const receiver = await startChaosReceiver(port, {
  host: process.env['HOST'] ?? '127.0.0.1',
  maxBodyBytes: 1024 * 1024,
  maxRequests: 1000,
  hangMs: 60_000,
});
console.log(`chaos receiver listening on port ${port}`);
let last = 0;
const timer = setInterval(() => {
  const total = receiver.total();
  if (total !== last) console.log(`received ${total} requests (+${total - last})`);
  last = total;
}, 5000);
const stop = () => {
  clearInterval(timer);
  void receiver.close().then(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
