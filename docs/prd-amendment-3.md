# PRD Amendment 3 — remote/MCP members, ratified

**Date:** 2026-07-21
**Author:** Cas (the Conductor)
**Applies to:** `docs/levare-prd.md` v1.0, as amended by Amendments 1 and 2
**Occasioned by:** the design session for remote/MCP members. `kind: remote` has validated
cleanly since REV1 while `RemoteBoundary` stayed a mocked fixture (invariant 10's standing
deferral, surfaced honestly by validate/doctor/registry warnings). This amendment ratifies the
implementation design that closes that deferral. When the MCP phase ships, invariant 10's
remote clause returns to full force and this amendment is its constitutional record.

---

## 0. The shape, in one sentence

**A remote member is a `cli` member that speaks MCP over stdio** — levare spawns a local MCP
server process, speaks JSON-RPC to it, and the call's result becomes one gated artifact. It
inherits the spawn path, the R4 sandbox, the connector-auth model, the taxonomy decisions, and
the artifact lifecycle. The genuinely new part is the protocol, and nothing else.

Everything below follows from that sentence. The rulings exist to make each inheritance explicit
and to name what is deliberately *not* in scope.

---

## 1. Transport — stdio first (ruling R1)

**R1 — stdio is phase 1; HTTP/SSE is a named, deferred phase 2.** MCP defines two transports:
stdio (spawn the server as a local subprocess, JSON-RPC over stdin/stdout) and HTTP/SSE (connect
to an already-running server over the network). Phase 1 implements **stdio only**, for three
reasons stated as the ruling's rationale: (a) the MCP ecosystem as it exists is overwhelmingly
stdio — the `npx @modelcontextprotocol/server-*` catalogue and community servers are local
processes; (b) stdio matches levare's local-first, git-native grain, where HTTP introduces a
dependency on something running elsewhere; (c) stdio reuses the spawn and sandbox machinery R4
already hardened (R3 below), where HTTP would need its own network-boundary story. HTTP/SSE is
not rejected — it is deferred until a hosted MCP service the studio actually wants appears, at
which point it becomes its own amendment. Until then, a `kind: mcp` connector whose `server:`
names an HTTP endpoint is a validation warning, not a runtime path.

---

## 2. Lifecycle — one dispatch, one call, one gated artifact (ruling R2)

**R2 — a remote member is a producer, not a new lifecycle.** `RemoteBoundary.call(req) →
{ doc: string }` already encodes the correct contract: a remote member is dispatched once,
makes its MCP call, and the result becomes one artifact document that flows through the normal
proposal / gate / review / merge path — identical to `native` and `cli`. MCP is a new
**transport**, never a new **lifecycle**. This ruling deliberately excludes the interactive /
multi-call model (a member holding a long MCP session, making many calls before emerging): that
would smuggle an unaudited multi-step process inside a single dispatch, breaking levare's core
accountability that every member produces one artifact a gate reviews. Multi-step work already
has its levare-native, auditable expression — the **review loop** (produce, gate, loop) — and
belongs there, in the open where the Conductor gates each step, not hidden inside one opaque MCP
dispatch. The artifact-per-invocation contract is not a limitation to design around; it is the
model correctly asserting itself.

---

## 3. Sandbox — a spawned MCP server is contained like any cli member (ruling R3)

**R3 — stdio MCP servers run inside the R4 sandbox.** Because R1 makes levare spawn the MCP
server as a local process, that process goes through the same OS sandbox a `cli` member's spawn
does (NOTES R4-SANDBOX, Ruling 2) — and it *should*, because an `npx`-fetched MCP server is
exactly the untrusted third-party code the sandbox exists to contain. The remote member's
process gets its per-dispatch scratch working area, its scoped `HOME`, the studio root read-only,
network denied unless a connector grants it, and the operator's home denied — the identical
confinement and the identical decoy guarantee proven for `cli`. Rationale worth recording: MCP
inherits the security work rather than needing its own, which is the strongest single argument
for stdio-first. (When HTTP/SSE arrives in a future phase, there is no process to sandbox; its
boundary is the network grant, and that phase must design its own containment story — noted so a
future round does not assume R3 covers it.)

---

## 4. Auth — the connector model, unchanged (ruling R4)

**R4 — a remote member authenticates through its connector, exactly as a cli member does.** A
`kind: mcp` connector grants credentials the same way a `cli` connector does: `auth: env`, the
token reaches the member's environment, MCP server reads it. No new auth machinery. This keeps
remote members inside the taxonomy decisions already ratified (NOTES TAXONOMY-DECISIONS): the
credential⇔network coupling proven by R4-VENDOR-CLI applies identically — a remote member holding
its MCP connector's credential is, by that same coupling, network-permitted, and the same
per-agent grant model governs who holds it. Nothing here reopens the taxonomy; MCP is a consumer
of its decisions, not an occasion to revisit them.

---

## 5. The protocol — what is genuinely new (ruling R5)

**R5 — a real MCP client, built in verifiable stages.** The one genuinely new body of work is the
MCP client itself: the JSON-RPC handshake (`initialize` + capability negotiation), discovering
what a server offers (`tools` / `resources` listing), mapping a member's declared intent to a
specific server call, invoking it, and turning the response into the artifact `doc`. This is
bounded — the MCP spec is well-defined and reference client behaviour exists — but it is real
protocol code, and MCP servers vary in how cleanly they behave. It is therefore built in three
stages, each independently verifiable against a real server, never one drop:

- **Phase 1a — handshake and discovery.** levare can spawn a real stdio MCP server, complete
  `initialize`, and list its capabilities. Proven by connecting to a real reference server (e.g.
  the filesystem or everything-server) and asserting the negotiated capability set. No artifact
  production yet — this phase proves levare can *speak* MCP at all. `RemoteBoundary` gains a real
  implementation behind the same interface; the mock stays available for tests.
- **Phase 1b — invocation to artifact.** A remote member's dispatch maps its declared intent to a
  server call, invokes it, and the result becomes the artifact `doc` — closing the mock, wiring
  the real `RemoteBoundary.call` into the dispatch switch. Proven by a real member producing a
  real artifact from a real server call, flowing through validate/gate unchanged. The REV1
  honesty warnings (validate/doctor/registry) are removed for the now-implemented stdio case and
  narrowed to name only the still-deferred HTTP case.
- **Phase 1c — sandbox wrap.** The spawned server process is wrapped in the R4 sandbox per R3,
  with the same decoy/network/home guarantees proven for `cli`, verified on a live macOS host by
  the Conductor gate (the standing rule: anything touching `sandbox.ts` requires the host run).

Each phase is a separate goal with its own acceptance tests and its own merge. 1a and 1b are
container-verifiable; 1c requires the live-host gate.

---

## 6. Out of scope, named so it is not mistaken for oversight

- **HTTP/SSE transport** (R1) — deferred to a future amendment, gated on a real hosted service.
- **Interactive / multi-call MCP sessions** (R2) — expressible as a review loop; not a dispatch shape.
- **MCP resources / prompts beyond a single tool call** — phase 1 implements the call path that
  maps to artifact production; richer MCP surface areas are future work if a real need names them.
- **MCP servers levare authors or hosts** — levare is an MCP *client* here, never a server.

---

## 7. Constitutional effect

Invariant 10's remote clause (*"remote members are mocked this phase"*) remains in force until
phase 1b ships and its acceptance tests pass, at which point the clause reads, for the stdio case,
in full force: a `kind: remote` member declaring a `kind: mcp` stdio connector produces real work
through a live MCP call, sandboxed per R3, gated like every other artifact. The HTTP case remains
deferred under invariant 10 until its own amendment. The REV1 honesty warnings are the measure:
they are removed exactly when, and only when, the runtime honors what the schema already accepts.
