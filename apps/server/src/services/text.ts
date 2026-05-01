/**
 * Lightweight text utilities for fuzzy matching and grounding checks.
 *
 * We deliberately avoid pulling in a fuzzy-matching library: the metrics
 * are explainable, the dependency surface stays tiny, and the algorithms
 * are easy to test directly.
 */

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ") // strip punctuation, keep letters/digits
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(s: string): string[] {
  const n = normalizeText(s);
  return n ? n.split(" ") : [];
}

/**
 * Token-set ratio (à la fuzzywuzzy): compare the multiset overlap of tokens.
 * Returns a value in [0, 1].
 */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return inter / union;
}

/** Levenshtein distance (iterative, O(m*n) time, O(min(m,n)) space). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (a.length > b.length) [a, b] = [b, a];
  const prev = Array.from({ length: a.length + 1 }, (_, i) => i);
  const cur = new Array<number>(a.length + 1);
  for (let j = 1; j <= b.length; j++) {
    cur[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[i] = Math.min(
        cur[i - 1]! + 1, // insert
        prev[i]! + 1, // delete
        prev[i - 1]! + cost, // substitute
      );
    }
    for (let i = 0; i <= a.length; i++) prev[i] = cur[i]!;
  }
  return prev[a.length]!;
}

/** Symmetric similarity in [0, 1] from edit distance over normalized strings. */
export function ratio(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;
  const d = levenshtein(na, nb);
  const max = Math.max(na.length, nb.length);
  return 1 - d / max;
}

/** Best of token-set and edit-ratio — robust to word order *and* typos. */
export function fuzzyScore(a: string, b: string): number {
  return Math.max(tokenSetRatio(a, b), ratio(a, b));
}

/**
 * Normalize medication frequency expressions so e.g. "BID" == "twice daily".
 * Keeps the door open: we map common prescriber abbreviations to a canonical
 * form *before* fuzzy matching dose/frequency strings.
 */
// Order matters: more specific patterns first so they consume "twice daily"
// before the generic "daily ⇒ qd" rule has a chance to grab it.
const FREQ_CANON: [RegExp, string][] = [
  [/\bq6h\b|\bevery\s+6\s+hours?\b/g, "q6h"],
  [/\bq8h\b|\bevery\s+8\s+hours?\b/g, "q8h"],
  [/\bq12h\b|\bevery\s+12\s+hours?\b/g, "q12h"],
  [
    /\bq\.?i\.?d\.?\b|\bfour\s+times\s+(a\s+)?(day|daily)\b|\b4x\s+daily\b/g,
    "qid",
  ],
  [
    /\bt\.?i\.?d\.?\b|\bthree\s+times\s+(a\s+)?(day|daily)\b|\b3x\s+daily\b/g,
    "tid",
  ],
  [/\bb\.?i\.?d\.?\b|\btwice\s+(a\s+)?(day|daily)\b|\b2x\s+daily\b/g, "bid"],
  [
    /\bq\.?d\.?\b|\bonce\s+(a\s+)?(day|daily)\b|\bdaily\b/g,
    "qd",
  ],
  [/\bprn\b|\bas\s+needed\b/g, "prn"],
];

export function canonicalizeFrequency(s: string | null | undefined): string {
  if (!s) return "";
  let out = " " + normalizeText(s) + " ";
  for (const [re, repl] of FREQ_CANON) out = out.replace(re, repl);
  return out.trim();
}

export function canonicalizeDose(s: string | null | undefined): string {
  if (!s) return "";
  return normalizeText(s).replace(/\s+/g, "");
}
