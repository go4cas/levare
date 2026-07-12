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
}

// Each directory entry is either a flat `<name>.md` file or (the Agent Skills convention, used by
// e.g. `skills/new-project/`) a folder containing its own `SKILL.md` bundled with supporting files —
// both resolve to one registry entity so the registry screen doesn't silently omit the latter.
function loadDir(dir: string): Entity[] {
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const name of readdirSync(dir).sort()) {
    let file: string;
    let stem: string;
    if (name.endsWith(".md")) {
      file = join(dir, name);
      stem = name.replace(/\.md$/, "");
    } else if (statSync(join(dir, name)).isDirectory() && existsSync(join(dir, name, "SKILL.md"))) {
      file = join(dir, name, "SKILL.md");
      stem = name;
    } else {
      continue;
    }
    const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
    out.push({ name: String(data.name ?? stem), data, body: body.trim() });
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
    skills: loadDir(join(root, "skills")),
    knowledge: loadDir(join(root, "knowledge")),
    evals: loadDir(join(root, "evals")),
    ideas: loadDir(join(root, "ideas")),
  };
}
