# levare — security audit brief (v1.1)

**For:** two independent reviewers — Codex (adversarial, fresh checkout) and the architect (adversarial,
direct on the repo) — consolidated and adjudicated afterward.
**From:** Cas (the Conductor).
**Read first:** `docs/levare-prd.md` (§2 invariants), `docs/prd-amendment-1.md`,
`docs/prd-amendment-2.md` (the merge phase), and `NOTES.md` — especially C13/C15 (roles, auth),
CAP-A/CAP-B (the capability layer), MERGE-1/MERGE-2 (the merge phase). The FIRST audit
(`docs/security-audit.md`) predates all four of these; this one targets what it could not see.

---

## Posture

You are not reviewing this code. You are **attacking it.** The operator is a solo developer running
levare on their own machine with a real `ANTHROPIC_API_KEY`, a real ChatGPT/Codex subscription login on
disk, real GitHub push credentials in their shell, and a daemon that executes unattended between gates.

**Assume an adversary can influence:** the contents of any file in the studio repo; any artifact a
member produces; any third-party team/agent/skill/connector definition the operator vendors in; any web
content, repo, or issue a member reads while working; any text that reaches the Orchestrator; and the
work-branch contents a foreign CLI member commits. **Assume they cannot** type in the Conductor's chat
or approve a gate — the Conductor's approval is the one trusted act.

**A finding is a failing test, not an opinion.** For every vulnerability, produce a test demonstrating
the exploit against the real code path, then the fix. Findings without a demonstration are hypotheses —
label them so. Never fix by loosening a test.

**Rank:** Critical (unattended compromise, secret exfiltration, arbitrary code execution, unapproved
push to a real remote), High (invariant violation, guardrail bypass, silent corruption, credential
reaching a member that should not hold it), Medium (needs operator error or unlikely precondition), Low
(hardening).

---

## The four new surfaces — most of your effort belongs here

### 1. Proposal execution (CAP-A) — the argv injection surface

A `write` connector declares `actions:` as argv templates with `{placeholder}` slots. A member emits a
`proposal` artifact naming an action and `params`. On approval, levare substitutes params into the
template and **spawns a real process**.

Attack it: Can a param value break out of its slot — inject an extra flag, a shell metacharacter, a
second command, a `--` that changes how following args parse? Is substitution positional-argv (safe) or
does anything reach a shell (fatal)? Can params smuggle `-o ProxyCommand`-style flags into an action
whose template looks innocent? Can a proposal name an action or connector the producing member was
never granted? Can `params` be incomplete-but-passing, or contain types (arrays, objects, newlines)
the templater mishandles? Can a member propose against a `read` connector? The claim to break:
**"a member can cause at most the actions the connector's author declared, with values only in
declared slots."**

### 2. The env allowlist, withholding, and scoped HOME (CAP-A/CAP-B)

levare now makes strong isolation claims. Break each:

- **Withholding:** a `write`+`proposal` connector's env vars must NOT reach any member process. Prove
  they don't — or prove they do. Check every spawn path (native worker, cli member, the proposal
  executor itself, the merge/push). Does the executor leak *other* connectors' vars beyond the one it
  executes?
- **Scoped HOME:** a subscription connector with `home: [".codex"]` gives the member a scratch HOME
  symlinking only declared paths. Can the member escape it — resolve the symlink and walk up to the
  real HOME? Read `~/.ssh` via a relative path, a `..`, or a second symlink? Does the scratch HOME get
  cleaned up on crash/timeout, or accumulate live credential symlinks in tmp? Is `HOME` the only home
  var, or does `XDG_*`/`USERPROFILE` leak the real one?
- Can a member set its own env via its definition to re-introduce a withheld var?

### 3. The merge/push path (MERGE-1) — unapproved landing, guardrail bypass

`levare-runner` holds the power to merge to `default_branch` and push to a real remote.

Attack it: Can code reach `default_branch` **without** a merge-gate approval — via the work-branch
mechanism, a crafted `unit.md`, a self-referential project, or the daemon advancing something it
shouldn't? Can a **guardrail be bypassed** — `protected_paths`/`protected_branches`/`never` evaded by
path normalization (`./`, `..`, symlink, case, unicode), by a diff that touches a protected path
indirectly, or by the trial-merge and the real merge disagreeing about what the diff is (TOCTOU:
does the guardrail check the same tree that gets pushed)? Can the **trial merge** (scratch worktree)
be made to touch or corrupt real branch state? Can push go to a **remote the operator didn't declare**
(a `remote:` influenced by adversarial project content)? Does a push-failure rollback truly restore, or
can a torn state (local merged, push failed) persist? Can a work branch's member commits carry a
malicious `.git/hooks` or `.gitattributes` that fires during levare's merge?

### 4. Conversation persistence (V11-CONV) — injection into the record

Exchanges append to `conversations/<scope>/<YYYY-MM>.md`, committed by `levare-runner`.

Attack it: Can adversarial content in an Orchestrator exchange (a message quoting a malicious artifact)
inject into the file in a way that corrupts it, escapes the turn-block format, forges a turn, or writes
outside the intended path (scope = a project name — can a crafted scope traverse: `../../etc`,
absolute, a git-significant path like `.git/`)? Does the conversation write go through the same
confinement the registry-editor write does, or is it a new unconfined write path? Is anything from the
conversation file later *executed* or fed to a member as trusted context?

---

## Also re-test (the first audit's territory, now changed underneath it)

- The three mutating routes + the gate verbs (`approve`/`recheck`) — still exactly three, still
  CSRF-guarded, still path-confined? Did any v1.1 route slip the confinement?
- `after:`/start-gate consent (invariant 1, C8) — still no unattended first-member start?
- The compiled binary — do its `$bunfs`/self-invocation paths open anything the source path doesn't?
  Does `__worker` accept anything an attacker could reach?

---

## Deliverable

A ranked findings report: each finding with its exploit demonstration (or labeled hypothesis), the code
path, and a recommended fix. Do **not** fix in place during the audit — findings first, so both
reviewers' reports can be consolidated and the fixes prioritized as goals. The one exception: if you
find a **Critical** that is trivially and safely closable, note it as such but still leave the fix for
the consolidated plan, so nothing is fixed twice or in conflict.
