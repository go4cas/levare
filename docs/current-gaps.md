# Current gaps

A register, not a roadmap. Every item here is a decision that was made — to defer, to leave
unenforced, or to accept a tradeoff — not a wish list with dates. Each paragraph cites the NOTES
entry or PRD amendment where the decision was actually made; read that source for the full reasoning.
If you're deciding whether to build one of these, start there, not here.

## The v1.1 merge phase — closed (NOTES MERGE-1), invariant 6 in full force

levare now takes a work unit's code through a merge gate to a project's `main`
([`docs/prd-amendment-2.md`](prd-amendment-2.md), rulings M1–M5) — **invariant 6 is back in full
force**; Amendment 1 §2's "SPECIFIED, NOT IMPLEMENTED" reclassification and its own REV1 guardrails
notice are both retired, per Amendment 2 §2. A unit opened on a project declaring `repo:` gets a work
branch (`levare/<unit>`, created from `default_branch`'s tip at unit-open time); when its flow
completes, a merge gate opens with a trial-merge report (branch, commits ahead, diffstat, clean or
conflicted with files named); approving a clean gate runs `checkGuardrails` against the actual diff
(a violation fails the execution, named, even post-approval) and, if clear, produces a real merge
commit (never squash/rebase) authored `levare-runner`, pushing in the same transaction where the
project declares `remote:` — a push failure rolls the local merge back byte-perfectly and blocks the
gate with the reason named. `checkGuardrails` (guardrails.ts) is no longer dormant: its production
call site is `board/gateops.ts#doApproveMerge`.

One thing this closure deliberately did NOT cover, closed by a later goal, and one standing exclusion
that remains by design:

- **Member-side work-branch checkout is per-dispatch isolated — closed (NOTES R4-SANDBOX, Ruling 1).**
  The single-working-tree checkout named here at the time of this closure (`adapters.ts#AdapterRunner`'s
  `memberWorkingContext`, since retired) has been replaced: a member dispatched for a unit on a
  repo-bearing project now gets its own `git worktree add` of the work branch, under a per-run scratch
  path, created immediately before the invoke call and removed immediately after
  (`merge.ts#createDispatchWorktree`) — the same scratch-worktree technique the merge machinery itself
  (trial merge, execution, rollback) already used, extended to a third caller. Two units on the same
  repo-bearing project advanced concurrently now get two independent worktrees of their own two
  branches — no shared checkout to race. A two-concurrent-dispatch test proves the isolation directly
  (`tests/adapters.test.ts`).
- **Self-referential projects (`repo: .`, e.g. the golden fixture's own `studio` project) are excluded
  from the whole mechanism** — no work branch, no merge gate, no per-dispatch worktree — because that
  path IS the studio's own repo, the same one every gate resolution in this app commits artifacts into.
  Mixing branch-switching into that tree would be a correctness hazard, not a feature; `resolveProjectRepoPath`
  (merge.ts) excludes it structurally. A project whose `repo:` doesn't resolve to a real local git checkout at
  all (an unfetched SSH URL, a placeholder) is likewise unaffected — no work branch, no merge gate, no
  worktree, flow completion behaves exactly as it did before either goal.

## Remote/MCP members — the stdio case is now real and sandboxed (docs/prd-amendment-3.md, NOTES MCP-1A/1B/1C)

A `kind: remote` agent declaring a real, granted, stdio `kind: mcp` connector now produces real work: a
real JSON-RPC handshake and tool call against a spawned local MCP server process
(`adapters.ts#createAsyncStdioRemoteBoundary`, `mcp-client.ts`), sandboxed exactly like a `kind: cli`
member's own spawn (ruling R3, NOTES MCP-1C — the same generator, sandbox.ts, plus the connector's own
`home:` for any declared per-server exception). `levare validate`/`levare doctor`/the registry's agent
card narrowed their REV1-era warning accordingly (env.ts#remoteAgentImplemented is the single dividing
line): a working stdio remote member carries no "not implemented" telling at all, only the same
`SANDBOX_UNAVAILABLE` a `kind: cli` agent already gets when this host has no working OS primitive. What
remains a mocked `RemoteBoundary` fixture (`adapters.ts`), by ruling R1, is the still-deferred HTTP/SSE
transport — a `kind: mcp` connector whose `server:` names an HTTP endpoint rather than a stdio `argv:`.
The MCP-1C sandbox wrap's own live-host verification (`scripts/repro-mcp-1c-sandbox.ts`) is the
Conductor's standing macOS gate, the same posture NOTES R4-SANDBOX's own live rounds established for
`kind: cli` — this container can only prove the wiring, never the primitive.

A `kind: mcp` connector whose `argv:` invokes a fetch-and-run package launcher (`npx -y`, `bunx`, `pnpm
dlx`, `yarn dlx` over a bare package spec) is a deliberately unsupported declaration under the sandbox
(NOTES MCP-1C addendum 6, closing item #4): `levare validate` warns (`MCP_FETCH_AT_DISPATCH`), and
`createAsyncStdioRemoteBoundary` refuses to dispatch it outright on a host with a working sandbox
primitive, rather than the 60s hang this used to be. A pre-installed server referenced by its resolved
path remains the only supported `kind: mcp` shape under a working sandbox — see
docs/guide/04-workflow/05-foreign-agent.md.

## Conversation persistence — closed (NOTES V11-CONV), two narrower gaps remain

The Orchestrator conversation now persists to `conversations/<scope>/<YYYY-MM>.md` — an append-only,
per-scope, per-month markdown log, committed as `levare-runner` via the REV2 transactional helper, one
commit per completed exchange (NOTES V11-CONV closes the exclusion NOTES UI8 named and UI10 left open).
Two deliberate, narrower gaps remain from that goal:

- **No in-UI "load earlier" affordance.** The panel only ever renders the current scope's
  current-month segment, capped to the last `TAIL_EXCHANGES` (conversation.ts) exchanges. Older months,
  and anything beyond the cap, stay on disk — fully greppable (`grep`/`cat`/`git log -p` over
  `conversations/`) but not reachable from the panel itself. Paging or a "load earlier" control was
  explicitly deferred, not attempted.
- **The turn-block format is a plain log, not an escaped serialization.** A message body line that
  happens to exactly match a `## conductor · <timestamp>` / `## orchestrator · <timestamp>` header
  would be misread as a new turn boundary on reparse — accepted deliberately (conversation.ts's own
  comment) to keep the format pleasant to hand-edit and diff, rather than adding escaping for an
  extremely unlikely accidental collision.

## The capability layer

Referenced repeatedly (NOTES C13; `docs/guide/07-community.md`'s own "roadmap has real gaps" note)
as the future phase that would give each member its own isolated runtime view — its own filesystem,
its own scoped environment — rather than every member sharing one process-level env allowlist.

**Part A is built (NOTES CAP-A):** a connector now declares `effects: read | write`, and a `write`
connector's `gate: proposal | trusted` — a member granted a `write` + `gate: proposal` connector (the
default) never sees that connector's own env vars at all; it drafts an artifact of kind `proposal`
naming a connector-declared action and params, a Conductor's gate approval is what triggers levare's
own execution step (the only code that ever reads the credential), and a `kind: mcp` proposal's
execution is honestly recorded `executed: skipped` rather than pretended. This closes the "levare
cannot tell a read from a write" gap named above and gives the member-drafts/Conductor-approves/
levare-acts shape a real, gated write path for the first time.

**Part B is built (NOTES CAP-B):** `tools:` is now a validated fixed vocabulary (`SDK_TOOL_NAMES`,
sdk-transport.ts) rather than a free-form registry — an unknown name is a validation error naming the
real one. For a `native` member the declared list forwards to the Claude Agent SDK's own boundary
verbatim (a test proves the boundary receives exactly the declared list); a `cli` member's `tools:`
cannot be enforced the same way at the per-tool level — there is no SDK boundary in that spawn path for
a named-tool allowlist to reach — so it's a validate/doctor warning instead (`CLI_TOOLS_NOT_ENFORCEABLE`),
silenced only by removing the field. **v2's OS sandbox (below) narrows this warning's text, but does not
silence it:** a working sandbox confines a `cli` member's overall filesystem/network reach, which is a
coarser boundary than `tools:` itself describes (it cannot distinguish "may use Read" from "may use
Write") — so the gap the warning names is real either way. A connector also gains `home:` — dotpaths
under `$HOME` a subscription-authenticated vendor CLI actually needs (`home: [".codex"]`); a member
granted a connector that declares it gets a per-run scratch `HOME` symlinking only those paths (never a
copy — the login is a live credential), created before the spawn and removed after. A subscription
connector declaring no `home:` keeps the pre-CAP-B behaviour (the member's process sees the real,
unscoped `HOME`) and gets a new `SUBSCRIPTION_NO_HOME` warning, the sibling to `SUBSCRIPTION_NO_ROLE`
(NOTES C15). This narrows, but does not close, "Per-member subscription-credential scoping" below — see
that entry for the residual `home:` itself cannot fix.

**OS-level sandboxing (v2) — closed (NOTES R4-SANDBOX, Ruling 2; the macOS shape settled by a Conductor
ruling after live bisection, NOTES R4-SANDBOX-FIX-3).** Process isolation between a `cli` member's
spawned process and the operating system — the one item parts A and B both named but deliberately left
unbuilt — now exists, best-effort and per-OS, honestly reported. Both real `cli` spawn paths
(`adapters.ts`'s sync and async `CliSpawn` boundaries) wrap the member process in an OS sandbox where a
working primitive exists on the host, detected fresh at every spawn (never assumed from the platform: a
binary can be present and non-functional, e.g. this repo's own Linux dev container, where
`bubblewrap`/`unshare` are both on `PATH` but fail every invocation because the outer container disables
unprivileged user namespaces).

**The two platforms no longer enforce the SAME SHAPE of confinement at the `full` tier, and this is
recorded honestly rather than implied uniform (`levare doctor` prints a model note alongside the
primitive name for exactly this reason).** Linux `bubblewrap`, unchanged since Ruling 2: an allow-list
built from an EMPTY root — the process can reach its per-dispatch worktree (Ruling 1, above) read-write,
its `scopeHome` scratch `HOME` (NOTES CAP-B) read-write, the studio root, the interpreter's own install
tree, and a small enumerated set of baseline system paths (`/usr`, `/bin`, `/lib`, `/lib64`, `/etc`) —
nothing else; a decoy file ANYWHERE outside that list is genuinely unreadable. macOS `sandbox-exec`,
flipped to a DENY-LIST model by a live 14-profile bisection (NOTES R4-SANDBOX-FIX-3): the allow-list shape
proved unwinnable against `dyld`'s own shared-cache lookup on this OS (every enumerated variant tried
aborted identically, `SIGABRT` before `main()`, no sandbox denial logged for it) — the OS is broadly
readable by default, the same as an unsandboxed process, and the operator's own user data (`$HOME`,
`/Users`, `/Volumes`) is denied instead, with the dispatch worktree/scoped HOME/granted connector targets/
interpreter tree re-allowed explicitly on top (Seatbelt's own later-rule-wins semantics makes this a real
deny-list, not merely a differently-ordered allow-list). Both satisfy the actual threat model — a member
must not read the operator's dotfiles, other projects, or the studio beyond its grants — by different,
non-equivalent means; hiding the OS from `dyld` was never the goal and, per the bisection, isn't
achievable on this platform regardless of further effort. The darwin decoy-file test's own meaning
survives this change: a file under the operator's `$HOME` outside the granted set is still genuinely
unreadable, proven the identical way — it's simply no longer true that everything outside a short
allow-list is unreadable on macOS, because nothing on this OS can make that claim survive contact with
`dyld`.

Network is best-effort on both platforms — denied unless the member holds at least one granted connector
(every connector this codebase has IS levare's own way of declaring an external reach). Per-OS primitive
selection: Linux tries `bubblewrap` first (level `full`), falling back to a raw `unshare` mount-namespace
confinement (level `fs-only` — filesystem only, weaker than `full` in a THIRD distinct way: it confines
writes to the declared roots via a read-only remount of `/`, but does not additionally hide unlisted
read-only paths the way bubblewrap's empty-root construction does); macOS uses a generated `sandbox-exec`
profile (level `full`, deny-list shape). No working primitive on either OS → an unsandboxed spawn (level
`none`) — a Conductor ruling, never escalated to a spawn failure — plus a new `SANDBOX_UNAVAILABLE`
doctor/validate/registry warning, sibling to `CLI_TOOLS_NOT_ENFORCEABLE` above. The enforcement level
actually used is recorded on the produced artifact (`sandbox: full | fs-only | none`), per run, never
omitted — though as of this ruling, `full` itself requires reading which `primitive` produced it to know
which of the two non-equivalent guarantees actually applied.

**Honestly, in six rounds — the sixth is where a real member dispatch finally ran end-to-end.** The FIRST
live run of this feature was on macOS — the only host in this
project's history where `sandbox-exec` actually engaged rather than reporting `none` — and it failed 20
pre-existing tests plus the two new decoy/read-back tests, all real-spawn paths. Round 1 (NOTES
R4-SANDBOX-FIX) fixed macOS path canonicalization (`sandbox-exec`'s path rules match the KERNEL-RESOLVED
form, and `/tmp`/`/var/folders` are symlinks into `/private`) and widened the read-only allowlist to
include the studio root and the interpreter's own install location, which had broken nearly every real
CLI fixture this repo's own suite spawns. A SECOND live run, with the kernel's own unified log checked
directly for sandbox denials, found ZERO — proving the member process was dying before the sandbox ever
judged anything, an entirely different class of bug than round 1 fixed. Round 2 (NOTES
R4-SANDBOX-FIX-2) found the actual composition defect: the profile was passed inline (`-p <string>`,
never independently verified on this host) rather than via a temp file (`-f <path>`, the exact form a
manual check proved works), plus an unverified `--` separator neither `man sandbox-exec` nor that same
manual check ever showed. Both are now aligned with the one invocation shape actually proven to work. A
THIRD live run — with the wrapper now composing and applying correctly, confirmed via
`LEVARE_SANDBOX_DEBUG` — found the process still dying, this time under `dyld`'s own
`ignition_halt`/`abort_with_reason`, no sandbox denial logged for it; a 14-profile bisection on the live
host proved no enumerated allow-list satisfies `dyld` on this OS, and a Conductor ruling (NOTES
R4-SANDBOX-FIX-3) flipped the macOS model to deny-listing instead, described above. A FOURTH live run —
against the new deny-list model — dropped the failure count from 20 to 9, and this time the
`LEVARE_SANDBOX_DEBUG` capture convicted the generated profile TEXT directly: a security bug (the
operator's real HOME was blanket re-allowed whenever a member had no genuinely scoped one — the exact
common case the round-3 decoy test exercised, and why that test itself was failing), a crash (denying
`/Users` without re-allowing the ancestor directory components between it and a re-allowed path breaks
path traversal — recognizable by a NEW signature, `SIGTRAP` inside `std::__call_once`, bun/Zig panicking
on an unexpected `EPERM`, never a logged sandbox denial), and a cosmetic duplicate-rule issue. Round 4
(NOTES R4-SANDBOX-FIX-4) fixed all three: the HOME re-allow now requires the home to be genuinely
DIFFERENT from the operator's real one; every re-allowed path gets ancestor-directory metadata access so
traversal into it survives a denied ancestor; every generated line is deduplicated. A FIFTH live run —
against the round-4-corrected profile — found the SAME crash signature persisting under a corrected
profile, traced to a probe-design flaw rather than the profile itself: script-mode `bun` reads a battery
of sysctls (`kern.osproductversion`, `kern.bootargs`, `security.mac.lockdown_mode_state`,
`kern.osvariant_status`, `hw.pagesize_compat`) at child-spawn startup, and every profile-design bisection
across every prior round had used `--version` to test candidate profiles — a fast-exit flag that never
reaches that startup path at all, which is why every earlier "working" profile still killed every real
dispatch. Round 5 (NOTES R4-SANDBOX-FIX-5) added `(allow sysctl-read)` to the fixed preamble (kernel
parameters, not user data — the threat model is unaffected) and rewrote the detection probe itself to run
a real script file through the real interpreter under a profile built by the SAME generator a real
dispatch uses, never a bespoke weaker canary. **Under the corrected profile, the member stub ran
end-to-end and printed its canned artifact, exit 0** — the first real member dispatch to succeed under
the darwin sandbox in this goal's entire history. Throughout, a `LEVARE_SANDBOX_DEBUG=1` env var prints
the composed argv and raw spawn result for whichever run confirms it. What COULD be verified without a
live macOS host (canonicalization logic, argv/profile construction, rule ORDER, the deny-defeat/ancestor-
metadata/dedup/sysctl-read/probe fixes all directly against the generator's own output) was; what could
only be proven by actually running there (bubblewrap's own Linux behaviour beyond this repo's own dev
container, `unshare`'s fs-only fallback anywhere, and now whether the fix generalizes beyond the one
member-stub workload actually exercised — a real wrapped vendor CLI may touch further kernel interfaces
this round's own evidence never surfaced) still wasn't, and is named rather than assumed — see NOTES
R4-SANDBOX-FIX-5's own "still requires a live host" list.

**A SIXTH live report (NOTES R4-SANDBOX-FIX-6) found the detection PROBE itself under-reporting a
sandbox that was, on the exact same host, already working for every real dispatch** — `./levare doctor`
printed `sandbox: none` (with `SANDBOX_UNAVAILABLE` warnings following on `validate`) on a host where the
full suite's own real `kind: cli` spawns sandboxed successfully, and `LEVARE_SANDBOX_DEBUG=1 ./levare
doctor` printed nothing at all: the one spawn that decides every dispatch's enforcement level was the one
spawn the debug flag never reached. Root cause: `probeSandboxExec` built a `sandbox-exec` profile scoped
to its own scratch directory, but the actual `Bun.spawnSync` call was never told to `cwd` there — the
probed process ran wherever the CALLING process's own ambient directory happened to be (typically the
studio root, under the operator's real `$HOME`, denied by the profile with nothing re-allowing it), while
every real dispatch's own spawn boundary (`adapters.ts#bunSpawn.run`) always passes a `cwd` matching the
exact policy its own profile was built for. **Fixed, two parts:** the probe/detection seam now threads
`cwd` through to the real spawn (`SandboxDetectOptions.probe` gained an optional `{cwd}` second
parameter), and the probe's own spawn — pre- and post- — is now instrumented under
`LEVARE_SANDBOX_DEBUG` in the identical shape a real dispatch's own wrap already used, closing the second
finding directly. This was the second time a probe was found testing a shape no real dispatch takes (the
first, FIX-5's `--version`, skipped script-mode startup entirely; this one skipped matching the process's
own working directory to the policy governing it) — worth naming as a recurring failure class for this
module specifically: a detection probe's fidelity to production is not proven by "it calls the same
generator," it also requires "it hands the result to the OS the same way." The exact OS-level failure
mode the mismatched `cwd` produced on the live host was not independently isolated (unchanged from every
prior round's own honest framing of what a Linux-only dev container can and cannot directly observe); the
fix removes the structural divergence rather than diagnosing a captured crash report, and the newly-wired
debug output is what the next live report should use to confirm (or refute) the mechanism precisely.

**Rounds R4-SANDBOX-FIX-7 through FIX-12 (full account in NOTES.md) closed a member's own commit inside
its dispatch worktree, an xcrun-shimmed git tool's `confstr`/temp-dir failure, and a real security
regression the second of those introduced.** Ruling 1's own promise ("a member's commit advances the work
branch") required write access to the ORIGINAL project repo's shared `.git` state (objects/refs/logs/this
dispatch's own worktree admin directory — never `.git/hooks`/`.git/config`, both code-execution vectors).
On darwin, this grant is now a DEDICATED field (`SandboxPolicy.gitWriteGrant`) whose own deny-the-root-
then-reallow-the-four-subpaths ordering reseals hooks/config regardless of what else the profile grants —
this replaced a flat write-list after FIX-11's own xcrun-cache fix (`DARWIN_USER_TEMP_DIR`, needed because
Apple's `/usr/bin/git` is an xcrun shim whose startup `confstr` call was denied) proved, on its first live
execution, that a broad grant on the whole per-user temp directory both swallowed the hooks/config seal
(every scratch repo in this codebase's own fixtures lives directly under that same directory) and broke
cross-dispatch write isolation (every concurrent dispatch's own worktree lives there too). FIX-12 narrows
the xcrun grant itself to a `(regex ...)` matching only `xcrun_db-*` cache-file names, which independently
closes the cross-dispatch leak (a sibling worktree's own name never matches that pattern). **Honest
residual:** cross-dispatch write isolation under this model rests on that regex narrowing continuing to
hold — the `gitWriteGrant` reseal protects the git-write seal specifically regardless of what else is
granted, but it does not, and cannot, deny writes to an arbitrary OTHER dispatch's scratch directory by
name (those paths aren't known at profile-build time). If a future round ever needs to widen the xcrun
grant back toward a broader shape, cross-dispatch write isolation must be independently re-examined at
that point, not assumed to still hold by extension of the git-write reseal.

**An app-server-architecture vendor CLI (`codex`) failed at spawn under this sandbox — two proactive
fixes shipped, the root cause remains unconfirmed pending a live host (NOTES R4-SANDBOX-APPSERVER).** A
`kind: cli` member wrapping `codex` died with `failed to initialize in-process app-server client:
Operation not permitted` under a generated `sandbox-exec` profile. Two real, provable gaps in the
generator were closed regardless of whether either is THIS failure's own cause: (1) `grantedHomeTargets`
(a subscription connector's own real `home:` target, e.g. `~/.codex`) was re-allowed for READ only, never
WRITE, on either platform — a vendor CLI refreshing its own stored credential through the scratch-HOME
symlink was silently denied; Linux `bubblewrap` never read this field AT ALL, leaving a granted
credential unreadable through its own symlink under an empty-root sandbox. Both fixed
(`sandbox.ts#buildSandboxExecProfile`'s write re-allow; `bubblewrapArgv`'s new `--bind-try`), proven by
construction (the profile/argv TEXT), not live-confirmed as codex's own cause. (2) A version-managed
vendor CLI (Volta/nvm/asdf/mise/pyenv/rbenv) resolves through the MANAGER's own shim, which needs the
manager's own root granted in `home:` too — undeclared, this fails with the MANAGER's own confusing
error, not levare's; `levare validate`/`levare doctor` now name this explicitly
(`SUBSCRIPTION_HOME_SHIM_GAP`), deliberately never auto-granted (a version-managed binary cannot be
scoped narrowly — granting the manager's root exposes every toolchain it manages). **The declared escape
hatch, shipped regardless of the outcome above:** `sandbox: unsandboxed` on an agent (with a required
`sandbox_reason`) makes `adapters.ts#sandboxWrap` skip the OS sandbox entirely, on any host — surfaced by
`levare validate`/`levare doctor` with the same plainness `SANDBOX_UNAVAILABLE` already uses, and
recorded on every artifact that member produces (`sandbox_reason:`, alongside `sandbox: none`). A live
diagnostic harness (`scripts/repro-r4-appserver-codex.ts`) is built and ready but not yet run — no live
macOS host was reachable this round; see NOTES R4-SANDBOX-APPSERVER for the ranked hypotheses (a
write-reallow gap vs. nested Seatbelt self-sandboxing) the next live run needs to distinguish. **The
harness itself had a plumbing bug, found and fixed before any live run used it (NOTES
DOCS-WALKTHROUGH-1):** every dispatch it drove targeted a work unit that doesn't exist
(`unit: "repro"`), which made context assembly throw and get silently swallowed into an empty prompt —
codex's own honest `No prompt provided via stdin.` was being misread as an app-server sandbox finding it
never was. Fixed to dispatch against a real fixture unit; the script now also cross-checks the sandboxed
run against its own unsandboxed control automatically and refuses to call a failure sandbox-related when
both fail identically. The ranked hypotheses above are unaffected — this was a harness defect, not a
finding about H1 or H2 — but the next live run needed this fix first, or it would have reproduced the
same false negative again.

**A live macOS run confirmed the write-reallow fix above — and surfaced a THIRD, distinct fault: TLS
certificate validation itself, not app-server initialization (NOTES R4-SANDBOX-TLS).** With the fix
installed (build `9c00154`, macOS 26.5.2 arm64, `sandbox: full`), a `cli` member wrapping `codex` now
initializes its app-server and reaches the network — the fault the paragraph above investigated is
closed — but certificate validation fails identically on both its WebSocket and HTTPS transports
(`invalid peer certificate: UnknownIssuer`). The same run's kernel log showed five denied mach-lookups/
ioctls in the same window (`com.apple.SystemConfiguration.configd`,
`com.apple.system.opendirectoryd.libinfo`, `com.apple.system.notification_center`, `com.apple.logd`,
`com.apple.diagnosticd`, and a `file-ioctl` on `/dev/dtracehelper`) — previously catalogued as benign
ambient noise every sandboxed macOS process tolerates (two of the five, opendirectoryd's own services,
were explicitly hand-acquitted for a DIFFERENT consumer, a `git`/`bun` chain, in NOTES
R4-SANDBOX-FIX-10), and none of the five is granted on the strength of merely co-occurring with this
failure — per this saga's own standing discipline, none is guessed at without a codex-independent live
trace naming it as the actual cause for THIS failure specifically. `com.apple.trustd.agent` (NOTES
R4-VENDOR-CLI's own shipped, network-gated fix, already in place) is NOT among the five — it is what let
`gh` (Go, its own certificate handling) complete a real HTTPS request; codex's Rust TLS stack defers to
the platform trust store directly, a different code path through the same sandbox, and `gh`'s own
success never certified it. **Built this round: `scripts/repro-r4-sandbox-tls-handshake.ts`, a
codex-independent probe** — a bare `curl` TLS handshake against a public host (`example.com`, chosen
because `UnknownIssuer` is a chain-building failure, not specific to any one domain's own certificate)
under the real generated profile, decisive without `codex` installed, mirroring the H1/H2 probe shape
NOTES R4-SANDBOX-APPSERVER already established. It has not yet been run live — no macOS host was
reachable this round — and is handed back for exactly that, the same method every prior live-host round
in this saga has used. **The Linux side, checked in the same round rather than assumed to hold by
extension:** a network-granted member under `bubblewrap` needs no further grant to complete a TLS
handshake, by construction — Linux has no daemon-mediated trust evaluation the way macOS routes through
`trustd`; a TLS client resolves its own trusted-root store by reading files (`/etc/ssl/certs/...`,
symlinked into `/usr/share/ca-certificates/...`) and verifies the chain in-process, and both `/etc` and
`/usr` are already in the unconditional baseline allow-list, while `allowNetwork: true` omits
`--unshare-net` entirely (the sandboxed process shares the host's real network namespace, not an
isolated one needing its own DNS/routing setup) — proven by construction
(`tests/sandbox.test.ts`), not live-confirmed on a working `bubblewrap` (this dev container's own outer
seccomp policy has never once let one run for real, the same limitation named throughout this file).

**The certificate-validation fault above is now closed: a live macOS dispatch confirmed
`com.apple.SecurityServer` as the second, load-bearing mach-lookup denial.** `trustd.agent` alone (the
prior round's own fix) was not sufficient for a real, live TLS handshake through a platform-trust-store-
deferring stack — a `log stream` capture of the failing live dispatch, diffed against
`scripts/repro-r4-sandbox-tls-handshake.ts`'s own PASSING `curl` capture under the identical generated
profile, named exactly one mach-lookup denial present in the failing run and absent from the passing
one. Granted, gated on `policy.allowNetwork` alongside `trustd.agent` (`src/sandbox.ts`), installed, and
re-dispatched live: the handshake completed, the member called its API, and produced a real artifact
(`review`, `sandbox: full`). None of the five mach services that same probe's PASS already acquitted by
evidence — `configd`, `diagnosticd`, `opendirectoryd.libinfo`, `notification_center`, `logd` (plus
`dtracehelper`'s file-ioctl and a `network-outbound` denial on `mDNSResponder`, also observed denied in
BOTH the passing and failing captures) — is granted; none was shown load-bearing, and this round's own
standing discipline never grants on the strength of mere co-occurrence. `com.apple.SecurityServer` **is**
`securityd` — a broader surface than `trustd.agent`'s own trust-evaluation-only scope; [Operations' own
new paragraph](guide/06-operations.md) states precisely what this opens (mach-lookup reach to the daemon)
and what it does not (any particular keychain item — `securityd` still gates those per-item, on every
request, regardless of mach-lookup reach). Read as a continuation of NOTES R4-VENDOR-CLI's own
investigation and gating discipline (evidence-named, network-gated, nothing broader) rather than a new
policy question — no separate Conductor ruling was raised for it; if a future Conductor reads the
widening as material enough to warrant one, that's a call this entry defers to them, not one it makes
here. `scripts/repro-r4-sandbox-securityserver.ts` (new, darwin-only) is the host-only A/B this grant's
own claim needs to stay honestly verified going forward — curl on this project's own dev/CI hosts links
LibreSSL and never exercises `securityd` at all, so the existing TLS-handshake probe's own PASS cannot
confirm this specific grant; the sibling drives `security list-keychains` (which does round-trip through
`securityd`) under the real generated profile and a synthetic variant with only this one line stripped,
and has not yet been run live from any session in this saga's own history — named as an honest residual,
not assumed closed by construction the way the Linux side above is.

## A loop's live-path dispatch and its retry path used to disagree — closed (NOTES R4-SANDBOX-TLS
## goal, faults 2+3)

The SAME live incident that surfaced the certificate-validation fault above also surfaced a second,
unrelated defect once the TLS grant let a real dispatch finally complete: **the produced `review`
reviewed nothing.** `agents/corvid.md` correctly declared `context_artifacts: inline` (ruling C9), and
the loop's live-path dispatch (`dagwalk.ts#produceOne`) correctly threads ruling C14's `extraConsumes` —
confirmed already-fixed and already regression-tested (NOTES F15, `tests/loop-critic-context.test.ts`).
The gap was one hop further downstream: every earlier dispatch of this SAME round's critic had failed on
the (then-ungranted) TLS fault and landed `blocked` (NOTES F19), and the Conductor's own explicit
`retry` verb — `board/gateops.ts#resolveBlockedArtifactGate` — is a SECOND call site to
`memberRunner.produce()` that dropped `extraConsumes` entirely. A critic retried after any transient
failure saw an empty `(none)` consumed-artifacts section no matter how correctly `context_artifacts`
was declared or how correctly the ORIGINAL (never-retried) dispatch would have assembled it.

**The same retry path also inflated the loop's own round accounting.** Every retry — failed or
successful — bumped `roundOf(art.id)` via `bumpVersion`, the identical mechanism `dagwalk.ts` uses to
pair a loop's two members to one round and `board/gateops.ts#doRequest` uses to detect `max_rounds`
exhaustion. A blocked attempt never reaches the Conductor, so this project's own reading (stated
plainly, not left implicit) is that it must never spend a round of the loop's own budget — a round is
spent only by a genuine author/critic exchange the Conductor actually resolves. The live incident's own
evidence matched exactly: 5 infrastructure-driven retries before the TLS fix landed inflated a loop that
ran exactly one genuine author/critic exchange into reporting "6 of 3 rounds used", past its own declared
`max_rounds: 3` cap.

Both close with the same fix, in `resolveBlockedArtifactGate`'s `retry` verb only (a plain, non-loop
step's retry is unchanged — it has no round concept and keeps its own pre-existing fresh-id-per-attempt
audit trail): a loop member's retry now threads `extraConsumes` (the round's author artifact id, when
retrying the critic) and rewrites its OWN slot in place — same id, same `supersedes`, no second file —
mirroring `doRecheckMerge`'s own pre-existing "same slot, re-run, never supersede" precedent, rather than
minting a new round on an attempt that never reached the Conductor.
`tests/loop-blocked-retry-context.test.ts` drives a real subprocess through `productionAdapterRunner`
across a blocked→retry→…→success chain (mirroring F15's own real-subprocess technique) and asserts on
what the member actually received and what round the loop reports — confirmed to fail without the fix.

## Connector trust-tier taxonomy — three recorded decisions, not open gaps (NOTES TAXONOMY-DECISIONS, 2026-07-21)

A connector now declares `role: model | tool` (NOTES C15) — what FUNCTION it serves — and, since NOTES
CAP-A, `effects: read | write` — whether a grant lets a member merely read through it or only propose
against it, with a `write` connector's `gate: proposal | trusted` on top. Three further dimensions this
entry used to name as unfinished work were put to the Conductor directly; each resolved to a deliberate
design stance with its own rationale, not deferred work. Read NOTES TAXONOMY-DECISIONS for the full
rulings; the decisions themselves:

**1. Credential-vs-network coupling — formalized as an intended invariant, not a gap to close.**
`env.ts#memberNetworkAllowed` derives a `kind: cli` member's sandboxed network reach from the SAME
condition `buildMemberEnv`'s own connector-gated allowlist uses — `grantedConnectors(repo,
member).length > 0`. First surfaced as a live finding by NOTES R4-VENDOR-CLI's validation against a real
`gh` dispatch, and re-confirmed holding through that investigation's round 4 close-out. Its consequence,
confirmed by construction: **levare cannot express "may hold this connector's credential, must not reach
the network" for a `kind: cli` member** — credential-scope and network-scope are welded at the
connector-grant level. (Originally scoped to `cli` specifically — NOTES R4-SANDBOX v2 Ruling 2 wrapped
only the two `cli` spawn paths, with `native`/`remote` exempt since neither went through this sandbox
mechanism. NOTES MCP-1C, ruling R3, extends the IDENTICAL coupling to `kind: remote`'s own spawned MCP
server process — `env.ts#memberNetworkAllowed` is read by `adapters.ts#buildRemoteSandboxPolicy`
exactly as it is by `buildDispatchSandboxPolicy`, and a remote member always holds at least its own
`server:` connector, so this reach is granted by construction. `native` remains exempt — a Claude Agent
SDK call has no separate spawned process for the sandbox to wrap.) **The Conductor's ruling: this is not a missing third
dimension awaiting construction, because levare has no connector shape that names a purely-local
capability in the first place** — Ruling 2's own reasoning is that every connector IS levare's declared
way of naming an external reach; "hold a credential but deny network" would require inventing a connector
TYPE that doesn't exist today, not adding a flag to the one that does. What WOULD motivate building a real
third axis: a credentialed-but-offline CLI member — a local-only decrypt or license-check tool that
authenticates but never phones home, or a belt-and-braces dry-run mode that should hold a live credential
without being allowed to use it over the network. No such member exists in this codebase today, and the
dimension is intentionally not built until one does.

**2. Write-tiers within `effects: write` — out of scope for current scope, not deferred.** NOTES CAP-A
gives every write connector exactly one gate (`proposal` or `trusted`); there is no tier concept beneath
that anywhere in the model — no "may propose against production, may not against staging" distinction.
**The Conductor's ruling: a single write-target does not justify inventing a tier** — there is nothing
concrete in the current model to draw such a boundary against. This stays deferred until a second,
genuinely distinct write-target exists in a real connector, at which point the split can be drawn from an
actual case instead of guessed in the abstract. Not a gap; a scoping decision.

**3. Team-scoped grants — per-agent grants are the ruled design at current scale.** There is no team- or
role-level grant system beyond whichever individual agents happen to be granted a connector — a grant is,
and remains, per-agent. **The Conductor's ruling: this is the right shape at the scale levare studios
operate at today, not an unbuilt feature** — revisitable if a studio grows past the point where per-member
grant lists are ergonomic to author and audit, but that's a future trigger condition, not a current gap.
This decision is also the answer to "who may hold the grant" in "Per-member subscription-credential
scoping" below — see that entry for the linkage.

NOTES C13's own guidance — "prefer `auth: env`, grant `auth: subscription` only to trusted members" —
remains advisory prose in a doctor warning, not an enforced taxonomy; that stays true independent of the
three rulings above; nothing here promotes it to enforcement.

## Per-member subscription-credential scoping

A subscription-authenticated CLI (the motivating case: `codex login` writing a session to
`~/.codex`) reads its credential off disk, outside any env var levare could withhold. NOTES C13 named
this precisely and NOTES CAP-B (the capability layer, part B, above) narrows it with a real filesystem
boundary: a connector declaring `home: [".codex"]` gives a granted member's spawned process a per-run
scratch `HOME` symlinking only that path — the operator's other dotfiles (`~/.ssh`, `~/.aws`, anything
not named) are never visible to that member's process at all, and a decoy-file test proves it. What
`home:` does **not** fix, and cannot: it scopes *what a granted member's process can see on disk* — it
never touched *who is allowed to hold the grant in the first place*, and that question is now decided,
not open: **"Connector trust-tier taxonomy" above's decision 3 rules the grant unit is, and stays, the
individual agent** — per-agent grants, no team-scoped flow. What remains a real, un-fixable-by-`home:`
residual is narrower than "who may hold it": **any** member holding that already-decided per-agent grant
can still use the live login, symlink or not; only the real `codex login`/`codex logout` revokes it.
`levare doctor` and the registry card both still say so plainly (now conditioned on whether `home:` is
declared), rather than let a scoped grant read as a per-member-revocable one. A connector declaring no
`home:` at all gets the pre-CAP-B behaviour unchanged — the member's process sees the operator's entire
real `HOME` — and a new warning (`SUBSCRIPTION_NO_HOME`) names that gap explicitly.

## Install script and Homebrew formula — closed (NOTES DIST6)

`scripts/install.sh` (POSIX `sh`, no bashisms) is the one-line installer DIST2 left for a later step:
`curl -fsSL https://raw.githubusercontent.com/go4cas/levare/main/scripts/install.sh | sh` detects
OS/arch, maps it to one of the four release assets (anything else fails, naming the platform it
found), resolves the latest GitHub Release via its `/releases/latest/download/<asset>` redirect
unless `LEVARE_VERSION=vX.Y.Z` pins a specific one, downloads the binary and `SHA256SUMS`, verifies
the checksum and refuses to install on a mismatch (leaving nothing behind — the download lands in a
`mktemp -d` scratch dir cleaned up by a trap, never touching the install destination until the
checksum passes), installs to `~/.local/bin/levare` unless `LEVARE_BIN_DIR` overrides it, and warns
without fixing it if that directory is off `PATH`. Re-running it is idempotent — it simply
re-downloads and overwrites. `tests/install-script.test.ts` proves platform mapping, latest-vs-pinned
resolution, the `LEVARE_BIN_DIR` override, checksum-mismatch refusal (including that nothing is left
behind, in the bin dir or the scratch `TMPDIR`), the missing-from-`SHA256SUMS` case, idempotent
re-runs, and the PATH warning — all against a local fixture release layout (`file://` URLs into a temp
dir of fake assets and `SHA256SUMS`), never live GitHub; `tests/release-workflow.test.ts` now asserts
the README's `curl | sh` claim exists and its URL resolves to a real file in this repo, inverting its
pre-DIST6 assertion that no such claim existed yet.

**A Homebrew formula was declined, not deferred** — a Conductor ruling (NOTES DIST6): levare ships as
a single static binary with no library dependencies to resolve, so a formula would add a tap, a
per-release PR to keep it current, and an ongoing packaging dependency, for zero gain over the install
script above. This is a closed decision, not a placeholder for "someday."

## Native members unrunnable from a released binary — closed (NOTES DIST7)

A cold-start install of the v0.2.0 release on macOS arm64 — `levare init` scaffold, valid
`ANTHROPIC_API_KEY` in `.env` — reported `orchestrator: off · native CLI binary for darwin-arm64 not
found — reinstall @anthropic-ai/claude-agent-sdk on this platform`, making `wren`/`lyra`, the scaffold's
own example native members, unrunnable on the primary platform, for every user. The mechanism (read
directly from the SDK's shipped `sdk.mjs` and its own README, not guessed, and confirmed with a live
side-by-side repro — full detail in NOTES DIST7): `sdk-transport.ts#resolveNativeBinary` resolved the
SDK's platform binary via `require.resolve`, which needs a real `node_modules` tree to walk up from — a
`bun build --compile` binary has none (its `import.meta.url` resolves into Bun's virtual `$bunfs`).
The failure was CWD-dependent, not blanket: the resolver's fallback walk from `process.cwd()` happened
to succeed when invoked from inside levare's own repo (exactly where `bun test`'s existing
compiled-smoke test runs from), masking the bug in every prior test — a real release binary is always
invoked from a scaffolded studio, never levare's own source tree, where the fallback has nothing to
find.

Fixed per the SDK's own documented mechanism for this exact situation: the platform's native binary is
now embedded as a Bun file asset (a source-level `with { type: "file" }` import, which `bun build
--compile` packs into the binary at build time) and extracted to a real temp path with the SDK's own
`@anthropic-ai/claude-agent-sdk/extract#extractFromBunfs` before spawning — no `node_modules` lookup at
run time at all. That extraction runs inside `sdk-worker.ts` specifically, not the module that resolves
viability — neither `require()` nor a runtime dynamic `import()` of an SDK subpath works inside a
compiled binary (confirmed empirically), only a static top-level import unconditionally reachable from
the binary's own entry point does, and `sdk-worker.ts` is the one module already loaded that way (via
`cli.ts`'s hidden `__worker` dispatch), which also keeps the SDK package out of every offline command's
load path. `scripts/build.sh` now selects and embeds the correct platform's binary per build
target (dev build: host platform; release build: whichever `--target` it was given), verified
byte-for-byte (not just by import-specifier name) for all four release platforms
(`scripts/verify-embedded-binary.ts`, wired into `.github/workflows/release.yml`'s build matrix) and
proven live end-to-end for the host-executable target by running a real compiled binary from a cwd
genuinely outside the repo (`tests/native-binary-embed.test.ts` — fails against the pre-fix code,
passes after; darwin-arm64/darwin-x64/linux-x64 have the byte-embed proof but, honestly, no live-run
proof from this container, which cannot execute a foreign-OS/arch binary). The error message itself no
longer conflates a source-tree developer with a compiled-binary end user: a compiled binary that still
can't find its embedded binary (an unofficial build, or an unsupported platform) now gets a remedy it
can actually act on, instead of being told to `npm install` a package it never installed and read a
README heading (`README.md`'s "Phase 7 section") that, it turns out, doesn't exist.

## The loadRepo-per-request position

Every board route re-derives its `Repo` from disk on every request — no caching layer sits in front
of `loadRepo`. This is a deliberate reading of PRD invariant 2 ("the binary holds no state that
cannot be reconstructed by re-reading the repo"), not an oversight: a prior `withRepo()` wrapper in
`board/serve.ts` looked like it might be a future cache seam but was in fact a zero-behaviour alias,
and was removed rather than kept as an implied promise of caching to come (NOTES REV4, item 3a) — a
derivation cache would sit in real tension with invariant 2's own wording, so it isn't treated as a
"someday" item here so much as a standing tradeoff: simplicity and correctness (every render reflects
the actual current file state) over the read latency of large repos.

## The daemon only watches `work/` — a named, undecided gap, not a bug (NOTES DOCS-WALKTHROUGH-1)

`src/daemon.ts#start` watches `work/` (recursively, where the host supports it) and re-derives the
whole repo — registry included — the instant it starts. It does **not** watch `teams/`, `agents/`,
`connectors/`, `projects/`, or `.env`: editing any of those while `levare serve` is already running is
real on disk immediately but invisible to that running daemon until it's restarted, because nothing
under `work/` changed to schedule a walk. A live cold-start walkthrough of `docs/guide/04-workflow/`
hit this three times in one session, independently: a corrected `ANTHROPIC_API_KEY` in `.env`, a
freshly-created `unit.md`, and a connector `home:` edit each produced nothing until the process was
restarted. None of the three is a daemon bug on its own terms — `.env` is documented (`dotenv.ts`'s own
"on startup" contract) to load once; the registry has always been re-read fresh from disk on every walk,
just never on a schedule triggered by editing it directly. **Whether the daemon should widen what it
watches (registry, not just `work/`) is a real product question, deliberately not decided here** — this
entry, and the docs fix that prompted it, only make the CURRENT behaviour honest wherever a reader is
told to edit a registry file or a credential: `docs/guide/04-workflow/06-first-loop.md` (where a reader
first needs a restart to make progress), `07-the-daemon.md` (a new "What it doesn't watch" section),
`README.md`'s `.env` section, and `05-foreign-agent.md`'s connector/agent section all now say so
explicitly, with a restart as the stated fix, rather than leaving "make the correct edit, retry, fail
identically" as something a reader has to discover by hand.

## Guide code blocks are now executable content, verified — not just proofread (NOTES DOCS-WALKTHROUGH-1)

A live cold-start walkthrough of `docs/guide/04-workflow/` on a released binary found a `cat > … <<'EOF'`
block (the codex connector, in 4.5) that the studio's own parser rejected outright — a multi-line
double-quoted `scope:` value, a construct subset-YAML has never supported (`src/yaml.ts`'s own header
names it explicitly) — and a second, related defect in the same block: a missing `role:` field that made
the chapter's own sample `levare doctor` output describe a different connector than the one the block
actually declares. Both survived a PRIOR unit that rewrote that exact block's prose without re-running it
through the real parser — proofreading prose does not catch a broken heredoc. Fixed (the connector now
matches `src/init.ts#CONNECTOR_CODEX`'s own shape: single-line `scope:`, `role: model` present); the
parser's own error reporting fixed alongside it (`src/yaml.ts` — a frontmatter parse error now names the
correct line, and a would-be multi-line double-quoted scalar names the real constraint — single line only
— rather than "unterminated," a syntax symptom that reads as a typo to fix rather than a shape that isn't
supported at all).

**The standing guard:** `tests/guide-workflow-blocks.test.ts` extracts every `cat > <path> <<'EOF'` block
from `docs/guide/04-workflow/*.md`, in reading order, and replays them into a studio scaffolded the way
`levare init .` actually leaves one — running the real frontmatter parser and `validatePath` after each
paste, the same check a reader following along would get from re-running `levare validate .`. It fails
loudly (naming the code, file, line, and message) on any error, and specifically asserts neither
`SUBSCRIPTION_NO_ROLE` nor `SUBSCRIPTION_NO_HOME` ever appears undocumented — the exact class of drift
this entry closes. Without it, a broken or drifted block in this directory reads as clean until a reader
pastes it by hand; this is the check that makes that not true again.

## A test's own outer timeout could be shorter than the internal bound the code it drives is entitled to
## use — closed (NOTES DIST5-HANG)

`tests/orchestrator-compiled-smoke.test.ts`'s credential-present test ("the real spawn is attempted
end-to-end") hung at exactly 20000/20001ms across six recorded runs (macOS host, Linux CI), every time,
correlating with no commit — its own declared Bun `test()` timeout, not an unbounded wait anywhere in the
real call path. The route it drives (`POST /orchestrator/message` → `orchestrator.ts#handle` →
`interpret()`) is contractually bounded by `orchestrator-boundary.ts`'s own transport timeout (45s,
proven sound and reaping-complete by `tests/sdk-transport-hermetic.test.ts`'s hung-worker tests) — but
this test's own outer bound (20s) was shorter than that, so Bun's test runner killed the test before the
already-working internal timeout-and-report ever got the chance to fire, leaving the detached
worker+CLI process group orphaned (`killed 1 dangling process` at teardown). The same rule
`orchestrator-boundary.ts`'s own comment and `board/serve.ts#serve`'s `idleTimeout` comment already state
for every OTHER caller of this boundary — "your own outer timeout must stay comfortably longer than the
bound beneath it, never shorter" — had never been audited for a TEST's own declared timeout, one level
further out than either of those callers.

Closed by exporting the real bound (`orchestrator-boundary.ts#DEFAULT_INTERPRET_TIMEOUT_MS`, still 45s)
instead of leaving it inlined, deriving this test's own outer timeout from that export with margin
(60s) rather than a second guessed number, and locking the export to what `interpret()`/`narrate()`
actually default to with a dedicated unit test (`tests/orchestrator-sdk.test.ts`) — a future edit that
changes one without the other now fails immediately and loudly in that file, not as a 45-second mystery
hang in an unrelated compiled-binary test. See NOTES DIST5-HANG for the full instrumented reproduction
(direct worker invocation, direct compiled-binary self-invocation, a direct `curl` against a real booted
`serve` — none hung on this container, all completing in ~1–1.4s, consistent with "the internal bound
works, the outer one was just shorter than it") and for the separate, pre-existing, explicitly
untouched `readBoundPort` cold-start flake this investigation surfaced but did not cause or fix.

**What is NOT closed by this entry:** why a real host took 20-45s in the first place. Direct
measurement on this container refutes the initial "SDK retrying the fake credential with backoff"
guess (zero retries logged, `duration_api_ms: 0`, consistently under 1.1s — this literal key is
rejected locally before any request is built) and rules out silent dependency version drift
(`bun.lock` pins the SDK and every platform binary exactly, `--frozen-lockfile` in CI). The real
explanation remains open — `sdk-worker.ts` now logs every SDK-reported retry (`SDKAPIRetryMessage`:
attempt count, classified error status, backoff delay) and total elapsed wall-clock time
unconditionally on every exit path, specifically so the next real occurrence is diagnosable from
stderr instead of requiring this same investigation to be redone from a bare timeout.

## The registry rendered frontmatter selectively and dropped markdown bodies entirely — closed
## (NOTES REGISTRY-BODY)

A cold-start walkthrough on a released binary found that the registry's own cards render inconsistently
across entity kinds: the skill card shows a document's actual content (its `description`, falling back
to the body's first paragraph); every other card either showed a partial slice of the frontmatter or
dropped the body outright. Established before any code changed, because it decides whether the fix is
one shared helper or four independent ones: `renderRegistry` (registry.ts) builds each entity kind's
`inner` HTML inline, in its own `.map()` block — there is no common function a team/agent/knowledge/
project card all funnel through. **This was four separate omissions of the same mistake class, not one
root cause** — each kind's block independently chose not to render its own entity's body (and, for
team/agent, several already-parsed frontmatter fields alongside it). The type card's `gates` row was
already correct and became the reference for the team flow fix below; the skill card's own lead-paragraph
treatment became `components.ts#leadText`, reused by every other fix rather than re-inlined a third time.

**What was dropped, and what now renders, per kind:**

- **Type** — the `expects`/`gates` rows were already right; only the heading over them was wrong
  ("Expected kinds" implied `gates` was a kind). Renamed "Definition", matching the agent/connector
  cards' own heading for the identical k/v-row shape.
- **Knowledge** — a name and two tag chips, for a document whose entire value is its content, injected
  into member context by name. Now renders the document's own first paragraph.
- **Project pointer panel** (project.ts, not the registry proper, but the same class of card) — `pace`
  alone; `default_branch` (declared, shown nowhere) and the body (house rules, injected into every
  member's context for that project) are now rendered. "Constitution" renamed "Founding artifacts" —
  the same jargon-heading fix applied to the type/agent cards, made here too since it named its own
  content (founding artifacts + citation counts) metaphorically rather than plainly.
- **Agent** — kind/model/produces and a skills+knowledge "recipe" list. Dropped: the body (a member's
  system prompt, second person — "You are Wren, a product framer." answers exactly what a reader wants
  to know, and is already written), `tools`/`connectors` as VALUES (read only to decide whether to show
  a warning about them, never shown themselves), and every cli/remote field beyond kind/model
  (`command` — the literal argv that executes, `context_via`, `context_artifacts`, `cwd`, `timeout`,
  `server`, `tool`, `result`). `connectors` is the single most security-relevant field an agent
  declares and had no rendering at all. The body renders as its own first SENTENCE
  (`registry.ts#firstSentence`, new) — a deliberate density call, not a default: full second-person
  system-prompt prose reads oddly as card copy, and dropping it entirely was the defect this closes.
  "Context recipe" renamed "Skills & knowledge".
- **Team** — members/produces and a flow strip. Dropped: the charter (the team's own body — exactly
  "what does this team do", answered in one sentence by every scaffold team), `guardrails` (arguably
  second in importance only to what the team does, since it's the actual constraint a merge gate checks
  the diff against), and `knowledge`. All three now render.
- **Team flow row — the one most wrong.** The flow strip rendered `t.members`, a flat avatar chain
  carrying no flow information, on a board whose entire premise is Conductor approval AT A GATE.
  `teams/kestrel.md` declares five stages — two `gate: human` halts and a bounded loop with an
  escalation path — collapsed into three avatars indistinguishable from a linear handoff; both gates
  were invisible, and DECLARED FLOW read as a redundant repeat of the Definition block's own `members`
  row because the flow row carried no flow information to begin with. Each declared `FlowNode` now
  renders as itself: a `step` as the resolved member's avatar (`flow.ts#resolveStep`, the Runner's own
  step→member binding, reused rather than re-derived so the card can never disagree with what actually
  dispatches); a `gate` as the same `.diamond.is-gate` marker the run view's own mini-score already
  draws for a gate node, not a new glyph; a `loop` as both `between` member avatars joined by a loop
  glyph, captioned with `until`/`max_rounds`/`on_exhaust` underneath in `.mn` — a CSS class `.flowstrip`
  had defined since UI7 with no caller ever using it.

**Tests, driven from the scaffold, not a hand-built fixture:**
`tests/registry-cards-render-definitions.test.ts` scaffolds a real studio via `scaffoldStudio` +
`loadRepo` (the same tree `levare init` leaves) and asserts each fix against it, so a future edit that
changes the scaffold's shape without updating the renderer (or vice versa) fails here rather than
drifting apart silently. Its `cardFor()` helper scopes every assertion to a card's `<div
class="rendered">`, never the whole `<article>` — every card also carries a hidden `<textarea
class="rawmd-source">` holding the entity's full raw markdown (`esc()`-escaped, for the edit overlay),
and plain body text with no HTML-special characters reads identically whether it came from the real
render or that raw fallback; an assertion against the whole article would have passed even before any
of these fixes existed, purely because the raw source happens to repeat the same words. A dedicated
assertion isolates the flow row specifically and counts two `diamond is-gate` markers plus the loop's
own `spec.approved`/`3`/`gate` — the fix the goal named as most load-bearing.

One pre-existing test (`tests/board-render.test.ts`, the knowledge-card UI7 test) had banned the literal
substring "Injected into" appearing anywhere in a rendered knowledge card — a guard against the OLD
backlink section UI7 removed. It broke the moment the card legitimately rendered `house-style.md`'s own
body, which happens to use that exact phrase to describe itself ("Injected into member context when
referenced"). Narrowed to the actual regression it exists to catch: the old section's own heading
(`<div class="card__h">Injected into</div>`), never a blind substring ban on prose the fix is now
supposed to show.

No frontmatter schema changed. Every field rendered here already existed and already validated —
repo.ts parsed all of it before this unit started; the fix is entirely in `render/registry.ts`,
`render/project.ts`, and one small `components.ts` primitive (`leadText`), plus one CSS rule
(`.flowstrip .looppair`) for the loop's own avatar pair.

## The score rail called an uncoverable stage "queued" — closed (NOTES RAIL-UNREACHABLE)

A unit's type `expects:` a fixed shape of stages (e.g. `feature`: product-brief, design, spec, code,
review), but the team actually assigned to a unit may cover only part of that shape — `kestrel`
produces product-brief/design/spec/review between its members but nothing anywhere in the studio
produces `code`; the docs/guide walkthrough's `press` team covers only product-brief/review against the
same five-kind type. `derive.ts#scoreNodes` rendered every kind with no artifact as plain "wait"
("queued" on the rail) regardless of whether the responsible team could ever produce it — a Conductor
watching that row had no way to tell "real work not started yet" from "nothing will ever arrive here".

**Fixed with one shared computation**, `flow.ts#unreachableExpectedKinds`, checked against real
per-member capabilities rather than a team's own declared `produces:` aggregate (which can under- or
over-promise relative to its members). Two consumers, never two copies of the logic: the score rail
renders a new `"unreachable"` node state ("unreachable · no member produces this", the neutral-gray
`blocked` treatment, never "queued"); `levare validate` gains a new WARNING, `UNCOVERABLE_EXPECTED_KIND`
— never an error, since a team covering only part of a type's shape (a brief-and-review-only unit) is a
legitimate configuration, but the Conductor should be told rather than discovering it only as a rail row
stuck at "queued" forever.

Found alongside it on the same board walkthrough and closed together: a `.prow` row's label colliding
with its value when the label was long (`protected_branches`/`protected_paths` on the team card,
`context_artifacts` on the agent card — one shared CSS cause, `min-width` in place of a fixed `width`);
an orphaned join arrow when a team's flow row wraps onto a second line; and unit summaries on the
project and studio screens showing literal `**bold**` markdown instead of rendering it (a member-
authored artifact body's first paragraph went through plain `esc()` at those two call sites — a new
`derive.ts#renderInline` escapes first, then converts already-escaped `**…**` to `<strong>`).

The join-arrow fix took two passes — the first (nesting the arrow inside the same flex item as its
node) stopped the DOM from ever splitting across a wrap, but broke the connector's own vertical
alignment and left the loop's arrow still reading as visually orphaned, caught only by rendering the
real page in a browser, not by the DOM-assertion test suite. The corrected design takes the arrow out
of its pair's own flow entirely (`position:absolute`, anchored to the pair's left edge, landing inside
the `column-gap` reserved before it) so it renders beside its neighbour when one exists and is clipped
by `overflow:hidden` when it would otherwise be the leading, disconnected thing on a wrapped line —
see NOTES RAIL-UNREACHABLE's addendum for the full mechanism and the measurements that led to it.

See NOTES RAIL-UNREACHABLE for the full reasoning behind both fault-1 decisions (what the rail renders;
why `validate` warns instead of staying silent or hard-erroring) and why the CSS and markdown defects
were checked for, and found NOT to share, a single root cause. No frontmatter schema changed.

## The registry cards became dense and hard to scan, and one modal couldn't show its own file's top — closed (NOTES CARD-LEGIBILITY)

The previous unit (NOTES REGISTRY-BODY) fixed cards silently dropping fields and bodies the files
actually declared — a real defect. It also created a second-order problem: with everything rendering,
the cards are dense, ragged, and hard to scan. This unit closes four findings from the same board
walkthrough, in priority order.

**The Edit source modal opened scrolled to the frontmatter pane's own bottom**, clipping content with no
way to scroll back to the start — the one genuinely functional defect here (the modal is the board's
only write path). Root cause: `autoGrow()` measured `scrollHeight` while the overlay was still
`display:none` (reads 0), and focusing the frontmatter textarea afterward scrolled to reveal the caret,
which sits at the END of the text after `.value` is set. Fixed by unhiding before measuring and
explicitly resetting scroll position and caret to the start before focus runs; each pane now also caps
its own growth and scrolls independently (`max-height` + `overflow-y:auto` per textarea) instead of
sharing one region with fixed `min-height` fallbacks — the same bug's other visible symptom
("body has ample unused height, frontmatter has almost none").

**Teams and agents gain an optional `description:`**, rendered as a short, bold card headline above the
existing body-derived lead paragraph — additive, never a replacement (kestrel's charter, including "the
team never touches a project's main branch," keeps rendering unconditionally below it). Falls back to
no headline at all (not a manufactured one) when absent, so a studio with no `description:` anywhere
renders byte-identical to before this unit — matching the precedent skill/knowledge cards already set
with their own optional `description:`. Display-only: parsed and validated like every other card field,
never read by the Runner. The accepted cost: a hand-written description can drift from the body it
summarizes, and nothing detects that — see NOTES CARD-LEGIBILITY for the full argument against adding
the field at all, and why it was overridden.

**The declared-flow loop renders inline as the sequence's own fifth stage**, joined by the same
`&rarr;`/`.fpair` mechanism (NOTES RAIL-UNREACHABLE) every other node uses, wrapped in a new subtle
bordered enclosure (`.m--loopstage`) marking "one stage, two members alternating inside it." Its bound
and escalation path (`until`/`max_rounds`/`on_exhaust`) stay visible inside that enclosure at their
existing smaller, muted treatment — never moved to hover, since a Conductor approving a start gate needs
to see what happens if a loop never converges, not go looking for it.

**Registry cards stop stretching to a grid row's tallest sibling.** A prior round already pinned the
actions row to a stretched card's true bottom (`.rendered{flex:1}` + `.editbar{margin-top:auto}`) — that
kept every row's buttons on one baseline, but the leftover space still had to go somewhere, and it
landed as a blank region inside a shorter card's own content area (lyra/scribe next to corvid; press
next to kestrel) — exactly the void this unit reports. Pinning the footer relocates the leftover space,
it doesn't remove it. `.entity-grid{ align-items:start }` opts registry's own grid out of row-stretch
entirely (scoped so the studio's project-card grid, which doesn't share this problem, is untouched), so
each card is exactly as tall as its own content — an intentional ragged bottom across a row, never a
void. The old flex:1/margin-top:auto rules are removed, not left inert.

The loop's arrow-to-avatar alignment and the grid fix were both verified by rendering a real
`levare serve` in headless Chromium (the same lesson NOTES RAIL-UNREACHABLE's addendum names: a
DOM-string assertion passes through a layout defect) — against the exact studio docs/guide/04-workflow's
own chapters build up incrementally, the only fixture with enough flow elements to wrap and an uneven
grid row.

No frontmatter schema changed beyond the one new optional `description:` string on two entity kinds.
See NOTES CARD-LEGIBILITY for the full reasoning, the rejected alternative designs (an always-rendered
headline that would duplicate the lead paragraph's own opening sentence; footer-pinning instead of
content-height grid cards), and the measurements behind the arrow re-alignment.

## The orchestrator rail card held stale runner-side state — closed (NOTES ORCH-STALE-CARD)

A live cold-start session found the run view's own gate/dispatch card reading state that was no longer
true — stuck at `DISPATCHING` after the unit had gone `blocked`, naming a superseded artifact after a
retry, not showing a gate that opened after a successful dispatch until a manual refresh, and (the same
fault from the other direction) an open gate vanishing until a refresh brought it back. The score rail
and timeline on the SAME page always updated correctly. Root cause: the run view's gate card
(`orchestratorPanel`'s `actionableHtml`, render/shell.ts) was the one region of the page
`board/serve.ts#extractFragment`/`assets/app.js#swapFragment` never carved a marker for — every refresh
path (the SSE `reload` tick, any in-app navigation) replaces `.main` wholesale and, on a scope change
only, the persisted conversation tail, but had no way to know this region existed at all. The server's
own per-request read was never stale (`loadRepo` re-derives fresh every request — see "The
loadRepo-per-request position" above); the client simply never asked for this one region again after
the page's first cold GET. Fixed the same way the persisted tail already worked: a `data-orch-action`
marker plus a client-side resync (`syncOrchAction`) — applied on EVERY refresh, unlike the tail, since a
gate card has no "already shown live" case that would make reapplying it a duplicate.

Two content faults on the same card, found and fixed alongside it, independent of the propagation
question above: the Orchestrator briefing's one-line summary said "`<label> is ready for review below.`"
for every open gate regardless of kind — true for an in-review artifact, false for a blocked/failed one
("review is ready for review below." on a blocked review, observed live) or a start gate ("start is
ready for review below." — nothing produced yet). New `derive.ts#gateBriefingSentence` states what's
actually true per `gate.type`. Separately, the local dispatch-click handler (`assets/app.js`) updated
the start-gate card's badge and spinner instantly but never its `.gate__ctx` paragraph, which kept
reading its pre-click default until the next real re-render landed — now updated in the same handler.

**Found one element up, after the fix above shipped and was verified live: the narrated briefing
sentence had the identical propagation gap.** Approving a studio's last open gate correctly cleared the
action region and the `Gates on you` stat, but the sentence directly above them — "2 gates are on you.
Ask me about any project or open a gate to review it." — survived two in-app navigations, now
contradicting the `0` stat one line below it. `orchestratorPanel`'s `briefingHtml` parameter shared the
exact same marker-less path into `.orch__body` as `actionableHtml` did before its own fix; a
`data-orch-briefing` marker plus an unconditional `syncOrchBriefing` closes it the identical way. The
original fix scoped itself to "the region with buttons on it" (the one obviously-interactive surface)
and under-covered "every region whose content is derived from the same live gate list" — worth
remembering the next time a region turns up stale this way: check every parameter carrying repo-derived
content into the panel, not just the one rendering verbs.

Investigated and explicitly NOT closed here: the same card's age reads as clock-derived but wrong by an
amount that isn't a timezone offset (7h on an artifact produced moments earlier, 8h an hour later).
Root cause found: every artifact-write site (`adapters.ts`'s production path, `dagwalk.ts#writeBlocked`,
`merge.ts#formatMergeArtifact`'s caller) stamps `created` as a bare calendar date
(`new Date().toISOString().slice(0, 10)`), never a timestamp — `ageLabel` then measures from that
date's UTC midnight, not from the artifact's real creation moment, which is never recorded at all. **A
second consumer of the identical defect: the studio's `Median gate response` stat**
(`derive.ts#medianGateResponseDays`) reads `1d` for a gate opened and approved the same working
session, because it too measures a day-granularity delta between `created` and a date regex-extracted
from `approved_by` — real minutes apart, a full day apart by this arithmetic whenever the two events
straddle a UTC midnight. A real fix means widening BOTH `created` and `approved_by` to a full
timestamp — a frontmatter-shape change touching every write site and every `.created`/`approved_by`
consumer in `derive.ts` (`leadingArtifact`, `projectLastActivity`, `recentReleases`,
`medianGateResponseDays`), out of scope for a unit titled "stop the card showing state that is no
longer true." Logged here as a real, understood, open defect with both consumers named, so the
eventual schema change knows what it needs to fix.

Also investigated and confirmed SEPARATE, not the same mechanism: the daemon's own startup-only reads
(`.env` loaded once, `teams:`/`connectors:`/a fresh `unit.md` invisible until `levare serve` restarts —
"The daemon only watches `work/`" above, NOTES DOCS-WALKTHROUGH-1). That gap is about what makes the
RUNNING DAEMON PROCESS re-walk and re-dispatch; this one is about what makes the BROWSER re-fetch and
re-apply a region of a page the board's own per-request read had already answered correctly. Different
code paths (`daemon.ts` vs. `board/serve.ts`), left as two gaps, not merged into one fix.

See NOTES ORCH-STALE-CARD for the full mechanism, the fourth symptom's exact reproduction (a client-side
navigation between two units in the same project, never resyncing the action region because the
conversation `scope` — a project, not a unit — never changes), and the age-label root-causing in full.
See its addendum for the briefing-sentence gap found afterward and why the original fix's own scoping
missed it.

## Ten cold-start-walkthrough findings — closed (NOTES DOCS-WALKTHROUGH-2); one was a decision

A second live cold-start walkthrough (install through first loop, on a released binary) found ten small
defects; nine were one-line-cause fixes, closed as stated below. The tenth — doctor's `orchestrator: on`
claim for a credential whose validity was never actually checked — needed a real decision, made and
recorded, not merely an edit; read NOTES DOCS-WALKTHROUGH-2 for its full reasoning, not the summary here.

**Bare `levare doctor` now defaults to the current directory**, not `fixtures/golden` (levare's own dev
fixture, previously the compiled-in default regardless of where `doctor` was actually run from) —
`context`/`serve` keep that dev-convenience default unchanged, deliberately. **The install script now
names `levare init`** as the next command in its own closing line, matching what `init`'s own closing
line already does for the command after IT. **Doctor's `missing-env` consequence line now names the
literal remedy** (`cp .env.example .env, then set <NAME>`), matching the standard
`SUBSCRIPTION_NO_HOME`/`SUBSCRIPTION_HOME_SHIM_GAP` already set (field, consequence, AND the literal
fix) rather than stopping at diagnosis. **The Studio page's `Gates on you` stat no longer tints its
number amber at zero** — it carried a second, unconditional colour mechanism alongside `actionable`
that directly contradicted the Foundation stat-band rule `components.ts#Stat` itself documents; removed
to match the Project page's own identical stat, which never had the bug. **The loop-bounds tooltip
(`feat/board-card-legibility`) now renders below its trigger, not above** — it was placement-only and
functional, but "above" routinely overlapped the team charter paragraph and "Declared flow" heading
directly above the flow row; "below" lands in the card's ordinary pre-"Definition" spacing instead.
**A founding artifact's `cited N` now carries the same accessible tooltip treatment**, explaining what
the count is (how many other artifacts in the project declare this one in their own `consumes:`) —
keyboard-reachable, never hover-only, sharing its positioning logic with the (also-fixed) loop tooltip
via one generalized `wireTooltip` helper rather than a second copy of the same machinery.

Two Conductor rulings, carried out as stated rather than relitigated: **the scaffold's `work/` now
ships a tracked `.gitkeep`**, so a freshly-cloned studio keeps the directory where the job actually
happens (`evals/`/`ideas/` stay untracked-until-used, unchanged — genuinely empty-until-used, not a
papercut); and **the scaffold's example `cli` member (`finch`) now wraps plain `git`, not Codex** — a
founding example runnable on any machine with no purchase or login, while the DOCS keep Codex as their
own canonical `cli` example across chapters 4.5/4.6 (the most thoroughly live-validated `cli` member in
the project after NOTES R4-SANDBOX-TLS; docs and scaffold serve different audiences here).

One investigated and confirmed correct, unchanged: `approved_commit` (`gates.ts`/`board/gateops.ts`)
records the PRE-approval baseline commit, not the approval commit's own SHA — precisely what lets
`validate.ts`'s A7 check diff against a permanent ancestor and catch a committed post-approval edit that
a HEAD-diff would launder as unchanged. Recorded here so the question isn't re-asked.

See NOTES DOCS-WALKTHROUGH-2 for the doctor-credential decision's full reasoning (why a real API
round-trip was rejected in favor of honest wording — doctor's own standing classification as an offline
command, alongside the file's own established discipline of naming exactly what was checked and no
more), every finding's exact mechanism, and the tests each closes with.
