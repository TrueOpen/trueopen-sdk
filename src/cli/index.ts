import { Command } from 'commander';
import { resolveConfig, loadMnemonic } from './config';
import type { CliOptions, CliConfig } from './config';
import { printResult, printError, toJsonSafe } from './output';
import { cmdAddress, cmdBuilders } from './commands/misc';
import { cmdSessionCreate, cmdSessionGet } from './commands/session';
import { cmdOrderSubmit, cmdOrderCancel } from './commands/order';
import { cmdTaskStatus, cmdTaskWatch } from './commands/task';
import { cmdOutputRef, cmdOutputStream, cmdOutputGet } from './commands/output';
import { cmdChallengePrepare, cmdChallengeSubmit } from './commands/challenge';

const program = new Command();
program
  .name('trueopen')
  .description('TrueOpen SDK CLI -- a thin wrapper around the TrueOpenClient facade')
  .version('0.1.0')
  .option('--rest-url <url>', 'node gRPC-gateway REST root')
  .option('--rpc-url <url>', 'node CometBFT RPC root')
  .option('--nexus-url <url>', 'nexus IngressAPI endpoint (http/https)')
  .option('--nexus-tls-pubkey-hash <hex>', 'when manually specifying --nexus-url, verify against this certificate public key sha256 (64-hex); nexus certificates are self-signed, so https endpoints should provide this')
  .option('--auto', 'discover the endpoint on chain when nexus is not specified')
  .option('--chain-id <id>', 'chain ID')
  .option('--prefix <p>', 'bech32 address prefix', undefined)
  .option('--gas-price <p>', 'gas price, e.g. 0.025utrueopen')
  .option('--key-file <path>', 'path to the mnemonic file')
  .option('--json', 'JSON output')
  .option('--verbose', 'print stack trace');

function config(): CliConfig {
  return resolveConfig(program.opts<CliOptions>(), process.env);
}

/** Unified execution: assemble -> call the command -> print; on error, print it and set exit code 1. */
async function run(fn: (cfg: CliConfig, mnemonic: string) => Promise<unknown>, needKey = true): Promise<void> {
  const cfg = config();
  try {
    const mnemonic = needKey ? loadMnemonic(program.opts<CliOptions>(), process.env) : '';
    printResult(await fn(cfg, mnemonic));
  } catch (e) {
    printError(e, cfg.json);
    if (cfg.verbose && e instanceof Error && e.stack) console.error(e.stack);
    process.exitCode = 1;
  }
}

program.command('address').description('mnemonic -> address').action(() => run((cfg, m) => cmdAddress(cfg, m)));
program.command('builders').description('discover nexus endpoints on chain').action(() => run((cfg) => cmdBuilders(cfg), false));

const session = program.command('session');
session.command('create').argument('[label]').description('create a session (gas)').action((label?: string) => run((cfg, m) => cmdSessionCreate(cfg, m, label)));
session.command('get').argument('<sessionId>').description('query a session').action((id: string) => run((cfg) => cmdSessionGet(cfg, id), false));

const order = program.command('order');
order
  .command('submit')
  .requiredOption('--order-file <f>', 'TaskOrder JSON file (the intent portion of the frozen TaskOrderV1)')
  .requiredOption('--session <id>')
  .option('--seq <n>', 'order_sequence; defaults to reading StreamState.next_expected_sequence on chain, an explicit value is only for RBF resubmission with the same sequence')
  .requiredOption('--payload-file <f>', 'plaintext input body file (the V1 data plane transmits plaintext); the SDK derives input_hash / input_size_bytes / payload_ref from it')
  .option('--idempotency-key <k>', 'the idempotency key from contract section 3.1; defaults to <session>:<seq>, must stay the same across retries')
  .description('submit an order (OpenTask: three-layer signing -> Task Builders selected by task_builder_seed)')
  .action((a: { orderFile: string; session: string; seq?: string; payloadFile: string; idempotencyKey?: string }) =>
    run((cfg, m) => cmdOrderSubmit(cfg, m, a)),
  );
order
  .command('cancel')
  .requiredOption('--session <id>')
  .requiredOption('--seq <n>')
  .description('cancel order (gas)')
  .action((a: { session: string; seq: string }) => run((cfg, m) => cmdOrderCancel(cfg, m, a)));

const task = program.command('task');
task.command('status').argument('<session>').argument('<task>').description('task status snapshot').action((s: string, t: string) => run((cfg) => cmdTaskStatus(cfg, s, t), false));
task
  .command('watch')
  .argument('<session>')
  .argument('<task>')
  .option('--from-cursor <c>')
  .description('subscribe to the task event stream')
  .action((s: string, t: string, a: { fromCursor?: string }) => watch(s, t, a.fromCursor));

const output = program.command('output');
output
  .command('ref')
  .argument('<session>')
  .argument('<task>')
  .option('--access-level <l>', 'package | sealed_key')
  .option('--usage <u>')
  .description('fetch the retrieval credential + commitment')
  .action((s: string, t: string, a: { accessLevel?: string; usage?: string }) =>
    run((cfg, m) => cmdOutputRef(cfg, m, s, t, a.accessLevel, a.usage)),
  );
output
  .command('get')
  .argument('<session>')
  .argument('<task>')
  .argument('<task-hash>', 'the on-chain accepted_task_hash, canonical lowercase 64-hex')
  .argument('<output-hash>', 'the on-chain InferReceipt.output_hash (MMR root), canonical lowercase 64-hex')
  .description('retrieve the output body (GetTaskDataMetadata + FetchTaskData, recompute the MMR root from chunk_lengths to verify; requires --auto)')
  .action((s: string, t: string, th: string, oh: string) => run((cfg, m) => cmdOutputGet(cfg, m, s, t, th, oh)));
output
  .command('stream')
  .argument('<session>')
  .argument('<task>')
  .argument('<task-hash>', 'the on-chain accepted_task_hash, canonical lowercase 64-hex')
  .argument('<worker-pubkey>', 'the service public key of the selected Worker (33-byte compressed, hex)')
  .option('--no-ack', 'do not report local delivery progress')
  .description('stream-subscribe to output (SubscribeOutput, verify per-frame signatures + the MMR root)')
  .action((s: string, t: string, th: string, wp: string, a: { ack?: boolean }) =>
    run((cfg, m) => cmdOutputStream(cfg, m, s, t, th, wp, a.ack !== false)),
  );

const challenge = program.command('challenge');
challenge
  .command('prepare')
  .argument('<session>')
  .argument('<task>')
  .argument('<kind>')
  .option('--evidence-file <f>')
  .description('prepare challenge materials')
  .action((s: string, t: string, k: string, a: { evidenceFile?: string }) => run((cfg, m) => cmdChallengePrepare(cfg, m, s, t, k, a.evidenceFile)));
challenge
  .command('submit')
  .requiredOption('--session <id>')
  .requiredOption('--task <id>')
  .requiredOption('--settlement <id>')
  .requiredOption('--kind <k>')
  .requiredOption('--evidence <hex>')
  .requiredOption('--bond <amt>')
  .description('submit an on-chain challenge (locks bond)')
  .action((a: { session: string; task: string; settlement: string; kind: string; evidence: string; bond: string }) =>
    run((cfg, m) => cmdChallengeSubmit(cfg, m, a)),
  );

/** Streaming command: print events line by line, exit cleanly on SIGINT. */
async function watch(s: string, t: string, fromCursor?: string): Promise<void> {
  const cfg = config();
  try {
    const m = loadMnemonic(program.opts<CliOptions>(), process.env);
    const { stream, dispose } = await cmdTaskWatch(cfg, m, s, t, fromCursor);
    const stop = (): void => {
      void dispose().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    try {
      for await (const ev of stream) console.log(toJsonSafe(ev, 0));
    } finally {
      await dispose();
    }
  } catch (e) {
    printError(e, cfg.json);
    process.exitCode = 1;
  }
}

program.parseAsync(process.argv);
