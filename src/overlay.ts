// A single candidate file's content substituted for what's on disk — the registry editor's unsaved
// buffer (board/serve.ts's live-validation route), checked against the real repo without writing it.
// Shared by validate.ts and pricing.ts so a candidate edit to knowledge/model-pricing.md itself is
// seen by the cross-reference checks (UNKNOWN_MODEL) that read pricing off disk.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface OverlayFile {
  /** Resolved absolute path of the file this overlay stands in for. */
  path: string;
  content: string;
}

/** Read `file`, substituting `overlay.content` when `file` resolves to `overlay.path`. */
export function readOverlaid(file: string, overlay?: OverlayFile): string {
  if (overlay && resolve(file) === overlay.path) return overlay.content;
  return readFileSync(file, "utf8");
}
