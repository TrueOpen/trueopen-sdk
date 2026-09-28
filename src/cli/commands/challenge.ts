import { readFileSync } from 'node:fs';
import { buildContext, queryAcrossNexus } from '../context';
import type { CliConfig } from '../config';
import type { ChallengeKind } from '../../types/challenge';

export async function cmdChallengePrepare(
  cfg: CliConfig,
  mnemonic: string,
  session: string,
  task: string,
  kind: string,
  evidenceFile?: string,
): Promise<unknown> {
  const ctx = await buildContext(cfg, mnemonic, { nexus: true, key: true });
  try {
    const evi = evidenceFile ? new Uint8Array(readFileSync(evidenceFile)) : undefined;
    return await queryAcrossNexus(ctx, (client) => client.prepareChallenge(session, task, kind as ChallengeKind, evi));
  } finally {
    await ctx.dispose();
  }
}
