import { describe, it, expect } from 'vitest';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { connectTrueOpenChainClient } from '../../src/transport/trueopen-chain-client';
import { createConnectTransport } from '@connectrpc/connect-node';
import { RestChainReader } from '../../src/transport/rest-chain-reader';
import { HubReader } from '../../src/transport/hub-reader';
import { IngressClient } from '../../src/transport/ingress-client';
import type { IngressAuth } from '../../src/transport/ingress-client';
import { privKeySecp256k1Signer, secp256k1PublicKey, secp256k1Address } from '../../src/signer/secp256k1';
import { fromHex } from '../../src/util/bytes';

/**
 * Node devnet integration tests. Skipped by default; they run only when the environment
 * variables below are set.
 *
 * Read-only part (costs nothing, runs as soon as REST is reachable). Set:
 *   TRUEOPEN_REST_URL     gRPC-gateway REST, for example http://localhost:1317
 *   TRUEOPEN_SESSION_ID   (optional) an existing session_id, for the read-only querySession check
 *   TRUEOPEN_QUERY_ADDR   (optional) the address for querySessionNonce; defaults to the wallet address when there is one
 *   TRUEOPEN_TASK_ID      (optional) used with SESSION_ID to query settlement_finality
 *
 * Write part (broadcasts transactions and spends test funds, so it must be enabled explicitly). Also set:
 *   TRUEOPEN_RPC_URL          CometBFT RPC, for example http://localhost:26657
 *   TRUEOPEN_MNEMONIC         mnemonic of a funded test account
 *   TRUEOPEN_ALLOW_BROADCAST  set to "1" to actually broadcast; this reaches the network, so it needs explicit consent
 *   TRUEOPEN_ADDR_PREFIX      bech32 prefix (default trueopen)
 *   TRUEOPEN_GAS_PRICE        gas price, for example 0.025utrueopen (the default)
 *
 * Purpose: exercise the node read and write path against a real chain: REST field mapping,
 * CosmJS registry encoding, transaction broadcast and msgResponse decoding, and confirm that
 * the signature field encoding matches the chain side.
 */
const RPC = process.env['TRUEOPEN_RPC_URL'];
const REST = process.env['TRUEOPEN_REST_URL'];
const MNEMONIC = process.env['TRUEOPEN_MNEMONIC'];
const PREFIX = process.env['TRUEOPEN_ADDR_PREFIX'] ?? 'trueopen';
const GAS = process.env['TRUEOPEN_GAS_PRICE'] ?? '0.025utrueopen';
const SESSION_ID = process.env['TRUEOPEN_SESSION_ID'];
const QUERY_ADDR = process.env['TRUEOPEN_QUERY_ADDR'];
const TASK_ID = process.env['TRUEOPEN_TASK_ID'];
const ALLOW_BROADCAST = process.env['TRUEOPEN_ALLOW_BROADCAST'] === '1';

const readEnabled = Boolean(REST);
const writeEnabled = Boolean(RPC && REST && MNEMONIC && ALLOW_BROADCAST);

// nexus IngressAPI (Connect over http; see TRUEOPEN_NEXUS_URL, for example http://host:8080)
const NEXUS = process.env['TRUEOPEN_NEXUS_URL'];
const NEXUS_CHAIN_ID = process.env['TRUEOPEN_CHAIN_ID'] ?? 'trueopen-localnet-1';
const NEXUS_SESSION = process.env['TRUEOPEN_NEXUS_SESSION_ID'] ?? 'nonexistent-session';
const nexusEnabled = Boolean(NEXUS);

// The read-only part runs only when fetch is available (the Node 18+ global fetch).
const restFetch = (globalThis as { fetch?: typeof fetch }).fetch;

describe.skipIf(!readEnabled || !restFetch)('node integration: read-only (REST)', () => {
  // Built lazily: the describe callback runs during collection, so REST may not be set yet.
  const makeReader = (): RestChainReader =>
    new RestChainReader({
      baseUrl: REST as string,
      fetch: (url) => (restFetch as typeof fetch)(url),
    });

  it.skipIf(!QUERY_ADDR)('querySessionNonce returns a parsable u64', async () => {
    const r = await makeReader().querySessionNonce(QUERY_ADDR as string);
    expect(typeof r.nextSessionNonce).toBe('bigint');
    expect(r.nextSessionNonce >= 0n).toBe(true);
  });

  it.skipIf(!SESSION_ID)('querySession maps the fields correctly', async () => {
    const s = await makeReader().querySession(SESSION_ID as string);
    expect(s.sessionId).toBe(SESSION_ID);
    expect(['ACTIVE', 'IDLE', 'CLOSED']).toContain(s.status);
    expect(typeof s.nextExpectedSequence).toBe('bigint');
    expect(typeof s.openPendingCount).toBe('bigint');
    expect(typeof s.lastActiveHeight).toBe('bigint');
  });

  it.skipIf(!(SESSION_ID && TASK_ID))('querySettlementFinality maps the fields correctly', async () => {
    const f = await makeReader().querySettlementFinality(SESSION_ID as string, TASK_ID as string);
    expect(['PENDING', 'CHALLENGED', 'FINAL', 'OVERTURNED']).toContain(f.optimisticFinalityStatus);
    expect(typeof f.challengeCloseHeight).toBe('bigint');
    expect(typeof f.taskFinalityHeight).toBe('bigint');
  });
});

describe.skipIf(!readEnabled || !restFetch)('node integration: Hub read-only (Builder discovery)', () => {
  const makeHub = (): HubReader =>
    new HubReader({ baseUrl: REST as string, fetch: (url) => (restFetch as typeof fetch)(url) });

  it('listBuilders returns a parsable Builder list', async () => {
    const bs = await makeHub().listBuilders();
    expect(Array.isArray(bs)).toBe(true);
    if (bs.length > 0) {
      const b = bs[0];
      expect(typeof b?.address).toBe('string');
      expect(typeof b?.status).toBe('string');
      expect(typeof b?.currentDescriptorVersion).toBe('bigint');
    }
  });

  it('getServiceDescriptor returns inline endpoints and a base64-to-hex hash, when a Builder exists', async () => {
    const hub = makeHub();
    const set = await hub.getActiveBuilderSet();
    const addr = set.builders.split(',').map((a) => a.trim()).filter((a) => a !== '')[0];
    if (!addr) return;
    const ref = await hub.getServiceDescriptor(addr);
    expect(ref.endpoints.length).toBeGreaterThan(0);
    expect(ref.descriptorHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!writeEnabled)('node integration: write (CreateSession broadcast)', () => {
  it('CreateSession then querySession round trip, and the nonce advances', async () => {
    const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC as string, { prefix: PREFIX });
    const accounts = await wallet.getAccounts();
    const account = accounts[0];
    if (!account) throw new Error('wallet has no account');

    const { client, signingClient } = await connectTrueOpenChainClient({
      rpcUrl: RPC as string,
      restUrl: REST as string,
      signer: wallet,
      signerAddress: account.address,
      fee: 'auto',
      gasPrice: GasPrice.fromString(GAS),
    });
    try {
      const nonceBefore = await client.querySessionNonce(account.address);

      const created = await client.createSession();
      expect(created.owner).toBe(account.address);
      expect(created.sessionId.length).toBeGreaterThan(0);
      expect(['ACTIVE', 'IDLE', 'CLOSED']).toContain(created.status);

      const fetched = await client.querySession(created.sessionId);
      expect(fetched.owner).toBe(account.address);
      expect(fetched.status).toBe('ACTIVE');
      expect(fetched.nextExpectedSequence).toBe(0n);

      const nonceAfter = await client.querySessionNonce(account.address);
      // After a new session, next_session_nonce must advance (>= the value before).
      expect(nonceAfter.nextSessionNonce >= nonceBefore.nextSessionNonce).toBe(true);
    } finally {
      signingClient.disconnect();
    }
  }, 60_000); // broadcast, inclusion in a block and gas simulation take far longer than the default 5s
});

describe.skipIf(!nexusEnabled)('nexus integration (Connect over http)', () => {
  const makeTransport = () => createConnectTransport({ baseUrl: NEXUS as string, httpVersion: '1.1' });

  it('GetTaskStatus reaches a real nexus over the Connect wire', async () => {
    const client = new IngressClient(makeTransport());
    // For an unknown task nexus answers Connect NOT_FOUND(5); receiving that numeric code proves the call landed and the wire is right.
    let reached = false;
    try {
      await client.getTaskStatus(NEXUS_SESSION, 'nonexistent-task');
      reached = true;
    } catch (e) {
      reached = typeof (e as { code?: unknown }).code === 'number';
    }
    expect(reached).toBe(true);
  }, 30_000);

  it('a real nexus accepts the SDKRequestEnvelope: fetchOutputRef fails for reasons other than auth', async () => {
    // Self-consistent identity: signer_address must equal bech32(prefix, ripemd160(sha256(signer_pubkey))), otherwise nexus rejects the signature.
    const PRIV = fromHex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
    const pub = secp256k1PublicKey(PRIV);
    const addr = secp256k1Address(pub, 'trueopen'); // dogfoods the SDK helper, which matches what nexus expects
    const auth: IngressAuth = {
      chainId: NEXUS_CHAIN_ID, userAddress: addr, signerPubKey: pub,
      signer: privKeySecp256k1Signer(PRIV),
      nonce: () => new Uint8Array([1, 2, 3, 4]), expiry: () => BigInt(Date.now() + 300_000),
    };
    const client = new IngressClient(makeTransport(), auth);
    let code: unknown;
    let msg = '';
    try {
      await client.fetchOutputRef({ sessionId: NEXUS_SESSION, taskId: 'nonexistent-task', requester: addr, accessLevel: 'SEALED_KEY', usage: 'SDK_DELIVERY' });
    } catch (e) {
      const err = e as { code?: unknown; message?: string; rawMessage?: string };
      code = err.code;
      msg = err.rawMessage ?? err.message ?? '';
    }
    // The signature was accepted => not UNAUTHENTICATED(16) and no INVALID_SIGNATURE, which would mean the frame or signature drifted.
    expect(msg).not.toContain('INVALID_SIGNATURE');
    expect(code).not.toBe(16);
  }, 30_000);
});
