import { describe, expect, it } from 'vitest';
import { hash32Text } from '../../src/codec/hash32';
import {
  OUTPUT_MMR_DOMAIN,
  OutputStreamVerifier,
  outputChunkSigningDigest,
  outputFinSigningDigest,
  outputHash,
  type OutputStreamVerifierCheckpoint,
  type VerifiedOutputFin,
} from '../../src/output/output-commitment';
import { confirmOutputWithReceipt } from '../../src/output/output-confirmation';
import { deserializeOutputStreamCheckpoint, serializeOutputStreamCheckpoint } from '../../src/output/output-checkpoint-codec';
import { confirmAssistantMessageWithReceipt } from '../../src/toolcall/assistant-view';
import { hermesParser } from '../../src/toolcall/parsers/hermes';
import { mmrPrefixRoot } from '../../src/codec/mmr';
import { privKeySecp256k1DigestSigner, secp256k1PublicKey } from '../../src/signer/secp256k1';
import type { InferReceiptView } from '../../src/types/node';
import { fromHex } from '../../src/util/bytes';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const CHAIN_ID = 'trueopen-localnet-1';
const TASK_ID = `0x${'aa'.repeat(32)}`;
const TASK_HASH = `0x${'bb'.repeat(32)}`;
const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const OTHER = fromHex('0302030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const WORKER_PUB = secp256k1PublicKey(PRIV);
const CHUNKS = [utf8('<tool_call>\n{"name": "f", '), utf8('"arguments": {}}\n</tool_call>')];
const ROOT = outputHash(CHUNKS);
const MAX_OUTPUT_TOKENS = 3;

const config = () => ({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH.slice(2)), workerServicePubKey: WORKER_PUB });

async function streamed(): Promise<OutputStreamVerifier> {
  const sign = privKeySecp256k1DigestSigner(PRIV);
  const verifier = new OutputStreamVerifier(config());
  for (let i = 0; i < CHUNKS.length; i++) {
    const seq = BigInt(i);
    const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, CHUNKS, i + 1);
    verifier.accept({
      seq, text: CHUNKS[i]!, mmrRoot,
      signature: await sign(outputChunkSigningDigest({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH.slice(2)), seq, mmrRoot })),
    });
  }
  return verifier;
}

/** A Fin as the Worker signs it; `over` tampers with what is presented after signing. */
async function fin(finishReason = 1, over: Partial<VerifiedOutputFin> = {}, signer = PRIV): Promise<VerifiedOutputFin> {
  const fields = { chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH.slice(2)), finalSeq: 1n, outputMmrRoot: ROOT, finishReason };
  const workerSignature = await privKeySecp256k1DigestSigner(signer)(outputFinSigningDigest(fields));
  return { finalSeq: 1n, outputMmrRoot: ROOT, finishReason, workerSignature, ...over };
}

function receipt(over: Partial<InferReceiptView> = {}): InferReceiptView {
  return {
    taskId: TASK_ID, winnerWorker: 'trueopen1worker', inferReceiptHash: `0x${'cc'.repeat(32)}`,
    outputHash: hash32Text(ROOT), outputLeafCount: 2n,
    outputSizeBytes: CHUNKS.reduce((n, c) => n + BigInt(c.length), 0n),
    ...over,
  };
}

const confirm = (checkpoint: OutputStreamVerifierCheckpoint) =>
  confirmOutputWithReceipt({ chainId: CHAIN_ID, taskId: TASK_ID, taskHash: TASK_HASH, checkpoint, receipt: receipt() });

describe('OutputStreamVerifier.acceptFin', () => {
  it('keeps a Fin that ends the verified stream, and exports it in a schema-2 checkpoint', async () => {
    const v = await streamed();
    v.acceptFin(await fin(MAX_OUTPUT_TOKENS));
    const cp = v.checkpoint();
    expect(cp.schemaVersion).toBe(2);
    expect(cp.fin).toMatchObject({ finalSeq: 1n, finishReason: MAX_OUTPUT_TOKENS });
  });

  it('refuses a Fin whose final_seq, root or signature does not match', async () => {
    for (const bad of [
      await fin(1, { finalSeq: 0n }),
      await fin(1, { outputMmrRoot: new Uint8Array(32) }),
      await fin(1, { finishReason: 3 }),
      await fin(1, {}, OTHER),
    ]) {
      const v = await streamed();
      expect(() => v.acceptFin(bad)).toThrow();
      expect(v.checkpoint().fin).toBeUndefined();
    }
  });

  it('re-verifies a kept Fin when restoring, so a stored copy is not trusted', async () => {
    const v = await streamed();
    v.acceptFin(await fin(1));
    const good = v.checkpoint();
    expect(new OutputStreamVerifier(config(), good).checkpoint().fin?.finishReason).toBe(1);
    const tampered = { ...good, fin: { ...good.fin!, finishReason: 3 } };
    expect(() => new OutputStreamVerifier(config(), tampered)).toThrow();
  });

  it('still restores a schema-1 checkpoint, which carries no Fin', async () => {
    const { fin: _none, ...v1 } = { ...(await streamed()).checkpoint(), schemaVersion: 1 as const };
    expect(new OutputStreamVerifier(config(), v1).leafCount).toBe(2n);
  });
});

describe('checkpoint JSON with a Fin', () => {
  it('round-trips the Fin and re-verifies it on decode', async () => {
    const v = await streamed();
    v.acceptFin(await fin(MAX_OUTPUT_TOKENS));
    const json = serializeOutputStreamCheckpoint(v.checkpoint());
    expect(JSON.parse(json)).toMatchObject({ schema_version: 2, fin: { final_seq: '1', finish_reason: MAX_OUTPUT_TOKENS } });
    expect(deserializeOutputStreamCheckpoint(json).fin?.finishReason).toBe(MAX_OUTPUT_TOKENS);
    const tampered = JSON.stringify({ ...JSON.parse(json), fin: { ...JSON.parse(json).fin, finish_reason: 1 } });
    expect(() => deserializeOutputStreamCheckpoint(tampered)).toThrow(expect.objectContaining({ code: 'OUTPUT_STREAM_CHECKPOINT_JSON_INVALID' }));
  });

  it('still decodes a schema-1 document', async () => {
    const json = JSON.parse(serializeOutputStreamCheckpoint((await streamed()).checkpoint()));
    const v1 = JSON.stringify({ ...json, schema_version: 1 });
    expect(deserializeOutputStreamCheckpoint(v1).fin).toBeUndefined();
  });
});

describe('confirmation recovers an unclosed final call by the signed Fin (design S7 requirement 6)', () => {
  const UNCLOSED = [utf8('<tool_call>\n{"name": "f", '), utf8('"arguments": {"k": 1}}')];
  const root = outputHash(UNCLOSED);

  async function confirmedWith(finishReason: number) {
    const sign = privKeySecp256k1DigestSigner(PRIV);
    const verifier = new OutputStreamVerifier(config());
    for (let i = 0; i < UNCLOSED.length; i++) {
      const seq = BigInt(i);
      const mmrRoot = mmrPrefixRoot(OUTPUT_MMR_DOMAIN, UNCLOSED, i + 1);
      verifier.accept({
        seq, text: UNCLOSED[i]!, mmrRoot,
        signature: await sign(outputChunkSigningDigest({ chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH.slice(2)), seq, mmrRoot })),
      });
    }
    const fields = { chainId: CHAIN_ID, taskHash: fromHex(TASK_HASH.slice(2)), finalSeq: 1n, outputMmrRoot: root, finishReason };
    verifier.acceptFin({ finalSeq: 1n, outputMmrRoot: root, finishReason, workerSignature: await sign(outputFinSigningDigest(fields)) });
    return confirmAssistantMessageWithReceipt(
      {
        chainId: CHAIN_ID, taskId: TASK_ID, taskHash: TASK_HASH, checkpoint: verifier.checkpoint(),
        receipt: receipt({
          outputHash: hash32Text(root), outputLeafCount: 2n,
          outputSizeBytes: UNCLOSED.reduce((n, c) => n + BigInt(c.length), 0n),
        }),
      },
      { parser: hermesParser },
    );
  }

  it('a Fin of EOS_TOKEN makes it an executable call', async () => {
    const m = await confirmedWith(1);
    expect(m.toolCalls).toEqual([{ name: 'f', arguments: '{"k": 1}' }]);
    expect(m.content).toBe('');
  });

  it('a Fin of MAX_OUTPUT_TOKENS keeps it as text', async () => {
    const m = await confirmedWith(MAX_OUTPUT_TOKENS);
    expect(m.toolCalls).toEqual([]);
    expect(m.content).toBe('<tool_call>\n{"name": "f", "arguments": {"k": 1}}');
  });
});

describe('confirmation carries the Fin\'s finish reason', () => {
  it('attaches the reason of a kept Fin that matches the receipt', async () => {
    const v = await streamed();
    v.acceptFin(await fin(MAX_OUTPUT_TOKENS));
    expect(confirm(v.checkpoint()).finishReason).toBe(MAX_OUTPUT_TOKENS);
  });

  it('leaves it unavailable without a kept Fin', async () => {
    expect(confirm((await streamed()).checkpoint()).finishReason).toBeUndefined();
  });

  it('refuses a kept Fin that does not verify, rather than dropping the reason', async () => {
    const v = await streamed();
    v.acceptFin(await fin(1));
    const cp = v.checkpoint();
    expect(() => confirm({ ...cp, fin: { ...cp.fin!, finishReason: 3 } }))
      .toThrow(expect.objectContaining({ code: 'DATA_OUTPUT_CONFIRMATION_FIN_INVALID' }));
  });

  it('exposes it on the confirmed assistant message, next to the calls', async () => {
    const v = await streamed();
    v.acceptFin(await fin(MAX_OUTPUT_TOKENS));
    const m = confirmAssistantMessageWithReceipt(
      { chainId: CHAIN_ID, taskId: TASK_ID, taskHash: TASK_HASH, checkpoint: v.checkpoint(), receipt: receipt() },
      { parser: hermesParser },
    );
    expect(m.finishReason).toBe(MAX_OUTPUT_TOKENS);
    // A truncated turn keeps its closed calls (sdk_详细设计 §5.5); the finish reason says it was cut off.
    expect(m.toolCalls).toEqual([{ name: 'f', arguments: '{}' }]);
  });
});
