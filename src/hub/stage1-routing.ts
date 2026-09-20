import { selectTaskBuilders } from './builder-selection';
import type { BuilderSetMember } from './builder-selection';
import { nexusGrpcEndpoint } from '../types/hub';
import type { BuilderSetSnapshot, ServiceDescriptorRef } from '../types/hub';
import { TrueOpenError } from '../errors/errors';

/** Minimal reader capability needed by resolveTaskBuilderEndpoints (for easy test injection). */
export interface TaskBuilderReader {
  /** The builder set of the currently active term (term_id + members + set_hash). */
  getActiveBuilderSet(): Promise<BuilderSetSnapshot>;
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
  /** Defaults to reader.getActiveBuilderSet() (its active_builders is the candidate pool). */
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
  const snapshot = await reader.getActiveBuilderSet();
  // The active_builders returned by the by_height snapshot is the candidate pool for the
  // current term; when node actually selects, it filters once more by **live** status
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
