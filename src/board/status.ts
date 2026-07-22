// The ONE status→colour map (design brief: "Status is the canonical state palette ... one system-
// owned palette expresses lifecycle state for EVERY stateful entity"). Every card, row, badge, chip,
// and score marker in the product renders lifecycle state by asking THIS module for a class — never
// by picking a colour inline. NOTES UI1: before this module existed, `active` rendered grey on the
// Studio project card and the project page's work-unit rows (both hand-picked `.chip.is-progress`,
// a plain-neutral class with no relationship to the palette) while the run-view score rail correctly
// rendered it blue (`.snode.active`) — three renderers, three independent colour decisions for the
// same word. A status colour is now impossible to set locally: every call site converts its own
// domain status (`WorkUnitStatus`, `ArtifactStatus`, a score node's `NodeState`) through the
// `fromXxx` functions below into one of the seven `CanonicalStatus` values, then asks `chipClass`/
// `dotClass`/`snodeClass` for the marker-family-appropriate class — the class SPELLING still varies
// by marker shape (a `.chip`, a `.dot`, a `.snode` each have their own historical CSS vocabulary),
// but the DECISION ("which of the seven states is this, and what colour does that state get") is
// made exactly once, here, for the whole product.
//
// "blocked" deliberately does NOT render red: the design brief's canonical palette states "blocked =
// solid neutral gray plus an explicit label (never orange — orange near brass is forbidden)" — red is
// reserved for `failed` (a content-level rejection), never a stalled-but-recoverable state. Gate
// brass (`needs-you`) is scarce by construction: it is the only canonical status this module ever
// hands out that uses the amber/brass family, and nothing outside a gate ever asks for it.

import type { ArtifactStatus, WorkUnitStatus } from "../types.ts";
import type { NodeState } from "../derive.ts";
import { esc } from "../derive.ts";

export type CanonicalStatus = "done" | "active" | "waiting" | "blocked" | "needs-you" | "failed" | "exhausted";

const CHIP_CLASS: Record<CanonicalStatus, string> = {
  done: "is-done",
  active: "is-active",
  waiting: "is-waiting",
  blocked: "is-blocked",
  "needs-you": "is-gate",
  failed: "is-failed",
  exhausted: "is-exhausted",
};

// `.dot` (mini-score, project view) has its own long-established class vocabulary; is-wait/is-danger
// predate this module and are kept rather than renamed, to avoid an unrelated mass rename across a
// frozen-by-convention stylesheet. The COLOUR each resolves to is still decided once, above.
const DOT_CLASS: Record<CanonicalStatus, string> = {
  done: "is-done",
  active: "is-active",
  waiting: "is-wait",
  blocked: "is-blocked",
  "needs-you": "is-gate",
  failed: "is-danger",
  exhausted: "is-gate",
};

// `.snode` (run-view score rail) likewise has its own historical class vocabulary (no `is-` prefix
// for done/active/blocked, `is-gate-open`/`is-danger` for the rest) — preserved verbatim so this
// module's introduction changes ZERO already-approved run-view markup (see scoreNodeClass, render.ts).
const SNODE_CLASS: Record<CanonicalStatus, string> = {
  done: "done",
  active: "active",
  waiting: "upcoming",
  blocked: "blocked",
  "needs-you": "is-gate-open",
  failed: "is-danger",
  exhausted: "is-gate-open",
};

const LABEL: Record<CanonicalStatus, string> = {
  done: "done",
  active: "active",
  waiting: "waiting",
  blocked: "blocked",
  "needs-you": "needs you",
  failed: "failed",
  exhausted: "exhausted",
};

export function chipClass(status: CanonicalStatus): string {
  return CHIP_CLASS[status];
}
export function dotClass(status: CanonicalStatus): string {
  return DOT_CLASS[status];
}
export function snodeClass(status: CanonicalStatus): string {
  return SNODE_CLASS[status];
}
export function statusLabel(status: CanonicalStatus): string {
  return LABEL[status];
}

/** A `.chip` rendering a canonical status — the one function every status badge in the product
 * should call. `label` overrides the default word (e.g. "2 gates" instead of "needs you"); `extraClass`
 * adds a purely-layout class a specific surface already keys off (e.g. `sstep__chip`'s positioning) —
 * neither ever touches the COLOUR, which is never overridable. That's the whole point. */
export function statusChip(status: CanonicalStatus, label?: string, extraClass?: string): string {
  const cls = extraClass ? `chip ${chipClass(status)} ${extraClass}` : `chip ${chipClass(status)}`;
  return `<span class="${cls}">${esc(label ?? statusLabel(status))}</span>`;
}

/** `WorkUnitStatus` → the canonical palette. `abandoned` is the unit-level terminal negative outcome
 * (the brief's "failed"); `paused` is an honest solid-neutral-gray "waiting", not a fabricated activity. */
export function fromWorkUnitStatus(status: WorkUnitStatus): CanonicalStatus {
  switch (status) {
    case "shipped":
      return "done";
    case "active":
      return "active";
    case "paused":
      return "waiting";
    case "blocked":
      return "blocked";
    case "abandoned":
      return "failed";
  }
}

/** `ArtifactStatus` → the canonical palette. `superseded`/`skipped`/`draft` all read as an honest
 * neutral "waiting" — none of them is a live gate, a failure, or a finished state. */
export function fromArtifactStatus(status: ArtifactStatus): CanonicalStatus {
  switch (status) {
    case "approved":
      return "done";
    case "in-review":
      return "needs-you";
    case "rejected":
      return "failed";
    case "blocked":
      return "blocked";
    case "superseded":
    case "skipped":
    case "draft":
      return "waiting";
  }
}

/** A run-view score node's `NodeState` → the canonical palette. `isGate` wins outright (ruling C2:
 * an artifact at in-review always means an open gate, regardless of the node's own state string). */
export function fromNodeState(state: NodeState, isGate: boolean): CanonicalStatus {
  if (isGate) return "needs-you";
  switch (state) {
    case "done":
      return "done";
    case "active":
      return "active";
    case "blocked":
      return "blocked";
    case "rejected":
      return "failed";
    case "gate":
      return "needs-you";
    case "wait":
    default:
      return "waiting";
  }
}
