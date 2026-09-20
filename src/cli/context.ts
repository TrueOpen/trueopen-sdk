import { Bip39, Slip10, Slip10Curve, EnglishMnemonic, stringToPath } from '@cosmjs/crypto';
import { GasPrice } from '@cosmjs/stargate';
import type { StdFee } from '@cosmjs/stargate';
import { Uint53 } from '@cosmjs/math';
import { nexusIngressTransport } from '../transport/nexus-tls';
import type { Transport } from '@connectrpc/connect';
import {
  TrueOpenClient,
  RestChainReader,
  HubReader,
  resolveBuilderEndpoints,
  connectTrueOpenChainClient,
  privKeySecp256k1Signer,
  secp256k1PublicKey,
  privKeyEip712Signer,
  ethSecp256k1Address,
  ethSecp256k1SignerFromMnemonic,
  TRUEOPEN_HD_PATH,

} from '../index';
import type { ChainClient, CosmosSecp256k1Signer } from '../index';
export { TRUEOPEN_HD_PATH };
import { TrueOpenError } from '../errors/errors';
import type { CliConfig } from './config';

export interface Identity {
  readonly privkey: Uint8Array;
  readonly signer: CosmosSecp256k1Signer;
  readonly pubKey: Uint8Array;
  readonly address: string;
}

export async function deriveIdentity(mnemonic: string, prefix: string): Promise<Identity> {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(TRUEOPEN_HD_PATH));
  const signer = privKeySecp256k1Signer(privkey);
  const pubKey = secp256k1PublicKey(privkey);
  return { privkey, signer, pubKey, address: ethSecp256k1Address(pubKey, prefix) };
}

/** A throwaway identity (a fixed dummy key), used only to satisfy TrueOpenClient construction for read-only commands; it never signs anything for real. */
const EPHEMERAL_PRIV = new Uint8Array(32).fill(1);
function ephemeralIdentity(prefix: string): Identity {
  const signer = privKeySecp256k1Signer(EPHEMERAL_PRIV);
  const pubKey = secp256k1PublicKey(EPHEMERAL_PRIV);
  return { privkey: EPHEMERAL_PRIV, signer, pubKey, address: ethSecp256k1Address(pubKey, prefix) };
}

/** FetchLike: Node's global fetch, structurally compatible with RestChainReader/HubReader. */
export const fetchLike = (url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> =>
  fetch(url) as unknown as Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Fetch the builder descriptor document bytes. Uses whatever scheme is written on chain; no longer downgrades https to http. */
export async function fetchDescriptorBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new TrueOpenError('CHAIN_REJECT', 'CLI_DESCRIPTOR_FETCH', `descriptor ${url} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * The Connect transport for the nexus IngressAPI.
 *
 * Endpoints in the on-chain descriptor may be `grpc://` (node seed) or `https://`, while Connect only
 * accepts an http(s) base URL; the normalization happens inside nexusIngressTransport.
 *
 * For https endpoints, the server certificate's public key is checked against the tls_pubkey_hash
 * registered on chain (transport/nexus-tls). When **no** hash is registered on chain, it falls back to
 * nexusTransportOptions's default transitional policy (`plaintext-fallback`: falls back to http and logs
 * a WARN only when the peer doesn't speak TLS at all; an untrusted certificate is never downgraded).
 * Setting `NEXUS_TLS_PUBKEY_HASH_REQUIRED=1` makes it reject unconditionally instead.
 *
 * The normalization lives here (rather than at each call site) so that the --auto single-endpoint path
 * and deterministic routing follow the same rules.
 */
export function nexusTransport(url: string, tlsPubkeyHash = ''): Transport {
  return nexusIngressTransport(url, tlsPubkeyHash);
}

/**
 * A --nexus-url manually specified by the operator: there's no on-chain descriptor to look up, so the
 * fingerprint must come from the caller.
 *
 * If `--nexus-tls-pubkey-hash` (or `TRUEOPEN_NEXUS_TLS_PUBKEY_HASH`) is given, the certificate public key
 * is checked against it, using the same PinnedHttpsAgent as the on-chain discovery path; if not given, it
 * falls back to CA chain verification, with no further downgrade. The latter is essentially unusable for
 * real deployments -- per ADR-0015 nexus certificates are self-signed, so CA chain verification will
 * always fail -- so a fingerprint should always be given alongside a manually specified https endpoint.
 */
export function explicitNexusTransport(url: string, tlsPubkeyHash = ''): Transport {
  if (tlsPubkeyHash.trim() !== '') return nexusIngressTransport(url, tlsPubkeyHash);
  return nexusIngressTransport(url, '', { unpinnedHttps: 'certificate-authority' });
}

/** A candidate nexus endpoint: the on-chain uri, the certificate public key hash (empty string if not registered), and the operator address of the Builder it belongs to. */
export interface NexusCandidate {
  readonly serviceEndpoint: string;
  readonly tlsPubkeyHash: string;
  /**
   * The operator address of the Builder this endpoint belongs to. Empty string for an explicit
   * --nexus-url -- a manually specified endpoint has no on-chain descriptor to look up, so there's no way
   * to know which Builder it represents.
   * This is required on the task data plane (fetchTaskOutput): nexus compares it byte-for-byte against
   * its own configuration.
   */
  readonly builderAddress: string;
}

/**
 * Candidate nexus endpoints: just the one when --nexus-url is explicit; **all** ACTIVE builder endpoints
 * when --auto is used.
 *
 * Why all of them rather than just the first: a task only exists on the handful of Task Builders selected
 * by task_builder_seed, and the selection seed depends on the anchor signed into the order -- when
 * checking status the caller only has (session, task) on hand, cannot recover the anchor, and so has no
 * way to work out who to ask. Taking the first one is just gambling (in practice it produces task not
 * found).
 */
export async function resolveNexusCandidates(cfg: CliConfig, hub: HubReader): Promise<string[]> {
  return (await resolveNexusCandidateEndpoints(cfg, hub)).map((e) => e.serviceEndpoint);
}

/** Same as resolveNexusCandidates, but also returns the on-chain tls_pubkey_hash, for verifying the certificate when connecting. */
export async function resolveNexusCandidateEndpoints(cfg: CliConfig, hub: HubReader): Promise<NexusCandidate[]> {
  // An explicit --nexus-url has no on-chain descriptor to look up: the fingerprint comes from --nexus-tls-pubkey-hash (may be empty).
  if (cfg.nexusUrl) return [{ serviceEndpoint: cfg.nexusUrl, tlsPubkeyHash: cfg.nexusTlsPubkeyHash ?? '', builderAddress: '' }];
  if (!cfg.auto) throw new TrueOpenError('SDK_LOCAL', 'CLI_MISSING_NEXUS', 'missing nexus endpoint: use --nexus-url or --auto');
  const { endpoints, errors } = await resolveBuilderEndpoints(hub);
  if (endpoints.length === 0) {
    throw new TrueOpenError('CHAIN_REJECT', 'CLI_AUTO_NO_ENDPOINT', `--auto found no available nexus endpoint${errors.length ? ` (${errors.length} error(s))` : ''}`);
  }
  return endpoints.map((e) => ({
    serviceEndpoint: e.serviceEndpoint,
    tlsPubkeyHash: e.tlsPubkeyHash ?? '',
    builderAddress: e.builderAddress,
  }));
}

/** Read-only chain: real reads over REST, writes throw (satisfies TrueOpenClient construction without allowing accidental writes). */
function readOnlyChain(restUrl: string): ChainClient {
  const reader = new RestChainReader({ baseUrl: restUrl, fetch: fetchLike });
  const die = async (): Promise<never> => {
    throw new TrueOpenError('SDK_LOCAL', 'CLI_WRITE_REQUIRES_RPC', 'this operation requires an on-chain transaction: please provide --rpc-url and a key');
  };
  return {
    querySession: (id) => reader.querySession(id),
    querySessionNonce: (a) => reader.querySessionNonce(a),
    querySettlementFinality: (s, t) => reader.querySettlementFinality(s, t),
    createSession: die,
    cancelOrder: die,
    userChallenge: die,
  };
}

export interface BuildNeeds {
  write?: boolean;
  nexus?: boolean;
  key?: boolean;
  /** Deterministic Stage-1 routing: assembles hub/fetchDescriptor/transportFactory, without pre-resolving a single nexus. */
  deterministic?: boolean;
}

export interface Ctx {
  client: TrueOpenClient;
  identity: Identity;
  /** All ACTIVE builder endpoints under --auto; contains only itself for an explicit --nexus-url. */
  nexusCandidates: string[];
  /** Same as nexusCandidates, but with the certificate fingerprint and the Builder operator address (the task data plane needs the latter). */
  nexusEndpoints: NexusCandidate[];
  /** A client bound to a specific endpoint (reuses the same chain/identity, no extra I/O). */
  clientFor(serviceEndpoint: string): TrueOpenClient;
  dispose(): Promise<void>;
}

/**
 * Query across candidate endpoints: try each one in turn until one responds.
 *
 * Task-level read commands (status / watch / output / challenge) only have local state on the Task
 * Builder that received the order; the others reply NOT_FOUND. So on NOT_FOUND we move on to the next
 * one, and on other errors we log and continue as well, only throwing an aggregated error once all have
 * failed.
 */
export async function queryAcrossNexus<T>(ctx: Ctx, run: (client: TrueOpenClient) => Promise<T>): Promise<T> {
  const failures: string[] = [];
  for (const endpoint of ctx.nexusCandidates) {
    try {
      return await run(ctx.clientFor(endpoint));
    } catch (e) {
      const err = e as { code?: unknown; rawMessage?: string; message?: string };
      failures.push(`${endpoint}: ${err.rawMessage ?? err.message ?? String(e)}`);
    }
  }
  throw new TrueOpenError(
    'NEXUS_INGRESS',
    'CLI_NO_NEXUS_HAS_TASK',
    `all ${ctx.nexusCandidates.length} candidate nexus endpoints have no such task or are unreachable:\n  ${failures.join('\n  ')}`,
    { retriable: true },
  );
}

/**
 * Assemble a TrueOpenClient with the minimal dependencies a command needs.
 * - key/write -> use the real mnemonic-derived identity (write also needs rpc/chainId); otherwise use a
 *   throwaway identity to satisfy construction.
 * - write -> connectTrueOpenChainClient(rpc+wallet) reads and writes chain; otherwise read-only chain
 *   (REST).
 * - nexus -> resolve nexus endpoints and build a transport; otherwise use a placeholder (never called).
 */
export async function buildContext(cfg: CliConfig, mnemonic: string | undefined, needs: BuildNeeds): Promise<Ctx> {
  const signing = needs.key === true || needs.write === true;
  const identity = signing ? await deriveIdentity(reqKey(mnemonic), cfg.prefix) : ephemeralIdentity(cfg.prefix);

  let chain: ChainClient;
  let dispose: () => Promise<void> = async () => {};
  if (needs.write) {
    // Use the ethsecp256k1 direct signer, not CosmJS's DirectSecp256k1HdWallet: the latter disagrees with
    // node app/account_ante.go on all three of address derivation, the DIRECT digest (sha256 vs. the
    // keccak256(SignDoc) that node requires), and the public key type URL.
    const wallet = await ethSecp256k1SignerFromMnemonic(reqKey(mnemonic), cfg.prefix);
    const accounts = await wallet.getAccounts();
    const account = accounts[0];
    if (!account) throw new TrueOpenError('SDK_LOCAL', 'CLI_NO_ACCOUNT', 'wallet has no account');
    // The chain-writing identity must be the same address as deriveIdentity, otherwise the signature diverges from the user_address in the order.
    if (account.address !== identity.address) {
      throw new TrueOpenError(
        'SDK_LOCAL',
        'CLI_SIGNER_ADDRESS_MISMATCH',
        `chain signer ${account.address} != identity ${identity.address}`,
      );
    }
    const conn = await connectTrueOpenChainClient({
      rpcUrl: cfg.requireRpc(),
      restUrl: cfg.requireRest(),
      signer: wallet,
      signerAddress: account.address,
      // **Cannot use fee: 'auto'**: it first sends a gas simulation, and CosmJS's simulate hardcodes the
      // sign mode to SIGN_MODE_UNSPECIFIED (@cosmjs/stargate modules/tx/queries.js). node's ante requires
      // exactly SIGN_MODE_DIRECT, so the simulation step itself gets rejected: "signer 0 uses an invalid
      // signature mode". So we compute an explicit fee ourselves here as gasPrice x gas.
      fee: explicitFee(cfg.gasPrice, cfg.gas),
    });
    chain = conn.client;
    dispose = async () => conn.signingClient.disconnect();
  } else {
    chain = readOnlyChain(cfg.requireRest());
  }

  // The EVM chain ID feeds into the EIP-712 domain separator; if not given explicitly, it's read from chain -- never guessed.
  const evmChainId =
    cfg.evmChainId ??
    (await new HubReader({ baseUrl: cfg.requireRest(), fetch: fetchLike }).getEvmChainId());

  let hubReader: HubReader | undefined;
  let candidates: NexusCandidate[] = [{ serviceEndpoint: 'http://nexus.unused.invalid', tlsPubkeyHash: '', builderAddress: '' }];
  if (needs.nexus) {
    hubReader = new HubReader({ baseUrl: cfg.requireRest(), fetch: fetchLike });
    // Deterministic routing: doesn't pre-resolve the endpoint (actual sending goes through transportFactory); other commands resolve all candidates.
    candidates = needs.deterministic
      ? [{ serviceEndpoint: cfg.nexusUrl ?? 'http://nexus.unused.invalid', tlsPubkeyHash: cfg.nexusTlsPubkeyHash ?? '', builderAddress: '' }]
      : await resolveNexusCandidateEndpoints(cfg, hubReader);
  }
  const nexusCandidates = candidates.map((c) => c.serviceEndpoint);
  const pinFor = (serviceEndpoint: string): string =>
    candidates.find((c) => c.serviceEndpoint === serviceEndpoint)?.tlsPubkeyHash ?? '';

  const clientFor = (serviceEndpoint: string): TrueOpenClient =>
    new TrueOpenClient({
      chainId: signing ? cfg.requireChainId() : (cfg.chainId ?? 'trueopen'),
      userAddress: identity.address,
      signerPubKey: identity.pubKey,
      signer: identity.signer,
      chain,
      ingressTransport: cfg.nexusUrl === serviceEndpoint
        ? explicitNexusTransport(serviceEndpoint, pinFor(serviceEndpoint))
        : nexusTransport(serviceEndpoint, pinFor(serviceEndpoint)),
      addressPrefix: cfg.prefix,
      // The order's inner signature is an EIP-712 digest (keccak, 65-byte R||S||V).
      // Note that Eip712Signer and Secp256k1DigestSigner have exactly the same function signature, so
      // TS's structural typing cannot catch a mix-up -- getting it wrong only surfaces inside
      // signAndEncodeOrder as "signature is not 65 bytes".
      orderSigner: privKeyEip712Signer(identity.privkey),
      evmChainId,
      feeDenom: cfg.feeDenom,
      ...(needs.deterministic && hubReader
        ? {
            hub: hubReader,
            fetchDescriptor: fetchDescriptorBytes,
            // scheme normalization has been pushed down into nexusTransport itself.
            ingressTransportFactory: nexusTransport,
          }
        : {}),
    });

  const first = nexusCandidates[0] as string;
  return { client: clientFor(first), identity, nexusCandidates, nexusEndpoints: candidates, clientFor, dispose };
}

/** The explicit StdFee for gasPrice x gas (rounded up; the chain charges in integer atomic units). */
function explicitFee(gasPrice: string, gas: string): StdFee {
  const price = GasPrice.fromString(gasPrice);
  const amount = price.amount.multiply(Uint53.fromString(gas)).ceil().toString();
  return { amount: [{ denom: price.denom, amount }], gas };
}

function reqKey(m: string | undefined): string {
  if (!m) throw new TrueOpenError('SDK_AUTH', 'CLI_MISSING_KEY', 'mnemonic required: set --key-file or TRUEOPEN_MNEMONIC');
  return m;
}
