import { describe, expect, test } from 'vitest';
import {
  MASK,
  attemptOutcome,
  deliveryStatusView,
  headerRows,
  hexDump,
  noDeliveriesText,
  signatureReasonText,
  viewBody,
} from './event-view.ts';

const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('viewBody', () => {
  test('JSON objects and arrays are pretty-printed', () => {
    expect(viewBody({ encoding: 'utf8', data: '{"a":1,"b":[true]}' })).toEqual({
      kind: 'json',
      text: '{\n  "a": 1,\n  "b": [\n    true\n  ]\n}',
      cut: false,
    });
    expect(viewBody({ encoding: 'utf8', data: ' [1]' }).kind).toBe('json');
  });

  test('text that only looks like JSON stays text, exactly as received', () => {
    expect(viewBody({ encoding: 'utf8', data: '{not json' })).toEqual({
      kind: 'text',
      text: '{not json',
      cut: false,
    });
    expect(viewBody({ encoding: 'utf8', data: '42' }).kind).toBe('text');
  });

  test('HTML stays an inert string (rendered as text by React, never as markup)', () => {
    const data = '<img src=x onerror=alert(1)>';
    expect(viewBody({ encoding: 'utf8', data })).toEqual({ kind: 'text', text: data, cut: false });
  });

  test('long bodies are cut for display only', () => {
    const view = viewBody({ encoding: 'utf8', data: 'x'.repeat(50) }, 10);
    expect(view).toEqual({ kind: 'text', text: 'x'.repeat(10), cut: true });
  });

  test('empty bodies, text or binary', () => {
    expect(viewBody({ encoding: 'utf8', data: '' })).toEqual({ kind: 'empty' });
    expect(viewBody({ encoding: 'base64', data: '' })).toEqual({ kind: 'empty' });
  });

  test('binary bodies get a hex preview of the first 256 bytes', () => {
    const view = viewBody({ encoding: 'base64', data: b64(Array.from({ length: 300 }, () => 0)) });
    expect(view.kind).toBe('binary');
    if (view.kind !== 'binary') return;
    expect(view.previewBytes).toBe(256);
    expect(view.hex.split('\n')).toHaveLength(16);
  });
});

test('hexDump: offset, hex and printable ASCII', () => {
  expect(hexDump(new Uint8Array([0x00, 0x1f, 0x8b, 0x41, 0x42, 0x7f]))).toBe(
    `00000000  ${'00 1f 8b 41 42 7f'.padEnd(47)}  |...AB.|`,
  );
  const twoLines = hexDump(new Uint8Array(17).fill(0x61)).split('\n');
  expect(twoLines[1]).toBe(`00000010  ${'61'.padEnd(47)}  |a|`);
});

describe('headerRows', () => {
  test('sorted, one row per value, credentials flagged', () => {
    expect(
      headerRows({
        'x-b': 'two',
        Authorization: 'Bearer secret',
        cookie: 'sid=1',
        'x-a': ['first', 'second'],
      }),
    ).toEqual([
      { name: 'Authorization', value: 'Bearer secret', sensitive: true },
      { name: 'cookie', value: 'sid=1', sensitive: true },
      { name: 'x-a', value: 'first', sensitive: false },
      { name: 'x-a', value: 'second', sensitive: false },
      { name: 'x-b', value: 'two', sensitive: false },
    ]);
  });

  test('the mask reveals nothing about the value', () => {
    expect(MASK).not.toMatch(/secret|sid/);
  });
});

test('signature reasons have readable text and a safe fallback', () => {
  expect(signatureReasonText('mismatch')).toMatch(/did not match/);
  expect(signatureReasonText('timestamp_out_of_tolerance')).toMatch(/timestamp/);
  expect(signatureReasonText(null)).toBe('The signature could not be verified.');
  expect(signatureReasonText('something_new')).toBe('The signature could not be verified.');
});

test('delivery status view', () => {
  expect(deliveryStatusView({ status: 'succeeded', deadReason: null })).toEqual({
    label: 'succeeded',
    tone: 'green',
    detail: null,
  });
  expect(deliveryStatusView({ status: 'in_flight', deadReason: null }).label).toBe('sending');
  const dead = deliveryStatusView({ status: 'dead', deadReason: 'redirect' });
  expect(dead).toMatchObject({ label: 'dead', tone: 'red' });
  expect(dead.detail).toMatch(/redirect/);
});

test('attempt outcome: HTTP status, or the error when there was no response', () => {
  expect(attemptOutcome({ statusCode: 204, errorCode: null })).toEqual({
    label: 'HTTP 204',
    tone: 'green',
  });
  expect(attemptOutcome({ statusCode: 503, errorCode: null }).tone).toBe('red');
  expect(attemptOutcome({ statusCode: null, errorCode: 'TIMEOUT' })).toEqual({
    label: 'TIMEOUT',
    tone: 'red',
  });
  expect(attemptOutcome({ statusCode: null, errorCode: null }).label).toBe('no response');
});

test('no-deliveries text explains why', () => {
  expect(noDeliveriesText({ signatureStatus: 'invalid' })).toMatch(/signature was invalid/);
  expect(noDeliveriesText({ signatureStatus: 'not_checked' })).toMatch(/no enabled destinations/);
});
