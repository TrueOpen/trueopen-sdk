/**
 * Node-only entry ("trueopen-sdk/node"): the SSRF-safe manifest downloader. Kept out of
 * the main entry so browser bundles never pull in node:https, node:dns or node:zlib.
 */
import { ManifestSource } from './manifest/manifest-source';
import type { ManifestSourceOptions } from './manifest/manifest-source';
import { createNodeManifestFetcher } from './manifest/node-fetcher';
import type { NodeManifestFetcherOptions } from './manifest/node-fetcher';

export { createNodeManifestFetcher } from './manifest/node-fetcher';
export type { NodeManifestFetcherOptions, HostResolver } from './manifest/node-fetcher';

export interface NodeManifestSourceOptions extends Omit<ManifestSourceOptions, 'fetcher' | 'trustedFetcher'> {
  /** Tuning for the manifest_uri downloader; the address policy stays on unless overridden here. */
  readonly fetcherOptions?: NodeManifestFetcherOptions;
}

/**
 * A ManifestSource with full downloader safety for the chain-provided manifest_uri.
 * Mirrors and the IPFS gateway are operator-configured, so they are fetched with the
 * same size and time limits but without the address policy (a local gateway such as
 * http://127.0.0.1:8080 must stay reachable).
 */
export function createNodeManifestSource(opts: NodeManifestSourceOptions): ManifestSource {
  const { fetcherOptions, ...rest } = opts;
  return new ManifestSource({
    ...rest,
    fetcher: createNodeManifestFetcher(fetcherOptions),
    trustedFetcher: createNodeManifestFetcher({ ...fetcherOptions, allowAddress: () => true, allowHttp: true }),
  });
}
