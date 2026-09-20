export type CredentialUsage =
  | 'SDK_DELIVERY'
  | 'VERIFIER_FETCH'
  | 'CHALLENGE_EVIDENCE'
  | 'WATCHER_AUDIT';

/**
 * Data plane output retrieval reference (used by ChunkVerifier.finalize for validation).
 * The V1 data plane transmits in plaintext with no sealed key; retrieval authorization is
 * carried by the on-chain role plus a signed credential (CredentialV1), see Section 5.
 */
export interface OutputRef {
  readonly taskId: string;
  readonly sessionId: string;
  readonly outputHash: Uint8Array;
  readonly canonicalOutputPackageHash: Uint8Array;
  readonly outputCid: string;
}

/** A raw chunk fetched from the gateway (includes commitment fields, Section 5.7). */
export interface RawChunk {
  readonly chunkIndex: bigint;
  readonly prevChunkHash: Uint8Array;
  readonly chunkDigest: Uint8Array;
  readonly bytes: Uint8Array;
}

export interface VerifiedChunk extends RawChunk {
  readonly verified: true;
}

export interface ChunkBoundary {
  readonly nextIndex: bigint;
  readonly prevChunkHash: Uint8Array;
}
