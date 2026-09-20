import { sha256 as nobleSha256 } from '@noble/hashes/sha256';

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}
