/**
 * The fixed identities and chain facts of the simulated network.
 *
 * Everything here is deterministic: the order the full flow signs, and therefore its task_hash,
 * depends only on these values. The Worker-signed output stream in
 * `fixtures/output-stream.json` was generated for that task_hash (see
 * `fixtures/gen/output_stream_gen.go`), so a change here that moves the task_hash needs the
 * fixture regenerated. The full flow test asserts the match and says so when it breaks.
 */
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ethSecp256k1Address } from '../../../src/signer/eth-secp256k1';
import { defaultGenerationParams } from '../../../src/order/task-order-input';
import type { TaskOrderIntent } from '../../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../../src/order/task-order';

const enc = new TextEncoder();

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const unhex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, 'hex'));
/** Deterministic 32-byte value from a label, as lowercase hex. */
export const label32 = (label: string): string => hex(sha256(enc.encode(label)));

export const PREFIX = 'trueopen';
export const CHAIN_ID = 'trueopen-interop-1';
export const EVM_CHAIN_ID = 424242n;
export const BUSINESS_DENOM = 'uusdc';

/** Latest block height when a world starts; the SDK anchors orders two blocks below it. */
export const LATEST_HEIGHT = 1000n;
export const ANCHOR_HEIGHT = LATEST_HEIGHT - 2n;

export interface Identity {
  readonly privKey: Uint8Array;
  readonly pubKey: Uint8Array;
  readonly address: string;
}

export function identity(privKeyHex: string): Identity {
  const privKey = unhex(privKeyHex);
  const pubKey = secp256k1.getPublicKey(privKey, true);
  return { privKey, pubKey, address: ethSecp256k1Address(pubKey, PREFIX) };
}

/** The user placing orders. */
export const USER = identity('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');

/** The winner Worker: its operator address and its service key (the key that signs output frames). */
export const WORKER_OPERATOR = 'trueopen15zs69gay5kn2029f4246etdw47ctrv4ns6facc';
export const WORKER_SERVICE = identity('3131313131313131313131313131313131313131313131313131313131313131');

/** Six Builder operators: the first three form the set in effect at the anchor. */
export const BUILDERS: readonly Identity[] = [0, 1, 2, 3, 4, 5].map((i) => identity(label32(`e2e-builder-${i}`)));

export interface BuilderSetFact {
  readonly id: string;
  readonly version: bigint;
  readonly effectiveHeight: bigint;
  readonly members: readonly string[];
  readonly hash: string;
}

export const SET_A: BuilderSetFact = {
  id: 'e2e-set-1',
  version: 1n,
  effectiveHeight: 900n,
  members: BUILDERS.slice(0, 3).map((b) => b.address),
  hash: label32('e2e-builder-set-1'),
};

/** A later set that takes effect between the anchor and the latest block. */
export const SET_B: BuilderSetFact = {
  id: 'e2e-set-2',
  version: 2n,
  effectiveHeight: ANCHOR_HEIGHT + 1n,
  members: BUILDERS.slice(3, 6).map((b) => b.address),
  hash: label32('e2e-builder-set-2'),
};

/** Beacon block hash for a height (what the session anchor signs). */
export const beaconBlockHash = (height: bigint): string => label32(`e2e-block-${height}`);

export const MODEL_ID = label32('e2e-model');
export const PROFILE_VERSION = 1;
export const TIMEOUT_BUCKET_VERSION = 3n;
export const PRICING = { initialOutputPrice: 1n, minOrderValue: 10n, verifyRatioBps: 1000n };

/** node derives a session id from its owner and nonce; the fake chain uses this stand-in. */
export const sessionIdFor = (owner: string, nonce: bigint): string => label32(`e2e-session|${owner}|${nonce}`);

export const PAYLOAD = enc.encode('Say hello to the world, in a few languages.');

/**
 * The order intent the full flow signs. order_value = floor(256 x 100000 / 1e6) = 25 for the
 * Worker plus 10% for verifiers = 27, above the profile minimum of 10 and within max_fee.
 */
export function orderIntent(overrides: Partial<TaskOrderIntent> = {}): TaskOrderIntent {
  return {
    modelId: MODEL_ID,
    profileVersion: PROFILE_VERSION,
    taskType: TASK_TYPE.TEXT_GENERATION,
    payload: PAYLOAD,
    inputBucket: 1,
    outputBudgetBucket: 1,
    generationParams: defaultGenerationParams(256n, 30_000n),
    amounts: {
      priceBid: { atomicUnits: '100000' },
      maxFee: { atomicUnits: '1000' },
      assignmentPriorityFee: { atomicUnits: '0' },
      txFeeReserve: { atomicUnits: '100' },
    },
    earliestSubmitHeight: LATEST_HEIGHT,
    orderExpireHeight: LATEST_HEIGHT + 400n,
    latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
    ...overrides,
  };
}
