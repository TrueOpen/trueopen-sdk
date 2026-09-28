import { describe, it, expect } from 'vitest';
import { isPublicAddress, parseIpv6 } from '../../src/manifest/address-policy';

describe('address policy for untrusted manifest_uri fetches', () => {
  it.each([
    // IPv4
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback range'],
    ['10.0.0.1', '10/8'],
    ['172.16.0.1', '172.16/12 start'],
    ['172.31.255.255', '172.16/12 end'],
    ['192.168.1.1', '192.168/16'],
    ['169.254.0.1', 'link-local'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'CGNAT'],
    ['100.100.100.200', 'CGNAT-hosted metadata'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['240.0.0.1', 'reserved'],
    ['192.0.2.1', 'documentation'],
    ['198.18.0.1', 'benchmarking'],
    // IPv6
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone'],
    ['febf::1', 'link-local end'],
    ['fc00::1', 'unique-local'],
    ['fd00:ec2::254', 'EC2 IPv6 metadata'],
    ['ff02::1', 'multicast'],
    ['fec0::1', 'site-local'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback in hex'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata'],
    ['::127.0.0.1', 'IPv4-compatible'],
    ['64:ff9b::a00:1', 'NAT64 of 10.0.0.1'],
    ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'],
    ['2002:a00:1::1', '6to4 of 10.0.0.1'],
    ['2001::1', 'Teredo'],
    ['2001:db8::1', 'documentation'],
    // RFC 9637 documentation is 3fff::/20, i.e. 3fff:0000:: through 3fff:0fff:ffff...
    ['3fff::1', 'documentation 3fff::/20'],
    ['3fff:0fff:ffff:ffff:ffff:ffff:ffff:ffff', 'documentation 3fff::/20 upper bound'],
    ['100::1', 'discard-only'],
    // Not an address at all
    ['', 'empty'],
    ['localhost', 'name'],
    ['1.2.3', 'short IPv4'],
    ['010.0.0.1', 'leading zero'],
    ['1::2::3', 'two ::'],
  ])('refuses %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each([
    ['93.184.216.34'],
    ['8.8.8.8'],
    ['172.32.0.1'],
    ['100.128.0.1'],
    ['169.253.255.255'],
    ['2606:4700:4700::1111'],
    ['2a00:1450::1'],
    // Just outside RFC 9637's 3fff::/20 on either side. The policy must not widen to
    // 3ff0::/12, which would blanket-refuse reserved-but-allocatable global unicast.
    ['3ffe::1'],
    ['3ff0::1'],
    ['3fff:1000::1'],
    ['::ffff:93.184.216.34'],
    ['64:ff9b::5db8:d822'],
    ['2002:5db8:d822::1'],
  ])('allows the public address %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it('parses IPv6 text forms', () => {
    expect(parseIpv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    expect(parseIpv6('::1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0, 0x102, 0x304]);
    expect(parseIpv6('1:2:3:4:5:6:1.2.3.4')).toEqual([1, 2, 3, 4, 5, 6, 0x102, 0x304]);
    expect(parseIpv6('1::')).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6('1:2:3:4:5:6:7:8:9')).toBeUndefined();
  });
});
