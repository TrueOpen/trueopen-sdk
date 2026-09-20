import { buildContext } from '../context';
import type { CliConfig } from '../config';

export async function cmdSessionCreate(cfg: CliConfig, mnemonic: string, label?: string): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { write: true, key: true });
  try {
    return await ctx.client.createSession(label);
  } finally {
    await ctx.dispose();
  }
}

export async function cmdSessionGet(cfg: CliConfig, sessionId: string): Promise<unknown> {
  const ctx = await buildContext(cfg, undefined, {});
  try {
    return await ctx.client.getSession(sessionId);
  } finally {
    await ctx.dispose();
  }
}
