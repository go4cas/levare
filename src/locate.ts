// Locate the on-disk file for a given artifact id within a unit directory. repo.ts's loaders parse
// artifacts into memory but discard the source path; both the live walk (dagwalk.ts) and the board's
// write routes (board/gateops.ts) need the path back to edit-and-commit the same file the read side
// parsed from.

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./yaml.ts";

export interface Located {
  /** The markdown file carrying the frontmatter (the index file, for folder artifacts). */
  file: string;
  isFolder: boolean;
}

/** Find the artifact `id`'s file under `unitDir`. Mirrors repo.ts's loadUnitArtifacts discovery. */
export function locateArtifactFile(unitDir: string, id: string): Located | undefined {
  if (!existsSync(unitDir)) return undefined;
  for (const name of readdirSync(unitDir).sort()) {
    const full = join(unitDir, name);
    const s = statSync(full);
    if (s.isFile() && name.endsWith(".md") && name !== "unit.md") {
      if (idOf(full) === id) return { file: full, isFolder: false };
    } else if (s.isDirectory()) {
      const index = readdirSync(full).filter((n) => n.endsWith(".md"))[0];
      if (index && idOf(join(full, index)) === id) return { file: join(full, index), isFolder: true };
    }
  }
  return undefined;
}

function idOf(file: string): string | undefined {
  try {
    const { data } = parseFrontmatter(readFileSync(file, "utf8"));
    return typeof data.id === "string" ? data.id : undefined;
  } catch {
    return undefined;
  }
}
