// Runs the chaos receiver as a standalone process (load tests, demos):
//   node apps/server/src/testing/chaos-cli.ts 4100
// Prints request counts every 5 s. Not used by the test suite.
import { startChaosReceiver } from './chaos-receiver.ts';

const port = Number(process.argv[2] ?? 4100);
const receiver = await startChaosReceiver(port);
console.log(`chaos receiver listening on ${receiver.url}`);
let last = 0;
const timer = setInterval(() => {
  const total = receiver.requests.length;
  if (total !== last) console.log(`received ${total} requests (+${total - last})`);
  last = total;
  // Keep memory flat during long runs: counts matter here, not the bodies.
  if (receiver.requests.length > 100_000) receiver.requests.splice(0, 50_000);
}, 5000);
const stop = () => {
  clearInterval(timer);
  void receiver.close().then(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
