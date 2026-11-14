// SSRF guard (design §7.1). Destinations are user-supplied URLs; without this, a user could
// make RelayForge call internal services (cloud metadata at 169.254.169.254, the database,
// localhost admin ports) and read the responses in the attempt log.
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

const IPV4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const IPV6_BLOCKED: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  // IPv4-mapped (::ffff:0:0/96) is deliberately absent: node's BlockList matches IPv4
  // addresses against mapped IPv6 rules, which would block every IPv4 address. Mapped
  // addresses are unwrapped and checked against the IPv4 list instead (embeddedIpv4).
  ['64:ff9b::', 96], // NAT64 (reaches IPv4 through a translator)
];

const blockList = new BlockList();
for (const [network, prefix] of IPV4_BLOCKED) blockList.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of IPV6_BLOCKED) blockList.addSubnet(network, prefix, 'ipv6');

/** True if connecting to this IP address is not allowed. Non-IP input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockList.check(address, 'ipv4');
  if (version === 6) {
    if (blockList.check(address, 'ipv6')) return true;
    const embedded = embeddedIpv4(address);
    return embedded !== null && blockList.check(embedded, 'ipv4');
  }
  return true;
}

/** The IPv4 address inside an IPv4-mapped/compatible IPv6 address in dotted form, if any. */
function embeddedIpv4(address: string): string | null {
  const dotted = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1] ?? null;
  // Hex form, e.g. ::ffff:7f00:1 (= 127.0.0.1).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const hi = parseInt(hex[1]!, 16);
  const lo = parseInt(hex[2]!, 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

export class SsrfBlockedError extends Error {
  readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

export type ResolvedAddress = { address: string; family: number };
export type ResolveFn = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolve: ResolveFn = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

// The message never says WHICH address was blocked: echoing resolved internal IPs back to
// the user would turn the guard into a network-mapping oracle.
const BLOCKED_MESSAGE = 'destination resolves to an address that is not allowed';

/** Resolves and vets a hostname (or IP literal). Throws SsrfBlockedError if any address is blocked. */
export async function resolveAllowed(
  hostname: string,
  options: { allowPrivate: boolean; resolve?: ResolveFn },
): Promise<ResolvedAddress[]> {
  const literal = isIP(hostname);
  const addresses =
    literal !== 0
      ? [{ address: hostname, family: literal }]
      : await (options.resolve ?? systemResolve)(hostname);
  if (addresses.length === 0) {
    throw Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' });
  }
  // Reject if ANY address is blocked, not just pick a safe one: an attacker controls the DNS
  // answer and can mix a public address with an internal one.
  if (!options.allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) {
    throw new SsrfBlockedError(BLOCKED_MESSAGE);
  }
  return addresses;
}

/**
 * A `lookup` for node:http/https that only ever hands back vetted addresses. The socket
 * connects to exactly what was checked — there is no second DNS resolution between check
 * and connect, so DNS rebinding (answer "public" to the check, "internal" to the connect)
 * doesn't work.
 */
export function createGuardedLookup(options: {
  allowPrivate: boolean;
  resolve?: ResolveFn;
}): LookupFunction {
  const lookup = (
    hostname: string,
    lookupOptions: { family?: number | string; all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    resolveAllowed(hostname, options).then(
      (addresses) => {
        const family = Number(lookupOptions.family) || 0;
        const usable = family === 0 ? addresses : addresses.filter((a) => a.family === family);
        const first = usable[0];
        if (!first) {
          callback(
            Object.assign(new Error(`no IPv${family} address for ${hostname}`), {
              code: 'ENOTFOUND',
            }),
          );
        } else if (lookupOptions.all) {
          callback(null, usable);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => callback(error),
    );
  };
  return lookup as unknown as LookupFunction;
}
