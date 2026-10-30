import { canonicalOperatorAddressBytes } from '../codec/address';
import { TrueOpenError } from '../errors/errors';

/** A member of the immutable BuilderSet; live status does not filter membership. */
export interface BuilderSetMember {
  readonly address: string;
  /** node BuilderStatus name, e.g. BUILDER_STATUS_ACTIVE. */
  readonly status: string;
}

export interface TaskBuilderSelectionInput {
  readonly chainId: string;
  /** Hash32 text, `0x` + 64 lowercase hex. */
  readonly taskId: string;
  /** Hash32 text (`0x` + 64 lowercase hex), from the builder set snapshot signed into the order. */
  readonly builderSetHash: string;
  /** @deprecated Retired selection anchor; ignored. */
  readonly sessionAnchorBlockHash?: string;
  readonly members: readonly BuilderSetMember[];
  readonly buildersPerTask?: number;
  readonly dispatchingBuilder?: string;
}

export interface SelectedBuilder {
  readonly address: string;
  /** 1-based rank. */
  readonly rank: number;
  /** @deprecated Ranking hashes are retired; always empty. */
  readonly rankHash: string;
}

/** Complete immutable snapshot, in cyclic order beginning with the dispatching Builder.
 * Live status and buildersPerTask never filter or truncate this group.
 */
export function selectTaskBuilders(input: TaskBuilderSelectionInput): SelectedBuilder[] {
  const addresses = input.members.map((m) => m.address);
  const seen = new Set<string>();
  for (const address of addresses) {
    canonicalOperatorAddressBytes('builder_set member', address);
    if (seen.has(address)) throw invalid('SDK_LOCAL_BUILDER_SET_DUPLICATE', `duplicate Builder ${address}`);
    seen.add(address);
  }
  if (addresses.length === 0) throw invalid('SDK_LOCAL_BUILDER_SET_TOO_SMALL', 'BuilderSet is empty');
  const start = input.dispatchingBuilder === undefined ? 0 : addresses.indexOf(input.dispatchingBuilder);
  if (start < 0) throw invalid('SDK_LOCAL_BUILDER_NOT_IN_SNAPSHOT', 'dispatching Builder is not in the locked snapshot');
  return [...addresses.slice(start), ...addresses.slice(0, start)]
    .map((address, i) => ({ address, rank: i + 1, rankHash: '' }));
}

function invalid(code: string, message: string): TrueOpenError {
  return new TrueOpenError('SDK_LOCAL', code, message);
}
