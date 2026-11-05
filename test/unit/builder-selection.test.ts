import { expect, it } from 'vitest';
import { bech32 } from '@scure/base';
import { selectTaskBuilders } from '../../src/hub/builder-selection';
const a = bech32.encode('trueopen', bech32.toWords(new Uint8Array(20).fill(1)));
const input = { chainId: '', taskId: '', builderSetHash: '', sessionAnchorBlockHash: '', members: [{ address: a, status: 'BUILDER_STATUS_ACTIVE' }] };
it('rejects duplicate snapshot members', () => {
  expect(() => selectTaskBuilders({ ...input, members: [...input.members, ...input.members] })).toThrow(/duplicate/);
});
it('rejects empty snapshots and malformed addresses', () => {
  expect(() => selectTaskBuilders({ ...input, members: [] })).toThrow(/empty/);
  expect(() => selectTaskBuilders({ ...input, members: [{ address: 'bad', status: '' }] })).toThrow();
});
it('keeps a one-member snapshot regardless of retired buildersPerTask', () => {
  expect(selectTaskBuilders({ ...input, buildersPerTask: 3 }).map(x => x.address)).toEqual([a]);
});
