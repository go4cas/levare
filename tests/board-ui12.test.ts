import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { callout } from "../src/board/components.ts";
import { loadRepo, type Repo } from "../src/repo.ts";
import { renderRegistry } from "../src/board/render.ts";
import type { Connector } from "../src/types.ts";

// NOTES UI12 — the message-severity scale (note/warning/danger) and the `callout()` primitive that
// is now the ONLY way a note/warning/danger message block is produced anywhere on the board. Closes
// the gap NOTES UI11 documented: the C13 connector warning had a tinted panel but no colour, because
// nothing in the design brief defined a warning treatment. The brief now defines NOTE/WARNING/DANGER
// alongside (not instead of) the status palette, with warning amber reserved exclusively for this
// channel — distinct from gate brass, which stays reserved exclusively for entity lifecycle state.

// NOTES REV4: render.ts is now a thin re-export barrel over render/ — see board-components.test.ts's
// identical RENDER_SRC construction for why this concatenates the whole directory, not just the barrel.
const RENDER_SRC = [
  readFileSync("src/board/render.ts", "utf8"),
  ...readdirSync("src/board/render").map((f) => readFileSync(`src/board/render/${f}`, "utf8")),
].join("\n");
const COMPONENTS_SRC = readFileSync("src/board/components.ts", "utf8");
const CSS = readFileSync("assets/styles.css", "utf8");

const root = "fixtures/golden";
const repo = loadRepo(root);

function subscriptionConnectorRepo(): Repo {
  const connectors = new Map<string, Connector>([
    ["codex", { name: "codex", kind: "cli", command: "codex", env: [], auth: "subscription", plan: "ChatGPT Plus — flat monthly rate" }],
  ]);
  return { root: "/tmp/nonexistent-ui12-connectors", teams: new Map(), agents: new Map(), types: new Map(), projects: new Map(), connectors, units: [], artifacts: new Map(), studio: {} };
}

describe("callout() primitive", () => {
  test("renders one of three distinct severity classes, never mixed", () => {
    expect(callout("note", "hi")).toBe('<div class="notice notice--note"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0" /><path d="M12 9h.01" /><path d="M11 12h1v4h1" /></svg><span class="notice__text">hi</span></div>');
    expect(callout("warning", "hi")).toContain('class="notice notice--warning"');
    expect(callout("danger", "hi")).toContain('class="notice notice--danger"');
  });

  test("each severity carries its own icon path — never sharing markup across severities", () => {
    const note = callout("note", "x");
    const warning = callout("warning", "x");
    const danger = callout("danger", "x");
    const iconOf = (html: string) => /<svg[\s\S]*?<\/svg>/.exec(html)![0];
    expect(iconOf(note)).not.toBe(iconOf(warning));
    expect(iconOf(note)).not.toBe(iconOf(danger));
    expect(iconOf(warning)).not.toBe(iconOf(danger));
  });

  test("body text is always plain — the severity lives in the wrapper class, never inline on the text", () => {
    for (const sev of ["note", "warning", "danger"] as const) {
      expect(callout(sev, "body")).toContain('<span class="notice__text">body</span>');
    }
  });
});

describe("severity tokens render visually distinct in CSS, and only warning touches amber", () => {
  test("three distinct .notice--* rules exist, each with its own background/border derivation", () => {
    expect(CSS).toContain(".notice--note{");
    expect(CSS).toContain(".notice--warning{");
    expect(CSS).toContain(".notice--danger{");
  });

  test("warning uses the --warning token; note and danger never do", () => {
    const noteRule = /\.notice--note\{[^}]*\}/.exec(CSS)![0];
    const noteIconRule = /\.notice--note svg\{[^}]*\}/.exec(CSS)![0];
    const warningRule = /\.notice--warning\{[^}]*\}/.exec(CSS)![0];
    const warningIconRule = /\.notice--warning svg\{[^}]*\}/.exec(CSS)![0];
    const dangerRule = /\.notice--danger\{[^}]*\}/.exec(CSS)![0];
    const dangerIconRule = /\.notice--danger svg\{[^}]*\}/.exec(CSS)![0];

    expect(warningRule + warningIconRule).toContain("var(--warning)");
    expect(noteRule + noteIconRule).not.toContain("var(--warning)");
    expect(dangerRule + dangerIconRule).not.toContain("var(--warning)");
  });

  test("--warning is a distinct token from --gate in both themes — the two ambers never share a value", () => {
    const rootBlock = /:root\{([\s\S]*?)\n\}/.exec(CSS)![1];
    const darkBlock = /\[data-theme="dark"\]\{([\s\S]*?)\n\}/.exec(CSS)![1];
    const lightGate = /--gate:(#[0-9A-Fa-f]+);/.exec(rootBlock)![1];
    const lightWarning = /--warning:(#[0-9A-Fa-f]+);/.exec(rootBlock)![1];
    const darkGate = /--gate:(#[0-9A-Fa-f]+);/.exec(darkBlock)![1];
    const darkWarning = /--warning:(#[0-9A-Fa-f]+);/.exec(darkBlock)![1];
    expect(lightWarning).not.toBe(lightGate);
    expect(darkWarning).not.toBe(darkGate);
  });

  test("no status-palette rule (.chip/.dot/.snode/.gate*) ever reads the --warning token", () => {
    const statusRules = CSS.match(/\.(chip|dot|snode|gate)[^{]*\{[^}]*\}/g) || [];
    expect(statusRules.length).toBeGreaterThan(0);
    for (const rule of statusRules) {
      expect(rule).not.toContain("var(--warning)");
    }
  });
});

describe("UI12: the C13 connector note routes through callout(\"warning\", …) and renders the warning treatment", () => {
  test("the note carries the notice--warning class and its icon", () => {
    const html = renderRegistry(subscriptionConnectorRepo(), "/tmp/nonexistent-ui12-connectors", "connectors");
    const card = /<article class="entity card" id="connectors-codex"[\s\S]*?<\/article>/.exec(html)![0];
    expect(card).toContain('<div class="notice notice--warning">');
    expect(card).toContain("<svg");
    expect(card).toContain("cannot scope this credential");
  });

  test("an auth: env connector carries no callout at all", () => {
    const html = renderRegistry(repo, root, "connectors");
    const github = /<article class="entity card" id="connectors-github"[\s\S]*?<\/article>/.exec(html)![0];
    expect(github).not.toContain('class="notice');
  });
});

describe("no board renderer emits a callout-shaped block except through the primitive", () => {
  test("render.ts never hand-builds a `notice notice--*` div literal", () => {
    expect(RENDER_SRC).not.toMatch(/class="notice notice--/);
  });

  test("render.ts imports callout from components.ts rather than re-deriving it", () => {
    // NOTES REV4: render/registry.ts sits one directory deeper than the old render.ts, so its import
    // is "../components.ts", not "./components.ts" — either relative depth is a real import, not a
    // re-derivation.
    expect(RENDER_SRC).toMatch(/import\s*\{[^}]*\bcallout\b[^}]*\}\s*from\s*"\.+\/components\.ts"/);
  });

  test("callout() is the only function in components.ts that emits a `notice notice--` string", () => {
    const literalOccurrences = (COMPONENTS_SRC.match(/notice notice--/g) || []).length;
    expect(literalOccurrences).toBe(1);
  });
});
