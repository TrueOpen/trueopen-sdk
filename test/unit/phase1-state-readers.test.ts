import { expect, it } from 'vitest';
import { RestChainReader } from '../../src/transport/rest-chain-reader';
import { HubReader } from '../../src/transport/hub-reader';
import { secp256k1PublicKey } from '../../src/signer/secp256k1';
const id = `0x${'11'.repeat(32)}`;
const key = new Uint8Array(20).fill(1);
const key64 = Buffer.from(key).toString('base64');
it('reads effective and pending Session grants separately without resetting spent', async () => {
  const session = { session_id: id, owner_user_address: 'owner', next_expected_sequence: '0', last_active_height: '10', open_pending_count: 0, status: 'SESSION_STATUS_ACTIVE', session_key: key64, session_key_expiry_height: '100', session_key_set_height: '2', session_key_spend_cap: { atomic_units: '1000' }, session_key_spent: { atomic_units: '700' }, pending_session_key_change: { kind: 'SESSION_KEY_CHANGE_KIND_V1_CLEAR', effective_height: '20' } };
  const reader = new RestChainReader({ baseUrl: 'https://chain.invalid', fetch: async () => ({ ok: true, status: 200, json: async () => ({ session }) }) });
  expect(await reader.querySession(id)).toMatchObject({ sessionKey: key, sessionKeySpent: '700', sessionKeyExpiryHeight: 100n, pendingSessionKeyChange: { kind: 'CLEAR', effectiveHeight: 20n } });
});
it('preserves the previous proof key as a separate generation and rejects partial presence', async () => {
  const current = secp256k1PublicKey(new Uint8Array(32).fill(1));
  const previous = secp256k1PublicKey(new Uint8Array(32).fill(2));
  const binding: Record<string, unknown> = { participant_type: 'PARTICIPANT_TYPE_CORTEX', operator_address: 'worker', service_address: 'current', service_pubkey: Buffer.from(current).toString('base64'), service_authorization_nonce: '2', cortex_service_key_status: 'SERVICE_KEY_STATUS_ACTIVE', previous_service_pubkey: Buffer.from(previous).toString('base64'), previous_service_authorization_nonce: '1', previous_retired_height: '50' };
  const hub = new HubReader({ baseUrl: 'https://chain.invalid', fetch: async () => ({ ok: true, status: 200, json: async () => ({ binding }) }) });
  expect(await hub.getCurrentServiceKey('PARTICIPANT_TYPE_CORTEX', 'worker')).toMatchObject({ servicePubKey: current, serviceAuthorizationNonce: 2n, previousServicePubKey: previous, previousServiceAuthorizationNonce: 1n, previousRetiredHeight: 50n });
  delete binding.previous_retired_height;
  await expect(hub.getCurrentServiceKey('PARTICIPANT_TYPE_CORTEX', 'worker')).rejects.toThrow('paired presence');
});
