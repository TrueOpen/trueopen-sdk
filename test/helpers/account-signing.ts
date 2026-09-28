/**
 * Reads wire testdata/v1/shared/account_signing_v1.json and turns an EIP-712 section into typed
 * data straight from the fixture: the struct type is parsed from the section's encode_type and
 * the values from its message, so nothing here depends on the SDK's own type tables.
 */
import { readFileSync } from 'node:fs';
import type { Eip712Types, Eip712Struct, Eip712Value } from '../../src/codec/eip712';
import type { TypedData } from '../../src/signer/typed-data-signer';
import { fromHex } from '../../src/util/bytes';

export const ACCOUNT_SIGNING = JSON.parse(
  readFileSync('third_party/wire/testdata/v1/shared/account_signing_v1.json', 'utf8'),
) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface Section {
  readonly domain: { name: string; version: string; chain_id: string; domain_separator: string; type_hash: string; encode_type: string };
  readonly encode_type: string;
  readonly type_hash: string;
  readonly hash_struct: string;
  readonly signing_digest: string;
  readonly signature_65: string;
  readonly recovered_address?: string;
  readonly message: Record<string, string>;
  readonly signer?: string;
}

export const section = (name: string): Section => ACCOUNT_SIGNING[name] as Section;

/** The raw private key of a fixture key block: "account", "session_key" or "wrong_key". */
export const fixtureKey = (name: string): Uint8Array => fromHex(ACCOUNT_SIGNING[name].private_key as string);

/** Parses "Name(type a,type b)" into [Name, fields]. */
export function parseEncodeType(encodeType: string): [string, { name: string; type: string }[]] {
  const m = /^([A-Za-z0-9]+)\((.*)\)$/.exec(encodeType);
  if (m === null) throw new Error(`not a single-struct encode_type: ${encodeType}`);
  const fields = m[2]!.split(',').map((f) => {
    const [type, name] = f.split(' ');
    return { name: name!, type: type! };
  });
  return [m[1]!, fields];
}

function value(type: string, raw: string): Eip712Value {
  if (type === 'string') return raw;
  if (type === 'address' || type.startsWith('bytes')) return fromHex(raw);
  return raw; // integers stay decimal strings
}

/**
 * The typed data of a section, with optional message and domain overrides (the "signed" or
 * "verified" columns of a negative row).
 */
export function fixtureTypedData(
  s: Section,
  overrides: { message?: Record<string, string>; domain?: { chain_id?: string; version?: string } } = {},
): TypedData {
  const [primaryType, fields] = parseEncodeType(s.encode_type);
  const [, domainFields] = parseEncodeType(s.domain.encode_type);
  const types: Eip712Types = { EIP712Domain: domainFields, [primaryType]: fields };
  const msg = { ...s.message, ...(overrides.message ?? {}) };
  const message: Record<string, Eip712Value> = {};
  for (const f of fields) {
    const raw = msg[f.name];
    if (raw === undefined) throw new Error(`fixture message has no ${f.name}`);
    message[f.name] = value(f.type, raw);
  }
  const domain: Eip712Struct = {
    name: s.domain.name,
    version: overrides.domain?.version ?? s.domain.version,
    chainId: overrides.domain?.chain_id ?? s.domain.chain_id,
  };
  return { types, primaryType, domain, message };
}
