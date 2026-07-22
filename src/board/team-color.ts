// levare — team-colour derivation (Phase 2 cluster 1). Ports dev/foundation/team-color.js's math
// into the real app so avatar() actually applies the base brief's own rules — "a contrast floor for
// avatar text (white on a raw light hue must be corrected automatically), and a minimum perceptual
// distance from the Podium accent and gate brass so user-declared hues cannot impersonate system
// colors" — instead of rendering a team's raw declared hex verbatim with no correction. Ported rather
// than imported: dev/foundation is the design workspace, never a runtime dependency of shipped code.
//
// Math: sRGB <-> OKLab/OKLCH via Björn Ottosson's public-domain formulas
// (https://bottosson.github.io/posts/oklab/). Contrast via the standard WCAG relative-luminance
// formula. Both well-known, unpatented constructions — not a third-party dependency.

interface Rgb {
  r: number;
  g: number;
  b: number;
}
interface Oklab {
  L: number;
  a: number;
  b: number;
}
interface Oklch {
  L: number;
  C: number;
  H: number;
}

function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`team-color: not a 6-digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }: Rgb): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

function srgbToLinear(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c: number): number {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
}

function rgbToOklab({ r, g, b }: Rgb): Oklab {
  const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

function oklabToRgb({ L, a, b }: Oklab): Rgb {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lr = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const lb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return { r: linearToSrgb(lr), g: linearToSrgb(lg), b: linearToSrgb(lb) };
}

function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const C = Math.sqrt(a * a + b * b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C, H };
}
function oklchToOklab({ L, C, H }: Oklch): Oklab {
  const rad = (H * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

function hexToOklch(hex: string): Oklch {
  return oklabToOklch(rgbToOklab(hexToRgb(hex)));
}
function oklchToHex(lch: Oklch): string {
  return rgbToHex(oklabToRgb(oklchToOklab(lch)));
}

function relLuminance({ r, g, b }: Rgb): number {
  const f = (c: number) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrastRatio(hexA: string, hexB: string): number {
  const la = relLuminance(hexToRgb(hexA)), lb = relLuminance(hexToRgb(hexB));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function oklabDistance(hexA: string, hexB: string): number {
  const a = rgbToOklab(hexToRgb(hexA)), b = rgbToOklab(hexToRgb(hexB));
  return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
}

// The system colours a team hue must never impersonate (both theme variants — a team's declared
// colour renders across both modes, so both exclusion zones apply regardless of which mode asks).
const PODIUM = { light: "#C2402A", dark: "#E56A50" };
const GATE = { light: "#8A6414", dark: "#C99A3C" };
const WHITE = "#FFFFFF";
const INK = "#191B21";

const MIN_LIGHTNESS = 0.45;
const MAX_LIGHTNESS = 0.72;
const HARD_MIN_LIGHTNESS = 0.3;
const HARD_MAX_LIGHTNESS = 0.85;
const MIN_CHROMA = 0.09; // floor for pastel/low-saturation input — the base brief's known issue
const MAX_CHROMA = 0.26; // ceiling to avoid neon oversaturation
const MIN_DISTANCE = 0.12; // OKLab Euclidean units to stay clear of Podium / gate brass
const CONTRAST_FLOOR = 4.5; // WCAG AA, small text

function fallbackHue(rgb: Rgb): number {
  return (((rgb.r * 53 + rgb.g * 97 + rgb.b * 193) % 360) + 360) % 360;
}

function circularDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export interface TeamStyle {
  hue: string;
  avatarText: string;
  contrastRatio: number;
  meetsContrastFloor: boolean;
}

/**
 * Derive a safe team hue + avatar text colour from a raw user-declared hex. One hue shared by both
 * themes — every *surface* (avatar fill, chip tint, border) color-mixes this one hue against the
 * current theme's own --panel/--border at render time, which already does the theme-adaptation.
 * Falls back to the raw input, uncorrected, when it isn't a parseable 6-digit hex (defensive only —
 * `style.color` is a free-form string in the schema) rather than throwing mid-render.
 */
export function deriveTeamStyle(rawHex: string): TeamStyle {
  let rawRgb: Rgb;
  try {
    rawRgb = hexToRgb(rawHex);
  } catch {
    return { hue: rawHex, avatarText: WHITE, contrastRatio: 0, meetsContrastFloor: false };
  }
  const lch = hexToOklch(rawHex);

  if (lch.C < 0.02) lch.H = fallbackHue(rawRgb); // achromatic input has no meaningful hue
  lch.C = Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, lch.C));
  lch.L = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, lch.L));

  const exclusions = [PODIUM.light, PODIUM.dark, GATE.light, GATE.dark];
  const originalH = lch.H;
  let step = 0;
  while (step <= 180) {
    const candidateHex = oklchToHex(lch);
    const tooClose = exclusions.some((ex) => oklabDistance(candidateHex, ex) < MIN_DISTANCE);
    if (!tooClose) break;
    step += 4;
    const dir = step % 8 < 4 ? 1 : -1;
    lch.H = ((originalH + dir * step) % 360 + 360) % 360;
    circularDelta(originalH, lch.H);
  }

  let hue = oklchToHex(lch);

  let candWhite = contrastRatio(hue, WHITE);
  let candInk = contrastRatio(hue, INK);
  let avatarText = candWhite >= candInk ? WHITE : INK;
  let best = Math.max(candWhite, candInk);

  let guard = 0;
  while (best < CONTRAST_FLOOR && guard < 20) {
    lch.L += avatarText === WHITE ? -0.02 : 0.02;
    if (lch.L < HARD_MIN_LIGHTNESS || lch.L > HARD_MAX_LIGHTNESS) break;
    hue = oklchToHex(lch);
    candWhite = contrastRatio(hue, WHITE);
    candInk = contrastRatio(hue, INK);
    const newText = candWhite >= candInk ? WHITE : INK;
    if (newText !== avatarText && Math.max(candWhite, candInk) > best + 0.05) avatarText = newText;
    best = avatarText === WHITE ? candWhite : candInk;
    guard++;
  }

  return {
    hue,
    avatarText,
    contrastRatio: Math.round(best * 100) / 100,
    meetsContrastFloor: best >= CONTRAST_FLOOR,
  };
}
