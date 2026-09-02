# PRD Amendment 4 — §7 restated to match what promotion actually is

**Date:** 2026-09-02
**Author:** Cas (the Conductor)
**Applies to:** `docs/levare-prd.md` v1.1, as amended by Amendments 1, 2, and 3
**Occasioned by:** Finding 183. §7 described promoting an idea into a project as a five-part
recipe — `gh repo create`, clone, write the `projects/<name>.md` pointer, ask for a deploy
target and house rules, commit — run by the Orchestrator through a `new-project` skill.
`orchestrator.ts#promoteIdea` only ever implemented one part of that (create an inception
unit, delete the idea file) and requires the project to already exist, so the "promote an
idea into a project" the PRD describes could never happen through it. The other half of the
recipe existed as `board/gateops.ts#runNewProjectSkill` — real, tested, git-clone-and-all —
but was never wired into the Orchestrator's intent grammar, reachable only from its own test.

---

## 1. Ruling — amend, don't build

**Promotion targets an existing project.** `levare project new` (Finding 137, RELEASE R1b)
already does the half of §7's recipe that is levare's to do: it registers a project whose
code already lives in a local git checkout — reading `default_branch`/`remote` straight off
it, writing the `projects/<name>.md` pointer, taking house rules on stdin, committing under
the operator's own git identity.

**What's missing — creating the remote itself — is deliberately not levare's job.** `gh repo
create` (or its GitLab/Gitea/bare-remote equivalent) is one command an operator runs before
`levare project new`, not a step levare should own: shelling out to a vendor CLI to create
repositories on a Conductor's behalf is a materially larger commitment (another credential
surface, another vendor-specific failure mode, another thing `doctor` has to reason about)
than reading facts off a checkout that already exists. levare's job starts once the checkout
exists.

## 2. §7 — restated

> Interprets intent into unit operations (open unit of type X, capture idea → `ideas/`,
> promote idea → project) — **promotion targets a project that already exists**, registered
> ahead of time with `levare project new` (the operator's own command, run outside the
> conversation — see the guide's [4.2](guide/04-workflow/02-promote-to-a-project.md)).
> Standing up the project's remote repository (`gh repo create` or equivalent) is the
> operator's own step before that; levare does not create or clone remote repositories.

The `new-project` skill in the scaffold (`skills/new-project/SKILL.md`) is rewritten to match:
it tells a member how to point the operator at `levare project new`, not how to run a repo-
creation script. The scaffold's `scripts/create-repo.sh` stub — the artifact of the old,
un-reachable recipe — is deleted.

## 3. `skill.scripts` and `type.promotable_to` — accepted, marked inert

Both fields validate and are preserved: rejecting them as unknown keys would fail every
studio scaffolded by a `v0.3.0`-or-earlier `levare init`, over fields levare itself put
there — asymmetric with Finding 179 (an enum *value* no writer ever produced; a straight
unknown-key rejection was correct there because nothing legitimate depended on it). Both now
carry a `levare validate` warning (`SKILL_SCRIPTS_INERT`, `TYPE_PROMOTABLE_TO_INERT`) naming
the gap without refusing the studio — the same shape `SUBSCRIPTION_NO_HOME` already uses for
an unscoped subscription connector. Neither field is written by a fresh `levare init` going
forward.

## 4. Constitutional effect

§7's promotion clause and the `new-project` skill line now read, in full force, as restated
above. `board/gateops.ts#runNewProjectSkill` (the tested-but-unreachable clone-and-write
implementation) is untouched by this amendment — it is not what promotion does going forward,
and whether it should be deleted is left to a follow-up unit rather than decided here.
