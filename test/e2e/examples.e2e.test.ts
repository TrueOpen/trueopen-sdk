/**
 * Runs examples/*.mjs as child processes against the simulated network. The examples import
 * ../dist, so this needs `npm run build` first; it is opt-in (TRUEOPEN_E2E_EXAMPLES=1) because the
 * unit suite runs before the build in CI. Every Builder here is https and pinned, so no example
 * needs TRUEOPEN_ALLOW_INSECURE_HTTP.
 *
 *   npm run build && TRUEOPEN_E2E_EXAMPLES=1 npx vitest run test/e2e/examples.e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EthSecp256k1DirectSigner, ethSecp256k1SignerFromMnemonic } from '../../src/signer/eth-direct-signer';
import { startWorld, outputText, STREAM } from './support/harness';
import type { World } from './support/harness';
import * as w from './support/world';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const enabled = process.env.TRUEOPEN_E2E_EXAMPLES === '1' && existsSync(`${ROOT}dist/index.js`);
// A throwaway test mnemonic; the fake node funds its first account.
const MNEMONIC = 'test test test test test test test test test test test junk';

interface Run { code: number; stdout: string; stderr: string }

function runExample(name: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [`examples/${name}`], { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

let world: World;
let address: string;
let baseEnv: Record<string, string>;

describe.skipIf(!enabled)('e2e: examples/*.mjs against the simulated network', () => {
  beforeAll(async () => {
    world = await startWorld();
    const signer: EthSecp256k1DirectSigner = await ethSecp256k1SignerFromMnemonic(MNEMONIC, w.PREFIX);
    address = (await signer.getAccounts())[0]!.address;
    world.node.accounts.set(address, { accountNumber: 11n, sequence: 0n });
    baseEnv = {
      TRUEOPEN_REST_URL: world.node.restUrl,
      TRUEOPEN_RPC_URL: world.node.rpcUrl,
      TRUEOPEN_CHAIN_ID: w.CHAIN_ID,
      TRUEOPEN_MNEMONIC: MNEMONIC,
      TRUEOPEN_MODEL_ID: w.MODEL_ID,
    };
  });
  afterAll(async () => { await world?.close(); });

  let sessionId = '';
  let taskId = '';

  it('read.mjs', async () => {
    const r = await runExample('read.mjs', { ...baseEnv, TRUEOPEN_QUERY_ADDR: address });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('"businessDenom": "uusdc"');
    for (const n of world.nexus.slice(0, 3)) expect(r.stdout).toContain(n.url);
  });

  it('create-session.mjs (signs and broadcasts MsgCreateSession to the fake RPC)', async () => {
    const r = await runExample('create-session.mjs', baseEnv);
    expect(r.code, r.stderr).toBe(0);
    sessionId = /TRUEOPEN_SESSION_ID=([0-9a-f]{64})/.exec(r.stdout)?.[1] ?? '';
    expect(sessionId).toBe(w.sessionIdFor(address, 0n));
    expect(world.node.txs.at(-1)).toMatchObject({ code: 0 });
  });

  it('open-task.mjs', async () => {
    const r = await runExample('open-task.mjs', { ...baseEnv, TRUEOPEN_SESSION_ID: sessionId });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('"accepted": true');
    taskId = /TRUEOPEN_TASK_ID=([0-9a-f]{64})/.exec(r.stdout)?.[1] ?? '';
    const taskHash = /"taskHash": "([0-9a-f]{64})"/.exec(r.stdout)?.[1] ?? '';
    expect(taskId).toMatch(/^[0-9a-f]{64}$/);
    for (const n of world.nexus.slice(0, 3)) expect(n.opened.map((o) => o.taskId)).toContain(taskId);

    // The chain accepts it, a winner runs it and its receipt lands; the Builders hold the output.
    world.node.tasks.set(taskId, { taskId, sessionId, orderSequence: 0n, taskHash, inputHash: w.label32('example-input'), winner: w.WORKER_OPERATOR });
    world.node.receipts.set(taskId, {
      outputHash: STREAM.output_hash, outputSizeBytes: BigInt(STREAM.output_size_bytes),
      outputLeafCount: BigInt(STREAM.output_leaf_count), winnerWorker: w.WORKER_OPERATOR,
    });
    world.outputs.set(taskId, { ...STREAM, task_id: taskId, session_id: sessionId, task_hash: taskHash });
  });

  it('fetch-output.mjs', async () => {
    const r = await runExample('fetch-output.mjs', { ...baseEnv, TRUEOPEN_SESSION_ID: sessionId, TRUEOPEN_TASK_ID: taskId });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain(`"text": ${JSON.stringify(outputText(STREAM))}`);
  });
});
