import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

// The UI8 chat redesign (NOTES) gave the Conductor's own message bubble (`.turn--user .turn__body`)
// the accent role (`--bg-accent`/`--text-accent`, both derived from `--accent`) — but levare's chosen
// accent direction is Podium vermilion, a warm red/coral (docs/levare-design-brief.md's "Podium —
// opera-house vermilion, around #C2402A"). A user's own message styled in the same hue as `--danger`
// (also warm red — see `:root`) reads as an error/alert, defeating the turn-taking clarity the bubble
// was meant to add. Fixed by replacing the accent-derived pair with a neutral pair (`--bg-user`/
// `--text-user`), derived from `--fg`/`--panel` the same way `--bg-accent` used to be derived from
// `--accent`/`--panel` — same "no new colour literal" recipe, different (neutral) ingredient.
const css = readFileSync("assets/styles.css", "utf8");

function rule(selector: string): string {
  const idx = css.indexOf(selector);
  expect(idx).toBeGreaterThanOrEqual(0);
  const end = css.indexOf("}", idx);
  return css.slice(idx, end + 1);
}

describe("the user-message bubble reads as 'your message', not an error (goal 2)", () => {
  test(".turn--user .turn__body never references the accent role, in any form", () => {
    const r = rule(".turn--user .turn__body");
    expect(r).not.toContain("var(--accent)");
    expect(r).not.toContain("var(--bg-accent)");
    expect(r).not.toContain("var(--text-accent)");
    expect(r).not.toContain("accent-ink");
  });

  test(".turn--user .turn__body never references the danger/error role either", () => {
    const r = rule(".turn--user .turn__body");
    expect(r).not.toContain("var(--danger)");
    expect(r).not.toContain("bg-danger");
  });

  test(".turn--user .turn__body uses a neutral fill/text pair", () => {
    const r = rule(".turn--user .turn__body");
    expect(r).toContain("background:var(--bg-user)");
    expect(r).toContain("color:var(--text-user)");
  });

  test("--bg-user/--text-user are derived from --fg/--panel (neutral), not --accent or --danger", () => {
    const rootMatch = css.match(/:root\{([\s\S]*?)\}/);
    expect(rootMatch).not.toBeNull();
    const root = rootMatch![1];
    const bgUserMatch = root.match(/--bg-user:([^;]+);/);
    const textUserMatch = root.match(/--text-user:([^;]+);/);
    expect(bgUserMatch).not.toBeNull();
    expect(textUserMatch).not.toBeNull();
    const bgUser = bgUserMatch![1];
    const textUser = textUserMatch![1];
    expect(bgUser).toContain("var(--fg)");
    expect(bgUser).toContain("var(--panel)");
    expect(bgUser).not.toContain("--accent");
    expect(bgUser).not.toContain("--danger");
    expect(textUser).toBe("var(--fg)");
  });

  test("the old accent-role tokens (--bg-accent/--text-accent) are gone, not just unused", () => {
    expect(css).not.toContain("--bg-accent");
    expect(css).not.toContain("--text-accent");
  });

  test("[data-theme=\"dark\"] declares no separate --bg-user/--text-user override — the neutral tint falls out of --fg/--panel's existing per-theme values, same as --bg-accent used to", () => {
    const darkMatch = css.match(/\[data-theme="dark"\]\{([\s\S]*?)\}/);
    expect(darkMatch).not.toBeNull();
    expect(darkMatch![1]).not.toContain("--bg-user");
    expect(darkMatch![1]).not.toContain("--text-user");
  });
});
