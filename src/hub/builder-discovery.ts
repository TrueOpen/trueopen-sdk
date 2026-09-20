import { sha256 } from '../codec/hash';
import { toHex } from '../util/bytes';
import { TrueOpenError } from '../errors/errors';
import { BUILDER_DESCRIPTOR_SCHEMA_V1, nexusGrpcEndpoint } from '../types/hub';
import type { BuilderDescriptorDoc, BuilderEndpoint } from '../types/hub';
import type { HubReader } from '../transport/hub-reader';

/** Fetches the raw bytes of the off-chain descriptor document (for byte-for-byte hash verification). The runtime implementation is injected by the caller. */
export type DescriptorDocFetch = (url: string) => Promise<Uint8Array>;

const dec = new TextDecoder();

/**
 * Verify the descriptor document bytes match the on-chain commitment (sha256(bytes) == descriptorHash)
 * before parsing. A hash mismatch throws (an integrity invariant); a missing schema / service_endpoint
 * also throws.
 */
export function verifyAndParseBuilderDescriptor(bytes: Uint8Array, descriptorHashHex: string): BuilderDescriptorDoc {
  const got = toHex(sha256(bytes));
  const want = descriptorHashHex.toLowerCase();
  if (got !== want) {
    throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_HASH_MISMATCH', `builder descriptor hash mismatch: got ${got}, want ${want}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(dec.decode(bytes));
  } catch (e) {
    throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_MALFORMED', 'builder descriptor is not valid JSON', { cause: e });
  }
  if (typeof doc !== 'object' || doc === null) {
    throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_MALFORMED', 'builder descriptor is not an object');
  }
  const o = doc as Record<string, unknown>;
  const schemaVersion = strField(o, 'schema_version');
  if (schemaVersion !== BUILDER_DESCRIPTOR_SCHEMA_V1) {
    throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_SCHEMA_UNSUPPORTED', `unsupported builder descriptor schema: ${schemaVersion}`);
  }
  const serviceEndpoint = strField(o, 'service_endpoint');
  if (serviceEndpoint === '') {
    throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_MALFORMED', 'builder descriptor missing service_endpoint');
  }
  return {
    schemaVersion,
    builderAddress: strField(o, 'builder_address'),
    serviceEndpoint,
    moniker: optStr(o, 'moniker'),
    p2pHint: optStr(o, 'p2p_hint'),
  };
}

export interface ResolveBuilderEndpointsOptions {
  /** Participant type enum name, defaults to PARTICIPANT_TYPE_BUILDER. */
  readonly participantType?: string;
}

export interface ResolveBuilderEndpointsResult {
  readonly endpoints: BuilderEndpoint[];
  /** Per-builder resolution errors (network/verification); does not block the rest of the builders. */
  readonly errors: { readonly builderAddress: string; readonly error: unknown }[];
}

/**
 * Discover nexus/builder endpoints from the chain (since #41, endpoints are inlined
 * directly on-chain instead of going through a well-known document):
 *   getActiveBuilderSet -> getServiceDescriptor per member -> read the inlined NEXUS_GRPC uri.
 * Best-effort per builder: a single failure is recorded in errors without affecting the rest.
 */
export async function resolveBuilderEndpoints(
  reader: HubReader,
  opts?: ResolveBuilderEndpointsOptions,
): Promise<ResolveBuilderEndpointsResult> {
  const endpoints: BuilderEndpoint[] = [];
  const errors: { builderAddress: string; error: unknown }[] = [];

  const snapshot = await reader.getActiveBuilderSet();
  const addrs = snapshot.builders.split(',').map((a) => a.trim()).filter((a) => a !== '');
  for (const address of addrs) {
    try {
      const ref = await reader.getServiceDescriptor(address, opts?.participantType);
      const endpoint = nexusGrpcEndpoint(ref);
      if (!endpoint || endpoint.uri === '') {
        throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_NO_NEXUS_ENDPOINT', `builder ${address} has no NEXUS_GRPC endpoint`);
      }
      endpoints.push({
        builderAddress: address,
        serviceEndpoint: endpoint.uri,
        tlsPubkeyHash: endpoint.tlsPubkeyHash ?? '',
        descriptorHash: ref.descriptorHash,
        descriptorVersion: ref.descriptorVersion,
      });
    } catch (error) {
      errors.push({ builderAddress: address, error });
    }
  }
  return { endpoints, errors };
}

function strField(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== 'string') {
    throw new TrueOpenError('CHAIN_REJECT', 'DESCRIPTOR_MALFORMED', `builder descriptor field ${key} must be string`);
  }
  return v;
}

function optStr(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === 'string' ? v : '';
}
