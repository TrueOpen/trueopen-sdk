import { expect, it } from 'vitest';
import { bech32 } from '@scure/base';
import { selectTaskBuilders } from '../../src/hub/builder-selection';
const members = [1, 2, 3, 4].map(n => ({ address: bech32.encode('trueopen', bech32.toWords(new Uint8Array(20).fill(n))), status: 'BUILDER_STATUS_INACTIVE' }));
const input = { chainId: 'test', taskId: `0x${'01'.repeat(32)}`, builderSetHash: `0x${'02'.repeat(32)}`, sessionAnchorBlockHash: '', members };
it('keeps the complete immutable snapshot and rotates dispatching Builder to rank one', () => {
  const result = selectTaskBuilders({ ...input, buildersPerTask: 1, dispatchingBuilder: members[2]!.address });
  expect(result.map(r => r.address)).toEqual([members[2]!.address, members[3]!.address, members[0]!.address, members[1]!.address]);
});
it('rejects a dispatching Builder outside the snapshot', () => {
  expect(() => selectTaskBuilders({ ...input, dispatchingBuilder: 'missing' })).toThrow();
});
