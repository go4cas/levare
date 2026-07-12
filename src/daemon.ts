// Phase 8: the daemon (PRD §6's Runner, made continuous). `levare serve` boots one of these
// alongside the board (deliverable a) — it watches `work/`, and on every relevant change re-derives
// the repo from disk (invariant 2) and walks every active unit one flow-step forward via
// dagwalk.ts#advanceUnit, which halts at every gate (an artifact landing at in-review) and never
// resolves one (invariant 1). It does not replace the phase-2 Runner engine or reimplement flow
// walking — dagwalk.ts is the one shared "what's next" derivation, driven here continuously instead
// of once, against a script, the way replay.ts drives it.
//
// Concurrency safety (deliverable e — the mechanism the goal asked to be explicit, simple, and
// tested): a single-threaded work queue. `tickRunning`/`tickQueued` guarantee at most one tick's
// worth of unit-walking logic ever executes at a time in this process, and every unit within a tick
// is processed strictly one after another (no per-unit concurrency at all) — so a work unit can never
// be advanced by two invocations at once, and because each tick re-derives "does a live artifact of
// this kind already exist?" fresh from disk immediately before producing, and no other tick can run
// concurrently to race that check, a member is never invoked twice for the same producible kind. A
// burst of rapid repo changes while a tick is already running coalesces into exactly one follow-up
// tick, not one per change (tested directly — see tests/daemon.test.ts's concurrency case).

import { watch, readFileSync, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { loadRepo, type Repo } from "./repo.ts";
import { advanceUnit, type AdvanceResult } from "./dagwalk.ts";
import { patchFrontmatter } from "./gates.ts";
import { conductorCommit } from "./git.ts";
import { stubAdapterRunner } from "./replay.ts";
import type { MemberRunner } from "./runner.ts";

export interface DaemonInvocation {
  project: string;
  unit: string;
  member: string;
  kind: string;
  /** ISO timestamp the invocation began. */
  startedAt: string;
}

export interface DaemonTickEntry {
  project: string;
  unit: string;
  outcome: AdvanceResult;
}

export interface DaemonTickResult {
  entries: DaemonTickEntry[];
}

/** Ruling C3 (extended): the three verbs a Conductor may resolve a raised budget gate with. */
export type BudgetVerb = "continue" | "raise" | "stop";

/** A currently-open budget gate: a unit whose ledger crossed its (effective) budget on the last walk
 * and is halted, per-unit, awaiting the Conductor (never global — other units keep advancing). */
export interface BudgetGate {
  project: string;
  unit: string;
  /** The ledger sum that crossed the budget. */
  spent: number;
  /** The effective budget it crossed (the unit's declared budget, or a prior `raise`-lifted one). */
  budget: number;
}

export interface ResolveBudgetResult {
  ok: boolean;
  error?: string;
}

export interface DaemonOptions {
  /** Builds the MemberRunner boundary for a freshly-loaded repo. Defaults to the same mocked-adapter
   * boundary `levare replay`/the board's gate resolution already drive (real context assembly, env
   * scoping, receipts, behind the still-mocked native/CLI boundaries — invariant 10). */
  memberRunner?: (repo: Repo) => MemberRunner;
  /** Debounce window between a repo change and a tick, ms (mirrors board/serve.ts's own 80ms). */
  debounceMs?: number;
  /** Called once per completed tick — test/observability hook, never required for correctness. */
  onTick?: (result: DaemonTickResult) => void;
  /** Injectable clock for deterministic tests (default: real ISO timestamps). */
  now?: () => string;
}

const MAX_LOG = 200;

export class Daemon {
  private readonly root: string;
  private readonly memberRunnerFor: (repo: Repo) => MemberRunner;
  private readonly debounceMs: number;
  private readonly onTick?: (r: DaemonTickResult) => void;
  private readonly now: () => string;

  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private tickRunning = false;
  private tickQueued = false;
  private tickCounter = 0;
  private readonly inFlight: DaemonInvocation[] = [];
  private readonly log: DaemonTickEntry[] = [];

  // Ruling C3 (extended) — per-unit budget-gate resolution memory, keyed by `${project}/${unit}`, held
  // in memory across ticks (the mirror of runner.ts's own `effBudget`/`budgetAck`; the daemon is the
  // one long-lived process, so this is the run). `budgetEff`: a `raise`-lifted effective budget.
  // `budgetAck`: the spend level a `continue`/`raise` acknowledged, below which the gate never
  // re-raises. `openBudgetGates`: the gates currently raised and awaiting the Conductor — a per-unit
  // halt, never global; a second unit in the same project is untouched by any of this.
  private readonly budgetEff = new Map<string, number>();
  private readonly budgetAck = new Map<string, number>();
  private readonly openBudgetGates = new Map<string, BudgetGate>();

  constructor(root: string, opts: DaemonOptions = {}) {
    this.root = root;
    this.memberRunnerFor = opts.memberRunner ?? stubAdapterRunner;
    this.debounceMs = opts.debounceMs ?? 80;
    this.onTick = opts.onTick;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** Start watching `work/` and run one tick immediately (so a daemon started against a repo that
   * already has an unblocked producible kind — e.g. `levare serve` restarted right after an approval
   * made on disk while it was down — doesn't sit idle waiting for the next file change). */
  start(): void {
    if (this.watcher || this.stopped) return;
    const workDir = join(this.root, "work");
    const notify = () => this.scheduleTick();
    try {
      this.watcher = watch(workDir, { recursive: true }, notify);
    } catch {
      try {
        this.watcher = watch(workDir, {}, notify);
      } catch {
        this.watcher = null; // no fs.watch support on this platform/path; manual tick() still works.
      }
    }
    this.scheduleTick();
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
  }

  /** Force a tick right away, bypassing the debounce — used by board/gateops.ts's `start` verb so a
   * Conductor authorizing a unit's flow sees it advance to its first gate in the same request, and by
   * tests that want deterministic, synchronous ticks instead of waiting on fs.watch/debounce timing. */
  notify(): void {
    this.scheduleTick(0);
  }

  private scheduleTick(delayMs = this.debounceMs): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runTick();
    }, delayMs);
  }

  private runTick(): void {
    if (this.tickRunning) {
      this.tickQueued = true;
      return;
    }
    this.tickRunning = true;
    try {
      const result = this.tickOnce();
      this.onTick?.(result);
    } finally {
      this.tickRunning = false;
      if (this.tickQueued && !this.stopped) {
        this.tickQueued = false;
        this.runTick();
      }
    }
  }

  /** Synchronous, single-flight: one full pass over every active unit. Throws if a tick is already in
   * progress (the same single-threaded-queue guarantee the watcher-driven path enforces on itself, so
   * a test forcing a tick can never interleave with one already running). */
  tick(): DaemonTickResult {
    if (this.tickRunning) throw new Error("daemon: a tick is already in progress");
    this.tickRunning = true;
    try {
      return this.tickOnce();
    } finally {
      this.tickRunning = false;
    }
  }

  private tickOnce(): DaemonTickResult {
    this.tickCounter++;
    const entries: DaemonTickEntry[] = [];
    let repo: Repo;
    try {
      repo = loadRepo(this.root);
    } catch (e) {
      // An off-contract repo (e.g. mid-edit) is not a daemon crash — skip this tick; the next repo
      // change (including the edit that fixes it) will trigger another.
      this.pushLog({ project: "", unit: "", outcome: { outcome: "halted", reason: `repo does not validate: ${e instanceof Error ? e.message : String(e)}` } });
      return { entries: [] };
    }
    const memberRunner = this.memberRunnerFor(repo);
    const units = [...repo.units].sort((a, b) => `${a.project}/${a.unit}`.localeCompare(`${b.project}/${b.unit}`));
    for (const unit of units) {
      const before = this.inFlight.length;
      const key = `${unit.project}/${unit.unit}`;
      let outcome: AdvanceResult;
      try {
        outcome = advanceUnit(this.root, repo, unit, memberRunner, {
          budget: { eff: this.budgetEff.get(key), ack: this.budgetAck.get(key) },
          onBeforeProduce: (member, kind) => {
            this.inFlight.push({ project: unit.project, unit: unit.unit, member, kind, startedAt: this.now() });
          },
        });
      } catch (e) {
        // Deliverable (f), belt and suspenders on top of dagwalk.ts's own try/catch around the member
        // call: ANY unexpected throw for one unit (a git failure, a filesystem error, a bug) is a halt
        // for that unit, never a crash of the daemon's watcher callback (which nothing else guards —
        // an uncaught exception there would take down the whole process) and never something that
        // stops the OTHER units in this same tick from being walked.
        outcome = { outcome: "halted", reason: e instanceof Error ? e.message : String(e) };
      } finally {
        this.inFlight.length = before; // only this unit's own pass could have grown it (single-flight).
      }
      // Ruling C3 (extended): track the open budget gate for this unit. A `budget-gate` outcome means
      // the daemon halted the unit AT its budget gate (it produced nothing) — record it so the
      // Conductor can resolve it. Any other outcome means the unit is not sitting at a budget gate
      // right now (a `continue`/`raise` let it advance again, or it was never over budget), so clear
      // any stale open gate. This is strictly per-unit — a different unit's gate is never touched.
      if (outcome.outcome === "budget-gate") {
        this.openBudgetGates.set(key, { project: unit.project, unit: unit.unit, spent: outcome.spent, budget: outcome.budget });
      } else {
        this.openBudgetGates.delete(key);
      }
      const entry: DaemonTickEntry = { project: unit.project, unit: unit.unit, outcome };
      entries.push(entry);
      this.pushLog(entry);
    }
    return { entries };
  }

  private pushLog(entry: DaemonTickEntry): void {
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.shift();
  }

  /** The board's live projection (deliverable c) — an in-flight invocation only ever exists for the
   * synchronous window between resolving what to produce and the write landing on disk. */
  running(): DaemonInvocation[] {
    return [...this.inFlight];
  }

  /** Every produced/blocked/halted/nothing outcome from the daemon's own recent ticks (deliverable f
   * — "never a silent stall": a budget/timebox halt or a member failure is always in here, not just
   * swallowed). Bounded to the most recent entries. */
  recentActivity(): DaemonTickEntry[] {
    return [...this.log];
  }

  ticks(): number {
    return this.tickCounter;
  }

  /** Ruling C3 (extended): every budget gate currently raised and awaiting the Conductor. */
  budgetGates(): BudgetGate[] {
    return [...this.openBudgetGates.values()];
  }

  /** The effective budget in force for a unit right now — its declared budget, or a `raise`-lifted
   * one. Lets the board (and tests) observe that a `raise` actually moved the ceiling for the run. */
  effectiveBudget(project: string, unit: string): number | undefined {
    return this.budgetEff.get(`${project}/${unit}`);
  }

  /**
   * Ruling C3 (extended, PRD v1.1 §5): the Conductor resolves a raised budget gate. Per-unit, never
   * global. `continue` acknowledges the current spend so the gate does not re-raise until spend
   * crosses a NEW threshold beyond it (C3's original memory rule) — the unit resumes walking on the
   * next tick. `raise` additionally lifts the effective budget for the rest of the run. `stop` pauses
   * the unit on disk (status → paused), so the daemon's disk-truth re-derivation skips it thereafter.
   * The daemon holds this resolution memory in-process, exactly as runner.ts holds its own; the only
   * difference is the resolution arrives out-of-band (the board's gate route) rather than from an
   * interactive DecisionSource.
   */
  resolveBudget(project: string, unit: string, verb: BudgetVerb): ResolveBudgetResult {
    const key = `${project}/${unit}`;
    const gate = this.openBudgetGates.get(key);
    if (!gate) return { ok: false, error: `no open budget gate for '${key}'` };

    if (verb === "continue") {
      this.budgetAck.set(key, gate.spent);
    } else if (verb === "raise") {
      // Lift the effective budget to the current spend for the rest of the run AND acknowledge that
      // level, so the gate re-raises only on a further crossing — mirrors runner.ts#overBudget.
      this.budgetEff.set(key, gate.spent);
      this.budgetAck.set(key, gate.spent);
    } else {
      // stop: pause the unit. Persisted to disk (files are the truth, invariant 2) so it survives a
      // daemon restart and the board's disk-derived view agrees.
      this.pauseUnit(project, unit);
    }
    this.openBudgetGates.delete(key);
    // The caller (the board's gate route, like every other verb) nudges the daemon with `notify()` so
    // a `continue`/`raise` visibly advances the unit in the same interaction — kept here as a pure
    // state transition, no self-scheduling, so it is safe to drive synchronously from a test too.
    return { ok: true };
  }

  private pauseUnit(project: string, unit: string): void {
    let repo: Repo;
    try {
      repo = loadRepo(this.root);
    } catch {
      return; // an off-contract repo can't be paused mid-edit; the gate stays cleared, the walk halts anyway.
    }
    const u = repo.units.find((x) => x.project === project && x.unit === unit);
    if (!u) return;
    const file = join(u.dir, "unit.md");
    const patched = patchFrontmatter(readFileSync(file, "utf8"), { status: "paused" });
    writeFileSync(file, patched);
    conductorCommit(this.root, [file], `stop ${unit}: budget gate → paused`);
  }
}
