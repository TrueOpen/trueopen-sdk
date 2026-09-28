import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseManifestUri, isValidManifestUri, DEFAULT_MAX_MANIFEST_URI_BYTES } from '../../src/manifest/manifest-uri';

/** Every accepted and rejected form in wire testdata/v1/hub/manifest_uri_v1.json. */
const FIXTURE = JSON.parse(readFileSync('third_party/wire/testdata/v1/hub/manifest_uri_v1.json', 'utf8')) as {
  max_manifest_uri_bytes: number;
  accepted: { uri: string; case: string }[];
  rejected: { uri: string; reason: string }[];
};

describe('manifest_uri syntax (manifest_uri_v1.json)', () => {
  it('uses the fixture default length cap', () => {
    expect(DEFAULT_MAX_MANIFEST_URI_BYTES).toBe(FIXTURE.max_manifest_uri_bytes);
    expect(FIXTURE.accepted.length).toBeGreaterThan(0);
    expect(FIXTURE.rejected.length).toBeGreaterThan(0);
  });

  it.each(FIXTURE.accepted.map((c) => [c.case, c.uri]))('accepts: %s', (_name, uri) => {
    expect(() => parseManifestUri(uri, FIXTURE.max_manifest_uri_bytes)).not.toThrow();
  });

  it.each(FIXTURE.rejected.map((c) => [c.reason, c.uri]))('rejects: %s', (_name, uri) => {
    expect(isValidManifestUri(uri, FIXTURE.max_manifest_uri_bytes)).toBe(false);
  });
});

describe('manifest_uri parts', () => {
  it('https: host, port and path+query are kept verbatim', () => {
    const u = parseManifestUri('https://cdn.trueopen.example:8443/m/golden.json?rev=3&sig=AbC-_.~');
    expect(u).toEqual({
      scheme: 'https',
      uri: 'https://cdn.trueopen.example:8443/m/golden.json?rev=3&sig=AbC-_.~',
      host: 'cdn.trueopen.example',
      port: 8443,
      pathAndQuery: '/m/golden.json?rev=3&sig=AbC-_.~',
    });
    expect(parseManifestUri('https://models.trueopen.example')).toMatchObject({ pathAndQuery: '/' });
    expect(parseManifestUri('https://[2001:db8::1]:443/m.json')).toMatchObject({ host: '[2001:db8::1]', port: 443 });
  });

  it('ipfs: CID and path are split', () => {
    const u = parseManifestUri('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/manifests/golden.json');
    expect(u).toMatchObject({ scheme: 'ipfs', cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi', path: '/manifests/golden.json' });
  });

  it('reports the specific rule a rejected form breaks', () => {
    expect(() => parseManifestUri('https://user:pass@models.trueopen.example/m.json')).toThrow(/userinfo/);
    expect(() => parseManifestUri('https://a@b.example/m.json')).toThrow(/userinfo/);
    expect(() => parseManifestUri('ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi?x=1')).toThrow(/query/);
    expect(() => parseManifestUri('https://models.trueopen.example/m.json#top')).toThrow(/fragment/);
    expect(() => parseManifestUri('http://models.trueopen.example/m.json')).toThrow(/scheme/);
  });

  it('the length cap follows the chain parameter', () => {
    const uri = 'https://models.trueopen.example/m.json';
    expect(isValidManifestUri(uri, uri.length)).toBe(true);
    expect(isValidManifestUri(uri, uri.length - 1)).toBe(false);
  });

  it.each([
    ['IPv4-mapped IPv6 literal', 'https://[::ffff:1.2.3.4]/m.json'],
    ['IPv4-mapped IPv6 in hex groups', 'https://[::ffff:102:304]/m.json'],
    ['single zero group compressed', 'https://[2001:db8:0:1:1:1:1:1]/m.json'.replace(':0:', '::')],
    ['shorter zero run compressed instead of the longest', 'https://[2001::1:0:0:0:1]/m.json'],
    ['tie between zero runs not resolved to the first', 'https://[2001:db8:0:0:1::1]/m.json'],
    ['IPv6 leading zeros', 'https://[2001:0db8::1]/m.json'],
    ['all-digit TLD', 'https://models.123/m.json'],
    ['label ending in hyphen', 'https://bad-.example/m.json'],
    ['64-byte label', `https://${'a'.repeat(64)}.example/m.json`],
    ['path without leading slash after port', 'https://a.example:443x/m.json'],
    ['CIDv0 not sha2-256', 'ipfs://Qm1111111111111111111111111111111111111111111'],
    ['CIDv1 version 2', 'ipfs://bajqaaeaa'],
    ['query in https path position is fine but # is not', 'https://a.example/?q=1#'],
  ])('also rejects: %s', (_name, uri) => {
    expect(isValidManifestUri(uri)).toBe(false);
  });

  it.each([
    ['longest zero run compressed', 'https://[2001:0:0:1::1]/m.json'],
    ['first of two equal zero runs compressed', 'https://[2001:db8::1:0:0:1]/m.json'],
    ['IPv6 loopback literal is syntactically fine (refused at connect)', 'https://[::1]/m.json'],
    ['private IPv4 literal is syntactically fine (refused at connect)', 'https://10.0.0.1/m.json'],
  ])('also accepts: %s', (_name, uri) => {
    expect(isValidManifestUri(uri)).toBe(true);
  });
});
