import { selectTaskBuilders } from './builder-selection';
import type { BuilderSetMember } from './builder-selection';
import { nexusGrpcEndpoint } from '../types/hub';
import type { BuilderSetSnapshot, ServiceDescriptorRef } from '../types/hub';
import { TrueOpenError } from '../errors/errors';
import { strictHash32 } from '../codec/hash32';

/** Minimal reader capability needed by resolveTaskBuilderEndpoints (for easy test injection). */
export interface TaskBuilderReader {
  /** The BuilderSet in effect at `height` (node `builder_set/by_height/{height}`). */
  getBuilderSetAtHeight(height: bigint): Promise<BuilderSetSnapshot>;
  /** A builder's service descriptor (#41: inlined endpoints). */
  getServiceDescriptor(operatorAddress: string, participantType?: string): Promise<ServiceDescriptorRef>;
}

export interface ResolveTaskBuilderInput {
  readonly chainId: string;
  /** Hash32 text, `0x` + 64 lowercase hex. */
  readonly taskId: string;
  /** The immutable BuilderSet hash signed into the order. */
  readonly builderSetHash: string;
  /** @deprecated Retired; ignored. */
  readonly sessionAnchorBlockHash?: string;
  /**
   * The session_anchor_height signed into the order. The candidate pool is the BuilderSet in
   * effect at this height -- the same set the chain checks the order against -- never the
   * latest one.
   */
  readonly sessionAnchorHeight: bigint;
  /** Defaults to the active_builders of the BuilderSet at sessionAnchorHeight. */
  readonly members?: readonly BuilderSetMember[];
  readonly buildersPerTask?: number;
  readonly dispatchingBuilder?: string;
}

export interface TaskBuilderEndpoint {
  readonly address: string;
  readonly rank: number;
  readonly serviceEndpoint: string;
  /** On-chain tls_pubkey_hash (`0x` + 64 lowercase hex); an empty string means it isn't registered, so the https endpoint falls back to normal CA verification. */
  readonly tlsPubkeyHash?: string;
}

export interface ResolveTaskBuilderResult {
  /** The builder set id actually used (the same one signed into the order). */
  readonly builderSetId: string;
  readonly endpoints: TaskBuilderEndpoint[];
  readonly errors: { readonly address: string; readonly error: unknown }[];
}

/** Resolve descriptors for the complete immutable snapshot in cyclic dispatch order.
 * Individual descriptor failures are returned without modifying group membership.
 */
export async function resolveTaskBuilderEndpoints(
  reader: TaskBuilderReader,
  input: ResolveTaskBuilderInput,
): Promise<ResolveTaskBuilderResult> {
  const snapshot = await reader.getBuilderSetAtHeight(input.sessionAnchorHeight);
  // The signed set and the set whose members get contacted must be the same one; if the chain
  // disagrees at the anchor height, the order would be sent to Builders that were never selected.
  // Both sides must already be canonical Hash32 text: TaskBuilderReader is an injection point,
  // and a non-canonical spelling on either side is refused as such rather than reported as a
  // spurious set mismatch (or folded into a match).
  strictHash32('builder_set_hash', input.builderSetHash);
  strictHash32('snapshot set_hash', snapshot.setHash);
  if (snapshot.setHash !== input.builderSetHash) {
    throw new TrueOpenError(
      'SDK_LOCAL',
      'SDK_LOCAL_BUILDER_SET_MISMATCH',
      `builder set ${snapshot.builderSetId} at anchor height ${input.sessionAnchorHeight} has hash ${snapshot.setHash}, ` +
        `but the order signs ${input.builderSetHash}`,
    );
  }
  // Snapshot membership is immutable; live status never filters it.
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
    members,
    ...(input.dispatchingBuilder !== undefined ? { dispatchingBuilder: input.dispatchingBuilder } : {}),
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
