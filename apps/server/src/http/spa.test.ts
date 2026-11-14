// The built dashboard is served by Fastify on the same origin as the API (design §3).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { createTestApp } from '../testing/helpers.ts';
import { isSpaPage } from './spa.ts';

const webRoot = mkdtempSync(join(tmpdir(), 'rf-web-'));
mkdirSync(join(webRoot, 'assets'));
writeFileSync(join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(join(webRoot, 'assets', 'index-abc123.js'), 'console.log(1)');
writeFileSync(join(webRoot, 'favicon.svg'), '<svg/>');

const html = { accept: 'text/html,application/xhtml+xml' };

describe('dashboard (SPA) serving', () => {
  const t = createTestApp({}, { webRoot });
  const { app } = t;
  afterAll(async () => {
    await t.close();
    rmSync(webRoot, { recursive: true, force: true });
  });

  test('/ serves index.html, never cached (so a deploy is picked up at once)', async () => {
    const response = await app.inject({ url: '/', headers: html });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain('id="root"');
  });

  test('a client-side route (deep link / refresh) gets index.html', async () => {
    const response = await app.inject({ url: '/endpoints/0190a1b2/events', headers: html });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.body).toContain('id="root"');
  });

  test('hashed assets are cached for a year (the name changes when the content does)', async () => {
    const response = await app.inject({ url: '/assets/index-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  test('other static files are served but revalidated', async () => {
    const response = await app.inject({ url: '/favicon.svg' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-cache');
  });

  test('a missing asset is a real 404, not index.html (a broken deploy must not look fine)', async () => {
    const response = await app.inject({ url: '/assets/index-gone.js', headers: html });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'Not found' });
  });

  test('unknown API routes stay JSON 404s, even when the client accepts HTML', async () => {
    const response = await app.inject({ url: '/api/v1/nope', headers: html });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'Not found' });
  });

  test('API and health routes still win over the dashboard', async () => {
    expect((await app.inject({ url: '/healthz', headers: html })).json()).toEqual({
      status: 'ok',
    });
    const me = await app.inject({ url: '/api/v1/auth/me', headers: html });
    expect(me.statusCode).toBe(401);
  });

  test('non-GET requests to unknown paths are JSON 404s', async () => {
    const response = await app.inject({ method: 'POST', url: '/endpoints', headers: html });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toMatch(/json/);
  });

  test('the security headers apply to the dashboard too', async () => {
    const response = await app.inject({ url: '/', headers: html });
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });
});

describe('without a built dashboard', () => {
  const t = createTestApp();
  afterAll(() => t.close());

  test('/ is a JSON 404 (the API runs on its own)', async () => {
    const response = await t.app.inject({ url: '/', headers: html });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', message: 'Not found' });
  });
});

describe('isSpaPage', () => {
  const page = (method: string, url: string, accept = html.accept) =>
    isSpaPage({ method, url, headers: { accept } });

  test.each([
    ['GET', '/', true],
    ['GET', '/login', true],
    ['GET', '/endpoints/abc?tab=events', true],
    ['HEAD', '/endpoints', true],
    ['GET', '/api/v1/anything', false],
    ['GET', '/api', false],
    ['GET', '/in/some-slug', false],
    ['GET', '/healthz', false],
    ['GET', '/assets/app.js', false],
    ['GET', '/favicon.ico', false],
    ['POST', '/login', false],
  ])('%s %s → %s', (method, url, expected) => {
    expect(page(method, url)).toBe(expected);
  });

  test('requires the client to accept HTML (curl/fetch of JSON gets a JSON 404)', () => {
    expect(page('GET', '/login', 'application/json')).toBe(false);
    expect(isSpaPage({ method: 'GET', url: '/login', headers: {} })).toBe(false);
  });
});
