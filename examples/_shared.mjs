// Shared helpers for the examples. They import from ../dist, so run `npm run build` first.
import { Bip39, Slip10, Slip10Curve, EnglishMnemonic, stringToPath } from '@cosmjs/crypto';
import { createConnectTransport } from '@connectrpc/connect-node';
import { privKeySecp256k1Signer, secp256k1PublicKey, ethSecp256k1Address, nexusHttpBaseUri, TRUEOPEN_HD_PATH } from '../dist/index.js';

/** Read an environment variable; exit with an error when it is missing and has no default. */
export function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    console.error(`\n[missing environment variable] ${name}\nsee examples/README.md`);
    process.exit(1);
  }
  return v;
}

/** Derive an identity from a mnemonic. The protocol HD path uses coin_type 60, not the 118 Cosmos usually takes. */
export async function deriveIdentity(mnemonic, prefix) {
  const seed = await Bip39.mnemonicToSeed(new EnglishMnemonic(mnemonic));
  const { privkey } = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath(TRUEOPEN_HD_PATH));
  const signer = privKeySecp256k1Signer(privkey);
  const pubKey = secp256k1PublicKey(privkey);
  const address = ethSecp256k1Address(pubKey, prefix);
  return { privkey, signer, pubKey, address };
}

/** Connect transport for the nexus IngressAPI. On-chain endpoints use a grpc scheme, so normalise it to http(s) first. */
export function nexusTransport(url) {
  return createConnectTransport({ baseUrl: nexusHttpBaseUri(url), httpVersion: '1.1' });
}

/** The FetchLike that RestChainReader / HubReader expect; the Node global fetch matches it structurally. */
export const fetchLike = (url) => fetch(url);

/** Fetch the raw bytes of a Builder descriptor document. The devnet :8080 endpoint actually speaks http, so downgrade https to http. */
export async function fetchDescriptorBytes(url) {
  const httpUrl = url.replace(/^https:/, 'http:');
  const res = await fetch(httpUrl);
  if (!res.ok) throw new Error(`fetch ${httpUrl} -> HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Print JSON under a heading, with bigint values rendered as strings. */
export function show(label, obj) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}
