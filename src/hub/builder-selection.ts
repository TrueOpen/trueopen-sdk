import { canonicalHashBytes } from '../codec/domain-hash';
import { canonicalOperatorAddressBytes } from '../codec/address';
import { fromHex, toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';

const enc = new TextEncoder();

/** Number of Task Builders selected per task (node builders_per_task). */
export const BUILDERS_PER_TASK = 3;

/** §1.4 domain registry: Task Builder selection seed and ranking. */
export const DOMAIN_TASK_BUILDERS_V1 = 'TRUEOPEN_TASK_BUILDERS_V1';
export const DOMAIN_TASK_BUILDER_RANK_V1 = 'TRUEOPEN_TASK_BUILDER_RANK_V1';

/** A builder set member (selection only considers ACTIVE). */
export interface BuilderSetMember {
  readonly address: string;
  /** node BuilderStatus name, e.g. BUILDER_STATUS_ACTIVE. */
  readonly status: string;
}

export interface TaskBuilderSelectionInput {
  readonly chainId: string;
  /** canonical lowercase 64-hex. */
  readonly taskId: string;
  /** canonical lowercase 64-hex, from the builder set snapshot signed into the order. */
  readonly builderSetHash: string;
  /** canonical lowercase 64-hex, the **same value** as session_anchor_block_hash in the order. */
  readonly sessionAnchorBlockHash: string;
  readonly members: readonly BuilderSetMember[];
  readonly buildersPerTask?: number;
}

export interface SelectedBuilder {
  readonly address: string;
  /** 1-based rank. */
  readonly rank: number;
  /** Digest of this builder's rank (lowercase 64-hex), useful for debugging. */
  readonly rankHash: string;
}

/**
 * task_builder_seed = H_FIELDS_V1("TRUEOPEN_TASK_BUILDERS_V1",
 *   utf8(chain_id), task_id, builder_set_hash, session_anchor_block_hash)
 * Mirrors node x/task/types/task_order.go:TaskBuilderSeed.
 *
 * The seed depends on the session_anchor_block_hash signed into the order -- meaning the
 * selection result is uniquely determined by the order the user signed. The SDK must
 * compute it with **that same anchor**, or it will send to a set of Builders that were
 * never actually selected.
 */
export function taskBuilderSeed(
  chainId: string,
  taskId: string,
  builderSetHash: string,
  sessionAnchorBlockHash: string,
): Uint8Array {
  return canonicalHashBytes(
    enc.encode(DOMAIN_TASK_BUILDERS_V1),
    enc.encode(chainId),
    hash32('task_id', taskId),
    hash32('builder_set_hash', builderSetHash),
    hash32('session_anchor_block_hash', sessionAnchorBlockHash),
  );
}

/**
 * task_builder_rank = H_FIELDS_V1("TRUEOPEN_TASK_BUILDER_RANK_V1", seed, address codec bytes)
 * Mirrors node TaskBuilderRank. What goes into the preimage is the address's codec bytes,
 * not its bech32 text.
 */
export function taskBuilderRank(seed: Uint8Array, builderAddress: string): Uint8Array {
  if (seed.length !== 32) {
    throw invalid('SDK_LOCAL_BAD_SEED_LEN', `task_builder_seed must be 32 bytes, got ${seed.length}`);
  }
  return canonicalHashBytes(
    enc.encode(DOMAIN_TASK_BUILDER_RANK_V1),
    seed,
    canonicalOperatorAddressBytes('builder_operator_address', builderAddress),
  );
}

/**
 * Reproduces node's Task Builder selection
 * (x/task/keeper/task_builder_selection_runtime.go:deriveTaskBuilderSelection):
 *
 *   1. Only BUILDER_STATUS_ACTIVE members participate -- the set stays frozen for audit
 *      and for existing tasks, but slashed members must be excluded from new tasks;
 *   2. rank = TaskBuilderRank(seed, address);
 *   3. sort ascending by rank bytes, breaking ties ascending by **address codec bytes**
 *      (the node fixture's sort field: rank_bytes_asc_then_address_codec_bytes_asc --
 *      note this is not bech32 text order);
 *   4. take the first buildersPerTask entries.
 *
 * The old TRUEOPEN_BUILDER_STAGE1_V1 scheme (with termId / sessionId / stageRef) has been
 * removed from node.
 */
export function selectTaskBuilders(input: TaskBuilderSelectionInput): SelectedBuilder[] {
  const want = input.buildersPerTask ?? BUILDERS_PER_TASK;
  const seed = taskBuilderSeed(
    input.chainId,
    input.taskId,
    input.builderSetHash,
    input.sessionAnchorBlockHash,
  );

  const seen = new Set<string>();
  const ranked: Array<{ address: string; addressBytes: Uint8Array; rank: Uint8Array }> = [];
  for (const member of input.members) {
    const address = member.address.trim();
    if (address === '') continue;
    const addressBytes = canonicalOperatorAddressBytes('builder_set member', address);
    if (seen.has(address)) {
      throw invalid('SDK_LOCAL_BUILDER_SET_DUPLICATE', `BuilderSet contains duplicate member ${address}`);
    }
    seen.add(address);
    if (member.status !== 'BUILDER_STATUS_ACTIVE') continue;
    ranked.push({ address, addressBytes, rank: taskBuilderRank(seed, address) });
  }

  if (ranked.length < want) {
    throw invalid(
      'SDK_LOCAL_BUILDER_SET_TOO_SMALL',
      `BuilderSet has ${ranked.length} currently eligible members, need ${want}`,
    );
  }

  ranked.sort((a, b) => compareBytes(a.rank, b.rank) || compareBytes(a.addressBytes, b.addressBytes));
  return ranked.slice(0, want).map((r, i) => ({ address: r.address, rank: i + 1, rankHash: toHex(r.rank) }));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

function hash32(field: string, hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw invalid('SDK_LOCAL_NOT_HASH32', `${field} must be canonical lowercase 64-hex Hash32`);
  }
  return fromHex(hex);
}

function invalid(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}
