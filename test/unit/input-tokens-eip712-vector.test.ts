import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  ORDER_INPUT_TOKENS_EIP712_DOMAIN_NAME,
  ORDER_INPUT_TOKENS_EIP712_DOMAIN_VERSION,
  ORDER_INPUT_TOKENS_EIP712_TYPES,
  orderInputTokensDigest,
  orderInputTokensTypedData,
  signOrderInputTokens,
} from '../../src/order/input-tokens';
import { eip712DomainSeparator, eip712EncodeType, eip712HashStruct, eip712TypeHash } from '../../src/codec/eip712';
import { privateKeyTypedDataSigner, typedDataDigest } from '../../src/signer/typed-data-signer';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethAddressBytes, ethSecp256k1Address, recoverEip712PubKey } from '../../src/signer/eth-secp256k1';
import { fromHex, toHex } from '../../src/util/bytes';

/**
 * The EIP-712 form of the input token attestation, as a vector another implementation (the
 * chain) can verify against. The canonical digest is wire's
 * testdata/v1/task/order_input_tokens_v1.json; this file adds the typed data, its hashes, and a
 * deterministic (RFC 6979, low S, V 27/28) signature by a published test key.
 *
 * Regenerate with UPDATE_VECTORS=1 only when the typed-data definition itself changes; the
 * test then fails on any drift.
 */
const PATH = 'test/fixtures/vectors/order_input_tokens_eip712_v1.json';
const WIRE = JSON.parse(readFileSync('third_party/wire/testdata/v1/task/order_input_tokens_v1.json', 'utf8')) as {
  vectors: { digest_hex: string; fields: { name: string; utf8?: string; hex?: string; value?: number }[] }[];
};
const wire = WIRE.vectors[0]!;
const f = (name: string) => wire.fields.find((x) => x.name === name)!;

// A published test key; never use it for anything else.
const PRIV_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const SIGNATURE_CHAIN_ID = 424242n;

async function build(): Promise<Record<string, unknown>> {
  const fields = {
    chainId: f('chain_id').utf8!,
    orderDigest: fromHex(f('order_digest').hex!),
    inputTokenCount: BigInt(f('input_token_count').value!),
  };
  const priv = fromHex(PRIV_HEX);
  const pub = secp256k1PublicKey(priv);
  const data = orderInputTokensTypedData(fields, SIGNATURE_CHAIN_ID);
  const att = await signOrderInputTokens({
    ...fields,
    signatureChainId: SIGNATURE_CHAIN_ID,
    signer: privateKeyTypedDataSigner(priv),
    expectedSigner: ethAddressBytes(pub),
  });
  return {
    schema: 'trueopen.task.order_input_tokens_eip712.v1',
    notes: [
      'EIP-712 form of OrderInputTokensAttestationV1.user_signature (signature_scheme "eip712").',
      'attestationDigest is the H_FIELDS_V1 digest of wire testdata/v1/task/order_input_tokens_v1.json; the same vector supplies chain_id, order_digest and input_token_count.',
      'signing_digest = keccak256(0x1901 || domain_separator || hash_struct). The signature is 65 bytes R||S||V, V in {27,28}, low S, RFC 6979; the verifier recovers the signer address and compares it with the order signer (the user, or the session key that signed the order).',
      'domain.chain_id is the attestation signature_chain_id, which must equal the order SignedOrderV2.signature_chain_id.',
    ],
    domain: {
      name: ORDER_INPUT_TOKENS_EIP712_DOMAIN_NAME,
      version: ORDER_INPUT_TOKENS_EIP712_DOMAIN_VERSION,
      chain_id: SIGNATURE_CHAIN_ID.toString(),
      encode_type: eip712EncodeType('EIP712Domain', ORDER_INPUT_TOKENS_EIP712_TYPES),
      type_hash: toHex(eip712TypeHash('EIP712Domain', ORDER_INPUT_TOKENS_EIP712_TYPES)),
      domain_separator: toHex(eip712DomainSeparator(ORDER_INPUT_TOKENS_EIP712_TYPES, data.domain)),
    },
    primary_type: 'OrderInputTokens',
    encode_type: eip712EncodeType('OrderInputTokens', ORDER_INPUT_TOKENS_EIP712_TYPES),
    type_hash: toHex(eip712TypeHash('OrderInputTokens', ORDER_INPUT_TOKENS_EIP712_TYPES)),
    message: {
      chainId: fields.chainId,
      orderDigest: toHex(fields.orderDigest),
      inputTokenCount: fields.inputTokenCount.toString(),
      attestationDigest: toHex(orderInputTokensDigest(fields)),
    },
    hash_struct: toHex(eip712HashStruct('OrderInputTokens', ORDER_INPUT_TOKENS_EIP712_TYPES, data.message)),
    signing_digest: toHex(typedDataDigest(data)),
    signer: {
      test_private_key: PRIV_HEX,
      eth_address: toHex(ethAddressBytes(pub)),
      bech32_address: ethSecp256k1Address(pub, 'trueopen'),
    },
    signature: toHex(att.userSignature),
    attestation: {
      schema_version: att.schemaVersion,
      chain_id: att.chainId,
      order_digest: toHex(att.orderDigest),
      input_token_count: att.inputTokenCount.toString(),
      signature_scheme: att.signatureScheme,
      user_signature: toHex(att.userSignature),
      signature_chain_id: att.signatureChainId.toString(),
    },
    negative_cases: [
      { name: 'other_signature_chain_id', signature_chain_id: '1', signing_digest: toHex(typedDataDigest(orderInputTokensTypedData(fields, 1n))) },
      {
        name: 'count_plus_one',
        input_token_count: (fields.inputTokenCount + 1n).toString(),
        signing_digest: toHex(typedDataDigest(orderInputTokensTypedData({ ...fields, inputTokenCount: fields.inputTokenCount + 1n }, SIGNATURE_CHAIN_ID))),
      },
    ],
  };
}

describe('input token attestation: EIP-712 vector', () => {
  it('matches the published vector byte for byte', async () => {
    const built = await build();
    if (process.env['UPDATE_VECTORS'] === '1' || !existsSync(PATH)) {
      if (process.env['UPDATE_VECTORS'] !== '1') throw new Error(`${PATH} is missing; run with UPDATE_VECTORS=1`);
      writeFileSync(PATH, JSON.stringify(built, null, 2) + '\n');
    }
    expect(JSON.parse(readFileSync(PATH, 'utf8'))).toEqual(built);
  });

  it('is self-consistent: the digest is the wire digest and the signature recovers to the signer', () => {
    const v = JSON.parse(readFileSync(PATH, 'utf8')) as {
      message: { attestationDigest: string };
      signing_digest: string;
      signature: string;
      signer: { eth_address: string };
      encode_type: string;
      negative_cases: { signing_digest: string }[];
    };
    expect(v.message.attestationDigest).toBe(wire.digest_hex);
    expect(v.encode_type).toBe('OrderInputTokens(string chainId,bytes32 orderDigest,uint64 inputTokenCount,bytes32 attestationDigest)');
    const recovered = ethAddressBytes(recoverEip712PubKey(fromHex(v.signing_digest), fromHex(v.signature)));
    expect(toHex(recovered)).toBe(v.signer.eth_address);
    for (const n of v.negative_cases) {
      expect(n.signing_digest).not.toBe(v.signing_digest);
      expect(toHex(ethAddressBytes(recoverEip712PubKey(fromHex(n.signing_digest), fromHex(v.signature))))).not.toBe(v.signer.eth_address);
    }
  });
});
