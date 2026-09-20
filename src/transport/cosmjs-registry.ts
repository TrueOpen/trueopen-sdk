import { Registry } from '@cosmjs/proto-signing';
import type { GeneratedType } from '@cosmjs/proto-signing';
import { defaultRegistryTypes } from '@cosmjs/stargate';
import {
  TYPE_URL,
  encodeMsgCreateSession,
  encodeMsgCancelOrder,
  encodeMsgUserChallenge,
} from './task-msgs';

/**
 * Wraps a hand-written encoder as a CosmJS GeneratedType (only outgoing Msg encoding is needed).
 * Registry.encode calls type.encode(value).finish(), so returning a thin shell with finish() is enough.
 */
function outgoingType(encode: (m: never) => Uint8Array): GeneratedType {
  return {
    encode: (message: unknown) => ({ finish: () => encode(message as never) }) as never,
    decode: () => {
      throw new Error('task outgoing Msg: decode not supported (SDK decodes responses directly)');
    },
    fromPartial: (o: unknown) => o,
  };
}

/** Registry containing the Cosmos default types plus the three task user Msgs, for use with SigningStargateClient. */
export function taskRegistry(): Registry {
  const registry = new Registry(defaultRegistryTypes);
  registry.register(TYPE_URL.createSession, outgoingType(encodeMsgCreateSession));
  registry.register(TYPE_URL.cancelOrder, outgoingType(encodeMsgCancelOrder));
  registry.register(TYPE_URL.userChallenge, outgoingType(encodeMsgUserChallenge));
  return registry;
}
