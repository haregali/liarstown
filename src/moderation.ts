// Minimal content moderation for public text (speeches, comments, bios, names).
// Blocks slurs / targeted hate and obvious spam. Keep this list conservative; false positives cost a turn.

const SLUR_PATTERNS: RegExp[] = [
  /\bn[i1!]+g+[e3]*r+s?\b/i, /\bn[i1!]gg?a+s?\b/i,
  /\bf[a@]gg?[o0]t+s?\b/i, /\bf[a@]g+s?\b/i,
  /\bk[i1]ke+s?\b/i, /\bsp[i1]c+s?\b/i, /\bch[i1]nk+s?\b/i, /\bg[o0]{2,}k+s?\b/i,
  /\btr[a@]nn(y|ie)s?\b/i, /\bret[a@]rd(s|ed)?\b/i, /\bwetb[a@]ck+s?\b/i,
  /\bbeaner+s?\b/i, /\bt[o0]welhead+s?\b/i, /\braghead+s?\b/i, /\bcoon+s?\b/i, /\bzipperhead+s?\b/i,
];
const HATE_PATTERNS: RegExp[] = [
  /\b(kill|gas|exterminate|lynch)\s+(all\s+)?(the\s+)?(jews|muslims|blacks|whites|gays|trans|immigrants|mexicans|asians|arabs)\b/i,
  /\b(heil\s+hitler|white\s+power|14\s*88)\b/i,
];
const SPAM_PATTERNS: RegExp[] = [
  /(https?:\/\/[^\s]+\s*){3,}/i, // 3+ links
  /\b(buy|free)\s+(crypto|bitcoin|nft|followers|viagra)\b/i,
  /(.)\1{24,}/, // 25+ repeated chars
];

export interface ModResult { ok: boolean; reason?: string }

export function moderate(text: string): ModResult {
  const t = text.normalize('NFKC');
  for (const re of SLUR_PATTERNS) if (re.test(t)) return { ok: false, reason: 'contains a slur' };
  for (const re of HATE_PATTERNS) if (re.test(t)) return { ok: false, reason: 'contains targeted hate' };
  for (const re of SPAM_PATTERNS) if (re.test(t)) return { ok: false, reason: 'looks like spam' };
  return { ok: true };
}

export function moderateName(name: string): ModResult {
  const r = moderate(name.replace(/[_.-]/g, ' '));
  if (!r.ok) return r;
  if (/\b(admin|moderator|liars\.?town|crier)\b/i.test(name)) return { ok: false, reason: 'reserved name' };
  return { ok: true };
}
