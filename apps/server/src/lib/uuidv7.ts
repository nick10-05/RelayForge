import { randomBytes, randomInt } from 'node:crypto';

// UUIDv7 (RFC 9562): 48-bit Unix ms timestamp | version 7 | 12-bit counter | variant | 62 random bits.
// The 12-bit counter (rand_a, "method 1") keeps ids from one process strictly increasing,
// even within the same millisecond or if the clock steps backwards.
let lastMs = -1;
let counter = 0;

export function uuidv7(now: number = Date.now()): string {
  let ms = now;
  if (ms <= lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1; // counter exhausted: borrow the next millisecond
      counter = 0;
    }
    ms = lastMs;
  } else {
    lastMs = ms;
    counter = randomInt(0, 0x800); // random start, leaving headroom for increments
  }

  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes.writeUInt8(0x70 | (counter >> 8), 6);
  bytes.writeUInt8(counter & 0xff, 7);
  bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8);

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The creation time encoded in a UUIDv7. */
export function uuidv7Timestamp(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}
