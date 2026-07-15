// repo.ts loads the entities the Runner needs (teams/agents/types/projects/connectors/work). The
// registry screen additionally renders skills/knowledge/evals/ideas, which the Runner never reads
// directly — loaded here, independently, so repo.ts's shape (and the tests that pin it) stays
// untouched.

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type YamlValue } from "../yaml.ts";

export interface Entity {
  name: string;
  data: Record<string, YamlValue>;
  body: string;
  /** Root-relative path of the file this entity was actually parsed from (e.g. `skills/spec-writing.md`
   * or `skills/new-project/SKILL.md`) — the single source of truth for where to read/validate/write
   * this entity. Callers must use THIS, never reconstruct `<dir>/<name>.md` from the entity name, or a
   * directory-form entity's card points at a file that was never read (empty buffer, invalid, and a
   * save would create a stray `<dir>/<name>.md` beside the real directory). */
  file: string;
}

export class RegistryEntityError extends Error {}

// Each directory entry is either a flat `<name>.md` file or (the Agent Skills convention, used by
// e.g. `skills/new-project/`) a folder containing its own `SKILL.md` bundled with supporting files —
// both resolve to one registry entity so the registry screen doesn't silently omit the latter. A
// sub-directory that plainly WAS meant as a bundle (it has markdown files of its own) but lacks the
// canonical `SKILL.md` name is a named error, not an arbitrary "pick the first .md by readdir order" —
// the same order-dependence class of bug this project keeps naming rather than allowing.
function loadDir(root: string, sub: string): Entity[] {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const name of readdirSync(dir).sort()) {
    let file: string;
    let relFile: string;
    let stem: string;
    if (name.endsWith(".md")) {
      file = join(dir, name);
      relFile = `${sub}/${name}`;
      stem = name.replace(/\.md$/, "");
    } else if (statSync(join(dir, name)).isDirectory()) {
      const bundled = join(dir, name, "SKILL.md");
      if (existsSync(bundled)) {
        file = bundled;
        relFile = `${sub}/${name}/SKILL.md`;
        stem = name;
      } else if (readdirSync(join(dir, name)).some((f) => f.endsWith(".md"))) {
        throw new RegistryEntityError(`${sub}/${name}/ has markdown files but no SKILL.md — expected the bundle's entry point to be named SKILL.md, not picked arbitrarily`);
      } else {
        continue;
      }
    } else {
      continue;
    }
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    out.push({ name: String(data.name ?? stem), data, body: body.trim(), file: relFile });
  }
  return out;
}

export interface RegistryExtras {
  skills: Entity[];
  knowledge: Entity[];
  evals: Entity[];
  ideas: Entity[];
}

export function loadExtras(root: string): RegistryExtras {
  return {
    skills: loadDir(root, "skills"),
    knowledge: loadDir(root, "knowledge"),
    evals: loadDir(root, "evals"),
    ideas: loadDir(root, "ideas"),
  };
}
