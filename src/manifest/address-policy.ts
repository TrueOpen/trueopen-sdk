/**
 * Address policy for fetching an untrusted manifest_uri: only globally routable unicast
 * addresses may be connected to. Refused, for both families:
 * unspecified, loopback, private (RFC 1918), shared/CGNAT, link-local (including the
 * 169.254.169.254 cloud metadata address), unique-local (including fd00:ec2::254),
 * multicast, reserved, benchmarking and documentation ranges, and the IPv6 transition
 * ranges whose embedded IPv4 address is itself refused (IPv4-mapped, NAT64, 6to4).
 * Text that does not parse as an IP address is refused too (fail closed).
 */

type Cidr4 = readonly [number, number];

const V4_BLOCKED: readonly Cidr4[] = [
  [ip4('0.0.0.0'), 8], // "this network", includes 0.0.0.0
  [ip4('10.0.0.0'), 8], // private
  [ip4('100.64.0.0'), 10], // shared address space (CGNAT, some cloud metadata)
  [ip4('127.0.0.0'), 8], // loopback
  [ip4('169.254.0.0'), 16], // link-local, cloud metadata 169.254.169.254
  [ip4('172.16.0.0'), 12], // private
  [ip4('192.0.0.0'), 24], // IETF protocol assignments
  [ip4('192.0.2.0'), 24], // documentation
  [ip4('192.88.99.0'), 24], // 6to4 relay anycast
  [ip4('192.168.0.0'), 16], // private
  [ip4('198.18.0.0'), 15], // benchmarking
  [ip4('198.51.100.0'), 24], // documentation
  [ip4('203.0.113.0'), 24], // documentation
  [ip4('224.0.0.0'), 4], // multicast
  [ip4('240.0.0.0'), 4], // reserved, includes 255.255.255.255
];

function ip4(s: string): number {
  const v = parseIpv4(s);
  if (v === undefined) throw new Error(`bad constant ${s}`);
  return v;
}

/** Parses dotted-decimal IPv4 into an unsigned 32-bit number. */
export function parseIpv4(s: string): number | undefined {
  const parts = s.split('.');
  if (parts.length !== 4) return undefined;
  let v = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p) || Number(p) > 255) return undefined;
    v = v * 256 + Number(p);
  }
  return v;
}

/** Parses IPv6 text (with optional dotted-quad tail and zone) into eight 16-bit groups. */
export function parseIpv6(input: string): number[] | undefined {
  let s = input;
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  if (s.includes('.')) {
    const v4 = parseIpv4(s.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    tail = [v4 >>> 16, v4 & 0xffff];
    // Keep a trailing "::" intact; otherwise drop the separator before the IPv4 tail.
    const prefix = s.slice(0, lastColon + 1);
    s = prefix.endsWith('::') ? prefix : prefix.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]!);
  if (head === undefined) return undefined;
  if (halves.length === 1) {
    const all = [...head, ...tail];
    return all.length === 8 ? all : undefined;
  }
  const rest = parse(halves[1]!);
  if (rest === undefined) return undefined;
  const known = head.length + rest.length + tail.length;
  if (known > 7) return undefined;
  return [...head, ...new Array<number>(8 - known).fill(0), ...rest, ...tail];
}

function v4Blocked(v: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((v & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

function v6Blocked(g: number[]): boolean {
  const zeros = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0);
  const embeddedV4 = (hi: number, lo: number): number => ((hi << 16) >>> 0) + lo;

  if (zeros(0, 5) && g[5] === 0xffff) return v4Blocked(embeddedV4(g[6]!, g[7]!)); // IPv4-mapped ::ffff:0:0/96
  if (zeros(0, 6)) return true; // ::, ::1 and deprecated IPv4-compatible ::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4Blocked(embeddedV4(g[6]!, g[7]!)); // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x100 && zeros(1, 4)) return true; // discard-only 100::/64
  if (g[0] === 0x2001 && g[1]! < 0x200) return true; // IETF protocol assignments 2001::/23 (Teredo, benchmarking)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation 2001:db8::/32
  if (g[0] === 0x2002) return v4Blocked(embeddedV4(g[1]!, g[2]!)); // 6to4 2002::/16
  if ((g[0]! & 0xfff0) === 0x3ff0 && g[0]! <= 0x3fff) return true; // documentation 3fff::/20
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7 (fd00:ec2::254 metadata)
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // deprecated site-local fec0::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** Whether an untrusted-URL fetch may connect to this address. */
export function isPublicAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const g = parseIpv6(ip);
    return g !== undefined && !v6Blocked(g);
  }
  const v = parseIpv4(ip);
  return v !== undefined && !v4Blocked(v);
}
