// findings backlog #96: `levare serve` on a port already in use surfaced a raw Bun stack trace
// (`/$bunfs/root/levare:32974`, `EADDRINUSE` buried in it) — accurate, but it reads as a crash rather
// than as "a server is already running", which is what it almost always means. Observed live on
// 2026-08-22 while restarting a studio's daemon.
//
// `formatServeStartError` is the pure formatter that fix introduced. Tested directly rather than by
// binding a real port twice: the branch that matters is the message, and a port-collision fixture
// would add a flaky real-network dependency to prove wording — precisely the class of test this
// project has already had to retire once (findings #67/#109, the guide-block clone test).

import { test, expect, describe } from "bun:test";
import { formatServeStartError } from "../src/cli.ts";

describe("formatServeStartError (findings backlog #96)", () => {
  test("EADDRINUSE names the cause and both remedies — never a stack trace", () => {
    const msg = formatServeStartError(Object.assign(new Error("Failed to start server"), { code: "EADDRINUSE" }), 4173, "/studio");

    // What went wrong, in the operator's own vocabulary.
    expect(msg).toContain("port 4173 is already in use");
    expect(msg).toContain("already running");

    // What to do about it — both remedies, since which is right depends on intent.
    expect(msg).toContain("--port 4174");
    expect(msg).toContain("pgrep -fl 'levare serve'");

    // The regression this closes: no interpreter internals reach the operator.
    expect(msg).not.toContain("$bunfs");
    expect(msg).not.toContain("at ");
  });

  test("the suggested alternate port is derived from the one that failed, not hardcoded", () => {
    const msg = formatServeStartError(Object.assign(new Error("x"), { code: "EADDRINUSE" }), 8080, "/studio");
    expect(msg).toContain("port 8080 is already in use");
    expect(msg).toContain("--port 8081");
    expect(msg).not.toContain("4173");
  });

  test("the studio root is echoed back so the suggested command is copy-pasteable as-is", () => {
    const msg = formatServeStartError(Object.assign(new Error("x"), { code: "EADDRINUSE" }), 4173, "~/source/jot-studio");
    expect(msg).toContain("levare serve ~/source/jot-studio --port 4174");
  });

  test("any other startup failure still reports its own real reason, never a guessed one", () => {
    const msg = formatServeStartError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }), 80, "/studio");
    expect(msg).toContain("could not start on port 80");
    expect(msg).toContain("EACCES: permission denied");
    // Must never claim a port conflict it has no evidence for.
    expect(msg).not.toContain("already in use");
    expect(msg).not.toContain("pgrep");
  });

  test("a non-Error throw is still reported, not swallowed into an empty reason", () => {
    expect(formatServeStartError("something odd", 4173, "/studio")).toContain("something odd");
  });
});
