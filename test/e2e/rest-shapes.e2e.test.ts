/**
 * Keeps the fake node honest, and the SDK readers with it: the bodies the fake serves must have
 * the wire REST shape fixture's key sets and JSON types, and the SDK readers must accept the
 * fixture's bodies as they are.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startWorld, acceptOnChain, drawWinner, STREAM } from './support/harness';
import type { World } from './support/harness';
import { shapeBody } from './support/fake-node';
import * as w from './support/world';

let world: World;
beforeAll(async () => {
  world = await startWorld();
  world.node.seedSession(w.USER.address);
});
afterAll(async () => { await world.close(); });

type Json = Record<string, unknown>;
const get = async (path: string): Promise<Json> => (await (await fetch(`${world.node.restUrl}${path}`)).json()) as Json;

/** Every leaf path with its JSON type ("string" | "number" | "boolean" | "null" | "array" | "object"). */
function leaves(v: unknown, path = '', out = new Map<string, string>()): Map<string, string> {
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (t === 'object') {
    for (const [k, x] of Object.entries(v as Json)) leaves(x, path === '' ? k : `${path}.${k}`, out);
    if (Object.keys(v as Json).length === 0) out.set(path, 'object');
  } else if (t === 'array') {
    (v as unknown[]).forEach((x) => leaves(x, `${path}[]`, out));
    if ((v as unknown[]).length === 0) out.set(`${path}[]`, 'empty');
  } else {
    out.set(path, t);
  }
  return out;
}

/**
 * The served body has every fixture field with the same JSON type. Extra fields are allowed only
 * where the fixture cannot show them: optional (oneof) members the fixture leaves unset, a set
 * Hash32 the zero-value fixture omits, and a sub-message the zero-value fixture renders as null.
 */
function expectSameShape(served: Json, fixture: Json, allowedExtra: readonly string[] = []): void {
  const s = leaves(served);
  const f = leaves(fixture);
  for (const [path, type] of f) {
    if (type === 'empty') continue;
    const present = [...s.keys()].some((k) => k === path || k.startsWith(`${path}.`) || k.startsWith(`${path}[]`));
    // A nullable sub-message may be unset (null) where the populated fixture fills it in.
    const nulledParent = [...s.entries()].some(([k, t]) => t === 'null' && path.startsWith(`${k}.`));
    expect(present || nulledParent, `missing ${path}`).toBe(true);
    if (s.has(path) && type !== 'null') expect(s.get(path), `type of ${path}`).toBe(type);
  }
  for (const [path, type] of s) {
    if (f.has(path) || [...f.keys()].some((k) => path.startsWith(`${k}.`) || path.startsWith(`${k}[]`))) continue;
    if (type === 'null' && [...f.keys()].some((k) => k.startsWith(`${path}.`))) continue;
    const hash32 = type === 'string' && /^[0-9a-f]{64}$/.test(String(path.split('.').reduce<unknown>((o, k) => (o as Json)?.[k.replace('[]', '')], served)));
    expect(hash32 || allowedExtra.some((a) => path === a || path.startsWith(`${a}.`)), `unexpected ${path}`).toBe(true);
  }
}

describe('e2e: fake node REST bodies match the wire REST shapes', () => {
  it('hub and task params', async () => {
    expectSameShape(await get('/TrueOpen/hub/v1/params'), shapeBody('hub_v1_queryhubparamsresponse_default'));
    expectSameShape(await get('/TrueOpen/task/v1/params'), shapeBody('task_v1_querytaskparamsresponse_default'));
  });

  it('profile', async () => {
    expectSameShape(await get(`/TrueOpen/hub/v1/profile/${w.MODEL_ID}/1`), shapeBody('hub_v1_queryprofileresponse'));
  });

  it('task: active before assignment, active with a winner, terminal', async () => {
    acceptOnChain(world);
    expectSameShape(await get(`/TrueOpen/task/v1/task/${STREAM.task_id}`), shapeBody('task_v1_querytaskresponse_active_zero'));
    drawWinner(world);
    expectSameShape(await get(`/TrueOpen/task/v1/task/${STREAM.task_id}`), shapeBody('task_v1_querytaskresponse_active'), [
      'task.active.assignment.winner_worker',
      'task.active.assignment.winner_confirm_height',
      'task.active.assignment.infer_deadline_height',
    ]);
    world.node.tasks.get(STREAM.task_id)!.terminal = true;
    expectSameShape(await get(`/TrueOpen/task/v1/task/${STREAM.task_id}`), shapeBody('task_v1_querytaskresponse_terminal'), [
      'task.terminal.winner_worker',
    ]);
  });
});

describe('e2e: SDK readers accept the wire REST shape bodies verbatim', () => {
  it('HubReader: params, generation limits, profile pricing', async () => {
    world.node.verbatim.set('/TrueOpen/hub/v1/params', shapeBody('hub_v1_queryhubparamsresponse_default'));
    world.node.verbatim.set('/TrueOpen/task/v1/params', shapeBody('task_v1_querytaskparamsresponse_default'));
    const model = 'ab'.repeat(32);
    world.node.verbatim.set(`/TrueOpen/hub/v1/profile/${model}/1`, shapeBody('hub_v1_queryprofileresponse'));
    try {
      expect(await world.hub.getBusinessDenom()).toBe('uusdc');
      expect(await world.hub.getEvmChainId()).toBe(31337n);
      expect((await world.hub.getTaskGenerationLimits()).maxOutputTokens).toBe(131072n);
      expect((await world.hub.getProfile(model, 1n)).pricing).toEqual({ minOrderValue: 1n, verifyRatioBps: 1n, initialOutputPrice: 1n });
    } finally {
      world.node.verbatim.clear();
    }
  });

  it('RestChainReader: task in its active (pending and populated) and terminal forms', async () => {
    const id = 'cd'.repeat(32);
    const path = `/TrueOpen/task/v1/task/${id}`;
    try {
      world.node.verbatim.set(path, shapeBody('task_v1_querytaskresponse_active_zero'));
      // The zero-value body omits every unset Hash32, including accepted_task_hash.
      await expect(world.taskReader.queryTask(id)).rejects.toMatchObject({ code: 'CHAIN_QUERY_MALFORMED' });

      world.node.verbatim.set(path, shapeBody('task_v1_querytaskresponse_active'));
      expect(await world.taskReader.queryTask(id)).toMatchObject({ view: 'active', acceptedTaskHash: 'ab'.repeat(32), winnerWorker: '' });

      world.node.verbatim.set(path, shapeBody('task_v1_querytaskresponse_terminal'));
      expect(await world.taskReader.queryTask(id)).toMatchObject({ view: 'terminal', terminalPhase: 'WORKER_ASSIGNMENT_PENDING', winnerWorker: '' });
    } finally {
      world.node.verbatim.clear();
    }
  });
});
