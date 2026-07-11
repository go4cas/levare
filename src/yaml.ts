// levare subset-YAML parser.
//
// A deliberately small, hand-rolled parser for the frontmatter subset declared in the PRD (§3):
// scalars, string/number arrays, and (block) maps. Nested block mappings and sequences are
// supported because the team `flow` / `loop` structure requires them (see NOTES.md A2), but
// genuine YAML exotica is *rejected* — the subset being a feature means these constructs are
// errors, not silently-accepted extras:
//
//   - anchors (`&a`) and aliases (`*a`)
//   - tags (`!!str`)
//   - flow maps (`{ a: 1 }`)
//   - block scalars (`|`, `>`)
//   - multiple documents (`---` / `...` inside the body)
//   - complex/quoted mapping keys
//   - tab indentation
//
// Inline flow *sequences* (`[a, b, c]`) are supported since the PRD's own example uses them.

export class YamlError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "YamlError";
    this.line = line;
  }
}

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  indent: number;
  content: string; // trimmed of trailing whitespace, leading indent stripped
  raw: string;
  number: number; // 1-indexed source line
}

function tokenizeLines(src: string): Line[] {
  const out: Line[] = [];
  const rawLines = src.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i];
    const lineNo = i + 1;
    if (raw.includes("\t")) {
      // Only reject tabs used as indentation; a tab inside a value is a caller problem, not ours.
      if (/^\s*\t/.test(raw)) {
        throw new YamlError("tab indentation is not allowed in subset-YAML", lineNo);
      }
    }
    const stripped = stripComment(raw);
    if (stripped.trim() === "") continue; // blank / comment-only line
    const indent = stripped.length - stripped.trimStart().length;
    out.push({
      indent,
      content: stripped.trim(),
      raw,
      number: lineNo,
    });
  }
  return out;
}

// Remove a trailing `# comment`, honoring quotes. A `#` only starts a comment when preceded by
// whitespace or at line start (so `a#b` and URLs like `http://x#y` survive).
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/** Parse a subset-YAML document string into a plain JS value. */
export function parse(src: string): YamlValue {
  const lines = tokenizeLines(src);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0].indent);
  if (next < lines.length) {
    throw new YamlError(
      `unexpected indentation; expected end of document but found more content`,
      lines[next].number,
    );
  }
  return value;
}

// Parse a block (mapping or sequence) whose items sit at exactly `indent`.
// Returns [value, indexOfFirstUnconsumedLine].
function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start];
  if (first.indent !== indent) {
    throw new YamlError("unexpected indentation", first.number);
  }
  if (first.content.startsWith("- ") || first.content === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const items: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside sequence", line.number);
    }
    if (!(line.content === "-" || line.content.startsWith("- "))) {
      // A non-`-` line at this indent ends the sequence (belongs to an outer block).
      break;
    }
    const afterDash = line.content === "-" ? "" : line.content.slice(2).trim();
    if (afterDash === "") {
      // Value lives on following, more-indented lines.
      const [child, next] = childBlock(lines, i + 1, indent, line.number);
      items.push(child);
      i = next;
    } else if (isInlineKeyValue(afterDash)) {
      // `- key: value` — a mapping item whose first key is inline; subsequent keys are indented
      // to the column of the inline key.
      const virtualIndent = indent + (line.content.length - afterDash.length);
      const rebuilt: Line = { ...line, content: afterDash, indent: virtualIndent };
      const scratch = [rebuilt, ...lines.slice(i + 1)];
      const [child, consumed] = parseMapping(scratch, 0, virtualIndent);
      items.push(child);
      i = i + consumed; // consumed counts lines in scratch; scratch[0] maps to lines[i]
    } else {
      items.push(parseScalar(afterDash, line.number));
      i++;
    }
  }
  return [items, i];
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): [{ [key: string]: YamlValue }, number] {
  const map: { [key: string]: YamlValue } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation inside mapping", line.number);
    }
    if (line.content.startsWith("- ") || line.content === "-") {
      // A sequence dash at mapping indent ends this mapping.
      break;
    }
    const { key, rest } = splitKey(line.content, line.number);
    if (key in map) {
      throw new YamlError(`duplicate mapping key '${key}'`, line.number);
    }
    if (rest === "") {
      // Nested block on following lines, or an explicit empty value (null).
      const [child, next] = childBlock(lines, i + 1, indent, line.number, /*allowEmpty*/ true);
      map[key] = child;
      i = next;
    } else {
      map[key] = parseScalar(rest, line.number);
      i++;
    }
  }
  return [map, i];
}

// Parse the more-indented block that provides a parent key/dash its value.
function childBlock(
  lines: Line[],
  start: number,
  parentIndent: number,
  parentLine: number,
  allowEmpty = false,
): [YamlValue, number] {
  if (start >= lines.length || lines[start].indent <= parentIndent) {
    if (allowEmpty) return [null, start];
    throw new YamlError("expected an indented value", parentLine);
  }
  return parseBlock(lines, start, lines[start].indent);
}

function isInlineKeyValue(s: string): boolean {
  // True when `s` begins a `key:` mapping (not a scalar that merely contains a colon).
  const m = /^[^\s:'"][^:]*:(\s|$)/.exec(s);
  return m !== null;
}

function splitKey(content: string, line: number): { key: string; rest: string } {
  const idx = findKeyColon(content);
  if (idx === -1) {
    throw new YamlError(`expected 'key: value' mapping entry`, line);
  }
  const key = content.slice(0, idx).trim();
  if (key === "") throw new YamlError("empty mapping key", line);
  if (key.startsWith('"') || key.startsWith("'")) {
    throw new YamlError("quoted mapping keys are not supported in subset-YAML", line);
  }
  const rest = content.slice(idx + 1).trim();
  return { key, rest };
}

// Find the colon that separates key from value (first `:` followed by space or EOL).
function findKeyColon(content: string): number {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === ":" && (i + 1 >= content.length || content[i + 1] === " ")) {
      return i;
    }
  }
  return -1;
}

function parseScalar(token: string, line: number): YamlValue {
  const t = token.trim();
  rejectExotica(t, line);
  if (t.startsWith("[")) return parseInlineSequence(t, line);
  if (t.startsWith("{")) {
    throw new YamlError("flow mappings ({ ... }) are not supported in subset-YAML", line);
  }
  return parseScalarAtom(t, line);
}

function rejectExotica(t: string, line: number): void {
  if (t.startsWith("&")) throw new YamlError("YAML anchors are not supported in subset-YAML", line);
  if (t.startsWith("*")) throw new YamlError("YAML aliases are not supported in subset-YAML", line);
  if (t.startsWith("!")) throw new YamlError("YAML tags are not supported in subset-YAML", line);
  if (t === "|" || t === ">" || /^[|>][+-]?$/.test(t)) {
    throw new YamlError("block scalars (| and >) are not supported in subset-YAML", line);
  }
}

function parseScalarAtom(t: string, line: number): YamlValue {
  if (t.startsWith('"')) return parseDoubleQuoted(t, line);
  if (t.startsWith("'")) return parseSingleQuoted(t, line);
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  if (isIntToken(t)) return parseInt(t, 10);
  if (isFloatToken(t)) return parseFloat(t);
  return t; // bare string
}

function isIntToken(t: string): boolean {
  return /^[-+]?\d+$/.test(t);
}
function isFloatToken(t: string): boolean {
  return /^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t) && /[.eE]/.test(t);
}

function parseDoubleQuoted(t: string, line: number): string {
  if (!t.endsWith('"') || t.length < 2) {
    throw new YamlError("unterminated double-quoted string", line);
  }
  const inner = t.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      const n = inner[++i];
      if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === '"') out += '"';
      else if (n === "\\") out += "\\";
      else if (n === undefined) throw new YamlError("dangling escape in string", line);
      else out += n;
    } else {
      out += c;
    }
  }
  return out;
}

function parseSingleQuoted(t: string, line: number): string {
  if (!t.endsWith("'") || t.length < 2) {
    throw new YamlError("unterminated single-quoted string", line);
  }
  // In YAML single-quotes, '' is a literal quote; no other escapes.
  return t.slice(1, -1).replace(/''/g, "'");
}

function parseInlineSequence(t: string, line: number): YamlValue[] {
  if (!t.endsWith("]")) throw new YamlError("unterminated inline sequence", line);
  const inner = t.slice(1, -1).trim();
  if (inner === "") return [];
  const parts = splitTopLevel(inner, line);
  return parts.map((p) => {
    const atom = p.trim();
    if (atom.startsWith("[")) {
      throw new YamlError("nested inline sequences are not supported in subset-YAML", line);
    }
    if (atom.startsWith("{")) {
      throw new YamlError("flow mappings are not supported in subset-YAML", line);
    }
    return parseScalarAtom(atom, line);
  });
}

// Split on top-level commas, respecting quotes.
function splitTopLevel(s: string, line: number): string[] {
  const parts: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (c === "," && !inSingle && !inDouble) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  if (inSingle || inDouble) throw new YamlError("unterminated quoted string in inline sequence", line);
  return parts;
}

/**
 * Extract and parse YAML frontmatter from a markdown document.
 * Returns { data, body }. Throws YamlError if the frontmatter fences are malformed.
 */
export function parseFrontmatter(src: string): { data: { [k: string]: YamlValue }; body: string } {
  // Normalize a leading BOM.
  const text = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    throw new YamlError("document does not begin with a '---' frontmatter fence", 1);
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === "---" || trimmed === "...") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new YamlError("frontmatter is not terminated by a closing '---' fence", lines.length);
  }
  const fmText = lines.slice(1, end).join("\n");
  const body = lines.slice(end + 1).join("\n");
  const data = fmText.trim() === "" ? {} : parse(fmText);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new YamlError("frontmatter must be a mapping", 2);
  }
  return { data: data as { [k: string]: YamlValue }, body };
}
