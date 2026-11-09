import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../codec/hash';
import { toHex } from '../util/bytes';
import type { OpenTaskStore, SentOrderRecord } from '../order/open-task-store';

/**
 * An OpenTaskStore with one JSON file per idempotency key in `dir` (created on first write, mode
 * 0700): `<sha256(key) hex>.json`, written to a temporary file and renamed into place, so a crash
 * never leaves half a record. The TrueOpenClient checks what it reads back.
 */
export function fileOpenTaskStore(dir: string): OpenTaskStore {
  const pathOf = (key: string): string => join(dir, `${toHex(sha256(new TextEncoder().encode(key)))}.json`);
  return {
    async get(key) {
      let text: string;
      try {
        text = await readFile(pathOf(key), 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw e;
      }
      return JSON.parse(text) as SentOrderRecord;
    },
    async set(key, record) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = pathOf(key);
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
    },
  };
}
