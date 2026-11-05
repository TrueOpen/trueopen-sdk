import { buildContext } from '../context';
import type { CliConfig } from '../config';

export async function cmdSessionCreate(
  cfg: CliConfig,
  mnemonic: string,
  label: string | undefined,
  funding: { readonly initialBuilder: string; readonly initialDeposit: string },
): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { write: true, key: true });
  try {
    return await ctx.client.createSession({ ...(label !== undefined ? { label } : {}), ...funding });
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

export async function cmdSessionFunds(cfg: CliConfig, mnemonic: string, action: 'deposit' | 'withdraw' | 'close', sessionId: string, amount?: string): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { write: true, key: true });
  try {
    if (action === 'close') return await ctx.client.closeSession(sessionId);
    if (amount === undefined) throw new Error('amount is required');
    return action === 'deposit'
      ? await ctx.client.depositSession({ sessionId, amount })
      : await ctx.client.withdrawSession({ sessionId, amount });
  } finally { await ctx.dispose(); }
}
