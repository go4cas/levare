// levare — team-colour derivation rules (Phase 1 foundation)
//
// Base brief: "Color means team ... The renderer owns derivation rules: tint generation via
// color-mix, a contrast floor for avatar text (white on a raw light hue must be corrected
// automatically), and a minimum perceptual distance from the Podium accent and gate brass so
// user-declared hues cannot impersonate system colors."
//
// Team colour is USER DATA — a team's definition file declares one raw hex hue. This module is
// the pure-function derivation: raw hex in, a corrected hue + safe avatar-text colour out. It
// implements the RULES, not any specific hue. No dependencies, vanilla JS, works in any browser
// with no build step (plain <script>, also usable from Bun/Node for future server-side reuse).
//
// Math: sRGB <-> OKLab/OKLCH via Björn Ottosson's public-domain formulas
// (https://bottosson.github.io/posts/oklab/). Contrast via the standard WCAG relative-luminance
// formula. Both are well-known, unpatented constructions — not a third-party dependency.

(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.levareTeamColor = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- sRGB <-> linear <-> OKLab <-> OKLCH ----------

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`team-color: not a 6-digit hex colour: ${hex}`);
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex({ r, g, b }) {
    const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }

  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, v * 255));
  }

  function rgbToOklab({ r, g, b }) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return {
      L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    };
  }

  function oklabToRgb({ L, a, b }) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
    const lr = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const lg = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const lb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    return { r: linearToSrgb(lr), g: linearToSrgb(lg), b: linearToSrgb(lb) };
  }

  function oklabToOklch({ L, a, b }) {
    const C = Math.sqrt(a * a + b * b);
    let H = (Math.atan2(b, a) * 180) / Math.PI;
    if (H < 0) H += 360;
    return { L, C, H };
  }
  function oklchToOklab({ L, C, H }) {
    const rad = (H * Math.PI) / 180;
    return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
  }

  function hexToOklch(hex) { return oklabToOklch(rgbToOklab(hexToRgb(hex))); }
  function oklchToHex(lch) { return rgbToHex(oklabToRgb(oklchToOklab(lch))); }

  // ---------- WCAG contrast ----------

  function relLuminance({ r, g, b }) {
    const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }
  function contrastRatio(hexA, hexB) {
    const la = relLuminance(hexToRgb(hexA)), lb = relLuminance(hexToRgb(hexB));
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  }

  // ---------- OKLab Euclidean distance (perceptual-ish) ----------

  function oklabDistance(hexA, hexB) {
    const a = rgbToOklab(hexToRgb(hexA)), b = rgbToOklab(hexToRgb(hexB));
    return Math.sqrt((a.L - b.L) ** 2 + (a.a - b.a) ** 2 + (a.b - b.b) ** 2);
  }

  // ---------- constants (the system colours a team hue must never impersonate) ----------

  const PODIUM = { light: "#C2402A", dark: "#E56A50" };
  const GATE = { light: "#8A6414", dark: "#C99A3C" };
  const WHITE = "#FFFFFF";
  const INK = "#191B21";

  const MIN_LIGHTNESS = 0.45;
  const MAX_LIGHTNESS = 0.72;
  const HARD_MIN_LIGHTNESS = 0.30;
  const HARD_MAX_LIGHTNESS = 0.85;
  const MIN_CHROMA = 0.09;   // floor for pastel/low-saturation input — the base brief's known issue
  const MAX_CHROMA = 0.26;   // ceiling to avoid neon oversaturation
  const MIN_DISTANCE = 0.12; // OKLab Euclidean units to stay clear of Podium / gate brass
  const CONTRAST_FLOOR = 4.5; // WCAG AA, small text

  /** Deterministic pseudo-hue for genuinely achromatic input (H is undefined at C≈0). */
  function fallbackHue(rgb) {
    return ((rgb.r * 53 + rgb.g * 97 + rgb.b * 193) % 360 + 360) % 360;
  }

  function circularDelta(a, b) {
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  /**
   * Derive a safe team hue + avatar text colour from a raw user-declared hex. The result is one
   * hue shared by both themes — light/dark never need two different team hues, because every
   * *surface* (avatar fill, chip tint, border) is produced by color-mix'ing this one hue against
   * the current theme's own --panel/--border at render time (see components.html for the
   * pattern), which already does the theme-adaptation. Both Podium and gate-brass theme variants
   * are checked as exclusion zones regardless of which mode is asking, so the one derived hue is
   * safe in both.
   * @param {string} rawHex
   * @returns {{ hue:string, avatarText:string, contrastRatio:number, meetsContrastFloor:boolean,
   *             rotatedDeg:number, chromaBoosted:boolean }}
   */
  function deriveTeamStyle(rawHex) {
    const rawRgb = hexToRgb(rawHex);
    let lch = hexToOklch(rawHex);

    const chromaBoosted = lch.C < MIN_CHROMA;
    if (lch.C < 0.02) lch.H = fallbackHue(rawRgb); // achromatic input has no meaningful hue
    lch.C = Math.min(MAX_CHROMA, Math.max(MIN_CHROMA, lch.C));
    lch.L = Math.min(MAX_LIGHTNESS, Math.max(MIN_LIGHTNESS, lch.L));

    // minimum perceptual distance from Podium accent + gate brass (both theme variants checked,
    // since a team's declared colour is rendered across both modes)
    const exclusions = [PODIUM.light, PODIUM.dark, GATE.light, GATE.dark];
    const originalH = lch.H;
    let rotatedDeg = 0;
    let step = 0;
    while (step <= 180) {
      const candidateHex = oklchToHex(lch);
      const tooClose = exclusions.some((ex) => oklabDistance(candidateHex, ex) < MIN_DISTANCE);
      if (!tooClose) break;
      step += 4;
      // alternate rotation direction each attempt, preferring the smallest total detour
      const dir = step % 8 < 4 ? 1 : -1;
      lch.H = ((originalH + dir * step) % 360 + 360) % 360;
      rotatedDeg = circularDelta(originalH, lch.H);
    }

    let hue = oklchToHex(lch);

    // contrast floor for avatar text: pick whichever of white/ink reads better, then, if neither
    // clears AA, nudge lightness (away from the chosen text colour) within a wider hard band.
    let candWhite = contrastRatio(hue, WHITE);
    let candInk = contrastRatio(hue, INK);
    let avatarText = candWhite >= candInk ? WHITE : INK;
    let best = Math.max(candWhite, candInk);

    let guard = 0;
    while (best < CONTRAST_FLOOR && guard < 20) {
      lch.L += avatarText === WHITE ? -0.02 : 0.02; // darken for white text, lighten for ink text
      if (lch.L < HARD_MIN_LIGHTNESS || lch.L > HARD_MAX_LIGHTNESS) break;
      hue = oklchToHex(lch);
      candWhite = contrastRatio(hue, WHITE);
      candInk = contrastRatio(hue, INK);
      const newText = candWhite >= candInk ? WHITE : INK;
      // once we've committed to a text colour, keep pushing lightness the same direction rather
      // than flip-flopping; only accept a flip if it's meaningfully better
      if (newText !== avatarText && Math.max(candWhite, candInk) > best + 0.05) avatarText = newText;
      best = avatarText === WHITE ? candWhite : candInk;
      guard++;
    }

    return {
      hue,
      avatarText,
      contrastRatio: Math.round(best * 100) / 100,
      meetsContrastFloor: best >= CONTRAST_FLOOR,
      rotatedDeg,
      chromaBoosted,
    };
  }

  return {
    deriveTeamStyle,
    contrastRatio,
    oklabDistance,
    hexToOklch,
    oklchToHex,
    PODIUM,
    GATE,
    MIN_DISTANCE,
    CONTRAST_FLOOR,
  };
});
