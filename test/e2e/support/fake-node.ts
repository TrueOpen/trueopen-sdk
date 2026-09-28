/**
 * A fake node on localhost: the REST gateway routes the SDK reads, plus the CometBFT JSON-RPC
 * methods CosmJS uses to sign and broadcast (status, abci_query for the account, broadcast_tx_sync,
 * tx_search).
 *
 * REST bodies follow the node gateway's rendering: snake_case, keys sorted, Hash32 as lowercase
 * hex, other bytes as base64, 64-bit integers as strings, 32-bit integers as numbers, enums by
 * full name, every field emitted. The larger bodies (params, task, profile) start from the wire
 * shape fixture so their key sets match it exactly.
 *
 * Broadcast transactions are decoded and their signature is checked (see independent.ts), then
 * recorded. Nothing leaves the process.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { BaseAccount } from 'cosmjs-types/cosmos/auth/v1beta1/auth';
import { QueryAccountRequest, QueryAccountResponse } from 'cosmjs-types/cosmos/auth/v1beta1/query';
import { Any } from 'cosmjs-types/google/protobuf/any';
import { TxMsgData } from 'cosmjs-types/cosmos/base/abci/v1beta1/abci';
import { decodeAndVerifyTx, addressFromPubKey } from './independent';
import type { DecodedTx } from './independent';
import * as w from './world';

// The node REST gateway's JSON rendering, as pinned by the wire submodule.
const shapes = JSON.parse(readFileSync(new URL('../../../third_party/wire/testdata/v1/shared/rest_json_shapes_v1.json', import.meta.url), 'utf8')) as {
  responses: { name: string; body: unknown }[];
};
export function shapeBody(name: string): Record<string, unknown> {
  const r = shapes.responses.find((x) => x.name === name);
  if (r === undefined) throw new Error(`no shape ${name}`);
  return structuredClone(r.body) as Record<string, unknown>;
}

type Json = Record<string, unknown>;
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');
const ZERO32 = '0'.repeat(64);

/** Keys sorted recursively, as the node gateway's re-encoding produces them. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Json)[k])]));
  }
  return v;
}

export interface TaskFact {
  readonly taskId: string;
  readonly sessionId: string;
  readonly orderSequence: bigint;
  taskHash: string;
  inputHash: string;
  /** Unset until the winner is drawn. */
  winner?: string;
  /** When true the task has been compacted to its terminal summary. */
  terminal?: boolean;
}

export interface ReceiptFact {
  readonly outputHash: string;
  readonly outputSizeBytes: bigint;
  readonly outputLeafCount: bigint;
  readonly winnerWorker: string;
}

export interface RecordedTx {
  readonly txBytes: Uint8Array;
  readonly decoded: DecodedTx;
  readonly code: number;
  readonly log: string;
  readonly height: bigint;
  readonly msgResponses: readonly { typeUrl: string; value: Uint8Array }[];
}

interface Account {
  readonly accountNumber: bigint;
  sequence: bigint;
  pubKey?: Uint8Array;
}

export class FakeNode {
  height = w.LATEST_HEIGHT;
  businessDenom = w.BUSINESS_DENOM;
  builderSets: w.BuilderSetFact[] = [w.SET_A];
  readonly descriptors = new Map<string, { uri: string; tlsPubkeyHash: string }>();
  readonly serviceKeys = new Map<string, { serviceAddress: string; pubKey: Uint8Array; status: string }>();
  readonly sessions = new Map<string, { owner: string; nextExpectedSequence: bigint; openPendingCount: number }>();
  readonly sessionNonces = new Map<string, bigint>();
  readonly tasks = new Map<string, TaskFact>();
  readonly receipts = new Map<string, ReceiptFact>();
  readonly accounts = new Map<string, Account>();
  readonly txs: RecordedTx[] = [];
  /** Every REST path and RPC method served, in order ("GET /path" or "RPC method"). */
  readonly requests: string[] = [];
  /** Bodies served verbatim for a path, ahead of the simulated state. */
  readonly verbatim = new Map<string, unknown>();
  private server?: Server;
  restUrl = '';
  rpcUrl = '';

  constructor() {
    this.serviceKeys.set(w.WORKER_OPERATOR, {
      serviceAddress: w.WORKER_SERVICE.address,
      pubKey: w.WORKER_SERVICE.pubKey,
      status: 'SERVICE_KEY_STATUS_ACTIVE',
    });
    this.accounts.set(w.USER.address, { accountNumber: 7n, sequence: 0n });
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((e: unknown) => this.send(res, 500, { code: 13, message: String(e), details: [] }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.restUrl = `http://127.0.0.1:${port}`;
    this.rpcUrl = `http://127.0.0.1:${port}/rpc`;
    return this;
  }

  async close(): Promise<void> {
    const s = this.server;
    if (s === undefined) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** The set in effect at `height`: the latest one whose effective height is not after it. */
  builderSetAt(height: bigint): w.BuilderSetFact | undefined {
    return [...this.builderSets].filter((s) => s.effectiveHeight <= height).sort((a, b) => Number(b.effectiveHeight - a.effectiveHeight))[0];
  }

  /** Puts a session on chain directly, as if MsgCreateSession had landed. */
  seedSession(owner: string): string {
    const nonce = this.sessionNonces.get(owner) ?? 0n;
    const sessionId = w.sessionIdFor(owner, nonce);
    this.sessionNonces.set(owner, nonce + 1n);
    this.sessions.set(sessionId, { owner, nextExpectedSequence: 0n, openPendingCount: 0 });
    return sessionId;
  }

  // ---------------------------------------------------------------- HTTP plumbing

  private send(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(sortKeys(body));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(text);
  }

  private notFound(res: ServerResponse, what: string): void {
    // grpc-gateway renders a NotFound status as HTTP 404 with the gRPC status body.
    this.send(res, 404, { code: 5, message: `${what}: not found`, details: [] });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const call = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: unknown; method: string; params: Json };
      this.requests.push(`RPC ${call.method}`);
      const result = this.rpc(call.method, call.params ?? {});
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result instanceof Error
        ? { jsonrpc: '2.0', id: call.id, error: { code: -32603, message: result.message, data: '' } }
        : { jsonrpc: '2.0', id: call.id, result }));
      return;
    }
    if (req.method !== 'GET') return this.send(res, 405, { code: 12, message: 'method not allowed', details: [] });
    this.requests.push(`GET ${url.pathname}`);
    const fixed = this.verbatim.get(url.pathname);
    if (fixed !== undefined) return this.send(res, 200, fixed);
    const p = url.pathname.split('/').filter((s) => s !== '').map(decodeURIComponent);
    const route = p.join('/');

    if (route === 'cosmos/base/tendermint/v1beta1/blocks/latest') {
      return this.send(res, 200, {
        block_id: { hash: b64(sha256(new TextEncoder().encode(`block-${this.height}`))), part_set_header: { total: 1, hash: '' } },
        block: { header: { chain_id: w.CHAIN_ID, height: this.height.toString(), time: '2026-09-28T00:00:00Z' }, data: { txs: [] } },
        sdk_block: null,
      });
    }
    if (route === 'TrueOpen/hub/v1/params') return this.send(res, 200, this.hubParams());
    if (route === 'TrueOpen/task/v1/params') return this.send(res, 200, shapeBody('task_v1_querytaskparamsresponse_default'));

    if (p[0] === 'TrueOpen' && p[1] === 'hub' && p[2] === 'v1') {
      if (p[3] === 'builder_set' && p[4] === 'by_height' && p[5] !== undefined) {
        const set = this.builderSetAt(BigInt(p[5]));
        if (set === undefined) return this.notFound(res, `builder set at ${p[5]}`);
        return this.send(res, 200, {
          set: {
            active_builder_count: set.members.length,
            active_builders: set.members,
            body_status: 'STORED_BODY_STATUS_PRESENT',
            builder_set_hash: set.hash,
            builder_set_id: set.id,
            builder_set_version: set.version.toString(),
            effective_height: set.effectiveHeight.toString(),
            pruned_height: '0',
          },
        });
      }
      if (p[3] === 'beacon' && p[4] !== undefined) {
        const h = BigInt(p[4]);
        if (h > this.height) return this.notFound(res, `beacon ${h}`);
        return this.send(res, 200, {
          beacon: {
            height: h.toString(),
            randomness_hex: w.label32(`e2e-randomness-${h}`),
            source_tag: 'proposer_vrf_v1',
            proposer_consensus_address: 'trueopenvalcons1fake',
            verified: true,
            block_hash: w.beaconBlockHash(h),
          },
        });
      }
      if (p[3] === 'timeout_bucket' && p[4] !== undefined) {
        return this.send(res, 200, {
          bucket: {
            bucket_kind: 'BUCKET_KIND_TIMEOUT',
            bucket_key: p[4],
            version: w.TIMEOUT_BUCKET_VERSION.toString(),
            schema_version: 1,
            effective_height: '500',
            bucket_hash: w.label32('e2e-timeout-bucket'),
            timeout_entries: { entries: [] },
            entry_count: 0,
            encoded_size_bytes: 0,
          },
          current_version: w.TIMEOUT_BUCKET_VERSION.toString(),
          pending_version: '0',
        });
      }
      if (p[3] === 'service_descriptor' && p[4] !== undefined && p[5] !== undefined) {
        const d = this.descriptors.get(p[5]);
        if (d === undefined || p[4] !== 'PARTICIPANT_TYPE_BUILDER') return this.notFound(res, `descriptor ${p[5]}`);
        return this.send(res, 200, {
          descriptor: {
            participant_type: 'PARTICIPANT_TYPE_BUILDER',
            operator_address: p[5],
            descriptor_version: '1',
            endpoint_count: 1,
            endpoints: [{
              endpoint_kind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC',
              uri: d.uri,
              protocol_version: 'v1',
              // Optional Hash32: omitted when unset.
              ...(d.tlsPubkeyHash !== '' ? { tls_pubkey_hash: d.tlsPubkeyHash } : {}),
            }],
            descriptor_hash: w.label32(`e2e-descriptor-${p[5]}`),
            updated_height: '100',
          },
        });
      }
      if (p[3] === 'current_service_key' && p[4] !== undefined && p[5] !== undefined) {
        const k = this.serviceKeys.get(p[5]);
        if (k === undefined || p[4] !== 'PARTICIPANT_TYPE_CORTEX') return this.notFound(res, `service key ${p[5]}`);
        return this.send(res, 200, {
          binding: {
            participant_type: 'PARTICIPANT_TYPE_CORTEX',
            operator_address: p[5],
            service_address: k.serviceAddress,
            service_pubkey: b64(k.pubKey),
            service_authorization_nonce: '1',
            // A oneof: only the status matching the participant type is rendered.
            cortex_service_key_status: k.status,
            current_descriptor_version: '1',
          },
        });
      }
      if (p[3] === 'profile' && p[4] !== undefined && p[5] !== undefined) {
        if (p[4] !== w.MODEL_ID || p[5] !== String(w.PROFILE_VERSION)) return this.notFound(res, 'profile');
        const body = shapeBody('hub_v1_queryprofileresponse');
        const profile = body['profile'] as Json;
        Object.assign(profile, {
          model_id: w.MODEL_ID,
          profile_version: w.PROFILE_VERSION,
          previous_profile_version: 0,
          status: 'MODEL_PROFILE_STATUS_ACTIVE',
          proposer_address: w.USER.address,
          manifest_uri: '',
          pricing_profile: {
            initial_output_price: w.PRICING.initialOutputPrice.toString(),
            min_order_value: w.PRICING.minOrderValue.toString(),
            verify_ratio_bps: Number(w.PRICING.verifyRatioBps),
          },
        });
        return this.send(res, 200, body);
      }
    }

    if (p[0] === 'TrueOpen' && p[1] === 'task' && p[2] === 'v1') {
      if (p[3] === 'session_nonce' && p[4] !== undefined) {
        return this.send(res, 200, { next_session_nonce: (this.sessionNonces.get(p[4]) ?? 0n).toString() });
      }
      if (p[3] === 'session' && p[4] !== undefined && p.length === 5) {
        const s = this.sessions.get(p[4]);
        if (s === undefined) return this.notFound(res, `session ${p[4]}`);
        return this.send(res, 200, {
          session: {
            session_id: p[4],
            owner_user_address: s.owner,
            next_expected_sequence: s.nextExpectedSequence.toString(),
            last_active_height: this.height.toString(),
            open_pending_count: s.openPendingCount,
            status: 'SESSION_STATUS_ACTIVE',
          },
        });
      }
      if (p[3] === 'task' && p[4] !== undefined && p.length === 5) {
        const t = this.tasks.get(p[4]);
        if (t === undefined) return this.notFound(res, `task ${p[4]}`);
        return this.send(res, 200, t.terminal === true ? this.terminalView(t) : this.activeView(t));
      }
      if (p[3] === 'task' && p[4] !== undefined && p[5] === 'infer_receipt') {
        const r = this.receipts.get(p[4]);
        if (r === undefined) return this.notFound(res, 'infer receipt');
        return this.send(res, 200, {
          receipt: {
            task_id: p[4],
            winner_worker: r.winnerWorker,
            infer_receipt_hash: w.label32(`e2e-receipt-${p[4]}`),
            generation_params_digest: w.label32('e2e-generation-params'),
            output_hash: r.outputHash,
            output_size_bytes: r.outputSizeBytes.toString(),
            generated_token_count: '9',
            evidence_commitments_hash: w.label32('e2e-evidence'),
            required_evidence_commitments: [],
            evidence_commitment_count: 0,
            infer_receipt_signing_digest: w.label32('e2e-receipt-digest'),
            signature_digest: w.label32('e2e-receipt-signature'),
            expiry_height: (this.height + 100n).toString(),
            receipt_height: this.height.toString(),
            output_leaf_count: r.outputLeafCount.toString(),
            output_key_commitment: ZERO32,
            worker_token_key_commitment: ZERO32,
            worker_value_key_commitment: ZERO32,
            ciphertext_output_root: ZERO32,
          },
        });
      }
    }
    // grpc-gateway answers an unrouted path with 404 too.
    this.notFound(res, `route ${url.pathname}`);
  }

  private hubParams(): Json {
    const body = shapeBody('hub_v1_queryhubparamsresponse_default');
    const phase0 = (body['params'] as Json)['phase0'] as Json;
    phase0['business_denom'] = this.businessDenom;
    phase0['evm_chain_id'] = w.EVM_CHAIN_ID.toString();
    return body;
  }

  private activeView(t: TaskFact): Json {
    const zero = t.winner === undefined;
    const body = shapeBody(zero ? 'task_v1_querytaskresponse_active_zero' : 'task_v1_querytaskresponse_active');
    const active = (body['task'] as Json)['active'] as Json;
    const core = active['core'] as Json;
    Object.assign(core, {
      task_id: t.taskId,
      session_id: t.sessionId,
      order_sequence: t.orderSequence.toString(),
      accepted_task_hash: t.taskHash,
      accepted_input_hash: t.inputHash,
      accepted_order_opening_hash: w.label32(`e2e-opening-${t.taskId}`),
      accepted_payload_mode: 'PAYLOAD_MODE_V1_PLAINTEXT',
      model_id: w.MODEL_ID,
      profile_version: w.PROFILE_VERSION,
      task_type: 'TASK_TYPE_TEXT_GENERATION',
      user_address: w.USER.address,
      created_height: this.height.toString(),
      updated_height: this.height.toString(),
      task_phase: zero ? 'TASK_PHASE_WORKER_ASSIGNMENT_PENDING' : 'TASK_PHASE_INFER_PENDING',
      assignment_status: zero ? 'ASSIGNMENT_STATUS_PENDING' : 'ASSIGNMENT_STATUS_ASSIGNED',
      receipt_status: this.receipts.has(t.taskId) ? 'RECEIPT_STATUS_ACCEPTED' : 'RECEIPT_STATUS_NONE',
      order_value: { atomic_units: '27' },
    });
    if (!zero) {
      const a = active['assignment'] as Json;
      Object.assign(a, {
        task_id: t.taskId,
        assignment_status: 'ASSIGNMENT_STATUS_ASSIGNED',
        // Optional fields (oneofs): present once the winner is drawn.
        winner_worker: t.winner,
        winner_confirm_height: this.height.toString(),
        infer_deadline_height: (this.height + 50n).toString(),
        winner_draw_digest: w.label32(`e2e-draw-${t.taskId}`),
      });
      // Verifier rounds have not started.
      active['round1_verifier_assignment'] = null;
      active['round2_verifier_assignment'] = null;
    }
    return body;
  }

  private terminalView(t: TaskFact): Json {
    const body = shapeBody('task_v1_querytaskresponse_terminal');
    const terminal = (body['task'] as Json)['terminal'] as Json;
    const set = this.builderSetAt(w.ANCHOR_HEIGHT) ?? w.SET_A;
    Object.assign(terminal, {
      task_id: t.taskId,
      session_id: t.sessionId,
      order_sequence: t.orderSequence.toString(),
      task_hash: t.taskHash,
      model_id: w.MODEL_ID,
      profile_version: w.PROFILE_VERSION,
      builder_set_id: set.id,
      builder_set_hash: set.hash,
      builder_set_version: set.version.toString(),
      terminal_phase: 'TASK_PHASE_SETTLED',
      verdict: 'TASK_VERDICT_PASS',
      finality_status: 'TASK_FINALITY_STATUS_V1_FINAL',
      settlement_status: 'SETTLEMENT_STATUS_SETTLED',
      failure_class: 'TASK_FAILURE_CLASS_NONE',
      ...(t.winner !== undefined ? { winner_worker: t.winner } : {}),
    });
    return body;
  }

  // ---------------------------------------------------------------- CometBFT JSON-RPC

  private rpc(method: string, params: Json): unknown {
    switch (method) {
      case 'status':
        return {
          node_info: {
            protocol_version: { p2p: '8', block: '11', app: '0' },
            id: 'aa'.repeat(20),
            listen_addr: 'tcp://127.0.0.1:26656',
            network: w.CHAIN_ID,
            version: '0.38.17',
            channels: '40202122233038606100',
            moniker: 'fake-node',
            other: { tx_index: 'on', rpc_address: 'tcp://127.0.0.1:26657' },
          },
          sync_info: {
            latest_block_hash: 'AB'.repeat(32),
            latest_app_hash: 'CD'.repeat(32),
            latest_block_height: this.height.toString(),
            latest_block_time: '2026-09-28T00:00:00.000000000Z',
            earliest_block_hash: 'AB'.repeat(32),
            earliest_app_hash: 'CD'.repeat(32),
            earliest_block_height: '1',
            earliest_block_time: '2026-09-01T00:00:00.000000000Z',
            catching_up: false,
          },
          validator_info: {
            address: 'BB'.repeat(20),
            pub_key: { type: 'tendermint/PubKeyEd25519', value: b64(new Uint8Array(32).fill(1)) },
            voting_power: '10',
          },
        };
      case 'abci_query':
        return { response: this.abciQuery(String(params['path']), Buffer.from(String(params['data'] ?? ''), 'hex')) };
      case 'broadcast_tx_sync':
        return this.broadcast(Uint8Array.from(Buffer.from(String(params['tx']), 'base64')));
      case 'tx_search': {
        const m = /^tx\.hash='([0-9A-F]+)'$/.exec(String(params['query']));
        const hits = this.txs.filter((t) => m !== null && t.decoded.hash === m[1] && t.code === 0);
        return {
          txs: hits.map((t, i) => ({
            hash: t.decoded.hash,
            height: t.height.toString(),
            index: i,
            tx: b64(t.txBytes),
            tx_result: {
              code: 0,
              data: b64(TxMsgData.encode({ data: [], msgResponses: t.msgResponses.map((r) => Any.fromPartial(r)) }).finish()),
              log: '',
              gas_wanted: '300000',
              gas_used: '120000',
              events: [],
            },
          })),
          total_count: String(hits.length),
        };
      }
      default:
        return new Error(`method ${method} not implemented by the fake node`);
    }
  }

  private abciQuery(path: string, data: Uint8Array): Json {
    if (path !== '/cosmos.auth.v1beta1.Query/Account') {
      return { code: 6, log: `unknown query path ${path}`, height: this.height.toString(), codespace: 'sdk' };
    }
    const { address } = QueryAccountRequest.decode(data);
    const acct = this.accounts.get(address);
    if (acct === undefined) {
      return { code: 22, log: `rpc error: code = NotFound desc = account ${address} not found`, height: this.height.toString(), codespace: 'sdk' };
    }
    const base = BaseAccount.encode(BaseAccount.fromPartial({
      address,
      accountNumber: acct.accountNumber,
      sequence: acct.sequence,
      ...(acct.pubKey !== undefined
        ? { pubKey: Any.fromPartial({ typeUrl: '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey', value: Uint8Array.from([0x0a, 33, ...acct.pubKey]) }) }
        : {}),
    })).finish();
    // EthAccount { BaseAccount base_account = 1; string code_hash = 2; }
    const codeHash = new TextEncoder().encode('0x' + 'c5'.repeat(32));
    const eth = Uint8Array.from([0x0a, ...varint(base.length), ...base, 0x12, ...varint(codeHash.length), ...codeHash]);
    const value = QueryAccountResponse.encode({ account: Any.fromPartial({ typeUrl: '/cosmos.evm.types.v1.EthAccount', value: eth }) }).finish();
    return { code: 0, log: '', info: '', index: '0', key: null, value: b64(value), proofOps: null, height: this.height.toString(), codespace: '' };
  }

  /** CheckTx and, when it passes, immediate inclusion. The result is recorded either way. */
  private broadcast(txBytes: Uint8Array): Json {
    const signerPub = decodeAndVerifyTx(txBytes, w.CHAIN_ID, 0n).signerPubKey;
    const signer = addressFromPubKey(w.PREFIX, signerPub);
    const acct = this.accounts.get(signer);
    const decoded = decodeAndVerifyTx(txBytes, w.CHAIN_ID, acct?.accountNumber ?? 0n);
    let code = 0;
    let log = '';
    const reject = (c: number, l: string): void => {
      if (code === 0) {
        code = c;
        log = l;
      }
    };
    if (acct === undefined) reject(9, `account ${signer} not found`);
    if (decoded.pubKeyTypeUrl !== '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey') reject(4, `pubkey type ${decoded.pubKeyTypeUrl}`);
    if (!decoded.signatureValid) reject(4, 'signature verification failed');
    if (acct !== undefined && decoded.sequence !== acct.sequence) reject(32, `account sequence mismatch, expected ${acct.sequence}, got ${decoded.sequence}`);
    if (decoded.feeDenoms.some((d) => d !== this.businessDenom)) reject(13, `fee denom must be ${this.businessDenom}`);

    const msgResponses: { typeUrl: string; value: Uint8Array }[] = [];
    if (code === 0 && acct !== undefined) {
      acct.sequence += 1n;
      acct.pubKey = decoded.signerPubKey;
      for (const m of decoded.messages) {
        if (m.typeUrl !== '/task.v1.MsgCreateSession') {
          reject(2, `message ${m.typeUrl} not handled by the fake node`);
          continue;
        }
        const claimed = new TextDecoder().decode(m.value.subarray(2, 2 + (m.value[1] ?? 0)));
        if (m.value[0] !== 0x0a || claimed !== signer) reject(4, `MsgCreateSession signer ${claimed} is not the tx signer ${signer}`);
        const nonce = this.sessionNonces.get(signer) ?? 0n;
        const sessionId = this.seedSession(signer);
        // MsgCreateSessionResponse { bytes session_id = 1; uint64 session_nonce = 2; MutationStatusV1 status = 3; }
        msgResponses.push({
          typeUrl: '/task.v1.MsgCreateSessionResponse',
          value: Uint8Array.from([0x0a, 32, ...Buffer.from(sessionId, 'hex'), 0x10, ...varint(Number(nonce)), 0x18, 1]),
        });
      }
    }
    this.txs.push({ txBytes, decoded, code, log, height: this.height, msgResponses });
    return { code, data: '', log, codespace: code === 0 ? '' : 'sdk', hash: decoded.hash, gas_wanted: '0', gas_used: '0' };
  }
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return out;
}
