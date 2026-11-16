import { describe, expect, test, vi } from 'vitest';
import { buildApp } from './app.ts';
import { createDb, createPool } from './db/client.ts';
import { createShutdown } from './shutdown.ts';
import { TEST_DATABASE_URL } from './testing/test-support.ts';

describe('createShutdown', () => {
  test('closes the server and pool, then exits 0; repeated signals are ignored', async () => {
    const pool = createPool(TEST_DATABASE_URL);
    const app = buildApp({
      config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
      pool,
      db: createDb(pool),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const exit = vi.fn();
    const shutdown = createShutdown({ app, pool, timeoutMs: 5000, exit });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(app.server.listening).toBe(false);
    expect(pool.ended).toBe(true);
  });

  test('waits for an in-flight request to finish before exiting', async () => {
    const pool = createPool(TEST_DATABASE_URL);
    const app = buildApp({
      config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
      pool,
      db: createDb(pool),
    });
    let finished = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    app.get('/slow', async () => {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 200));
      finished = true;
      return { done: true };
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const request = fetch(`http://127.0.0.1:${address.port}/slow`);
    // Wait until the request is really inside the handler (a fixed sleep was flaky under load:
    // shutdown sometimes closed the server before the request had arrived).
    await started;
    const exit = vi.fn();
    await createShutdown({ app, pool, timeoutMs: 5000, exit })('SIGTERM');

    expect(finished).toBe(true);
    expect((await request).status).toBe(200);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('exits 1 when shutdown exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const pool = createPool(TEST_DATABASE_URL);
      const app = buildApp({
        config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
        pool,
        db: createDb(pool),
      });
      // A close that never finishes.
      app.close = (() => new Promise(() => {})) as unknown as typeof app.close;
      const exit = vi.fn();
      void createShutdown({ app, pool, timeoutMs: 1000, exit })('SIGTERM');

      await vi.advanceTimersByTimeAsync(1000);

      expect(exit).toHaveBeenCalledWith(1);
      await pool.end();
    } finally {
      vi.useRealTimers();
    }
  });

  test('exits 1 (and logs) when closing fails', async () => {
    const lines: string[] = [];
    const pool = createPool(TEST_DATABASE_URL);
    const app = buildApp({
      config: { LOG_LEVEL: 'error', NODE_ENV: 'test' },
      pool,
      db: createDb(pool),
      logStream: { write: (line) => void lines.push(line) },
    });
    app.close = (() => Promise.reject(new Error('close failed'))) as unknown as typeof app.close;
    const exit = vi.fn();

    await createShutdown({ app, pool, timeoutMs: 5000, exit })('SIGTERM');

    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(lines.join('')).toContain('shutdown failed');
    await pool.end();
  });

  test('stops the delivery worker (shorter budget) before closing the pool', async () => {
    const pool = createPool(TEST_DATABASE_URL);
    const app = buildApp({
      config: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
      pool,
      db: createDb(pool),
    });
    const order: string[] = [];
    const worker = {
      stop: vi.fn(async (ms: number) => {
        expect(ms).toBeGreaterThan(0);
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push(pool.ended ? 'worker-after-pool' : 'worker-stopped');
      }),
    };
    const exit = vi.fn();
    await createShutdown({ app, pool, worker, timeoutMs: 5000, exit })('SIGTERM');
    expect(worker.stop).toHaveBeenCalledWith(4000);
    expect(order).toEqual(['worker-stopped']);
    expect(pool.ended).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
