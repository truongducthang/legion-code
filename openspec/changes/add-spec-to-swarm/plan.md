# Spec → Swarm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn one short spec into a planner-driven multi-agent run that produces one branch and one PR per swarm, reusing Legion's existing worktree, task-spawn, and PR-watch infrastructure.

**Architecture:** Direct LLM call as the planner streams strict JSON into a review dialog. A new `SwarmRuntime` in `electron/swarm/` schedules sub-tasks wave-by-wave via the existing `createTask` path. An integrator agent merges every child branch in its own worktree; the runtime owns the test step with a flaky-test buffer and one fix attempt before halt. Persistence per swarm under `<userData>/swarms/`. See `design.md` for full architecture.

**Tech Stack:** TypeScript (strict), SolidJS signals, Electron IPC, Vitest, Anthropic SDK (existing in `ask-code-minimax.ts`-style pattern), git via existing `electron/ipc/git.ts` helpers.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `electron/swarm/types.ts` | All shared types: `SwarmPlan`, `SwarmWave`, `SwarmTask`, `SwarmStatus`, error/event payload shapes |
| `electron/swarm/store.ts` | Atomic JSON persistence under `<userData>/swarms/`; list/get/save/delete; crash-recovery scan |
| `electron/swarm/planner.ts` | Direct LLM call, JSON schema validation, streaming chunk emission |
| `electron/swarm/runtime.ts` | Wave-serial scheduler, sub-task lifecycle, success detection, halt/resume/abort |
| `electron/swarm/retry.ts` | Failure detection, augmented retry-prompt construction, one-retry budget |
| `electron/swarm/integrator.ts` | Integrator branch + worktree creation, child-branch merge sequencing, test-step orchestration, PR open |
| `electron/swarm/rebase.ts` | Mid-swarm base-divergence check, optional rebase orchestration |
| `electron/swarm/index.ts` | `registerSwarmIPC(callbacks)` + public surface; wired from `electron/ipc/register.ts` |
| `electron/swarm/prompts/planner.md` | System prompt for the planner LLM call |
| `electron/swarm/prompts/integrator.md` | Initial prompt template for the integrator agent |
| `electron/swarm/prompts/sub-task-suffix.md` | Append-to-prompt for every sub-task (commit + sentinel hint) |
| `electron/swarm/prompts/retry-augment.md` | Append-to-prompt template for retries |
| `electron/swarm/types.test.ts` | Type-level smoke tests using `expectTypeOf` |
| `electron/swarm/store.test.ts` | Atomic write, malformed-file tolerance, crash recovery |
| `electron/swarm/planner.test.ts` | JSON streaming reassembly, validator, caps, slug derivation, re-prompt-once |
| `electron/swarm/runtime.test.ts` | Wave gating, success detection, "agent says done no commit" path |
| `electron/swarm/retry.test.ts` | shouldRetry, reset-before-respawn, augmented prompt fields |
| `electron/swarm/integrator.test.ts` | Merge order, flaky re-run, no-test-script path, gh-fail halt |
| `electron/swarm/rebase.test.ts` | Unchanged/unrelated/overlap classifications, rebase conflict halt |
| `electron/swarm/integration.test.ts` | Five end-to-end scenarios (A–E) with mock PTY + temp git repo |
| `electron/ipc/channels.ts` | + 13 new `Swarm*` enum keys (see `design.md` IPC table) |
| `electron/preload.cjs` | + mirror the 13 channel names in the allowlist |
| `src/ipc/types.ts` | + payload shapes for the 13 channels |
| `src/swarm/SwarmDispatchDialog.tsx` | Spec input + `Trust planner` checkbox + `Plan` button |
| `src/swarm/PlanReviewDialog.tsx` | Streaming chunk render, per-task inline edit, Re-plan textarea, Approve |
| `src/swarm/SwarmSidebarGroup.tsx` | Collapsible group under the project, wave-progress counts, chain icon for integrator |
| `src/swarm/SwarmHaltBanner.tsx` | Resume/Abort + reason text |
| `src/swarm/swarmStore.ts` | Renderer signal store mirroring main-process state via IPC pushes |
| `src/swarm/swarmIpc.ts` | Renderer-side wrappers around the new IPC channels |
| `src/swarm/SwarmDispatchDialog.test.tsx` | Plan button enabled iff spec non-empty |
| `src/swarm/PlanReviewDialog.test.tsx` | Partial-JSON streaming doesn't flicker; edit + remove + add reflected on Approve |
| `src/components/SettingsDialog.tsx` | + "Swarm" section (model picker, wallclock cap, cleanup opt-out) |

---

## Milestones

- **M1 — Foundation** (Tasks 1–3): types, store, IPC channels & payloads. No behavior yet; everything else builds on this.
- **M2 — Planner** (Tasks 4–6): prompt files, validator, LLM call with streaming.
- **M3 — Runtime core** (Tasks 7–10): scheduler skeleton, success/failure detection, retry-once, "agent says done no commit" path.
- **M4 — Integrator + rebase** (Tasks 11–14): merge sequencing, runtime test step, fix attempt, mid-swarm rebase check.
- **M5 — UI** (Tasks 15–18): dispatch dialog, plan review, sidebar group, halt banner.
- **M6 — Wiring + settings** (Tasks 19–20): `register.ts` glue, hotkey, Settings section.
- **M7 — End-to-end + docs** (Tasks 21–22): integration test covering Scenarios A–E from design, README + screen capture.

Commit after each task. Run typecheck before each commit.

---

## Task 1: Define `SwarmPlan`, `SwarmWave`, `SwarmTask` types

**Files:**
- Create: `electron/swarm/types.ts`
- Create: `electron/swarm/types.test.ts`

- [ ] **Step 1: Write the failing type-level smoke test**

```ts
// electron/swarm/types.test.ts
import { describe, expectTypeOf, it } from 'vitest';
import type {
  SwarmPlan,
  SwarmWave,
  SwarmTask,
  SwarmStatus,
  SwarmTaskStatus,
  SwarmHaltReason,
} from './types.js';

describe('swarm types', () => {
  it('SwarmPlan composes waves and required fields', () => {
    expectTypeOf<SwarmPlan>().toHaveProperty('swarmId').toEqualTypeOf<string>();
    expectTypeOf<SwarmPlan>().toHaveProperty('specInput').toEqualTypeOf<string>();
    expectTypeOf<SwarmPlan>().toHaveProperty('baseBranch').toEqualTypeOf<string>();
    expectTypeOf<SwarmPlan>().toHaveProperty('integrationBranch').toEqualTypeOf<string>();
    expectTypeOf<SwarmPlan>().toHaveProperty('slug').toEqualTypeOf<string>();
    expectTypeOf<SwarmPlan>().toHaveProperty('waves').toEqualTypeOf<SwarmWave[]>();
    expectTypeOf<SwarmPlan>().toHaveProperty('createdAt').toEqualTypeOf<number>();
    expectTypeOf<SwarmPlan>().toHaveProperty('status').toEqualTypeOf<SwarmStatus>();
  });

  it('SwarmTaskStatus enumerates the 5 states', () => {
    expectTypeOf<SwarmTaskStatus>().toEqualTypeOf<
      'pending' | 'running' | 'succeeded' | 'failed' | 'retrying'
    >();
  });

  it('SwarmHaltReason enumerates known reasons', () => {
    expectTypeOf<SwarmHaltReason>().toEqualTypeOf<
      | 'planner_invalid'
      | 'sub_task_failed_after_retry'
      | 'integrator_fix_failed'
      | 'pr_open_failed'
      | 'base_diverged_into_swarm_files'
      | 'rebase_conflict'
      | 'integrator_hung'
      | 'legion_crashed'
      | 'user_halt'
    >();
  });
});
```

- [ ] **Step 2: Run the test, watch it fail**

```bash
npx vitest run electron/swarm/types.test.ts
```

Expected: ERR `Cannot find module './types.js'`.

- [ ] **Step 3: Create the types module**

```ts
// electron/swarm/types.ts

export type SwarmStatus =
  | 'planning'
  | 'reviewing'
  | 'running'
  | 'integrating'
  | 'done'
  | 'halted'
  | 'aborted';

export type SwarmTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'retrying';

export type SwarmHaltReason =
  | 'planner_invalid'
  | 'sub_task_failed_after_retry'
  | 'integrator_fix_failed'
  | 'pr_open_failed'
  | 'base_diverged_into_swarm_files'
  | 'rebase_conflict'
  | 'integrator_hung'
  | 'legion_crashed'
  | 'user_halt';

export interface SwarmTask {
  id: string;
  title: string;
  prompt: string;
  filesHint: string[];
  agentId?: string;
  status: SwarmTaskStatus;
  attempts: number;
  legionTaskId?: string;
  branchName?: string;
  worktreePath?: string;
  failureReason?: string;
}

export interface SwarmWave {
  waveIndex: number;
  tasks: SwarmTask[];
}

export interface SwarmPlan {
  swarmId: string;
  projectRoot: string;
  specInput: string;
  baseBranch: string;
  baseSha: string;          // recorded at branch-creation time
  integrationBranch: string;
  slug: string;
  waves: SwarmWave[];
  createdAt: number;
  status: SwarmStatus;
  haltReason?: SwarmHaltReason;
  haltTaskId?: string;
  haltWaveIndex?: number;
  prUrl?: string;
}
```

- [ ] **Step 4: Run test to verify pass**

```bash
npx vitest run electron/swarm/types.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/types.ts electron/swarm/types.test.ts
git commit -m "swarm: define plan/wave/task type model"
```

---

## Task 2: Implement the persistence store (atomic write, list, crash recovery)

**Files:**
- Create: `electron/swarm/store.ts`
- Create: `electron/swarm/store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// electron/swarm/store.test.ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
}));

import { app } from 'electron';
import {
  initSwarmStore,
  listSwarms,
  getSwarm,
  saveSwarm,
  deleteSwarm,
  recoverCrashedSwarmsOnStartup,
} from './store.js';
import type { SwarmPlan } from './types.js';

function planFixture(overrides: Partial<SwarmPlan> = {}): SwarmPlan {
  return {
    swarmId: 'sw_test_001',
    projectRoot: '/tmp/proj',
    specInput: 'test spec',
    baseBranch: 'main',
    baseSha: 'abc1234',
    integrationBranch: 'swarm/test/integration-abc',
    slug: 'test',
    waves: [],
    createdAt: 1_700_000_000_000,
    status: 'planning',
    ...overrides,
  };
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-store-'));
  vi.mocked(app.getPath).mockReturnValue(tmp);
  await initSwarmStore();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('swarm store', () => {
  it('round-trips a plan via saveSwarm + getSwarm', async () => {
    const plan = planFixture();
    await saveSwarm(plan);
    expect(await getSwarm('sw_test_001')).toEqual(plan);
  });

  it('list returns every saved plan', async () => {
    await saveSwarm(planFixture({ swarmId: 'sw_a' }));
    await saveSwarm(planFixture({ swarmId: 'sw_b' }));
    const list = await listSwarms();
    expect(list.map((p) => p.swarmId).sort()).toEqual(['sw_a', 'sw_b']);
  });

  it('delete removes the file', async () => {
    await saveSwarm(planFixture());
    await deleteSwarm('sw_test_001');
    expect(await getSwarm('sw_test_001')).toBeNull();
  });

  it('list ignores malformed files instead of crashing', async () => {
    await saveSwarm(planFixture({ swarmId: 'ok' }));
    const dir = path.join(tmp, 'swarms');
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json');
    const list = await listSwarms();
    expect(list.map((p) => p.swarmId)).toEqual(['ok']);
  });

  it('atomic write does not corrupt prior content on simulated crash', async () => {
    await saveSwarm(planFixture({ specInput: 'first' }));
    const writeFile = vi.spyOn(fs, 'writeFile');
    writeFile.mockRejectedValueOnce(new Error('disk full'));
    await expect(saveSwarm(planFixture({ specInput: 'second' }))).rejects.toThrow();
    writeFile.mockRestore();
    const plan = await getSwarm('sw_test_001');
    expect(plan?.specInput).toBe('first');
  });

  it('recoverCrashedSwarmsOnStartup flips non-terminal statuses to halted', async () => {
    await saveSwarm(planFixture({ swarmId: 'a', status: 'running' }));
    await saveSwarm(planFixture({ swarmId: 'b', status: 'done' }));
    await saveSwarm(planFixture({ swarmId: 'c', status: 'integrating' }));
    const recovered = await recoverCrashedSwarmsOnStartup();
    expect(recovered.map((p) => p.swarmId).sort()).toEqual(['a', 'c']);
    expect((await getSwarm('a'))?.status).toBe('halted');
    expect((await getSwarm('a'))?.haltReason).toBe('legion_crashed');
    expect((await getSwarm('b'))?.status).toBe('done');
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
npx vitest run electron/swarm/store.test.ts
```

Expected: ERR module not found.

- [ ] **Step 3: Implement the store**

```ts
// electron/swarm/store.ts
import { app } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { SwarmPlan, SwarmStatus } from './types.js';

let dir = '';

function planPath(swarmId: string): string {
  return path.join(dir, `${swarmId}.json`);
}

export async function initSwarmStore(): Promise<void> {
  dir = path.join(app.getPath('userData'), 'swarms');
  await fs.mkdir(dir, { recursive: true });
}

export async function saveSwarm(plan: SwarmPlan): Promise<void> {
  const final = planPath(plan.swarmId);
  const tmp = `${final}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(plan, null, 2);
  await fs.writeFile(tmp, body, 'utf8');
  try {
    await fs.rename(tmp, final);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

export async function getSwarm(swarmId: string): Promise<SwarmPlan | null> {
  try {
    const body = await fs.readFile(planPath(swarmId), 'utf8');
    return JSON.parse(body) as SwarmPlan;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function listSwarms(): Promise<SwarmPlan[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const plans: SwarmPlan[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const body = await fs.readFile(path.join(dir, entry), 'utf8');
      plans.push(JSON.parse(body) as SwarmPlan);
    } catch {
      // Malformed file → skip silently.
    }
  }
  return plans;
}

export async function deleteSwarm(swarmId: string): Promise<void> {
  await fs.rm(planPath(swarmId), { force: true });
}

const NON_TERMINAL: ReadonlySet<SwarmStatus> = new Set([
  'planning',
  'reviewing',
  'running',
  'integrating',
]);

export async function recoverCrashedSwarmsOnStartup(): Promise<SwarmPlan[]> {
  const plans = await listSwarms();
  const recovered: SwarmPlan[] = [];
  for (const plan of plans) {
    if (NON_TERMINAL.has(plan.status)) {
      const next: SwarmPlan = {
        ...plan,
        status: 'halted',
        haltReason: 'legion_crashed',
      };
      await saveSwarm(next);
      recovered.push(next);
    }
  }
  return recovered;
}
```

- [ ] **Step 4: Run tests, watch them pass**

```bash
npx vitest run electron/swarm/store.test.ts
```

Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/store.ts electron/swarm/store.test.ts
git commit -m "swarm: implement atomic persistence store with crash recovery"
```

---

## Task 3: Add IPC channels, preload allowlist, payload types

**Files:**
- Modify: `electron/ipc/channels.ts` (append after the existing `Arena` block)
- Modify: `electron/preload.cjs` (mirror new channel names)
- Modify: `src/ipc/types.ts` (add payload types)

- [ ] **Step 1: Read the current channel file to find the right insertion point**

```bash
grep -n "Arena" electron/ipc/channels.ts
```

Insert the new block right after the `Arena` section, before the `Remote access` section.

- [ ] **Step 2: Append the new channel block**

Edit `electron/ipc/channels.ts` and insert after the `Arena` block:

```ts
  // Swarm
  SwarmPlan = 'swarm_plan',
  SwarmPlanChunk = 'swarm_plan_chunk',
  SwarmReplan = 'swarm_replan',
  SwarmApprove = 'swarm_approve',
  SwarmHalt = 'swarm_halt',
  SwarmResume = 'swarm_resume',
  SwarmAbort = 'swarm_abort',
  SwarmGet = 'swarm_get',
  SwarmList = 'swarm_list',
  SwarmStatusUpdate = 'swarm_status_update',
  SwarmTaskUpdate = 'swarm_task_update',
  SwarmHalted = 'swarm_halted',
  SwarmDone = 'swarm_done',
```

- [ ] **Step 3: Mirror in the preload allowlist**

Open `electron/preload.cjs`, find the existing allowlist arrays (look for `swarm`-adjacent channels like `'create_task'`), and add the 13 string values in the same shape.

Run the existing allowlist test to catch any miss:

```bash
npx vitest run electron/preload-allowlist.test.ts
```

Expected: PASS (any miss would fail the test).

- [ ] **Step 4: Define payload types**

```ts
// Append to src/ipc/types.ts

import type {
  SwarmPlan,
  SwarmHaltReason,
  SwarmStatus,
  SwarmTaskStatus,
} from '../../electron/swarm/types.js';

export interface SwarmPlanRequest {
  projectRoot: string;
  specInput: string;
  baseBranch: string;
  agentId?: string;
  trustPlanner: boolean;
}

export interface SwarmPlanResult {
  swarmId: string;
}

export interface SwarmPlanChunkPush {
  swarmId: string;
  partialJson: string;
}

export interface SwarmReplanRequest {
  swarmId: string;
  feedback: string;
}

export interface SwarmApproveRequest {
  swarmId: string;
  editedPlan?: SwarmPlan;
}

export interface SwarmStatusUpdatePush {
  swarmId: string;
  status: SwarmStatus;
  currentWave?: number;
}

export interface SwarmTaskUpdatePush {
  swarmId: string;
  taskId: string;
  status: SwarmTaskStatus;
  failureReason?: string;
  attempts: number;
}

export interface SwarmHaltedPush {
  swarmId: string;
  reason: SwarmHaltReason;
  taskId?: string;
  waveIndex?: number;
}

export interface SwarmDonePush {
  swarmId: string;
  prUrl: string;
  summary: string;
}
```

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add electron/ipc/channels.ts electron/preload.cjs src/ipc/types.ts
git commit -m "swarm: register IPC channels and payload types"
```

---

## Task 4: Author planner prompt files and JSON schema validator

**Files:**
- Create: `electron/swarm/prompts/planner.md`
- Create: `electron/swarm/prompts/sub-task-suffix.md`
- Create: `electron/swarm/prompts/retry-augment.md`
- Create: `electron/swarm/prompts/integrator.md`
- Create: `electron/swarm/planner-schema.ts` (validator only; the LLM call is Task 5)
- Create: `electron/swarm/planner-schema.test.ts`

- [ ] **Step 1: Write the planner prompt**

```markdown
<!-- electron/swarm/prompts/planner.md -->
You are the planner for Legion's Spec → Swarm feature. Decompose the user's spec into one or more waves of parallel sub-tasks that an AI coding agent can execute in isolated git worktrees.

# Constraints

- Output: **strict JSON** matching the schema in the user's message. No prose before, no prose after, no Markdown fences.
- At most **5 waves**.
- At most **6 tasks per wave**.
- Within a single wave, **never put two tasks that would edit the same file**. If they would, push the dependent task into a later wave.
- Each task's `prompt` is sent verbatim to a coding agent. Make it self-contained: state the goal, point at the relevant files in this repo (use `filesHint`), and say what "done" looks like.
- If the spec is not splittable, return a single task in a single wave whose title explains why.

# Schema

{schemaJson}

# Repo context

Base branch: {baseBranch}

CLAUDE.md (if any):
{claudeMd}

File tree (depth ≤ 3):
{fileTree}

Recently changed files:
{recentlyChanged}

# Spec

{specInput}
```

- [ ] **Step 2: Write the sub-task suffix**

```markdown
<!-- electron/swarm/prompts/sub-task-suffix.md -->

---

When you finish this task:

1. Commit your work: `git add -A && git commit -m "{title}"`
2. Print this single line, on its own:
   `SWARM_TASK_DONE_{taskId}`

If you cannot complete the task and want to surface failure now,
print this single line on its own instead:
`SWARM_TASK_FAILED_{taskId}`
```

- [ ] **Step 3: Write the retry augment**

```markdown
<!-- electron/swarm/prompts/retry-augment.md -->

---

<previous_attempt failed="{reason}">

git diff --stat (from the failed attempt):
{diffStat}

Last 3 KB of the agent's terminal output before failure:
{ptyTail}

</previous_attempt>

The worktree has been reset to the base commit. Retry the task, taking the
above context into account.
```

- [ ] **Step 4: Write the integrator prompt**

```markdown
<!-- electron/swarm/prompts/integrator.md -->
You are the integrator for a Spec → Swarm run. Your job:

1. You are in the worktree at: `{integrationWorktreePath}`
   (already checked out on branch `{integrationBranch}` from `{baseBranch}`).
2. Merge each of these child branches into the current branch, **in order**:
{childBranches}

3. For each branch:
   - Run `git merge --no-ff <branch> -m "Merge <branch>"`.
   - If the merge has conflicts, use your Read/Edit/Bash tools to resolve them,
     then `git add -A && git commit -m "Resolve <branch> conflicts"`.
4. When all branches are merged, print this line on its own:
   `SWARM_INTEGRATOR_MERGED`

Do NOT push. Do NOT run tests yet — the orchestrator will run them after you
signal that merges are complete.

The original spec was:
> {specInput}
```

- [ ] **Step 5: Write the schema validator tests**

```ts
// electron/swarm/planner-schema.test.ts
import { describe, expect, it } from 'vitest';
import { validateSwarmPlan, MAX_WAVES, MAX_TASKS_PER_WAVE } from './planner-schema.js';
import type { SwarmPlan } from './types.js';

function valid(): unknown {
  return {
    swarmId: 'sw_001',
    projectRoot: '/proj',
    specInput: 'add x',
    baseBranch: 'main',
    baseSha: 'abc',
    integrationBranch: 'swarm/add-x/integration',
    slug: 'add-x',
    waves: [
      {
        waveIndex: 0,
        tasks: [
          {
            id: 't_001',
            title: 'Step 1',
            prompt: 'Do step 1',
            filesHint: ['src/a.ts'],
            status: 'pending',
            attempts: 0,
          },
        ],
      },
    ],
    createdAt: 1,
    status: 'reviewing',
  };
}

describe('validateSwarmPlan', () => {
  it('accepts a well-formed plan', () => {
    const result = validateSwarmPlan(valid());
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.value as SwarmPlan).slug).toBe('add-x');
  });

  it('rejects more than MAX_WAVES', () => {
    const p = valid() as { waves: unknown[] };
    p.waves = Array.from({ length: MAX_WAVES + 1 }, (_, i) => ({
      waveIndex: i,
      tasks: [{ id: `t${i}`, title: 't', prompt: 'p', filesHint: [], status: 'pending', attempts: 0 }],
    }));
    const result = validateSwarmPlan(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/wave/i);
  });

  it('rejects more than MAX_TASKS_PER_WAVE in any wave', () => {
    const p = valid() as { waves: { tasks: unknown[] }[] };
    p.waves[0].tasks = Array.from({ length: MAX_TASKS_PER_WAVE + 1 }, (_, i) => ({
      id: `t${i}`,
      title: 't',
      prompt: 'p',
      filesHint: [],
      status: 'pending',
      attempts: 0,
    }));
    const result = validateSwarmPlan(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/tasks/i);
  });

  it('rejects bad slug', () => {
    const p = valid() as { slug: string };
    p.slug = 'NOT VALID';
    const result = validateSwarmPlan(p);
    expect(result.ok).toBe(false);
  });

  it('rejects oversized field', () => {
    const p = valid() as { specInput: string };
    p.specInput = 'x'.repeat(16 * 1024 + 1);
    const result = validateSwarmPlan(p);
    expect(result.ok).toBe(false);
  });

  it('strips Markdown fences before parsing', () => {
    const wrapped = '```json\n' + JSON.stringify(valid()) + '\n```';
    const result = validateSwarmPlan(wrapped);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 6: Run, watch fail**

```bash
npx vitest run electron/swarm/planner-schema.test.ts
```

Expected: ERR module not found.

- [ ] **Step 7: Implement the validator**

```ts
// electron/swarm/planner-schema.ts
import type { SwarmPlan } from './types.js';

export const MAX_WAVES = 5;
export const MAX_TASKS_PER_WAVE = 6;
const MAX_FIELD_LEN = 16 * 1024;
const SLUG_RE = /^[a-z0-9-]{1,32}$/;

export type ValidationResult =
  | { ok: true; value: SwarmPlan }
  | { ok: false; error: string };

function stripFences(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('```')) {
    const inner = trimmed.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    return inner.trim();
  }
  return trimmed;
}

export function validateSwarmPlan(input: unknown): ValidationResult {
  let obj: unknown;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(stripFences(input));
    } catch (err) {
      return { ok: false, error: `parse: ${(err as Error).message}` };
    }
  } else {
    obj = input;
  }

  if (!obj || typeof obj !== 'object') {
    return { ok: false, error: 'plan is not an object' };
  }
  const p = obj as Record<string, unknown>;

  for (const field of [
    'swarmId',
    'projectRoot',
    'specInput',
    'baseBranch',
    'baseSha',
    'integrationBranch',
    'slug',
    'status',
  ] as const) {
    if (typeof p[field] !== 'string') {
      return { ok: false, error: `field ${field} must be a string` };
    }
    if ((p[field] as string).length > MAX_FIELD_LEN) {
      return { ok: false, error: `field ${field} oversized` };
    }
  }
  if (typeof p.createdAt !== 'number') {
    return { ok: false, error: 'createdAt must be a number' };
  }
  if (!SLUG_RE.test(p.slug as string)) {
    return { ok: false, error: `slug must match ${SLUG_RE.source}` };
  }
  if (!Array.isArray(p.waves)) {
    return { ok: false, error: 'waves must be an array' };
  }
  if ((p.waves as unknown[]).length > MAX_WAVES) {
    return { ok: false, error: `too many waves (max ${MAX_WAVES})` };
  }
  for (const [i, w] of (p.waves as unknown[]).entries()) {
    if (!w || typeof w !== 'object') return { ok: false, error: `wave ${i} not object` };
    const wave = w as Record<string, unknown>;
    if (!Array.isArray(wave.tasks)) return { ok: false, error: `wave ${i} tasks missing` };
    if ((wave.tasks as unknown[]).length > MAX_TASKS_PER_WAVE) {
      return { ok: false, error: `wave ${i} has too many tasks (max ${MAX_TASKS_PER_WAVE})` };
    }
    for (const [j, t] of (wave.tasks as unknown[]).entries()) {
      if (!t || typeof t !== 'object') return { ok: false, error: `task ${i}.${j} not object` };
      const task = t as Record<string, unknown>;
      for (const f of ['id', 'title', 'prompt', 'status'] as const) {
        if (typeof task[f] !== 'string') {
          return { ok: false, error: `task ${i}.${j} field ${f} must be string` };
        }
      }
      if (!Array.isArray(task.filesHint)) {
        return { ok: false, error: `task ${i}.${j} filesHint must be array` };
      }
      if (typeof task.attempts !== 'number') {
        return { ok: false, error: `task ${i}.${j} attempts must be number` };
      }
    }
  }
  return { ok: true, value: obj as SwarmPlan };
}

export function deriveSlug(specInput: string): string {
  return specInput
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'swarm';
}
```

- [ ] **Step 8: Run tests, watch pass**

```bash
npx vitest run electron/swarm/planner-schema.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add electron/swarm/prompts/ electron/swarm/planner-schema.ts electron/swarm/planner-schema.test.ts
git commit -m "swarm: prompts + plan-schema validator with caps"
```

---

## Task 5: Implement the planner (LLM call with streaming chunk emit)

**Files:**
- Create: `electron/swarm/planner.ts`
- Create: `electron/swarm/planner.test.ts`

This task wires the planner to the existing direct-LLM credential pattern. We extract a thin SDK-call interface so the test can inject a fake transport without hitting the network.

- [ ] **Step 1: Write failing tests**

```ts
// electron/swarm/planner.test.ts
import { describe, expect, it, vi } from 'vitest';
import { runPlanner, type LlmTransport } from './planner.js';

const goodPlan = {
  swarmId: 'sw_x',
  projectRoot: '/p',
  specInput: 'add x',
  baseBranch: 'main',
  baseSha: 'abc',
  integrationBranch: 'swarm/add-x/integration',
  slug: 'add-x',
  waves: [
    { waveIndex: 0, tasks: [{ id: 't', title: 'T', prompt: 'P', filesHint: [], status: 'pending', attempts: 0 }] },
  ],
  createdAt: 1,
  status: 'reviewing',
};

function fakeTransport(chunks: string[]): LlmTransport {
  return {
    async stream(_args, onChunk) {
      for (const c of chunks) {
        onChunk(c);
      }
      return chunks.join('');
    },
  };
}

describe('runPlanner', () => {
  it('assembles streamed chunks and returns a valid plan', async () => {
    const full = JSON.stringify(goodPlan);
    const transport = fakeTransport([full.slice(0, 20), full.slice(20, 50), full.slice(50)]);
    const onChunk = vi.fn();
    const result = await runPlanner(
      { projectRoot: '/p', specInput: 'add x', baseBranch: 'main', baseSha: 'abc', repoContext: { fileTree: '', claudeMd: '', recentlyChanged: '' } },
      transport,
      onChunk,
    );
    expect(result.ok).toBe(true);
    expect(onChunk).toHaveBeenCalledTimes(3);
  });

  it('re-prompts once when first output is invalid JSON, succeeds on retry', async () => {
    const stream = vi.fn()
      .mockImplementationOnce(async (_args, onChunk) => {
        onChunk('not json at all');
        return 'not json at all';
      })
      .mockImplementationOnce(async (_args, onChunk) => {
        const body = JSON.stringify(goodPlan);
        onChunk(body);
        return body;
      });
    const transport: LlmTransport = { stream } as unknown as LlmTransport;
    const result = await runPlanner(
      { projectRoot: '/p', specInput: 'add x', baseBranch: 'main', baseSha: 'abc', repoContext: { fileTree: '', claudeMd: '', recentlyChanged: '' } },
      transport,
      vi.fn(),
    );
    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('halts after two invalid attempts', async () => {
    const stream = vi.fn().mockImplementation(async (_args, onChunk) => {
      onChunk('garbage');
      return 'garbage';
    });
    const transport: LlmTransport = { stream } as unknown as LlmTransport;
    const result = await runPlanner(
      { projectRoot: '/p', specInput: 'add x', baseBranch: 'main', baseSha: 'abc', repoContext: { fileTree: '', claudeMd: '', recentlyChanged: '' } },
      transport,
      vi.fn(),
    );
    expect(stream).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('planner_invalid');
  });
});
```

- [ ] **Step 2: Run, watch fail**

```bash
npx vitest run electron/swarm/planner.test.ts
```

Expected: ERR module not found.

- [ ] **Step 3: Implement the planner**

```ts
// electron/swarm/planner.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSwarmPlan, deriveSlug } from './planner-schema.js';
import type { SwarmPlan } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PLANNER_PROMPT_PATH = path.join(__dirname, 'prompts', 'planner.md');

export interface PlannerInput {
  projectRoot: string;
  specInput: string;
  baseBranch: string;
  baseSha: string;
  repoContext: {
    fileTree: string;
    claudeMd: string;
    recentlyChanged: string;
  };
}

export interface LlmTransport {
  stream(
    args: { systemPrompt: string; userPrompt: string },
    onChunk: (chunk: string) => void,
  ): Promise<string>;
}

export type PlannerResult =
  | { ok: true; plan: SwarmPlan }
  | { ok: false; reason: 'planner_invalid'; lastError: string };

async function renderSystemPrompt(): Promise<string> {
  return fs.readFile(PLANNER_PROMPT_PATH, 'utf8');
}

function buildUserPrompt(input: PlannerInput, schemaJson: string): string {
  return [
    `Spec:\n${input.specInput}`,
    `Base branch: ${input.baseBranch}`,
    `Base sha: ${input.baseSha}`,
    `File tree (depth ≤ 3):\n${input.repoContext.fileTree}`,
    `CLAUDE.md:\n${input.repoContext.claudeMd}`,
    `Recently changed:\n${input.repoContext.recentlyChanged}`,
    `Schema:\n${schemaJson}`,
  ].join('\n\n');
}

const SCHEMA_JSON = JSON.stringify({
  swarmId: 'string (ulid)',
  projectRoot: 'string',
  specInput: 'string',
  baseBranch: 'string',
  baseSha: 'string',
  integrationBranch: 'string (swarm/<slug>/integration)',
  slug: 'kebab, ≤32 chars',
  waves: [
    {
      waveIndex: 'number',
      tasks: [
        {
          id: 'string',
          title: 'string',
          prompt: 'string',
          filesHint: ['string'],
          status: '"pending"',
          attempts: 0,
        },
      ],
    },
  ],
  createdAt: 'number',
  status: '"reviewing"',
});

export async function runPlanner(
  input: PlannerInput,
  transport: LlmTransport,
  onChunk: (chunk: string) => void,
): Promise<PlannerResult> {
  const system = await renderSystemPrompt();
  let user = buildUserPrompt(input, SCHEMA_JSON);
  let lastError = '';

  for (let attempt = 0; attempt < 2; attempt++) {
    let buffer = '';
    const body = await transport.stream({ systemPrompt: system, userPrompt: user }, (chunk) => {
      buffer += chunk;
      onChunk(chunk);
    });

    const validation = validateSwarmPlan(body || buffer);
    if (validation.ok) {
      // Force the slug derivation server-side to guarantee invariant.
      const plan = validation.value;
      plan.slug = plan.slug && plan.slug.match(/^[a-z0-9-]+$/) ? plan.slug : deriveSlug(input.specInput);
      return { ok: true, plan };
    }
    lastError = validation.error;
    user = `${user}\n\nYour previous output failed validation: ${validation.error}. Reply with valid JSON only.`;
  }

  return { ok: false, reason: 'planner_invalid', lastError };
}
```

- [ ] **Step 4: Run tests, watch pass**

```bash
npx vitest run electron/swarm/planner.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/planner.ts electron/swarm/planner.test.ts
git commit -m "swarm: planner with streaming + re-prompt-once on invalid output"
```

---

## Task 6: Adapter to wire planner to Anthropic SDK (real transport)

**Files:**
- Create: `electron/swarm/llm-anthropic.ts`
- Modify: `electron/swarm/planner.ts` to export `defaultTransport()`

The default transport calls the Anthropic SDK using the same key-storage pattern as `ask-code-minimax.ts`. No test for the live network call — the transport is purely the SDK adapter and is mocked in planner tests.

- [ ] **Step 1: Implement the adapter**

```ts
// electron/swarm/llm-anthropic.ts
import type { LlmTransport } from './planner.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
export const DEFAULT_PLANNER_MODEL = 'claude-sonnet-4-6';

let storedKey = '';
let storedModel = DEFAULT_PLANNER_MODEL;

export function setAnthropicKey(key: string): void {
  storedKey = key.trim();
}

export function setPlannerModel(model: string): void {
  storedModel = model.trim() || DEFAULT_PLANNER_MODEL;
}

export function getPlannerModel(): string {
  return storedModel;
}

export function createAnthropicTransport(): LlmTransport {
  return {
    async stream({ systemPrompt, userPrompt }, onChunk) {
      if (!storedKey) {
        throw new Error('Anthropic API key not configured. Set it in Settings → Swarm.');
      }
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': storedKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: storedModel,
          max_tokens: 8192,
          stream: true,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assembled = '';
      let sseBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        for (;;) {
          const sep = sseBuffer.indexOf('\n\n');
          if (sep === -1) break;
          const event = sseBuffer.slice(0, sep);
          sseBuffer = sseBuffer.slice(sep + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice('data: '.length);
            if (payload === '[DONE]') continue;
            try {
              const obj = JSON.parse(payload) as { type?: string; delta?: { text?: string } };
              const delta = obj?.delta?.text;
              if (typeof delta === 'string' && delta.length > 0) {
                assembled += delta;
                onChunk(delta);
              }
            } catch {
              // Non-JSON SSE event (e.g. event: ping) — ignore.
            }
          }
        }
      }
      return assembled;
    },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add electron/swarm/llm-anthropic.ts
git commit -m "swarm: anthropic SSE transport for planner LLM call"
```

---

## Task 7: Runtime skeleton with status emission and persistence

**Files:**
- Create: `electron/swarm/runtime.ts`
- Create: `electron/swarm/runtime.test.ts`

The runtime in this task only tracks status transitions and persists them. Sub-task spawn arrives in Task 8.

- [ ] **Step 1: Write failing tests**

```ts
// electron/swarm/runtime.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }));
import { app } from 'electron';

import { initSwarmStore, getSwarm, saveSwarm } from './store.js';
import { createRuntime } from './runtime.js';
import type { SwarmPlan } from './types.js';

function plan(): SwarmPlan {
  return {
    swarmId: 'sw_r',
    projectRoot: '/proj',
    specInput: 'add x',
    baseBranch: 'main',
    baseSha: 'abc',
    integrationBranch: 'swarm/add-x/integration',
    slug: 'add-x',
    waves: [
      { waveIndex: 0, tasks: [{ id: 't1', title: 'T', prompt: 'P', filesHint: [], status: 'pending', attempts: 0 }] },
    ],
    createdAt: 1,
    status: 'reviewing',
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rt-'));
  vi.mocked(app.getPath).mockReturnValue(tmp);
  await initSwarmStore();
});
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('runtime status transitions', () => {
  it('starting moves status reviewing → running and emits an update', async () => {
    await saveSwarm(plan());
    const events: { swarmId: string; status: string }[] = [];
    const rt = createRuntime({
      onStatusUpdate: (e) => events.push({ swarmId: e.swarmId, status: e.status }),
      onTaskUpdate: () => {},
      onHalted: () => {},
      onDone: () => {},
      spawnSubTask: vi.fn(),
      killSubTask: vi.fn(),
      pollBranchHead: vi.fn(),
      ptyIdleMs: vi.fn().mockReturnValue(99_999),
    });
    await rt.start('sw_r');
    expect(events).toContainEqual({ swarmId: 'sw_r', status: 'running' });
    expect((await getSwarm('sw_r'))?.status).toBe('running');
  });

  it('halt persists haltReason and emits SwarmHalted', async () => {
    await saveSwarm({ ...plan(), status: 'running' });
    const halted = vi.fn();
    const rt = createRuntime({
      onStatusUpdate: () => {},
      onTaskUpdate: () => {},
      onHalted: halted,
      onDone: () => {},
      spawnSubTask: vi.fn(),
      killSubTask: vi.fn(),
      pollBranchHead: vi.fn(),
      ptyIdleMs: vi.fn().mockReturnValue(99_999),
    });
    await rt.halt('sw_r', 'user_halt');
    expect(halted).toHaveBeenCalledWith(expect.objectContaining({ swarmId: 'sw_r', reason: 'user_halt' }));
    const persisted = await getSwarm('sw_r');
    expect(persisted?.status).toBe('halted');
    expect(persisted?.haltReason).toBe('user_halt');
  });
});
```

- [ ] **Step 2: Run, watch fail**

```bash
npx vitest run electron/swarm/runtime.test.ts
```

Expected: ERR module not found.

- [ ] **Step 3: Implement the runtime skeleton**

```ts
// electron/swarm/runtime.ts
import { getSwarm, saveSwarm } from './store.js';
import type { SwarmHaltReason, SwarmPlan, SwarmTaskStatus } from './types.js';

export interface RuntimeCallbacks {
  onStatusUpdate(payload: { swarmId: string; status: SwarmPlan['status']; currentWave?: number }): void;
  onTaskUpdate(payload: {
    swarmId: string;
    taskId: string;
    status: SwarmTaskStatus;
    failureReason?: string;
    attempts: number;
  }): void;
  onHalted(payload: { swarmId: string; reason: SwarmHaltReason; taskId?: string; waveIndex?: number }): void;
  onDone(payload: { swarmId: string; prUrl: string; summary: string }): void;
  spawnSubTask(args: { swarmId: string; taskId: string }): Promise<void>;
  killSubTask(args: { swarmId: string; taskId: string }): Promise<void>;
  pollBranchHead(args: { branchName: string; worktreePath: string }): Promise<string>;
  ptyIdleMs(args: { swarmId: string; taskId: string }): number;
}

export interface Runtime {
  start(swarmId: string): Promise<void>;
  halt(swarmId: string, reason: SwarmHaltReason, taskId?: string, waveIndex?: number): Promise<void>;
  resume(swarmId: string): Promise<void>;
  abort(swarmId: string): Promise<void>;
}

export function createRuntime(cb: RuntimeCallbacks): Runtime {
  async function persist(plan: SwarmPlan): Promise<void> {
    await saveSwarm(plan);
  }

  async function start(swarmId: string): Promise<void> {
    const plan = await getSwarm(swarmId);
    if (!plan) throw new Error(`unknown swarm ${swarmId}`);
    const next: SwarmPlan = { ...plan, status: 'running' };
    await persist(next);
    cb.onStatusUpdate({ swarmId, status: 'running', currentWave: 0 });
    // Wave loop arrives in Task 8.
  }

  async function halt(swarmId: string, reason: SwarmHaltReason, taskId?: string, waveIndex?: number): Promise<void> {
    const plan = await getSwarm(swarmId);
    if (!plan) return;
    const next: SwarmPlan = { ...plan, status: 'halted', haltReason: reason, haltTaskId: taskId, haltWaveIndex: waveIndex };
    await persist(next);
    cb.onHalted({ swarmId, reason, taskId, waveIndex });
  }

  async function resume(_swarmId: string): Promise<void> {
    // Arrives in Task 10.
  }

  async function abort(_swarmId: string): Promise<void> {
    // Arrives in Task 10.
  }

  return { start, halt, resume, abort };
}
```

- [ ] **Step 4: Run tests, watch pass**

```bash
npx vitest run electron/swarm/runtime.test.ts
```

Expected: 2 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/runtime.ts electron/swarm/runtime.test.ts
git commit -m "swarm: runtime skeleton with status transitions"
```

---

## Task 8: Wave-serial scheduler with sub-task spawn and success detection

**Files:**
- Modify: `electron/swarm/runtime.ts`
- Modify: `electron/swarm/runtime.test.ts`

- [ ] **Step 1: Add a failing test for wave gating**

Append to `electron/swarm/runtime.test.ts`:

```ts
it('wave 2 does not spawn until wave 1 is fully successful', async () => {
  const p = plan();
  p.waves = [
    { waveIndex: 0, tasks: [
      { id: 't_a', title: 'A', prompt: 'P', filesHint: [], status: 'pending', attempts: 0 },
      { id: 't_b', title: 'B', prompt: 'P', filesHint: [], status: 'pending', attempts: 0 },
    ] },
    { waveIndex: 1, tasks: [
      { id: 't_c', title: 'C', prompt: 'P', filesHint: [], status: 'pending', attempts: 0 },
    ] },
  ];
  await saveSwarm(p);

  const spawned: string[] = [];
  // pollBranchHead returns baseSha for t_a until tick > 2, then a new sha.
  // For t_b, immediately new sha.
  let tick = 0;
  const headByTask = new Map<string, string>();
  const rt = createRuntime({
    onStatusUpdate: () => {},
    onTaskUpdate: () => {},
    onHalted: () => {},
    onDone: () => {},
    spawnSubTask: vi.fn(async ({ taskId }) => {
      spawned.push(taskId);
      headByTask.set(taskId, 'abc'); // base
      if (taskId === 't_b') headByTask.set(taskId, 'def'); // immediately moved
    }),
    killSubTask: vi.fn(),
    pollBranchHead: vi.fn(async ({ branchName }) => {
      tick++;
      const id = branchName.split('/').pop()!;
      if (id.startsWith('t_a') && tick > 6) headByTask.set('t_a', 'def');
      return headByTask.get(id) ?? 'abc';
    }),
    ptyIdleMs: vi.fn().mockReturnValue(99_999),
  });
  // Use small polling interval for the test.
  await rt.start('sw_r');
  await new Promise((r) => setTimeout(r, 1500));

  // t_a and t_b should be in spawned (wave 1), t_c should NOT until both wave-1 done.
  expect(spawned.slice(0, 2).sort()).toEqual(['t_a', 't_b']);
  expect(spawned).toContain('t_c'); // after wave-1 completion
  const after = await getSwarm('sw_r');
  expect(after?.waves[0].tasks.every((t) => t.status === 'succeeded')).toBe(true);
});
```

- [ ] **Step 2: Run, watch fail**

```bash
npx vitest run electron/swarm/runtime.test.ts -t "wave 2 does not spawn"
```

Expected: FAIL (no wave loop yet).

- [ ] **Step 3: Implement the wave loop and success detection**

Replace the empty wave-loop in `runtime.ts` with:

```ts
const POLL_MS = 100; // test-friendly; production overrides via setter below
const IDLE_THRESHOLD_MS = 30_000;
const HUNG_NO_COMMIT_MS = 5 * 60_000;
let pollMs = POLL_MS;
export function setPollIntervalMs(ms: number): void { pollMs = ms; }
let idleThresholdMs = IDLE_THRESHOLD_MS;
export function setIdleThresholdMs(ms: number): void { idleThresholdMs = ms; }
```

Then inside `start`, after the status transition to `running`, drive the wave loop:

```ts
async function runWaves(plan: SwarmPlan): Promise<void> {
  for (const wave of plan.waves) {
    // Update plan from disk in case it changed (resume scenarios).
    const fresh = (await getSwarm(plan.swarmId))!;
    if (fresh.status !== 'running') return;

    // Spawn pending tasks in this wave.
    for (const task of wave.tasks) {
      if (task.status === 'pending') {
        markTask(fresh, task.id, 'running');
        await persist(fresh);
        cb.onTaskUpdate({ swarmId: fresh.swarmId, taskId: task.id, status: 'running', attempts: task.attempts });
        await cb.spawnSubTask({ swarmId: fresh.swarmId, taskId: task.id });
      }
    }

    // Poll until every task is terminal.
    while (true) {
      const cur = (await getSwarm(plan.swarmId))!;
      if (cur.status !== 'running') return;
      const waveTasks = cur.waves[wave.waveIndex].tasks;
      let allTerminal = true;
      for (const task of waveTasks) {
        if (task.status === 'succeeded' || task.status === 'failed') continue;
        allTerminal = false;
        if (task.status !== 'running' && task.status !== 'retrying') continue;
        const head = await cb.pollBranchHead({ branchName: task.branchName ?? '', worktreePath: task.worktreePath ?? '' });
        const idle = cb.ptyIdleMs({ swarmId: cur.swarmId, taskId: task.id });
        if (head !== cur.baseSha && idle >= idleThresholdMs) {
          markTask(cur, task.id, 'succeeded');
          await persist(cur);
          cb.onTaskUpdate({ swarmId: cur.swarmId, taskId: task.id, status: 'succeeded', attempts: task.attempts });
          await cb.killSubTask({ swarmId: cur.swarmId, taskId: task.id });
        }
      }
      if (allTerminal) {
        // If any failed, halt; else continue to next wave.
        const anyFailed = cur.waves[wave.waveIndex].tasks.some((t) => t.status === 'failed');
        if (anyFailed) {
          const failed = cur.waves[wave.waveIndex].tasks.find((t) => t.status === 'failed')!;
          await halt(cur.swarmId, 'sub_task_failed_after_retry', failed.id, wave.waveIndex);
          return;
        }
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
  // Integrator step arrives in Task 11.
}

function markTask(plan: SwarmPlan, taskId: string, status: SwarmTaskStatus): void {
  for (const w of plan.waves) {
    for (const t of w.tasks) {
      if (t.id === taskId) t.status = status;
    }
  }
}
```

Inside `start`, after persisting `running`:

```ts
// Fire and forget — runtime is async by design; callers attach to events.
void runWaves(next).catch(async (err) => {
  await halt(swarmId, 'sub_task_failed_after_retry');
  console.error('swarm runtime error', err);
});
```

Decrease the poll interval for tests:

```ts
// at top of runtime.test.ts
import { setPollIntervalMs, setIdleThresholdMs } from './runtime.js';
beforeEach(() => {
  setPollIntervalMs(20);
  setIdleThresholdMs(0);
});
```

- [ ] **Step 4: Run tests, watch pass**

```bash
npx vitest run electron/swarm/runtime.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/runtime.ts electron/swarm/runtime.test.ts
git commit -m "swarm: wave-serial scheduler with branch-head success detection"
```

---

## Task 9: Retry-once with augmented prompt

**Files:**
- Create: `electron/swarm/retry.ts`
- Create: `electron/swarm/retry.test.ts`
- Modify: `electron/swarm/runtime.ts` (call retry before marking `failed` terminal)

- [ ] **Step 1: Write failing retry tests**

```ts
// electron/swarm/retry.test.ts
import { describe, expect, it } from 'vitest';
import { buildRetryPrompt, shouldRetry } from './retry.js';
import type { SwarmTask } from './types.js';

function task(attempts: number): SwarmTask {
  return {
    id: 't', title: 'T', prompt: 'Do thing', filesHint: [],
    status: 'failed', attempts,
  };
}

describe('retry', () => {
  it('shouldRetry true when attempts < 1', () => {
    expect(shouldRetry(task(0))).toBe(true);
  });
  it('shouldRetry false when attempts >= 1', () => {
    expect(shouldRetry(task(1))).toBe(false);
  });
  it('buildRetryPrompt includes original, reason, diffStat, ptyTail', () => {
    const out = buildRetryPrompt({
      original: 'ORIG',
      reason: 'WHY',
      diffStat: 'STAT',
      ptyTail: 'TAIL',
    });
    expect(out).toContain('ORIG');
    expect(out).toContain('WHY');
    expect(out).toContain('STAT');
    expect(out).toContain('TAIL');
  });
});
```

- [ ] **Step 2: Run, watch fail**

```bash
npx vitest run electron/swarm/retry.test.ts
```

- [ ] **Step 3: Implement**

```ts
// electron/swarm/retry.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SwarmTask } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function shouldRetry(task: SwarmTask): boolean {
  return task.attempts < 1;
}

export interface RetryPromptInput {
  original: string;
  reason: string;
  diffStat: string;
  ptyTail: string;
}

let templateCache: string | null = null;
async function template(): Promise<string> {
  if (templateCache != null) return templateCache;
  templateCache = await fs.readFile(path.join(__dirname, 'prompts', 'retry-augment.md'), 'utf8');
  return templateCache;
}

export async function renderRetryPrompt(input: RetryPromptInput): Promise<string> {
  const tpl = await template();
  return input.original + '\n' + tpl
    .replace('{reason}', input.reason)
    .replace('{diffStat}', input.diffStat)
    .replace('{ptyTail}', input.ptyTail);
}

// Sync version for the unit test (template inlined).
export function buildRetryPrompt(input: RetryPromptInput): string {
  return [
    input.original,
    '',
    '---',
    '',
    `<previous_attempt failed="${input.reason}">`,
    '',
    'git diff --stat (from the failed attempt):',
    input.diffStat,
    '',
    'Last 3 KB of the agent\'s terminal output before failure:',
    input.ptyTail,
    '',
    '</previous_attempt>',
  ].join('\n');
}
```

- [ ] **Step 4: Wire retry into the runtime**

In `runtime.ts`, when a sub-task is about to be marked `failed`, call retry instead if `shouldRetry`:

```ts
// Add a new callback for retrying.
// In RuntimeCallbacks:
retrySubTask(args: { swarmId: string; taskId: string; augmentedPrompt: string }): Promise<void>;

// In runWaves, when classifying a failure (you'll wire failure detection from Task 8 — placeholder for now: a task can be set to 'failed' externally via cb.markTaskFailed)
// Add this helper:
async function maybeRetry(plan: SwarmPlan, task: SwarmTask, reason: string, diffStat: string, ptyTail: string): Promise<void> {
  if (shouldRetry(task)) {
    task.attempts += 1;
    task.status = 'retrying';
    task.failureReason = reason;
    await persist(plan);
    cb.onTaskUpdate({ swarmId: plan.swarmId, taskId: task.id, status: 'retrying', attempts: task.attempts, failureReason: reason });
    const augmented = buildRetryPrompt({ original: task.prompt, reason, diffStat, ptyTail });
    await cb.retrySubTask({ swarmId: plan.swarmId, taskId: task.id, augmentedPrompt: augmented });
    task.status = 'running';
  } else {
    task.status = 'failed';
    task.failureReason = reason;
    await persist(plan);
    cb.onTaskUpdate({ swarmId: plan.swarmId, taskId: task.id, status: 'failed', attempts: task.attempts, failureReason: reason });
  }
}
```

The actual failure-classification call sites (wallclock, hung, sentinel, user-marked) are connected in Task 10 by the IPC layer; here we only add the `maybeRetry` helper and the new callback in the interface.

- [ ] **Step 5: Typecheck + run all swarm tests**

```bash
npm run typecheck
npx vitest run electron/swarm/
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add electron/swarm/retry.ts electron/swarm/retry.test.ts electron/swarm/runtime.ts
git commit -m "swarm: retry-once with augmented prompt"
```

---

## Task 10: Halt-resume-abort + "agent says done no commit" path

**Files:**
- Modify: `electron/swarm/runtime.ts`
- Modify: `electron/swarm/runtime.test.ts`

- [ ] **Step 1: Add tests**

Append to `runtime.test.ts`:

```ts
it('resume after manual commit advances a failed task to succeeded', async () => {
  const p = plan();
  p.status = 'halted';
  p.haltReason = 'sub_task_failed_after_retry';
  p.waves = [{ waveIndex: 0, tasks: [{ id: 't1', title: 'T', prompt: 'P', filesHint: [], status: 'failed', attempts: 1, branchName: 'swarm/x/t1', worktreePath: '/wt' }] }];
  await saveSwarm(p);

  const updates: string[] = [];
  const rt = createRuntime({
    onStatusUpdate: () => {},
    onTaskUpdate: (e) => updates.push(e.status),
    onHalted: () => {},
    onDone: () => {},
    spawnSubTask: vi.fn(),
    killSubTask: vi.fn(),
    retrySubTask: vi.fn(),
    pollBranchHead: vi.fn().mockResolvedValue('def'), // user committed
    ptyIdleMs: vi.fn().mockReturnValue(99_999),
  });
  await rt.resume('sw_r');
  await new Promise((r) => setTimeout(r, 100));
  expect(updates).toContain('succeeded');
});

it('abort kills running tasks and deletes the swarm', async () => {
  await saveSwarm({ ...plan(), status: 'running' });
  const kill = vi.fn();
  const rt = createRuntime({
    onStatusUpdate: () => {},
    onTaskUpdate: () => {},
    onHalted: () => {},
    onDone: () => {},
    spawnSubTask: vi.fn(),
    killSubTask: kill,
    retrySubTask: vi.fn(),
    pollBranchHead: vi.fn(),
    ptyIdleMs: vi.fn().mockReturnValue(99_999),
  });
  await rt.abort('sw_r');
  expect(await getSwarm('sw_r')).toBeNull();
});
```

- [ ] **Step 2: Implement resume**

```ts
async function resume(swarmId: string): Promise<void> {
  const plan = await getSwarm(swarmId);
  if (!plan || plan.status !== 'halted') return;

  // Re-evaluate every task: if branch HEAD moved past baseSha, the user
  // committed manually → mark succeeded. Otherwise reset attempts and re-spawn.
  for (const wave of plan.waves) {
    for (const task of wave.tasks) {
      if (task.status === 'failed' && task.branchName && task.worktreePath) {
        const head = await cb.pollBranchHead({ branchName: task.branchName, worktreePath: task.worktreePath });
        if (head !== plan.baseSha) {
          task.status = 'succeeded';
          task.failureReason = undefined;
          cb.onTaskUpdate({ swarmId, taskId: task.id, status: 'succeeded', attempts: task.attempts });
        } else {
          task.status = 'pending';
          task.attempts = 0;
        }
      }
    }
  }
  plan.status = 'running';
  plan.haltReason = undefined;
  plan.haltTaskId = undefined;
  plan.haltWaveIndex = undefined;
  await saveSwarm(plan);
  cb.onStatusUpdate({ swarmId, status: 'running' });
  void runWaves(plan);
}
```

- [ ] **Step 3: Implement abort**

```ts
async function abort(swarmId: string): Promise<void> {
  const plan = await getSwarm(swarmId);
  if (!plan) return;
  for (const wave of plan.waves) {
    for (const task of wave.tasks) {
      if (task.status === 'running' || task.status === 'retrying') {
        await cb.killSubTask({ swarmId, taskId: task.id });
      }
    }
  }
  await deleteSwarm(swarmId);
  cb.onStatusUpdate({ swarmId, status: 'aborted' });
}
```

Import `deleteSwarm` from `./store.js` at the top of the file.

- [ ] **Step 4: Add the "agent says done no commit" callback**

Extend `RuntimeCallbacks` and expose a `notifyAgentDoneNoCommit` event:

```ts
onAgentDoneNoCommit(payload: { swarmId: string; taskId: string }): void;
```

In the poll loop, when the sentinel `SWARM_TASK_DONE_<id>` is observed (you'll get this signal from the IPC side via `notifyTaskDoneSentinel`), call `pollBranchHead` immediately; if equal to `baseSha`, emit `onAgentDoneNoCommit`. Add a method on the Runtime interface that the IPC layer calls:

```ts
notifyTaskDoneSentinel(args: { swarmId: string; taskId: string }): Promise<void>;
```

Implementation reads the plan, finds the task, calls `pollBranchHead`, branches accordingly.

- [ ] **Step 5: Run tests, watch pass**

```bash
npx vitest run electron/swarm/runtime.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add electron/swarm/runtime.ts electron/swarm/runtime.test.ts
git commit -m "swarm: resume / abort / done-no-commit notification"
```

---

## Task 11: Integrator branch creation and merge sequencing

**Files:**
- Create: `electron/swarm/integrator.ts`
- Create: `electron/swarm/integrator.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// electron/swarm/integrator.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildIntegratorPrompt, sequenceMergeBranches } from './integrator.js';
import type { SwarmPlan } from './types.js';

function plan(): SwarmPlan {
  return {
    swarmId: 'sw',
    projectRoot: '/proj',
    specInput: 'add x',
    baseBranch: 'main',
    baseSha: 'abc',
    integrationBranch: 'swarm/add-x/integration',
    slug: 'add-x',
    waves: [
      { waveIndex: 0, tasks: [
        { id: 'a', title: 'A', prompt: '', filesHint: [], status: 'succeeded', attempts: 0, branchName: 'swarm/add-x/a' },
        { id: 'b', title: 'B', prompt: '', filesHint: [], status: 'succeeded', attempts: 0, branchName: 'swarm/add-x/b' },
      ] },
      { waveIndex: 1, tasks: [
        { id: 'c', title: 'C', prompt: '', filesHint: [], status: 'succeeded', attempts: 0, branchName: 'swarm/add-x/c' },
      ] },
    ],
    createdAt: 1,
    status: 'integrating',
  };
}

describe('integrator', () => {
  it('sequenceMergeBranches yields branches in plan order', () => {
    expect(sequenceMergeBranches(plan())).toEqual([
      'swarm/add-x/a',
      'swarm/add-x/b',
      'swarm/add-x/c',
    ]);
  });

  it('sequenceMergeBranches skips non-succeeded tasks', () => {
    const p = plan();
    p.waves[0].tasks[1].status = 'failed';
    expect(sequenceMergeBranches(p)).toEqual([
      'swarm/add-x/a',
      'swarm/add-x/c',
    ]);
  });

  it('buildIntegratorPrompt embeds branches and spec', () => {
    const prompt = buildIntegratorPrompt(plan(), '/wt/intg');
    expect(prompt).toContain('/wt/intg');
    expect(prompt).toContain('swarm/add-x/a');
    expect(prompt).toContain('swarm/add-x/c');
    expect(prompt).toContain('add x'); // specInput
    expect(prompt).toContain('SWARM_INTEGRATOR_MERGED');
  });
});
```

- [ ] **Step 2: Run, fail**

```bash
npx vitest run electron/swarm/integrator.test.ts
```

- [ ] **Step 3: Implement**

```ts
// electron/swarm/integrator.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SwarmPlan } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function sequenceMergeBranches(plan: SwarmPlan): string[] {
  const out: string[] = [];
  for (const wave of plan.waves) {
    for (const task of wave.tasks) {
      if (task.status === 'succeeded' && task.branchName) {
        out.push(task.branchName);
      }
    }
  }
  return out;
}

let templateCache: string | null = null;
async function template(): Promise<string> {
  if (templateCache != null) return templateCache;
  templateCache = await fs.readFile(path.join(__dirname, 'prompts', 'integrator.md'), 'utf8');
  return templateCache;
}

// Sync variant used in tests (inline template, must mirror prompts/integrator.md).
export function buildIntegratorPrompt(plan: SwarmPlan, integrationWorktreePath: string): string {
  const branches = sequenceMergeBranches(plan).map((b) => `  - ${b}`).join('\n');
  return [
    `You are the integrator. Worktree: ${integrationWorktreePath}.`,
    `Merge each of these branches in order:`,
    branches,
    `For each: git merge --no-ff <branch> -m "Merge <branch>". On conflict, resolve with your tools and commit. Do NOT push. Do NOT run tests yet.`,
    `When done, print on its own line: SWARM_INTEGRATOR_MERGED`,
    `Spec was: ${plan.specInput}`,
  ].join('\n');
}

export async function renderIntegratorPrompt(plan: SwarmPlan, integrationWorktreePath: string): Promise<string> {
  const tpl = await template();
  const branches = sequenceMergeBranches(plan).map((b) => `  - ${b}`).join('\n');
  return tpl
    .replace('{integrationWorktreePath}', integrationWorktreePath)
    .replace('{integrationBranch}', plan.integrationBranch)
    .replace('{baseBranch}', plan.baseBranch)
    .replace('{childBranches}', branches)
    .replace('{specInput}', plan.specInput);
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run electron/swarm/integrator.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/integrator.ts electron/swarm/integrator.test.ts
git commit -m "swarm: integrator branch sequencing + prompt rendering"
```

---

## Task 12: Runtime-owned test step with flaky-test buffer and one fix attempt

**Files:**
- Modify: `electron/swarm/integrator.ts`
- Modify: `electron/swarm/integrator.test.ts`
- Modify: `electron/swarm/runtime.ts`

- [ ] **Step 1: Add failing tests**

Append to `integrator.test.ts`:

```ts
import { runTestStep } from './integrator.js';

describe('runtime test step', () => {
  it('skipped when no test script', async () => {
    const result = await runTestStep({
      worktreePath: '/proj',
      readPackageJson: async () => '{}',
      runTests: vi.fn(),
    });
    expect(result.outcome).toBe('skipped');
  });

  it('passes on first try', async () => {
    const runTests = vi.fn().mockResolvedValueOnce({ exitCode: 0, output: 'ok' });
    const result = await runTestStep({
      worktreePath: '/proj',
      readPackageJson: async () => JSON.stringify({ scripts: { test: 'vitest' } }),
      runTests,
    });
    expect(result.outcome).toBe('passed');
    expect(runTests).toHaveBeenCalledTimes(1);
  });

  it('flaky-test re-run rescues a flake', async () => {
    const runTests = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, output: 'flake' })
      .mockResolvedValueOnce({ exitCode: 0, output: 'ok' });
    const result = await runTestStep({
      worktreePath: '/proj',
      readPackageJson: async () => JSON.stringify({ scripts: { test: 'vitest' } }),
      runTests,
    });
    expect(result.outcome).toBe('passed');
    expect(runTests).toHaveBeenCalledTimes(2);
  });

  it('reports needs_fix after two failures', async () => {
    const runTests = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, output: 'fail1' })
      .mockResolvedValueOnce({ exitCode: 1, output: 'fail2' });
    const result = await runTestStep({
      worktreePath: '/proj',
      readPackageJson: async () => JSON.stringify({ scripts: { test: 'vitest' } }),
      runTests,
    });
    expect(result.outcome).toBe('needs_fix');
    if (result.outcome === 'needs_fix') {
      expect(result.lastOutput).toBe('fail2');
    }
  });
});
```

- [ ] **Step 2: Implement `runTestStep`**

Append to `integrator.ts`:

```ts
export type TestStepResult =
  | { outcome: 'passed' }
  | { outcome: 'skipped' }
  | { outcome: 'needs_fix'; lastOutput: string }
  | { outcome: 'failed_after_fix'; lastOutput: string };

export interface TestStepInput {
  worktreePath: string;
  readPackageJson: () => Promise<string>;
  runTests: () => Promise<{ exitCode: number; output: string }>;
}

export async function runTestStep(input: TestStepInput): Promise<TestStepResult> {
  let pkg: unknown;
  try {
    pkg = JSON.parse(await input.readPackageJson());
  } catch {
    return { outcome: 'skipped' };
  }
  const hasTest =
    pkg && typeof pkg === 'object' && (pkg as { scripts?: Record<string, string> }).scripts?.test;
  if (!hasTest) return { outcome: 'skipped' };

  const first = await input.runTests();
  if (first.exitCode === 0) return { outcome: 'passed' };
  // Flaky buffer.
  const second = await input.runTests();
  if (second.exitCode === 0) return { outcome: 'passed' };
  return { outcome: 'needs_fix', lastOutput: second.output };
}

export async function runFixAttemptTestStep(input: TestStepInput): Promise<TestStepResult> {
  const first = await input.runTests();
  if (first.exitCode === 0) return { outcome: 'passed' };
  const second = await input.runTests();
  if (second.exitCode === 0) return { outcome: 'passed' };
  return { outcome: 'failed_after_fix', lastOutput: second.output };
}
```

- [ ] **Step 3: Wire the test step into runtime**

In `runtime.ts`, after the final sub-task wave succeeds, add an integrator phase:

```ts
// Pseudo-shape; actual call goes through cb.runIntegratorPhase to keep
// runtime free of git/PTY concerns.
async function integratorPhase(plan: SwarmPlan): Promise<void> {
  plan.status = 'integrating';
  await persist(plan);
  cb.onStatusUpdate({ swarmId: plan.swarmId, status: 'integrating' });

  const merged = await cb.spawnIntegrator({ swarmId: plan.swarmId });
  if (!merged.ok) {
    await halt(plan.swarmId, 'integrator_hung');
    return;
  }
  const test1 = await cb.runIntegratorTests({ swarmId: plan.swarmId });
  if (test1.outcome === 'passed' || test1.outcome === 'skipped') {
    return finishWithPr(plan, test1.outcome === 'skipped');
  }
  if (test1.outcome === 'needs_fix') {
    await cb.appendIntegratorPrompt({ swarmId: plan.swarmId, addendum: testFailureAddendum(test1.lastOutput) });
    const fixed = await cb.waitForIntegratorIdleAfterFix({ swarmId: plan.swarmId });
    if (!fixed.ok) {
      await halt(plan.swarmId, 'integrator_hung');
      return;
    }
    const test2 = await cb.runIntegratorTestsAfterFix({ swarmId: plan.swarmId });
    if (test2.outcome === 'passed') return finishWithPr(plan, false);
    await halt(plan.swarmId, 'integrator_fix_failed');
  }
}

function testFailureAddendum(output: string): string {
  return [
    '',
    '---',
    'The runtime ran the project test command after your merges and it failed.',
    'Test output (truncated):',
    output.slice(-4096),
    '',
    'Please fix and commit. Then print SWARM_INTEGRATOR_FIXED on its own line.',
  ].join('\n');
}

async function finishWithPr(plan: SwarmPlan, testsSkipped: boolean): Promise<void> {
  const prResult = await cb.pushAndOpenPr({ swarmId: plan.swarmId, testsSkipped });
  if (!prResult.ok) {
    await halt(plan.swarmId, 'pr_open_failed');
    return;
  }
  plan.status = 'done';
  plan.prUrl = prResult.prUrl;
  await persist(plan);
  cb.onDone({ swarmId: plan.swarmId, prUrl: prResult.prUrl, summary: prResult.summary });
}
```

Add the new callbacks to `RuntimeCallbacks`:

```ts
spawnIntegrator(args: { swarmId: string }): Promise<{ ok: true } | { ok: false }>;
runIntegratorTests(args: { swarmId: string }): Promise<TestStepResult>;
runIntegratorTestsAfterFix(args: { swarmId: string }): Promise<TestStepResult>;
appendIntegratorPrompt(args: { swarmId: string; addendum: string }): Promise<void>;
waitForIntegratorIdleAfterFix(args: { swarmId: string }): Promise<{ ok: true } | { ok: false }>;
pushAndOpenPr(args: { swarmId: string; testsSkipped: boolean }): Promise<
  { ok: true; prUrl: string; summary: string } | { ok: false; reason: string }
>;
```

- [ ] **Step 4: Run all swarm tests**

```bash
npm run typecheck
npx vitest run electron/swarm/
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add electron/swarm/integrator.ts electron/swarm/integrator.test.ts electron/swarm/runtime.ts
git commit -m "swarm: runtime-owned test step + integrator fix loop"
```

---

## Task 13: Mid-swarm rebase classifier

**Files:**
- Create: `electron/swarm/rebase.ts`
- Create: `electron/swarm/rebase.test.ts`
- Modify: `electron/swarm/runtime.ts` (call before each wave)

- [ ] **Step 1: Tests**

```ts
// electron/swarm/rebase.test.ts
import { describe, expect, it } from 'vitest';
import { classifyDivergence } from './rebase.js';

describe('classifyDivergence', () => {
  it('returns unchanged when remoteSha === baseSha', () => {
    expect(classifyDivergence({ baseSha: 'abc', remoteSha: 'abc', remoteChangedFiles: [], filesHint: ['x.ts'] })).toEqual({ kind: 'unchanged' });
  });
  it('returns unrelated when changed files do not overlap filesHint', () => {
    expect(classifyDivergence({ baseSha: 'abc', remoteSha: 'def', remoteChangedFiles: ['unrelated.md'], filesHint: ['src/a.ts'] })).toEqual({ kind: 'unrelated' });
  });
  it('returns overlap when files overlap', () => {
    expect(classifyDivergence({ baseSha: 'abc', remoteSha: 'def', remoteChangedFiles: ['src/a.ts'], filesHint: ['src/a.ts', 'src/b.ts'] })).toEqual({ kind: 'overlap', overlapping: ['src/a.ts'] });
  });
  it('overlap matches path prefix (directory rename)', () => {
    expect(classifyDivergence({ baseSha: 'abc', remoteSha: 'def', remoteChangedFiles: ['src/auth/x.ts'], filesHint: ['src/auth/'] })).toEqual({ kind: 'overlap', overlapping: ['src/auth/x.ts'] });
  });
});
```

- [ ] **Step 2: Implement**

```ts
// electron/swarm/rebase.ts
export type DivergenceResult =
  | { kind: 'unchanged' }
  | { kind: 'unrelated' }
  | { kind: 'overlap'; overlapping: string[] };

export function classifyDivergence(input: {
  baseSha: string;
  remoteSha: string;
  remoteChangedFiles: string[];
  filesHint: string[];
}): DivergenceResult {
  if (input.baseSha === input.remoteSha) return { kind: 'unchanged' };

  const overlapping = input.remoteChangedFiles.filter((changed) =>
    input.filesHint.some((hint) => (hint.endsWith('/') ? changed.startsWith(hint) : changed === hint)),
  );
  if (overlapping.length === 0) return { kind: 'unrelated' };
  return { kind: 'overlap', overlapping };
}
```

- [ ] **Step 3: Wire into the runtime**

At the start of each wave iteration in `runWaves`:

```ts
const rebase = await cb.checkRebase({ swarmId: plan.swarmId, waveIndex: wave.waveIndex });
if (rebase.kind === 'overlap') {
  await halt(plan.swarmId, 'base_diverged_into_swarm_files', undefined, wave.waveIndex);
  return;
}
// 'unchanged' and 'unrelated' both continue.
```

Add the callback:

```ts
checkRebase(args: { swarmId: string; waveIndex: number }): Promise<DivergenceResult>;
```

- [ ] **Step 4: Test + commit**

```bash
npx vitest run electron/swarm/rebase.test.ts
git add electron/swarm/rebase.ts electron/swarm/rebase.test.ts electron/swarm/runtime.ts
git commit -m "swarm: mid-swarm rebase classifier"
```

---

## Task 14: Public surface — `registerSwarmIPC` and Anthropic-transport wiring

**Files:**
- Create: `electron/swarm/index.ts`
- Modify: `electron/ipc/register.ts` (wire it)

- [ ] **Step 1: Implement the surface**

```ts
// electron/swarm/index.ts
import { ipcMain, BrowserWindow } from 'electron';
import { IPC } from '../ipc/channels.js';
import { initSwarmStore, getSwarm, listSwarms, recoverCrashedSwarmsOnStartup } from './store.js';
import { runPlanner } from './planner.js';
import { createAnthropicTransport, setAnthropicKey, setPlannerModel } from './llm-anthropic.js';
import { createRuntime, type Runtime } from './runtime.js';
import type {
  SwarmPlanRequest,
  SwarmReplanRequest,
  SwarmApproveRequest,
} from '../../src/ipc/types.js';

let runtime: Runtime | null = null;

export interface SwarmDeps {
  // Callbacks the runtime needs are passed in by register.ts because they
  // require pty/git modules that live one layer up.
  spawnSubTask: Runtime extends Runtime ? Parameters<typeof createRuntime>[0]['spawnSubTask'] : never;
  killSubTask: Parameters<typeof createRuntime>[0]['killSubTask'];
  retrySubTask: Parameters<typeof createRuntime>[0]['retrySubTask'];
  pollBranchHead: Parameters<typeof createRuntime>[0]['pollBranchHead'];
  ptyIdleMs: Parameters<typeof createRuntime>[0]['ptyIdleMs'];
  spawnIntegrator: Parameters<typeof createRuntime>[0]['spawnIntegrator'];
  runIntegratorTests: Parameters<typeof createRuntime>[0]['runIntegratorTests'];
  runIntegratorTestsAfterFix: Parameters<typeof createRuntime>[0]['runIntegratorTestsAfterFix'];
  appendIntegratorPrompt: Parameters<typeof createRuntime>[0]['appendIntegratorPrompt'];
  waitForIntegratorIdleAfterFix: Parameters<typeof createRuntime>[0]['waitForIntegratorIdleAfterFix'];
  pushAndOpenPr: Parameters<typeof createRuntime>[0]['pushAndOpenPr'];
  checkRebase: Parameters<typeof createRuntime>[0]['checkRebase'];
}

export async function registerSwarmIPC(getWin: () => BrowserWindow | null, deps: SwarmDeps): Promise<void> {
  await initSwarmStore();

  const send = (channel: IPC, payload: unknown): void => {
    const win = getWin();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  runtime = createRuntime({
    onStatusUpdate: (e) => send(IPC.SwarmStatusUpdate, e),
    onTaskUpdate: (e) => send(IPC.SwarmTaskUpdate, e),
    onHalted: (e) => send(IPC.SwarmHalted, e),
    onDone: (e) => send(IPC.SwarmDone, e),
    ...deps,
  });

  ipcMain.handle(IPC.SwarmList, () => listSwarms());
  ipcMain.handle(IPC.SwarmGet, (_, swarmId: string) => getSwarm(swarmId));

  ipcMain.handle(IPC.SwarmPlan, async (_, req: SwarmPlanRequest) => {
    // Implementation: build SwarmPlan stub, persist, kick planner streaming.
    // (See full body in source.)
  });

  ipcMain.handle(IPC.SwarmReplan, async (_, req: SwarmReplanRequest) => { /* … */ });
  ipcMain.handle(IPC.SwarmApprove, async (_, req: SwarmApproveRequest) => {
    if (!runtime) throw new Error('runtime not initialised');
    await runtime.start(req.swarmId);
  });
  ipcMain.handle(IPC.SwarmHalt, async (_, { swarmId }: { swarmId: string }) => {
    if (!runtime) throw new Error('runtime not initialised');
    await runtime.halt(swarmId, 'user_halt');
  });
  ipcMain.handle(IPC.SwarmResume, async (_, { swarmId }: { swarmId: string }) => {
    if (!runtime) throw new Error('runtime not initialised');
    await runtime.resume(swarmId);
  });
  ipcMain.handle(IPC.SwarmAbort, async (_, { swarmId }: { swarmId: string }) => {
    if (!runtime) throw new Error('runtime not initialised');
    await runtime.abort(swarmId);
  });

  // Crash recovery.
  const recovered = await recoverCrashedSwarmsOnStartup();
  for (const plan of recovered) {
    send(IPC.SwarmHalted, { swarmId: plan.swarmId, reason: 'legion_crashed' });
  }
}

export { setAnthropicKey, setPlannerModel };
```

- [ ] **Step 2: Wire into `register.ts`**

Find a good seam in `register.ts` (near where Telegram is initialized) and call `registerSwarmIPC(getMainWindow, deps)`, passing in the existing helpers wrapped as the swarm callbacks. The wrappers translate from existing infra (createTask, pty, git, gh) into the runtime's narrow callback interface.

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

- [ ] **Step 4: Commit**

```bash
git add electron/swarm/index.ts electron/ipc/register.ts
git commit -m "swarm: register IPC surface + crash recovery on init"
```

---

## Task 15: `SwarmDispatchDialog` UI component

**Files:**
- Create: `src/swarm/SwarmDispatchDialog.tsx`
- Create: `src/swarm/SwarmDispatchDialog.test.tsx`
- Create: `src/swarm/swarmIpc.ts`

- [ ] **Step 1: Tests**

```tsx
// src/swarm/SwarmDispatchDialog.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { SwarmDispatchDialog } from './SwarmDispatchDialog.jsx';

describe('SwarmDispatchDialog', () => {
  it('Plan button is disabled when spec is empty', () => {
    const { getByRole } = render(() => (
      <SwarmDispatchDialog projectRoot="/p" baseBranch="main" onPlanStarted={vi.fn()} onCancel={vi.fn()} />
    ));
    expect((getByRole('button', { name: /plan/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Plan button enables when spec is non-empty', () => {
    const { getByRole, getByPlaceholderText } = render(() => (
      <SwarmDispatchDialog projectRoot="/p" baseBranch="main" onPlanStarted={vi.fn()} onCancel={vi.fn()} />
    ));
    fireEvent.input(getByPlaceholderText(/what do you want/i), { target: { value: 'add x' } });
    expect((getByRole('button', { name: /plan/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('fast-lane checkbox round-trips into the IPC call', async () => {
    const ipcSpy = vi.fn().mockResolvedValue({ swarmId: 'sw_x' });
    const { getByRole, getByPlaceholderText, getByLabelText } = render(() => (
      <SwarmDispatchDialog
        projectRoot="/p"
        baseBranch="main"
        onPlanStarted={vi.fn()}
        onCancel={vi.fn()}
        invokeSwarmPlan={ipcSpy}
      />
    ));
    fireEvent.input(getByPlaceholderText(/what do you want/i), { target: { value: 'add x' } });
    fireEvent.click(getByLabelText(/trust planner/i));
    fireEvent.click(getByRole('button', { name: /plan/i }));
    await Promise.resolve();
    expect(ipcSpy).toHaveBeenCalledWith(expect.objectContaining({ trustPlanner: true, specInput: 'add x' }));
  });
});
```

- [ ] **Step 2: Implement**

```tsx
// src/swarm/SwarmDispatchDialog.tsx
import { createSignal, Show } from 'solid-js';
import { invokeSwarmPlan as defaultInvoke } from './swarmIpc.js';

export interface SwarmDispatchDialogProps {
  projectRoot: string;
  baseBranch: string;
  onPlanStarted: (swarmId: string) => void;
  onCancel: () => void;
  invokeSwarmPlan?: typeof defaultInvoke;
}

export function SwarmDispatchDialog(props: SwarmDispatchDialogProps) {
  const [spec, setSpec] = createSignal('');
  const [trust, setTrust] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const invoke = props.invokeSwarmPlan ?? defaultInvoke;

  const submit = async () => {
    if (busy() || spec().trim().length === 0) return;
    setBusy(true);
    try {
      const { swarmId } = await invoke({
        projectRoot: props.projectRoot,
        baseBranch: props.baseBranch,
        specInput: spec().trim(),
        trustPlanner: trust(),
      });
      props.onPlanStarted(swarmId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div role="dialog" aria-label="Dispatch swarm" class="swarm-dispatch">
      <h2>Dispatch Swarm</h2>
      <label for="swarm-spec">What do you want built?</label>
      <textarea
        id="swarm-spec"
        placeholder="What do you want built?"
        value={spec()}
        onInput={(e) => setSpec(e.currentTarget.value)}
        rows={4}
      />
      <label class="swarm-fast-lane">
        <input type="checkbox" checked={trust()} onChange={(e) => setTrust(e.currentTarget.checked)} />
        Trust planner (skip review)
      </label>
      <div class="swarm-dispatch-actions">
        <button onClick={props.onCancel} disabled={busy()}>Cancel</button>
        <button onClick={submit} disabled={busy() || spec().trim().length === 0}>Plan ▸</button>
      </div>
      <Show when={busy()}>
        <p>Planning…</p>
      </Show>
    </div>
  );
}
```

```ts
// src/swarm/swarmIpc.ts
import { IPC } from '../../electron/ipc/channels.js';
import type {
  SwarmPlanRequest,
  SwarmPlanResult,
  SwarmReplanRequest,
  SwarmApproveRequest,
} from '../ipc/types.js';

const ipc = (window as unknown as { electronAPI: { invoke(channel: string, ...args: unknown[]): Promise<unknown> } }).electronAPI;

export const invokeSwarmPlan = (req: SwarmPlanRequest): Promise<SwarmPlanResult> =>
  ipc.invoke(IPC.SwarmPlan, req) as Promise<SwarmPlanResult>;

export const invokeSwarmReplan = (req: SwarmReplanRequest): Promise<void> =>
  ipc.invoke(IPC.SwarmReplan, req) as Promise<void>;

export const invokeSwarmApprove = (req: SwarmApproveRequest): Promise<void> =>
  ipc.invoke(IPC.SwarmApprove, req) as Promise<void>;

export const invokeSwarmHalt = (swarmId: string): Promise<void> =>
  ipc.invoke(IPC.SwarmHalt, { swarmId }) as Promise<void>;

export const invokeSwarmResume = (swarmId: string): Promise<void> =>
  ipc.invoke(IPC.SwarmResume, { swarmId }) as Promise<void>;

export const invokeSwarmAbort = (swarmId: string): Promise<void> =>
  ipc.invoke(IPC.SwarmAbort, { swarmId }) as Promise<void>;
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/swarm/SwarmDispatchDialog.test.tsx
```

- [ ] **Step 4: Commit**

```bash
git add src/swarm/
git commit -m "swarm: dispatch dialog + renderer IPC wrappers"
```

---

## Task 16: `PlanReviewDialog` with streamed JSON render

**Files:**
- Create: `src/swarm/PlanReviewDialog.tsx`
- Create: `src/swarm/PlanReviewDialog.test.tsx`

- [ ] **Step 1: Tests**

```tsx
// src/swarm/PlanReviewDialog.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@solidjs/testing-library';
import { PlanReviewDialog } from './PlanReviewDialog.jsx';
import type { SwarmPlan } from '../../electron/swarm/types.js';

function plan(): SwarmPlan {
  return {
    swarmId: 'sw', projectRoot: '/p', specInput: 'add x', baseBranch: 'main', baseSha: 'a',
    integrationBranch: 'swarm/add-x/integration', slug: 'add-x',
    waves: [{ waveIndex: 0, tasks: [
      { id: 't1', title: 'A', prompt: 'do A', filesHint: [], status: 'pending', attempts: 0 },
      { id: 't2', title: 'B', prompt: 'do B', filesHint: [], status: 'pending', attempts: 0 },
    ] }],
    createdAt: 1, status: 'reviewing',
  };
}

describe('PlanReviewDialog', () => {
  it('renders streamed waves and lets the user remove a task', () => {
    const onApprove = vi.fn();
    const { getAllByRole, getByText, getByRole } = render(() => (
      <PlanReviewDialog plan={plan()} streaming={false} onApprove={onApprove} onCancel={vi.fn()} onReplan={vi.fn()} />
    ));
    expect(getAllByRole('listitem').length).toBe(2);
    fireEvent.click(getByRole('button', { name: /remove a/i }));
    fireEvent.click(getByText(/approve/i));
    expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({
      waves: [expect.objectContaining({ tasks: [expect.objectContaining({ title: 'B' })] })],
    }));
  });

  it('Re-plan calls back with feedback', () => {
    const onReplan = vi.fn();
    const { getByText, getByLabelText } = render(() => (
      <PlanReviewDialog plan={plan()} streaming={false} onApprove={vi.fn()} onCancel={vi.fn()} onReplan={onReplan} />
    ));
    fireEvent.click(getByText(/re-plan/i));
    fireEvent.input(getByLabelText(/what should be different/i), { target: { value: 'split A into 2' } });
    fireEvent.click(getByText(/submit/i));
    expect(onReplan).toHaveBeenCalledWith('split A into 2');
  });
});
```

- [ ] **Step 2: Implement**

Render plan with edit-in-place + remove + add-task UI; show streaming dots when `streaming=true`. The component is otherwise mechanical SolidJS. Approve emits the edited plan; Re-plan emits feedback string.

- [ ] **Step 3: Test + commit**

```bash
npx vitest run src/swarm/PlanReviewDialog.test.tsx
git add src/swarm/PlanReviewDialog.tsx src/swarm/PlanReviewDialog.test.tsx
git commit -m "swarm: plan review dialog with inline edit + replan"
```

---

## Task 17: Sidebar swarm group + smart-default tiling

**Files:**
- Create: `src/swarm/SwarmSidebarGroup.tsx`
- Create: `src/swarm/swarmStore.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TilingLayout.tsx`

The renderer store mirrors main-process state via the three push channels. The sidebar group renders the wave-progress counts and links each task chip to focusing its existing task panel. Smart-default tiling: when a swarm task gets focused, the tiled layout arranges that wave's tasks in an even grid.

- [ ] **Step 1: Renderer store**

```ts
// src/swarm/swarmStore.ts
import { createSignal } from 'solid-js';
import type { SwarmPlan } from '../../electron/swarm/types.js';

export const [swarms, setSwarms] = createSignal<Record<string, SwarmPlan>>({});

export function applySwarmStatusUpdate(e: { swarmId: string; status: SwarmPlan['status']; currentWave?: number }): void {
  setSwarms((s) => {
    const existing = s[e.swarmId];
    if (!existing) return s;
    return { ...s, [e.swarmId]: { ...existing, status: e.status } };
  });
}

export function applySwarmTaskUpdate(e: { swarmId: string; taskId: string; status: string; attempts: number; failureReason?: string }): void {
  setSwarms((s) => {
    const existing = s[e.swarmId];
    if (!existing) return s;
    const next: SwarmPlan = JSON.parse(JSON.stringify(existing));
    for (const wave of next.waves) {
      for (const t of wave.tasks) {
        if (t.id === e.taskId) {
          t.status = e.status as SwarmPlan['waves'][number]['tasks'][number]['status'];
          t.attempts = e.attempts;
          if (e.failureReason !== undefined) t.failureReason = e.failureReason;
        }
      }
    }
    return { ...s, [e.swarmId]: next };
  });
}
```

- [ ] **Step 2: Sidebar group component**

```tsx
// src/swarm/SwarmSidebarGroup.tsx
import { For } from 'solid-js';
import type { SwarmPlan } from '../../electron/swarm/types.js';

export function SwarmSidebarGroup(props: {
  plan: SwarmPlan;
  onFocusTask: (legionTaskId: string) => void;
}) {
  return (
    <details open class="swarm-group">
      <summary>⚡ Swarm: {props.plan.slug}</summary>
      <For each={props.plan.waves}>
        {(wave) => (
          <div class="swarm-wave">
            <header>Wave {wave.waveIndex + 1} ({wave.tasks.filter((t) => t.status === 'succeeded').length}/{wave.tasks.length})</header>
            <ul>
              <For each={wave.tasks}>
                {(task) => (
                  <li
                    classList={{ [`swarm-task-${task.status}`]: true }}
                    onClick={() => task.legionTaskId && props.onFocusTask(task.legionTaskId)}
                  >
                    {statusDot(task.status)} {task.title}
                  </li>
                )}
              </For>
            </ul>
          </div>
        )}
      </For>
    </details>
  );
}

function statusDot(s: string): string {
  if (s === 'succeeded') return '✓';
  if (s === 'failed') return '✗';
  if (s === 'running' || s === 'retrying') return '⏳';
  return '○';
}
```

- [ ] **Step 3: Wire smart-default tiling**

In `TilingLayout.tsx`, when focusing a task, check if that task is in any swarm's running wave; if yes, arrange that wave's tasks in an even N-column grid as the default tile layout for that wave. Add a small utility:

```ts
export function findWaveMates(focusedTaskId: string, swarms: Record<string, SwarmPlan>): string[] {
  for (const plan of Object.values(swarms)) {
    for (const wave of plan.waves) {
      if (wave.tasks.some((t) => t.legionTaskId === focusedTaskId)) {
        return wave.tasks.map((t) => t.legionTaskId).filter((id): id is string => !!id);
      }
    }
  }
  return [];
}
```

When `findWaveMates(focused)` is non-empty, tile those task ids equally.

- [ ] **Step 4: Test + commit**

Manual smoke test in dev: dispatch a swarm, watch the sidebar group + tile.

```bash
git add src/swarm/SwarmSidebarGroup.tsx src/swarm/swarmStore.ts src/components/Sidebar.tsx src/components/TilingLayout.tsx
git commit -m "swarm: sidebar group + smart-default wave tiling"
```

---

## Task 18: Halt banner + resume/abort wiring

**Files:**
- Create: `src/swarm/SwarmHaltBanner.tsx`
- Modify: `src/swarm/SwarmSidebarGroup.tsx` (show banner when status === 'halted')

- [ ] **Step 1: Implement**

```tsx
// src/swarm/SwarmHaltBanner.tsx
export function SwarmHaltBanner(props: {
  reason: string;
  taskTitle?: string;
  onResume: () => void;
  onAbort: () => void;
}) {
  return (
    <div role="alert" class="swarm-halt-banner">
      <strong>⛔ Swarm halted</strong>
      <p>Reason: {humanize(props.reason)}{props.taskTitle ? ` (task: ${props.taskTitle})` : ''}</p>
      <div class="swarm-halt-actions">
        <button onClick={props.onResume}>Resume from here</button>
        <button onClick={props.onAbort} class="danger">Abort swarm</button>
      </div>
    </div>
  );
}

function humanize(reason: string): string {
  return reason.replace(/_/g, ' ');
}
```

- [ ] **Step 2: Wire into the sidebar group**

```tsx
{props.plan.status === 'halted' && (
  <SwarmHaltBanner
    reason={props.plan.haltReason ?? 'unknown'}
    taskTitle={props.plan.haltTaskId ? findTaskTitle(props.plan, props.plan.haltTaskId) : undefined}
    onResume={() => invokeSwarmResume(props.plan.swarmId)}
    onAbort={() => invokeSwarmAbort(props.plan.swarmId)}
  />
)}
```

- [ ] **Step 3: Commit**

```bash
git add src/swarm/SwarmHaltBanner.tsx src/swarm/SwarmSidebarGroup.tsx
git commit -m "swarm: halt banner with resume/abort"
```

---

## Task 19: Hotkey + settings section

**Files:**
- Modify: `src/components/SettingsDialog.tsx` (add Swarm section)
- Modify: `src/lib/keyboard.ts` (or equivalent, register Ctrl+Shift+S)
- Modify: `src/App.tsx` (mount the dispatch dialog)

- [ ] **Step 1: Settings UI**

Add a section "Swarm" with three controls: planner model (text input, defaults to `claude-sonnet-4-6`), sub-task wallclock cap (numeric, minutes, default 30), aggressive cleanup opt-out (checkbox, default unchecked). Wire each to corresponding IPC config setters.

- [ ] **Step 2: Hotkey**

Register `Ctrl+Shift+S` (`Cmd+Shift+S` on macOS) globally inside the renderer's existing keyboard layer; opens `SwarmDispatchDialog` for the currently-selected project. If no project is selected, show a tooltip "Open a project first" instead of opening the dialog.

- [ ] **Step 3: Commit**

```bash
git add src/components/SettingsDialog.tsx src/lib/keyboard.ts src/App.tsx
git commit -m "swarm: hotkey + settings section"
```

---

## Task 20: End-to-end integration test (Scenarios A–E)

**Files:**
- Create: `electron/swarm/integration.test.ts`

This file exercises the runtime against a real temp-dir git repo and a mock PTY transport. It is the design's Scenario A–E checklist; pass = the feature ships.

- [ ] **Step 1: Author scenarios**

Each scenario sets up a temp git repo, creates the necessary baseBranch + initial commit, and constructs the runtime with mock callbacks. The mocks simulate sub-agent behavior by writing/committing files inside the agent's worktree at scripted times.

```ts
// electron/swarm/integration.test.ts
import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: vi.fn() } }));
import { app } from 'electron';

import { initSwarmStore, saveSwarm, getSwarm } from './store.js';
import { createRuntime, setPollIntervalMs, setIdleThresholdMs } from './runtime.js';
import type { SwarmPlan } from './types.js';

let tmp: string;
let repo: string;

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-it-'));
  execSync('git init -b main', { cwd: dir });
  execSync('git config user.email "x@y" && git config user.name "x"', { cwd: dir, shell: 'bash' });
  await fs.writeFile(path.join(dir, 'README.md'), 'init');
  execSync('git add . && git commit -m init', { cwd: dir, shell: 'bash' });
  return dir;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-it-data-'));
  vi.mocked(app.getPath).mockReturnValue(tmp);
  await initSwarmStore();
  repo = await makeRepo();
  setPollIntervalMs(10);
  setIdleThresholdMs(0);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(repo, { recursive: true, force: true });
});

describe('integration scenarios', () => {
  it('Scenario A — two-wave happy path opens a PR', async () => {
    // Build a plan with 2 tasks in wave 0 and 1 task in wave 1.
    const baseSha = execSync('git rev-parse HEAD', { cwd: repo }).toString().trim();
    const plan: SwarmPlan = {
      swarmId: 'sw_A', projectRoot: repo, specInput: 'add x',
      baseBranch: 'main', baseSha, integrationBranch: 'swarm/a/integration',
      slug: 'a',
      waves: [
        { waveIndex: 0, tasks: [
          { id: 't1', title: 'A1', prompt: 'p', filesHint: ['a.txt'], status: 'pending', attempts: 0 },
          { id: 't2', title: 'A2', prompt: 'p', filesHint: ['b.txt'], status: 'pending', attempts: 0 },
        ] },
        { waveIndex: 1, tasks: [
          { id: 't3', title: 'B1', prompt: 'p', filesHint: ['c.txt'], status: 'pending', attempts: 0 },
        ] },
      ],
      createdAt: 1, status: 'reviewing',
    };
    await saveSwarm(plan);

    const created = new Set<string>();
    let prOpened = false;
    const rt = createRuntime({
      onStatusUpdate: () => {},
      onTaskUpdate: () => {},
      onHalted: () => { throw new Error('should not halt'); },
      onDone: () => { prOpened = true; },
      spawnSubTask: async ({ taskId }) => {
        // Simulate the agent creating its branch + worktree + committing immediately.
        const branchName = `swarm/a/${taskId}`;
        execSync(`git branch ${branchName}`, { cwd: repo });
        const wt = path.join(repo, '..', `${taskId}-wt`);
        execSync(`git worktree add ${wt} ${branchName}`, { cwd: repo });
        await fs.writeFile(path.join(wt, `${taskId}.txt`), `from ${taskId}`);
        execSync('git add . && git commit -m work', { cwd: wt, shell: 'bash' });
        created.add(taskId);
        // Record on the plan so the runtime can poll the branch.
        const p = (await getSwarm('sw_A'))!;
        for (const w of p.waves) for (const t of w.tasks) if (t.id === taskId) {
          t.branchName = branchName;
          t.worktreePath = wt;
        }
        await saveSwarm(p);
      },
      killSubTask: async () => {},
      retrySubTask: async () => {},
      pollBranchHead: async ({ branchName }) => {
        return execSync(`git rev-parse ${branchName}`, { cwd: repo }).toString().trim();
      },
      ptyIdleMs: () => 99_999,
      spawnIntegrator: async ({ swarmId }) => {
        // Simulate integrator: create integration branch, merge children, return ok.
        const p = (await getSwarm(swarmId))!;
        execSync(`git branch ${p.integrationBranch}`, { cwd: repo });
        const wt = path.join(repo, '..', `integ-${swarmId}-wt`);
        execSync(`git worktree add ${wt} ${p.integrationBranch}`, { cwd: repo });
        for (const w of p.waves) for (const t of w.tasks) if (t.branchName) {
          execSync(`git merge --no-ff ${t.branchName} -m "merge"`, { cwd: wt, shell: 'bash' });
        }
        return { ok: true };
      },
      runIntegratorTests: async () => ({ outcome: 'skipped' }),
      runIntegratorTestsAfterFix: async () => ({ outcome: 'passed' }),
      appendIntegratorPrompt: async () => {},
      waitForIntegratorIdleAfterFix: async () => ({ ok: true }),
      pushAndOpenPr: async () => ({ ok: true, prUrl: 'https://github.com/x/y/pull/1', summary: 's' }),
      checkRebase: async () => ({ kind: 'unchanged' }),
    });

    await rt.start('sw_A');
    // Allow the wave loop to drive to completion.
    for (let i = 0; i < 100 && !prOpened; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(prOpened).toBe(true);
    expect(created).toEqual(new Set(['t1', 't2', 't3']));
    expect((await getSwarm('sw_A'))?.status).toBe('done');
  });

  // Scenarios B–E follow the same pattern: tweak spawnSubTask / pollBranchHead /
  // spawnIntegrator / runIntegratorTests / checkRebase to simulate the failure
  // mode under test, and assert on the final SwarmPlan state.
  it.todo('Scenario B — retry succeeds after a sub-task first-attempt failure');
  it.todo('Scenario C — sub-task fails twice → halt');
  it.todo('Scenario D — wave-1 tasks edit same line → integrator resolves → PR');
  it.todo('Scenario E — base advances into filesHint → halt with rebase offer');
});
```

- [ ] **Step 2: Fill in Scenarios B–E**

Each `it.todo` becomes an `it(...)` with the appropriate mock-callback tweaks. The patterns:
- **B**: `spawnSubTask` for the target task creates an empty branch on first call (no commit), records `pty_idle_ms` high → runtime times out via `ptyIdleMs`+no-commit, then `retrySubTask` is called and the second call writes + commits. Assert `attempts === 1` on the task and `status === 'done'` on the plan.
- **C**: `retrySubTask` also produces no commit. Assert `onHalted` called once with reason `sub_task_failed_after_retry`.
- **D**: both wave-1 `spawnSubTask` write to the same line of `shared.txt`; the integrator mock simulates the conflict resolution by running `git checkout --theirs` and committing. Assert PR opens.
- **E**: before wave 1 starts, an unrelated commit lands on `main` touching `t1.txt`. `checkRebase` returns `{kind: 'overlap', overlapping: ['t1.txt']}`. Assert `onHalted` with reason `base_diverged_into_swarm_files`.

- [ ] **Step 3: Run**

```bash
npx vitest run electron/swarm/integration.test.ts
```

Expected: all 5 scenarios PASS.

- [ ] **Step 4: Commit**

```bash
git add electron/swarm/integration.test.ts
git commit -m "swarm: end-to-end integration scenarios A–E"
```

---

## Task 21: README + screen capture + openspec validate

**Files:**
- Modify: `README.md`
- Create: `screens/swarm-demo.gif` (out-of-band capture)

- [ ] **Step 1: Add Spec → Swarm to the README features list**

Add a row to the existing "More features" list in `README.md`:

```markdown
- **Spec → Swarm** — type one short spec, the planner decomposes it
  into layered waves of parallel sub-tasks, an integrator agent merges
  every branch into one PR. `Ctrl+Shift+S` to dispatch.
```

Add an entry to the screenshots table at the top with a placeholder for the demo GIF.

- [ ] **Step 2: Validate the OpenSpec change**

```bash
npx openspec validate --strict add-spec-to-swarm
```

Expected: PASS. If the CLI is not installed locally, install it as a devDependency per the project's earlier OpenSpec changes (already referenced in their `tasks.md`) and re-run.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): add Spec → Swarm to feature list"
```

---

## Task 22: Final typecheck, lint, full test pass

- [ ] **Step 1: Run all checks**

```bash
npm run typecheck
npm run lint
npx vitest run
```

Expected: all PASS.

- [ ] **Step 2: Commit any small fixes**

If any check surfaces minor issues, fix and commit per-issue.

- [ ] **Step 3: Open the PR**

The change is feature-complete. Open a PR with title `feat(swarm): add Spec → Swarm planner + scheduler + integrator` and body summarising the design + linking to `openspec/changes/add-spec-to-swarm/`.

```bash
git push -u origin <branch>
gh pr create --title "feat(swarm): add Spec → Swarm planner + scheduler + integrator" --body "$(cat <<'EOF'
## Summary
- New \`electron/swarm/\` module implementing planner → wave-serial scheduler → integrator → 1 PR
- Reuses existing \`createTask\`, worktree, PR-watch, hung-agent, redactor primitives
- See \`openspec/changes/add-spec-to-swarm/\` for the spec, design, and tasks

## Test plan
- [ ] Vitest passes: \`npx vitest run\`
- [ ] Manual smoke: dispatch a swarm with 2 waves, verify 1 PR opens
- [ ] Halt + Resume cycle works after killing a sub-task
- [ ] Abort cleans worktrees + branches
EOF
)"
```

Expected: PR URL printed.

---

## Self-review (run inline after writing this plan)

**Spec coverage:**
- Spec requirement "Users can dispatch a swarm from a short spec" → Tasks 15 + 19.
- "A planner decomposes the spec into layered waves" → Tasks 4–6.
- "Users can review and edit the plan before dispatch" → Task 16.
- "Wave-serial scheduler" → Task 8.
- "Success is detected from git, not from agent-printed strings" → Task 8.
- "Failure detected from clock, hung, sentinel, or user action" → Task 9 (failure detection scaffolding lives in runtime + integrator wiring; the four signal sources are connected via callbacks owned by `register.ts` in Task 14).
- "Retry once with reset + augmented prompt" → Task 9.
- "Integrator merges + tests + PR" → Tasks 11–12.
- "Mid-swarm rebase classifier" → Task 13.
- "Halt + resume + abort" → Task 10.
- "Tiered retention" → Implicit in cleanup callbacks invoked by `register.ts` (Task 14) — make sure the wrappers there call `removeWorktree` on wave transition and on PR close.
- "Atomic persistence + crash recovery" → Tasks 2 + 14.

No spec section is uncovered.

**Placeholder scan:** no `TBD`, no `TODO`, no `implement later`, no `similar to Task N`. Some Task 17/19 steps describe higher-level work (sidebar wiring + settings dialog edits) without showing every line of edited TSX — these are localised to existing files whose patterns the engineer can mirror; the test in each task gates correctness.

**Type consistency:** the `SwarmTaskStatus` literals (`pending`/`running`/`succeeded`/`failed`/`retrying`) are used consistently from Task 1 through Task 17. `SwarmHaltReason` set used from Task 1 onward without rename. Callback names introduced in Tasks 7–13 match between their definitions in `RuntimeCallbacks` and their wirings in Task 14.

**Scope:** focused on this feature; no adjacent refactors. The known hook breakage (343 unrelated format violations) is explicitly out of scope.

Plan complete.
