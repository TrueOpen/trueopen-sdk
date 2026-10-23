import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRouterTransport } from '@connectrpc/connect';
import type { Transport } from '@connectrpc/connect';
import { IngressAPI } from '../../src/gen/nexus/v1/ingress_pb.js';
import type { AckOutputRequest, OpenTaskHeader, OpenTaskRequest } from '../../src/gen/nexus/v1/ingress_pb.js';
import { TrueOpenClient } from '../../src/client';
import type { FacadeHubReader, TrueOpenClientConfig } from '../../src/client';
import type { ChainClient, UpdateSessionKeyInput } from '../../src/transport/chain-client';
import type { SessionKeyGrant } from '../../src/transport/task-msgs';
import type { StreamStateView } from '../../src/types/node';
import type { TaskOrderIntent, TaskOrderChainContext } from '../../src/order/task-order-input';
import { buildTaskOrder, defaultGenerationParams } from '../../src/order/task-order-input';
import { TASK_TYPE, DEADLINE_LATENCY_CLASS } from '../../src/order/task-order';
import { decodeSignedOrder, taskOrderEip712Digest } from '../../src/order/signed-order';
import { sdkRequestEip712Digest } from '../../src/transport/sdk-request-envelope';
import { sessionGrantHash } from '../../src/session/session-grant';
import type { BuilderSetSnapshot, ServiceDescriptorRef, BeaconView, ParameterBucketView } from '../../src/types/hub';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
import { ethSecp256k1Address, ethAddressBytes, recoverEip712PubKey } from '../../src/signer/eth-secp256k1';
import { privateKeyTypedDataSigner } from '../../src/signer/typed-data-signer';
import type { TypedData } from '../../src/signer/typed-data-signer';
import { generateSessionKey, sessionKeyFromPrivateKey } from '../../src/session/registered-session-key';
import { fromHex, toHex } from '../../src/util/bytes';
import { hash32Text } from '../../src/codec/hash32';
import { SESSION_KEY_AUTH, skKey, skAddress, fixtureOrder } from '../helpers/session-key-authorization';

const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const USER = ethSecp256k1Address(secp256k1PublicKey(PRIV), 'trueopen');
const USER_ADDRESS_HEX = toHex(ethAddressBytes(secp256k1PublicKey(PRIV)));
const EVM = 424242n;
const ORDER_EIP712 = { signatureChainId: EVM, feeDenom: 'utrueopen' };

const hexOf = (b: number): string => hash32Text(new Uint8Array(32).fill(b));
const SESSION = '0xb793a05ff8441795fca46a890b906b0c81af9d8d7a4d53e82de53a1c917b9883';
const SET_HASH = hexOf(0x15);
const ANCHOR_HASH = hexOf(0x14);
const ADDRS = [
  'trueopen1yfse4c367uc2rja5g3905ynmnuv2hjk8gcgvfl',
  'trueopen1870sqtdru7dj3xgwpzcexry0dwvyz2ku7xv9mg',
  'trueopen1wltmkp6cpvulh9ya7z0hhw0cpgwsvsdccd5man',
];
const snapshot: BuilderSetSnapshot = {
  builderSetId: 'genesis-1', builderSetVersion: 1n, effectiveHeight: 1n, builders: ADDRS.join(','), setHash: SET_HASH,
};

/** The delegated order's max_fee in the wire fixture (the admission cases are built around it). */
const MAX_FEE = fixtureOrder().maxFee.atomicUnits;

const intent: TaskOrderIntent = {
  modelId: '0xad410b3157d13dbfb8263e92914cfe5a75868ce68fd722d2f73c75ff8cc7378b',
  profileVersion: 1,
  taskType: TASK_TYPE.TEXT_GENERATION,
  payload: new TextEncoder().encode('trueopen-input'),
  inputBucket: 1,
  outputBudgetBucket: 1,
  generationParams: defaultGenerationParams(128n, 2_000n),
  amounts: {
    priceBid: { atomicUnits: '100000' }, maxFee: { atomicUnits: MAX_FEE },
    assignmentPriorityFee: { atomicUnits: '0' }, txFeeReserve: { atomicUnits: '0' },
  },
  earliestSubmitHeight: 1_000n,
  orderExpireHeight: 51_000n,
  latencyClass: DEADLINE_LATENCY_CLASS.STANDARD,
};
const PRICING = { minOrderValue: 0n, verifyRatioBps: 0n, initialOutputPrice: 0n };

interface HubState {
  latest: bigint;
  /** Each latest-height read moves the chain one block on (a chain producing blocks during a wait). */
  advance?: boolean;
  maxKeyBlocks: bigint | undefined;
  beaconReads: bigint[];
}

function makeHub(state: HubState): FacadeHubReader {
  const hub = {
    getLatestHeight: async (): Promise<bigint> => (state.advance === true ? (state.latest += 1n) : state.latest),
    getBuilderSetAtHeight: async (): Promise<BuilderSetSnapshot> => snapshot,
    getBeacon: async (height: bigint): Promise<BeaconView> => {
      state.beaconReads.push(height);
      return { height, blockHash: ANCHOR_HASH, randomnessHex: toHex(new Uint8Array(32).fill(0x01)), sourceTag: 'proposer_vrf_v1', verified: true };
    },
    getTaskGenerationLimits: async () => ({
      maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
      stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
    }),
    getParameterBucket: async (kind: string): Promise<ParameterBucketView> => ({
      bucketKind: kind, bucketKey: 'default', version: 1n, currentVersion: 1n, effectiveHeight: 0n,
    }),
    getBusinessDenom: async (): Promise<string> => 'utrueopen',
    getProfile: async () => ({ pricing: PRICING }),
    getAnchorFreshnessWindowBlocks: async (): Promise<bigint> => 100n,
    getServiceDescriptor: async (id: string): Promise<ServiceDescriptorRef> => ({
      participantType: 'PARTICIPANT_TYPE_BUILDER', participantId: id, descriptorVersion: 2n,
      endpoints: [{ endpointKind: 'SERVICE_ENDPOINT_KIND_NEXUS_GRPC', uri: `grpc://${id}:8080`, protocolVersion: 'v1' }],
      descriptorHash: hexOf(0xaa), updatedHeight: 1n,
    }),
    ...(state.maxKeyBlocks !== undefined ? { getMaxSessionKeyBlocks: async (): Promise<bigint> => state.maxKeyBlocks! } : {}),
  };
  return hub as unknown as FacadeHubReader;
}

/** A chain whose session state follows createSession / updateSessionKey, at the hub's latest height. */
class FakeChain implements ChainClient {
  stream: StreamStateView = {
    sessionId: SESSION, owner: USER, nextExpectedSequence: 7n, lastActiveHeight: 0n, openPendingCount: 0n, status: 'ACTIVE',
    sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySpent: '0', sessionKeySetHeight: 0n,
  };
  creates: ({ readonly sessionKey?: SessionKeyGrant } | undefined)[] = [];
  updates: UpdateSessionKeyInput[] = [];
  sessionReads = 0;

  constructor(private readonly hub: HubState) {}

  async querySession(id: string): Promise<StreamStateView> {
    this.sessionReads += 1;
    return { ...this.stream, sessionId: id };
  }
  async querySessionNonce() { return { nextSessionNonce: 0n }; }
  async createSession(input?: { readonly sessionKey?: SessionKeyGrant }) {
    this.creates.push(input);
    if (input?.sessionKey !== undefined) this.applySet(input.sessionKey);
    return { sessionId: SESSION, owner: USER, nonce: 0n, status: 'MUTATION_STATUS_V1_APPLIED' };
  }
  async updateSessionKey(input: UpdateSessionKeyInput) {
    this.updates.push(input);
    if ('set' in input.action) this.applySet(input.action.set);
    else {
      const { sessionKey: _, ...rest } = this.stream;
      void _;
      this.stream = { ...rest, sessionKeyExpiryHeight: 0n, sessionKeySpendCap: '0', sessionKeySetHeight: 0n };
    }
    const s = this.stream;
    return {
      ...(s.sessionKey !== undefined ? { sessionKey: s.sessionKey } : {}),
      expiryHeight: s.sessionKeyExpiryHeight, spendCap: s.sessionKeySpendCap, spent: s.sessionKeySpent,
      setHeight: s.sessionKeySetHeight, status: 'MUTATION_STATUS_V1_APPLIED',
    };
  }
  async cancelOrder(): Promise<never> { throw new Error('unused'); }

  private applySet(g: SessionKeyGrant): void {
    const same = this.stream.sessionKey !== undefined && toHex(this.stream.sessionKey) === toHex(g.sessionKey);
    this.stream = {
      ...this.stream, sessionKey: g.sessionKey, sessionKeyExpiryHeight: g.expiryHeight, sessionKeySpendCap: g.spendCap,
      sessionKeySetHeight: same ? this.stream.sessionKeySetHeight : this.hub.latest,
    };
  }
}

function acceptTransport(headers: OpenTaskHeader[]): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      async openTask(reqs: AsyncIterable<OpenTaskRequest>) {
        for await (const f of reqs) if (f.frame.case === 'header') headers.push(f.frame.value);
        return { taskId: '', accepted: true, reason: '', sessionId: SESSION };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

/** A Builder that answers AckOutput and records each request envelope. */
function ackTransport(acks: AckOutputRequest[]): Transport {
  return createRouterTransport(({ service }) => {
    service(IngressAPI, {
      ackOutput(req: AckOutputRequest) {
        acks.push(req);
        return { acked: true, alreadyAcked: false, ackedAt: 1n };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });
}

function setup(opts: { maxKeyBlocks?: bigint | undefined; latest?: bigint; anchorWaitMs?: number; grant?: boolean; config?: Partial<TrueOpenClientConfig> } = {}) {
  const hubState: HubState = {
    latest: opts.latest ?? 1_000n,
    maxKeyBlocks: 'maxKeyBlocks' in opts ? opts.maxKeyBlocks : 100n,
    beaconReads: [],
  };
  const chain = new FakeChain(hubState);
  const headers: OpenTaskHeader[] = [];
  const prompts: TypedData[] = [];
  const inner = privateKeyTypedDataSigner(PRIV);
  const wallet = { signTypedData: async (d: TypedData) => { prompts.push(d); return inner.signTypedData(d); } };
  const acks: AckOutputRequest[] = [];
  const client = new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, wallet, chain,
    ingressTransport: ackTransport(acks), hub: makeHub(hubState),
    ...(opts.grant === true ? { session: { maxGrantBlocks: 400 } } : {}),
    ingressTransportFactory: () => acceptTransport(headers),
    nonce: () => new Uint8Array(32).fill(1),
    signatureChainId: EVM, feeDenom: 'utrueopen',
    sessionKeyAnchorPollMs: 1,
    ...(opts.anchorWaitMs !== undefined ? { sessionKeyAnchorWaitMs: opts.anchorWaitMs } : {}),
    ...opts.config,
  });
  return { client, chain, hubState, headers, prompts, acks };
}

/** What an SDK request envelope's signature recovers to, and whether it carries a grant. */
function envelopeSigner(env: NonNullable<AckOutputRequest['requestEnvelope']>): { signer: string; grant: boolean } {
  const g = env.sessionGrant;
  const digest = sdkRequestEip712Digest(
    { chainId: env.chainId, method: env.method, sessionId: env.sessionId, taskId: env.taskId, requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime, bodyDigest: env.bodyDigest },
    EVM,
    g !== undefined
      ? sessionGrantHash({ chainId: g.chainId, user: g.user, sessionKey: g.sessionKey, expiryHeight: g.expiryHeight, grantNonce: g.grantNonce, signatureChainId: g.signatureChainId })
      : undefined,
  );
  return { signer: toHex(ethAddressBytes(recoverEip712PubKey(digest, env.signature))), grant: g !== undefined };
}

/** What a header's order signature and request envelope recover to. */
function recovered(header: OpenTaskHeader, ctx: TaskOrderChainContext, orderSequence: bigint): { order: string; envelope: string; grant: boolean } {
  const order = buildTaskOrder(ctx, { ...intent, userAddress: USER, sessionId: SESSION, orderSequence }, PRICING);
  const sig = decodeSignedOrder(header.orderEnvelope).userSignature;
  const env = header.requestEnvelope!;
  const envDigest = sdkRequestEip712Digest(
    { chainId: env.chainId, method: env.method, sessionId: env.sessionId, taskId: env.taskId, requestNonce: env.requestNonce, expiryHeightOrTime: env.expiryHeightOrTime, bodyDigest: env.bodyDigest },
    EVM,
  );
  return {
    order: toHex(ethAddressBytes(recoverEip712PubKey(taskOrderEip712Digest(order, ORDER_EIP712), sig))),
    envelope: toHex(ethAddressBytes(recoverEip712PubKey(envDigest, env.signature))),
    grant: env.sessionGrant !== undefined,
  };
}

function context(latestHeight: bigint, anchorHeight: bigint): TaskOrderChainContext {
  return {
    chainId: 'trueopen-localnet-1', sessionAnchorHeight: anchorHeight, sessionAnchorBlockHash: ANCHOR_HASH,
    builderSetId: 'genesis-1', builderSetHash: SET_HASH, timeoutBucketVersion: 1n,
    generationLimits: {
      maxOutputTokens: 131_072n, topKMax: 1000n, stopSequenceMaxItems: 16n,
      stopSequenceMaxBytesEach: 128n, stopSequenceMaxTotalBytes: 1024n, stopTokenMaxItems: 64n,
    },
    latestHeight,
  };
}

const open = (client: TrueOpenClient, extra: { context?: TaskOrderChainContext; orderSequence?: bigint } = {}) =>
  client.openTask({ sessionId: SESSION, order: intent, idempotencyKey: 'idem-1', pricing: PRICING, ...extra });

describe('TrueOpenClient.createSession with a session key (ADR-0037)', () => {
  it('generates a key, registers it in MsgCreateSession and returns its 32-byte private key once', async () => {
    const { client, chain } = setup();
    const h = await client.createSession({ label: 'k', sessionKey: {} });
    const sk = h.sessionKey!;
    expect(sk.privateKey).toHaveLength(32);
    const address = sessionKeyFromPrivateKey(sk.privateKey).address;
    expect(sk.address).toBe(`0x${toHex(address)}`);
    // Defaults: max_session_key_blocks - 2 blocks from the latest height, and an explicit "0" cap.
    expect(sk.expiryHeight).toBe(1_098n);
    expect(sk.spendCap).toBe('0');
    expect(chain.creates).toHaveLength(1);
    const grant = chain.creates[0]!.sessionKey!;
    expect(toHex(grant.sessionKey)).toBe(toHex(address));
    expect(toHex(grant.sessionKey)).not.toBe(USER_ADDRESS_HEX);
    expect(grant).toMatchObject({ expiryHeight: 1_098n, spendCap: '0' });
    expect(h.label).toBe('k');
    // Loaded: the chain's key is the one this client holds.
    expect(await client.sessionKeyState(SESSION)).toMatchObject({ registered: true, matchesLoadedKey: true, expiryHeight: 1_098n, setHeight: 1_000n });
  });

  it('takes expiryBlocks and a bigint or decimal spendCap', async () => {
    const { client, chain } = setup();
    expect((await client.createSession({ sessionKey: { expiryBlocks: 100, spendCap: 5_000n } })).sessionKey)
      .toMatchObject({ expiryHeight: 1_100n, spendCap: '5000' });
    expect((await client.createSession({ sessionKey: { expiryBlocks: 2, spendCap: '7' } })).sessionKey)
      .toMatchObject({ expiryHeight: 1_002n, spendCap: '7' });
    expect(chain.creates.map((c) => c?.sessionKey?.spendCap)).toEqual(['5000', '7']);
  });

  it('a label alone (the old signature) registers no key', async () => {
    const { client, chain } = setup();
    const h = await client.createSession('plain');
    expect(h.label).toBe('plain');
    expect(h.sessionKey).toBeUndefined();
    expect(chain.creates).toEqual([undefined]);
  });

  it('refuses a chain without session keys: max_session_key_blocks 0 (or 1, which no registration can land with), or a hub that cannot read it', async () => {
    for (const maxKeyBlocks of [0n, 1n, undefined]) {
      const { client, chain } = setup({ maxKeyBlocks });
      await expect(client.createSession({ sessionKey: {} })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_UNSUPPORTED' });
      expect(chain.creates).toHaveLength(0);
    }
  });

  it('refuses expiryBlocks outside [2, max_session_key_blocks] and a non-canonical cap', async () => {
    const { client, chain } = setup();
    // 1 block never lands: the tx executes at latest + 1 and needs height < expiry.
    for (const expiryBlocks of [0, 1, 101, 1.5, -1, Number.NaN]) {
      await expect(client.createSession({ sessionKey: { expiryBlocks } })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' });
    }
    for (const spendCap of ['01', '-1', '', '1.0', -1n]) {
      await expect(client.createSession({ sessionKey: { spendCap } })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' });
    }
    expect(chain.creates).toHaveLength(0);
  });

  it('a small limit: the default expiry is at least two blocks', async () => {
    for (const maxKeyBlocks of [2n, 3n, 4n]) {
      const { client } = setup({ maxKeyBlocks });
      expect((await client.createSession({ sessionKey: {} })).sessionKey!.expiryHeight).toBe(1_002n);
    }
    const { client } = setup({ maxKeyBlocks: 5n });
    expect((await client.createSession({ sessionKey: {} })).sessionKey!.expiryHeight).toBe(1_003n);
  });

  it('the default expiry is exact for a limit above 2^53 (computed in bigint)', async () => {
    const max = (1n << 60n) + 1n;
    const { client, chain } = setup({ maxKeyBlocks: max });
    expect((await client.createSession({ sessionKey: {} })).sessionKey!.expiryHeight).toBe(1_000n + max - 2n);
    expect(chain.creates[0]!.sessionKey!.expiryHeight).toBe(1_000n + max - 2n);
  });

  it('registers caller-supplied key material (persisted before the broadcast) as is', async () => {
    const { client, chain } = setup();
    const m = generateSessionKey();
    const h = await client.createSession({ sessionKey: { key: m } });
    expect(toHex(chain.creates[0]!.sessionKey!.sessionKey)).toBe(toHex(m.address));
    expect(h.sessionKey!.address).toBe(`0x${toHex(m.address)}`);
    expect(toHex(h.sessionKey!.privateKey)).toBe(toHex(m.privateKey));
    expect((await client.sessionKeyState(SESSION)).matchesLoadedKey).toBe(true);
  });

  it('refuses invalid supplied material before any transaction, without key material in the error', async () => {
    const { client, chain } = setup();
    const m = generateSessionKey();
    const other = generateSessionKey();
    const bad = [
      { privateKey: m.privateKey, address: other.address }, // address is not the key's
      { privateKey: new Uint8Array(31), address: m.address },
      { privateKey: new Uint8Array(32), address: m.address }, // zero key
      sessionKeyFromPrivateKey(PRIV), // the owner's own key
    ];
    for (const key of bad) {
      const e = (await client.createSession({ sessionKey: { key } }).then(() => undefined, (x: unknown) => x)) as Error;
      expect(e).toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' });
      for (const secret of [m.privateKey, PRIV]) expect(e.message).not.toContain(toHex(secret));
    }
    expect(chain.creates).toHaveLength(0);
  });
});

describe('TrueOpenClient config: the session-key anchor wait', () => {
  const make = (extra: Record<string, number>) => () => new TrueOpenClient({
    chainId: 'trueopen-localnet-1', userAddress: USER, wallet: privateKeyTypedDataSigner(PRIV),
    chain: new FakeChain({ latest: 1n, maxKeyBlocks: 100n, beaconReads: [] }), ingressTransport: acceptTransport([]),
    ...extra,
  });

  it('refuses a wait that is not finite and >= 0, and a poll that is not finite and > 0', () => {
    for (const w of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(make({ sessionKeyAnchorWaitMs: w })).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_CONFIG_INVALID' }));
    }
    for (const p of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(make({ sessionKeyAnchorPollMs: p })).toThrow(expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_CONFIG_INVALID' }));
    }
  });

  it('accepts 0 (no wait), positive values and the defaults', () => {
    expect(make({ sessionKeyAnchorWaitMs: 0, sessionKeyAnchorPollMs: 0.5 })).not.toThrow();
    expect(make({ sessionKeyAnchorWaitMs: 15_000, sessionKeyAnchorPollMs: 1_000 })).not.toThrow();
    expect(make({})).not.toThrow();
  });
});

describe('TrueOpenClient.openTask with a registered session key', () => {
  it('the key signs the order and the envelope (no grant, no wallet prompt); one session read serves the sequence', async () => {
    const { client, chain, headers, prompts } = setup();
    const h = await client.createSession({ sessionKey: {} });
    const key = toHex(sessionKeyFromPrivateKey(h.sessionKey!.privateKey).address);
    chain.sessionReads = 0;
    const res = await open(client, { context: context(1_000n, 1_000n) });
    expect(chain.sessionReads).toBe(1);
    expect(headers).toHaveLength(3);
    for (const header of headers) {
      expect(header.orderSequence).toBe(7n);
      expect(header.userAddress).toBe(USER);
      expect(header.requestEnvelope!.signerAddress).toBe(USER);
      expect(recovered(header, res.context, 7n)).toEqual({ order: key, envelope: key, grant: false });
    }
    expect(prompts).toHaveLength(0);
  });

  it('without a loaded key the wallet signs, as before', async () => {
    const { client, headers, prompts } = setup();
    const res = await open(client, { context: context(1_000n, 998n), orderSequence: 3n });
    expect(recovered(headers[0]!, res.context, 3n)).toEqual({ order: USER_ADDRESS_HEX, envelope: USER_ADDRESS_HEX, grant: false });
    expect(prompts).toHaveLength(2);
  });

  describe('the local admission prechecks mirror wire admission_cases', () => {
    type Case = {
      name: string; order: string; expected: string; anchor_height: number; current_height: number;
      state: { cap: string; expiry: number; key: string; next_sequence: number; set_height: number; spent: string; status: StreamStateView['status'] };
    };
    const NAMES = [
      'inclusive_expiry_and_exact_cap', 'idle_session', 'expiry_passed', 'anchor_before_reregistration', 'anchor_equals_set_height',
      'rotated_to_other_key', 'cleared_key', 'closed_retained_session', 'cap_one_unit_short', 'cap_reduced_below_spent', 'zero_cap_is_unlimited',
      'unlimited_still_checks_overflow',
    ];
    /** The chain's admission result -> what the SDK refuses with before signing (undefined: it signs). */
    const SDK_CODE: Record<string, string | undefined> = {
      ACCEPT_SESSION_KEY: undefined,
      ERR_SESSION_KEY_EXPIRED: 'SDK_LOCAL_SESSION_KEY_EXPIRED',
      // A different key, and an anchor before the registration, are both ERR_SESSION_KEY_INVALID on chain.
      ERR_SESSION_KEY_INVALID: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
      // No key registered: on chain the signature simply does not match the user.
      SIGNATURE_MISMATCH: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
      SESSION_CLOSED: 'SDK_LOCAL_SESSION_CLOSED',
      ERR_SESSION_KEY_SPEND_CAP_EXCEEDED: 'SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED',
      // spent + max_fee past u64, even with cap 0 (unlimited): the same local code, details.overflow.
      AMOUNT_OVERFLOW: 'SDK_LOCAL_SESSION_KEY_SPEND_CAP_EXCEEDED',
    };
    /** Where the chain's single ERR_SESSION_KEY_INVALID splits into a more specific SDK code. */
    const BY_NAME: Record<string, string> = { anchor_before_reregistration: 'SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT' };
    const cases = (SESSION_KEY_AUTH.admission_cases as Case[]).filter((c) => NAMES.includes(c.name));

    it('every named case is in the fixture, with the delegated order and its max_fee', () => {
      expect(cases.map((c) => c.name).sort()).toEqual([...NAMES].sort());
      expect(cases.every((c) => c.order === 'delegated_order')).toBe(true);
      expect(toHex(skAddress('session_key'))).toBe(cases[0]!.state.key);
      expect(MAX_FEE).toBe('150000');
    });

    for (const name of NAMES) {
      it(name, async () => {
        const c = cases.find((x) => x.name === name)!;
        const { client, chain, headers, prompts } = setup({ latest: BigInt(c.current_height) });
        // Load the fixture key against a matching registration, then put the case's state on chain.
        chain.stream = { ...chain.stream, sessionKey: skAddress('session_key'), sessionKeyExpiryHeight: 1n << 40n };
        await client.useSessionKey(SESSION, skKey('session_key'));
        const { key: _k, ...rest } = c.state;
        void _k;
        chain.stream = {
          sessionId: SESSION, owner: USER, nextExpectedSequence: BigInt(rest.next_sequence), lastActiveHeight: 0n, openPendingCount: 0n,
          status: rest.status, sessionKeyExpiryHeight: BigInt(rest.expiry), sessionKeySpendCap: rest.cap, sessionKeySpent: rest.spent,
          sessionKeySetHeight: BigInt(rest.set_height), ...(c.state.key !== '' ? { sessionKey: fromHex(c.state.key) } : {}),
        };
        const run = open(client, { context: context(BigInt(c.current_height), BigInt(c.anchor_height)) });
        const want = BY_NAME[name] ?? SDK_CODE[c.expected];
        expect(c.expected in SDK_CODE, c.expected).toBe(true);
        if (want === undefined) {
          const res = await run;
          expect(recovered(headers[0]!, res.context, BigInt(rest.next_sequence)).order).toBe(c.state.key);
        } else {
          await expect(run).rejects.toMatchObject({ code: want });
          expect(headers).toHaveLength(0);
        }
        // Never a wallet fallback.
        expect(prompts).toHaveLength(0);
      });
    }
  });

  it('a reused anchor older than the key registration is replaced by a fresh one, once', async () => {
    const { client, chain, hubState, headers } = setup();
    // Cache an anchor at 998 (latest 1000 - 2).
    await client.resolveTaskBuilders({ sessionId: SESSION, orderSequence: 0n });
    hubState.latest = 1_003n;
    await client.createSession({ sessionKey: {} }); // registered at 1003
    chain.stream = { ...chain.stream, sessionKeySetHeight: 1_001n };
    hubState.beaconReads = [];
    const res = await open(client);
    // The reused 998 predates 1001: one fresh context at 1003 - 2.
    expect(res.context.sessionAnchorHeight).toBe(1_001n);
    expect(hubState.beaconReads).toEqual([1_001n]);
    expect(headers).toHaveLength(3);
  });

  it('right after registration: waits for a fresh anchor at or after set_height, then signs with the key', async () => {
    const { client, chain, hubState, headers, prompts } = setup();
    await client.resolveTaskBuilders({ sessionId: SESSION, orderSequence: 0n });
    hubState.latest = 1_003n;
    const h = await client.createSession({ sessionKey: {} });
    expect(chain.stream.sessionKeySetHeight).toBe(1_003n);
    // The chain keeps producing blocks while openTask waits.
    hubState.advance = true;
    const res = await open(client);
    expect(res.context.sessionAnchorHeight).toBeGreaterThanOrEqual(1_003n);
    const key = toHex(sessionKeyFromPrivateKey(h.sessionKey!.privateKey).address);
    expect(recovered(headers[0]!, res.context, 7n)).toMatchObject({ order: key, envelope: key, grant: false });
    expect(prompts).toHaveLength(0);
  });

  it('the wait is bounded: past it, a retriable SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT with the heights, nothing signed', async () => {
    const { client, chain, hubState, headers, prompts } = setup({ anchorWaitMs: 20 });
    await client.resolveTaskBuilders({ sessionId: SESSION, orderSequence: 0n });
    hubState.latest = 1_003n;
    await client.createSession({ sessionKey: {} });
    expect(chain.stream.sessionKeySetHeight).toBe(1_003n);
    await expect(open(client)).rejects.toMatchObject({
      code: 'SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT',
      retriable: true,
      details: { setHeight: 1_003n, anchorHeight: 998n },
    });
    expect(headers).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("a caller's stale context is refused at once, not retriable, without waiting or a fresh anchor", async () => {
    const { client, chain, hubState, headers } = setup();
    await client.createSession({ sessionKey: {} });
    hubState.beaconReads = [];
    hubState.advance = true;
    const before = hubState.latest;
    await expect(open(client, { context: context(1_000n, 999n) })).rejects.toMatchObject({
      code: 'SDK_LOCAL_SESSION_KEY_ANCHOR_BEFORE_SET_HEIGHT',
      retriable: false,
      details: { setHeight: 1_000n, anchorHeight: 999n },
      message: expect.stringContaining('pass a newer context'),
    });
    expect(hubState.beaconReads).toEqual([]);
    // No latest-height polling happened.
    expect(hubState.latest).toBe(before);
    expect(chain.stream.sessionKeySetHeight).toBe(1_000n);
    expect(headers).toHaveLength(0);
  });
});

describe('TrueOpenClient.useSessionKey / updateSessionKey / forgetSessionKey', () => {
  it('useSessionKey refuses a key the chain does not have registered, and a CLOSED session', async () => {
    const { client, chain } = setup();
    chain.stream = { ...chain.stream, sessionKey: skAddress('session_key'), sessionKeyExpiryHeight: 2_000n };
    await expect(client.useSessionKey(SESSION, skKey('wrong_key'))).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED' });
    expect((await client.sessionKeyState(SESSION)).matchesLoadedKey).toBe(false);
    chain.stream = { ...chain.stream, status: 'CLOSED' };
    await expect(client.useSessionKey(SESSION, skKey('session_key'))).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_CLOSED' });
    chain.stream = { ...chain.stream, status: 'IDLE' };
    await client.useSessionKey(SESSION, skKey('session_key'));
    expect(await client.sessionKeyState(SESSION)).toMatchObject({ registered: true, matchesLoadedKey: true, status: 'IDLE' });
  });

  it("useSessionKey refuses a session owned by someone other than this client's user", async () => {
    const { client, chain } = setup();
    chain.stream = { ...chain.stream, owner: ADDRS[0]!, sessionKey: skAddress('session_key'), sessionKeyExpiryHeight: 2_000n };
    await expect(client.useSessionKey(SESSION, skKey('session_key'))).rejects.toMatchObject({
      code: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED',
      message: expect.stringContaining('belongs to'),
    });
    expect((await client.sessionKeyState(SESSION)).matchesLoadedKey).toBe(false);
  });

  it('rotate registers a fresh key and replaces the loaded one; orders then recover to the new key', async () => {
    const { client, chain, headers } = setup();
    const first = (await client.createSession({ sessionKey: { spendCap: 900_000n } })).sessionKey!;
    const r = await client.updateSessionKey(SESSION, { rotate: { expiryBlocks: 50 } });
    const next = r.newKey!;
    expect(next.address).not.toBe(first.address);
    expect(toHex(next.privateKey)).not.toBe(toHex(first.privateKey));
    // The cap is kept unless given: a rotation never lifts it silently.
    expect(next).toMatchObject({ expiryHeight: 1_050n, spendCap: '900000' });
    const set = (chain.updates[0]!.action as { set: SessionKeyGrant }).set;
    expect(`0x${toHex(set.sessionKey)}`).toBe(next.address);
    expect(r.response.expiryHeight).toBe(1_050n);
    const res = await open(client, { context: context(1_000n, 1_000n) });
    expect(`0x${recovered(headers[0]!, res.context, 7n).order}`).toBe(next.address);
  });

  it('renew keeps the loaded key; its cap defaults to the chain cap', async () => {
    const { client, chain } = setup();
    const k = (await client.createSession({ sessionKey: { spendCap: '1234' } })).sessionKey!;
    const r = await client.updateSessionKey(SESSION, { renew: { expiryBlocks: 20 } });
    expect(r.newKey).toBeUndefined();
    const set = (chain.updates[0]!.action as { set: SessionKeyGrant }).set;
    expect(`0x${toHex(set.sessionKey)}`).toBe(k.address);
    expect(set).toMatchObject({ expiryHeight: 1_020n, spendCap: '1234' });
    await client.updateSessionKey(SESSION, { renew: { spendCap: 0n } });
    expect((chain.updates[1]!.action as { set: SessionKeyGrant }).set.spendCap).toBe('0');
  });

  it('renew refuses a loaded key the chain no longer has (rotated elsewhere, or cleared), and a CLOSED session', async () => {
    const { client, chain } = setup();
    chain.stream = { ...chain.stream, sessionKey: skAddress('session_key'), sessionKeyExpiryHeight: 2_000n };
    await client.useSessionKey(SESSION, skKey('session_key')); // K1 loaded
    chain.stream = { ...chain.stream, sessionKey: skAddress('wrong_key') }; // another device rotated to K2
    await expect(client.updateSessionKey(SESSION, { renew: {} })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED' });
    const { sessionKey: _, ...cleared } = chain.stream;
    void _;
    chain.stream = cleared;
    await expect(client.updateSessionKey(SESSION, { renew: {} })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED' });
    chain.stream = { ...chain.stream, sessionKey: skAddress('session_key'), status: 'CLOSED' };
    await expect(client.updateSessionKey(SESSION, { renew: {} })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_CLOSED' });
    expect(chain.updates).toHaveLength(0);
  });

  it('renew without a loaded key is refused before any transaction', async () => {
    const { client, chain } = setup();
    await expect(client.updateSessionKey(SESSION, { renew: {} })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_NOT_REGISTERED' });
    expect(chain.updates).toHaveLength(0);
  });

  it('rotate and renew validate the height window; clear does not need one', async () => {
    const { client, chain } = setup();
    await client.createSession({ sessionKey: {} });
    await expect(client.updateSessionKey(SESSION, { rotate: { expiryBlocks: 101 } })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' });
    await expect(client.updateSessionKey(SESSION, { renew: { expiryBlocks: 1 } })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' });
    expect(chain.updates).toHaveLength(0);
  });

  it('clear removes the registration and the loaded key: the wallet signs again', async () => {
    const { client, chain, headers, prompts } = setup();
    await client.createSession({ sessionKey: {} });
    const r = await client.updateSessionKey(SESSION, { clear: true });
    expect(chain.updates[0]!.action).toEqual({ clear: true });
    expect(r.response.sessionKey).toBeUndefined();
    expect(await client.sessionKeyState(SESSION)).toMatchObject({ registered: false, matchesLoadedKey: false });
    const res = await open(client, { context: context(1_000n, 998n) });
    expect(recovered(headers[0]!, res.context, 7n).order).toBe(USER_ADDRESS_HEX);
    expect(prompts).toHaveLength(2);
  });

  it('rotate when the chain has no key (after clear) needs an explicit spendCap: cap 0 would be unlimited', async () => {
    const { client, chain } = setup();
    await client.createSession({ sessionKey: { spendCap: 500n } });
    await client.updateSessionKey(SESSION, { clear: true });
    await expect(client.updateSessionKey(SESSION, { rotate: {} })).rejects.toMatchObject({
      code: 'SDK_LOCAL_SESSION_KEY_INVALID',
      message: expect.stringContaining('rotate.spendCap'),
    });
    expect(chain.updates).toHaveLength(1); // only the clear
    const r = await client.updateSessionKey(SESSION, { rotate: { spendCap: 700n } });
    expect(r.newKey!.spendCap).toBe('700');
    expect((chain.updates[1]!.action as { set: SessionKeyGrant }).set.spendCap).toBe('700');
  });

  it('rotate registers caller-supplied material, and refuses the key being rotated out', async () => {
    const { client, chain } = setup();
    const first = generateSessionKey();
    await client.createSession({ sessionKey: { key: first } });
    await expect(client.updateSessionKey(SESSION, { rotate: { key: first } })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_INVALID' });
    expect(chain.updates).toHaveLength(0);
    const next = generateSessionKey();
    const r = await client.updateSessionKey(SESSION, { rotate: { key: next } });
    expect(r.newKey!.address).toBe(`0x${toHex(next.address)}`);
    expect(toHex((chain.updates[0]!.action as { set: SessionKeyGrant }).set.sessionKey)).toBe(toHex(next.address));
    expect((await client.sessionKeyState(SESSION)).matchesLoadedKey).toBe(true);
  });

  it('forgetSessionKey unloads the key locally only', async () => {
    const { client, chain, headers } = setup();
    await client.createSession({ sessionKey: {} });
    client.forgetSessionKey(SESSION);
    expect(await client.sessionKeyState(SESSION)).toMatchObject({ registered: true, matchesLoadedKey: false });
    expect(chain.updates).toHaveLength(0);
    const res = await open(client, { context: context(1_000n, 998n) });
    expect(recovered(headers[0]!, res.context, 7n).order).toBe(USER_ADDRESS_HEX);
  });
});

describe('requests after the registered key expires (orders never fall back)', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const TASK = hexOf(0x42);
  /** Moves the clock past the reuse window of the last observed height. */
  const later = (): void => { const t = Date.now() + 5_000; vi.spyOn(Date, 'now').mockReturnValue(t); };

  for (const grant of [false, true]) {
    it(`before the margin the key signs a request; inside it, ${grant ? 'the grant key' : 'the wallet'} does; an expired order is still refused`, async () => {
      const { client, hubState, headers, acks, prompts } = setup({ grant });
      const h = await client.createSession({ sessionKey: { expiryBlocks: 10 } }); // expiry 1010
      const key = toHex(sessionKeyFromPrivateKey(h.sessionKey!.privateKey).address);
      hubState.latest = 1_007n; // 1007 + the default 3-block margin == expiry: still the key
      later();
      await client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n });
      expect(envelopeSigner(acks[0]!.requestEnvelope!)).toEqual({ signer: key, grant: false });
      expect(prompts).toHaveLength(0);

      hubState.latest = 1_008n; // two blocks before the expiry: inside the margin, falls back
      later();
      await client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n });
      const after = envelopeSigner(acks[1]!.requestEnvelope!);
      if (grant) {
        const g = acks[1]!.requestEnvelope!.sessionGrant!;
        expect(after.grant).toBe(true);
        expect(after.signer).toBe(toHex(g.sessionKey));
        expect(after.signer).not.toBe(key);
        expect(prompts.map((p) => p.primaryType)).toEqual(['SessionGrant']);
      } else {
        expect(after).toEqual({ signer: USER_ADDRESS_HEX, grant: false });
        expect(prompts).toHaveLength(1);
      }
      const promptsBefore = prompts.length;
      await expect(open(client, { context: context(1_011n, 1_009n) })).rejects.toMatchObject({ code: 'SDK_LOCAL_SESSION_KEY_EXPIRED' });
      expect(headers).toHaveLength(0);
      expect(prompts).toHaveLength(promptsBefore);
    });
  }

  it('sessionKeyRequestExpiryMarginBlocks sets the margin; a bad value is refused at construction', async () => {
    const { client, hubState, acks } = setup({ config: { sessionKeyRequestExpiryMarginBlocks: 0 } });
    const h = await client.createSession({ sessionKey: { expiryBlocks: 10 } }); // expiry 1010
    const key = toHex(sessionKeyFromPrivateKey(h.sessionKey!.privateKey).address);
    hubState.latest = 1_010n; // margin 0: the expiry height itself still signs
    later();
    await client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n });
    expect(envelopeSigner(acks[0]!.requestEnvelope!).signer).toBe(key);
    for (const bad of [-1, 2.5, Number.NaN]) {
      expect(() => setup({ config: { sessionKeyRequestExpiryMarginBlocks: bad } })).toThrow(
        expect.objectContaining({ code: 'SDK_LOCAL_SESSION_KEY_CONFIG_INVALID' }),
      );
    }
  });

  it('a renew seen on chain (sessionKeyState) brings the key back for requests', async () => {
    const { client, chain, hubState, acks } = setup();
    const h = await client.createSession({ sessionKey: { expiryBlocks: 2 } });
    const key = toHex(sessionKeyFromPrivateKey(h.sessionKey!.privateKey).address);
    hubState.latest = 1_003n;
    later();
    await client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n });
    expect(envelopeSigner(acks[0]!.requestEnvelope!).signer).toBe(USER_ADDRESS_HEX);
    // Renewed on another device.
    chain.stream = { ...chain.stream, sessionKeyExpiryHeight: 2_000n };
    await client.sessionKeyState(SESSION);
    await client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n });
    expect(envelopeSigner(acks[1]!.requestEnvelope!).signer).toBe(key);
  });

  it('renew through this client moves the expiry for requests too', async () => {
    const { client, hubState, acks } = setup();
    const h = await client.createSession({ sessionKey: { expiryBlocks: 2 } });
    const key = toHex(sessionKeyFromPrivateKey(h.sessionKey!.privateKey).address);
    await client.updateSessionKey(SESSION, { renew: { expiryBlocks: 50 } }); // 1050
    hubState.latest = 1_010n;
    later();
    await client.ingress.ackOutput({ sessionId: SESSION, taskId: TASK, lastSeq: 0n });
    expect(envelopeSigner(acks[0]!.requestEnvelope!).signer).toBe(key);
  });
});
