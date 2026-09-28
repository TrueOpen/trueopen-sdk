import { selectTaskBuilders } from './builder-selection';
import type { BuilderSetMember } from './builder-selection';
import { nexusGrpcEndpoint } from '../types/hub';
import type { BuilderSetSnapshot, ServiceDescriptorRef } from '../types/hub';
import { TrueOpenError } from '../errors/errors';

/** Minimal reader capability needed by resolveTaskBuilderEndpoints (for easy test injection). */
export interface TaskBuilderReader {
  /** The BuilderSet in effect at `height` (node `builder_set/by_height/{height}`). */
  getBuilderSetAtHeight(height: bigint): Promise<BuilderSetSnapshot>;
  /** A builder's service descriptor (#41: inlined endpoints). */
  getServiceDescriptor(operatorAddress: string, participantType?: string): Promise<ServiceDescriptorRef>;
}

export interface ResolveTaskBuilderInput {
  readonly chainId: string;
  /** canonical lowercase 64-hex. */
  readonly taskId: string;
  /**
   * The builder_set_hash and session_anchor_block_hash signed into the order.
   * The selection seed is determined by these, and they must **match exactly** the
   * order the user signed, or the order will get sent to a set of Builders that were
   * never actually selected.
   */
  readonly builderSetHash: string;
  readonly sessionAnchorBlockHash: string;
  /**
   * The session_anchor_height signed into the order. The candidate pool is the BuilderSet in
   * effect at this height -- the same set the chain checks the order against -- never the
   * latest one.
   */
  readonly sessionAnchorHeight: bigint;
  /** Defaults to the active_builders of the BuilderSet at sessionAnchorHeight. */
  readonly members?: readonly BuilderSetMember[];
  readonly buildersPerTask?: number;
}

export interface TaskBuilderEndpoint {
  readonly address: string;
  readonly rank: number;
  readonly serviceEndpoint: string;
  /** On-chain tls_pubkey_hash (hex); an empty string means it isn't registered, so the https endpoint falls back to normal CA verification. */
  readonly tlsPubkeyHash?: string;
}

export interface ResolveTaskBuilderResult {
  /** The builder set id actually used (the same one signed into the order). */
  readonly builderSetId: string;
  readonly endpoints: TaskBuilderEndpoint[];
  readonly errors: { readonly address: string; readonly error: unknown }[];
}

/**
 * Select this task's Task Builders -> for each, fetch the nexus gRPC uri from the endpoints
 * inlined in the on-chain descriptor.
 *
 * Selection matches node's deriveTaskBuilderSelection (see builder-selection.ts): the seed
 * is determined by chain_id/task_id/builder_set_hash/session_anchor_block_hash, i.e. it is
 * **uniquely determined by the order the user signed**.
 *
 * Best-effort per builder: if a single descriptor cannot be fetched it is recorded in
 * errors without blocking the rest.
 */
export async function resolveTaskBuilderEndpoints(
  reader: TaskBuilderReader,
  input: ResolveTaskBuilderInput,
): Promise<ResolveTaskBuilderResult> {
  const snapshot = await reader.getBuilderSetAtHeight(input.sessionAnchorHeight);
  // The signed set and the set whose members get contacted must be the same one; if the chain
  // disagrees at the anchor height, the order would be sent to Builders that were never selected.
  if (snapshot.setHash !== input.builderSetHash.toLowerCase()) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_BUILDER_SET_MISMATCH',
      `builder set ${snapshot.builderSetId} at anchor height ${input.sessionAnchorHeight} has hash ${snapshot.setHash}, ` +
        `but the order signs ${input.builderSetHash}`,
    );
  }
  // The active_builders returned by the by_height snapshot is the candidate pool at the
  // anchor height; when node actually selects, it filters once more by **live** status
  // (slashed members must be excluded from new tasks), but the snapshot cannot read live
  // status. So this treats all of them as ACTIVE; callers needing strict consistency can
  // pass members explicitly.
  const members: readonly BuilderSetMember[] =
    input.members ??
    snapshot.builders
      .split(',')
      .map((a) => a.trim())
      .filter((a) => a !== '')
      .map((address) => ({ address, status: 'BUILDER_STATUS_ACTIVE' }));

  const selected = selectTaskBuilders({
    chainId: input.chainId,
    taskId: input.taskId,
    builderSetHash: input.builderSetHash,
    sessionAnchorBlockHash: input.sessionAnchorBlockHash,
    members,
    ...(input.buildersPerTask !== undefined ? { buildersPerTask: input.buildersPerTask } : {}),
  });

  const endpoints: TaskBuilderEndpoint[] = [];
  const errors: { address: string; error: unknown }[] = [];
  for (const s of selected) {
    try {
      const ref = await reader.getServiceDescriptor(s.address);
      const endpoint = nexusGrpcEndpoint(ref);
      if (!endpoint || endpoint.uri === '') {
        throw new TrueOpenError(
          'CHAIN_REJECT',
          'TASK_BUILDER_NO_NEXUS_ENDPOINT',
          `builder ${s.address} descriptor has no SERVICE_ENDPOINT_KIND_NEXUS_GRPC endpoint`,
        );
      }
      endpoints.push({ address: s.address, rank: s.rank, serviceEndpoint: endpoint.uri, tlsPubkeyHash: endpoint.tlsPubkeyHash ?? '' });
    } catch (error) {
      errors.push({ address: s.address, error });
    }
  }
  return { builderSetId: snapshot.builderSetId, endpoints, errors };
}
