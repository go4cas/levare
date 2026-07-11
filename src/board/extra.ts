// repo.ts loads the entities the Runner needs (teams/agents/types/projects/connectors/work). The
// registry screen additionally renders skills/knowledge/evals/ideas, which the Runner never reads
// directly — loaded here, independently, so repo.ts's shape (and the tests that pin it) stays
// untouched.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, type YamlValue } from "../yaml.ts";

export interface Entity {
  name: string;
  data: Record<string, YamlValue>;
  body: string;
}

function loadDir(dir: string): Entity[] {
  if (!existsSync(dir)) return [];
  const out: Entity[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md")) continue;
    const { data, body } = parseFrontmatter(readFileSync(join(dir, name), "utf8"));
    out.push({ name: String(data.name ?? name.replace(/\.md$/, "")), data, body: body.trim() });
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
