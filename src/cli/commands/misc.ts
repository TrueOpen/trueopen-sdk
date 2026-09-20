import { HubReader, resolveBuilderEndpoints } from '../../index';
import { deriveIdentity, fetchLike } from '../context';
import type { CliConfig } from '../config';

/** trueopen address -- mnemonic -> bech32 address + compressed public key. */
export async function cmdAddress(cfg: CliConfig, mnemonic: string): Promise<unknown> {
  const id = await deriveIdentity(mnemonic, cfg.prefix);
  return { address: id.address, pubKey: id.pubKey };
}

/** trueopen builders -- on-chain discovery of nexus endpoints (builders + serviceDescriptor + verification hash). */
export async function cmdBuilders(cfg: CliConfig): Promise<unknown> {
  const hub = new HubReader({ baseUrl: cfg.requireRest(), fetch: fetchLike });
  const builderSet = await hub.getActiveBuilderSet();
  const { endpoints, errors } = await resolveBuilderEndpoints(hub);
  return {
    builderSet,
    endpoints,
    errors: errors.map((e) => ({ builder: e.builderAddress, error: String((e.error as Error)?.message ?? e.error) })),
  };
}
