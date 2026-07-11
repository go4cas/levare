#!/usr/bin/env bun
// Deterministic stub member CLI (phase 1 deliverable; driven by the Runner in phase 2).
//
// A wrapped member — foreign CLI shape — that emits a canned artifact markdown document to stdout
// with zero nondeterminism (no clocks, no randomness, no model call). The Runner's CLI adapter
// validates the emitted frontmatter against the artifact contract at the boundary.
//
//   member-stub.ts <member> <kind> [--unit U] [--project P]
//
// Every (member, kind) pair maps to one fixed artifact. Unknown pairs exit non-zero so a
// misconfigured flow fails loudly rather than emitting garbage.

interface Canned {
  id: string;
  produced_by: string;
  consumes: string[];
  status: string;
  body: string;
  // `null` means the member reports nothing — a wrapped foreign CLI with no token accounting. The
  // phase-3 adapter records this honestly as an `unreported` receipt (§10), never a fabricated $0.
  usage: { model: string; tokens_in: number; tokens_out: number; usd: number; wall_clock_s: number } | null;
}

// Keyed by `${member}:${kind}`. Values are byte-for-byte deterministic.
const CANNED: Record<string, Canned> = {
  "wren:product-brief": {
    id: "product-brief-v1",
    produced_by: "kestrel/wren",
    consumes: [],
    status: "in-review",
    body:
      "# Product brief — checkout-flow\n\n" +
      "**Problem.** The current three-page checkout loses buyers between address and payment.\n" +
      "**Job to be done.** Pay for a full cart in one uninterrupted flow.\n" +
      "**Success signal.** Checkout completion rate up, measured 30 days post-ship.\n",
    usage: { model: "claude-sonnet", tokens_in: 8200, tokens_out: 2100, usd: 0.06, wall_clock_s: 95 },
  },
  "lyra:design": {
    id: "design-checkout-v1",
    produced_by: "kestrel/lyra",
    consumes: ["product-brief-v1"],
    status: "in-review",
    body: "# Design — checkout-flow\n\nSingle-page flow with four collapsible sections and a summary rail.\n",
    usage: { model: "claude-sonnet", tokens_in: 12400, tokens_out: 3800, usd: 0.1, wall_clock_s: 210 },
  },
  "lyra:spec": {
    id: "spec-checkout-flow-v1",
    produced_by: "kestrel/lyra",
    consumes: ["product-brief-v1", "design-checkout-v1"],
    status: "in-review",
    body: "# Spec — checkout-flow\n\nServer-rendered `/checkout`; idempotent payment on an order key.\n",
    usage: { model: "claude-sonnet", tokens_in: 31000, tokens_out: 10000, usd: 0.58, wall_clock_s: 480 },
  },
  "finch:review": {
    id: "review-checkout-flow-v1",
    produced_by: "kestrel/finch",
    consumes: ["spec-checkout-flow-v1"],
    status: "in-review",
    body: "# Review — checkout-flow spec\n\nApproved with one note: name the idempotency key column in the spec.\n",
    // Codex (wrapped foreign CLI) surfaces no usage → the adapter records an `unreported` receipt.
    usage: null,
  },
};

// The (member, kind) pairs this stub can produce, derived from CANNED. The phase-2 Runner reads
// this to resolve a flow step label to the member+kind that satisfies it. Additive: does not change
// any emitted artifact bytes.
export const CAPABILITIES: Array<{ member: string; kind: string }> = Object.keys(CANNED).map((k) => {
  const [member, kind] = k.split(":");
  return { member, kind };
});

function opt(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

export function render(member: string, kind: string, unit: string, project: string): string {
  const c = CANNED[`${member}:${kind}`];
  if (!c) throw new Error(`no canned artifact for member '${member}' kind '${kind}'`);
  const lines = [
    "---",
    `kind: ${kind}`,
    `id: ${c.id}`,
    `unit: ${unit}`,
    `project: ${project}`,
    `status: ${c.status}`,
    `produced_by: ${c.produced_by}`,
    `consumes: [${c.consumes.join(", ")}]`,
    "supersedes: null",
    "approved_by: null",
    // Fixed created date so replays are byte-for-byte deterministic (no clock).
    "created: 2026-07-11",
    "files: []",
  ];
  // A member that reports nothing emits no usage block at all — the adapter records `unreported`.
  if (c.usage !== null) {
    lines.push(
      "usage:",
      `  model: ${c.usage.model}`,
      `  tokens_in: ${c.usage.tokens_in}`,
      `  tokens_out: ${c.usage.tokens_out}`,
      `  usd: ${c.usage.usd}`,
      `  wall_clock_s: ${c.usage.wall_clock_s}`,
    );
  }
  lines.push("---", "");
  return lines.join("\n") + c.body;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [member, kind] = args;
  if (!member || !kind) {
    console.error("usage: member-stub.ts <member> <kind> [--unit U] [--project P]");
    process.exit(2);
  }
  const unit = opt(args, "--unit", "checkout-flow");
  const project = opt(args, "--project", "storefront");
  try {
    process.stdout.write(render(member, kind, unit, project));
    process.exit(0);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }
}
