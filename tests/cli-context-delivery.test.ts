import { test, expect, describe } from "bun:test";
import { loadRepo } from "../src/repo.ts";
import { assembleContext } from "../src/context.ts";
import { loadPricing } from "../src/pricing.ts";
import { AdapterRunner, AdapterError, bunSpawn, asyncBunSpawn, type NativeBoundary, type RemoteBoundary } from "../src/adapters.ts";
import { render } from "../fixtures/stubs/member-stub.ts";

// NOTES F7: an agent declares HOW it wants its §6 context delivered — `context_via: arg` (default,
// substituted into {task}) or `context_via: stdin` (written to the child's stdin, then closed). Both
// spawn boundaries (bunSpawn — sync, replay/tests; asyncBunSpawn — non-blocking, the live serve/daemon
// path, NOTES F5) must honor this identically: `stdin` mode delivers the context on stdin; `arg` mode
// closes stdin immediately with nothing written, so a CLI that unexpectedly reads stdin sees instant
// EOF, never a hang waiting on input that will never arrive.

const ROOT = "fixtures/golden";
const pricing = loadPricing(ROOT);
const nativeMock: NativeBoundary = { invoke: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };
const remoteMock: RemoteBoundary = { call: (r) => ({ doc: render(r.member, r.kind, r.unit, r.project) }) };

// `cat`: the simplest real, unmocked process that proves the OS-level stdin contract — it echoes
// whatever it reads from stdin to stdout, and exits the instant it sees EOF. No {task} in the argv
// template at all (stdin mode never needs one), matching a real CLI whose prompt comes from stdin.
function catRunner(member: string, contextVia: "arg" | "stdin", spawn: "sync" | "async") {
  const repo = loadRepo(ROOT);
  repo.agents.set(member, { ...repo.agents.get("finch")!, name: member, command: ["cat"], cwd: undefined, context_via: contextVia, timeout: 5 });
  repo.teams.get("kestrel")!.members.push(member);
  const runner = new AdapterRunner(repo, {
    pricing,
    capabilities: [{ member, kind: "review" }],
    native: nativeMock,
    remote: remoteMock,
    // Real spawn boundaries throughout — this test proves genuine OS-level stdin behavior, not a mock.
    spawn: spawn === "sync" ? bunSpawn : undefined,
    asyncSpawn: spawn === "async" ? asyncBunSpawn : undefined,
  });
  return { runner, repo };
}

for (const spawn of ["sync", "async"] as const) {
  describe(`context_via, real ${spawn} spawn`, () => {
    test(`context_via: stdin — the full assembled context arrives on the child's stdin (${spawn})`, async () => {
      const member = `stdiner-${spawn}`;
      const { runner, repo } = catRunner(member, "stdin", spawn);
      const expectedContext = assembleContext(repo, { root: ROOT, agent: member, unit: "checkout-flow", capabilities: [{ member, kind: "review" }] });

      const { doc } = spawn === "sync" ? runner.produce(member, "review", "checkout-flow", "storefront") : await runner.produceAsync(member, "review", "checkout-flow", "storefront");
      // `cat` echoed back exactly what it read on stdin: the full §6-assembled context, landing as the
      // authored artifact's BODY (ruling C12 — levare wraps the member's raw content in its own
      // frontmatter; it is never the whole document).
      expect(doc).toContain(expectedContext.trim());
      expect(doc).toContain(`── 1. agent · ${member}`);
      expect(doc).toContain("kind: review");
      expect(doc).toContain(`produced_by: kestrel/${member}`);
    });

    test(`context_via: arg (default) — stdin is closed, never left open (${spawn})`, async () => {
      const member = `argmode-${spawn}`;
      const { runner } = catRunner(member, "arg", spawn);
      const start = Date.now();
      // `cat` read nothing (stdin closed with EOF immediately) and exited with empty stdout — no
      // usable content, so the boundary throws rather than authoring a blank artifact (ruling C12: "a
      // member's output is empty or unusable" is a blocked artifact, never a silent empty document).
      let threw: unknown;
      try {
        if (spawn === "sync") runner.produce(member, "review", "checkout-flow", "storefront");
        else await runner.produceAsync(member, "review", "checkout-flow", "storefront");
      } catch (e) {
        threw = e;
      }
      const elapsed = Date.now() - start;
      expect(threw).toBeInstanceOf(AdapterError);
      // Proof `cat` never blocked waiting on input that would never arrive — a left-open/inherited
      // stdin would hang `cat` until the agent's 5s timeout killed it; this must return almost
      // instantly instead.
      expect(elapsed).toBeLessThan(2000);
    });
  });
}
