// Text helpers: normalization, similarity for dedupe, a tiny BM25 for picking relevant entries.

export const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[`*_~"'«»“”()[\]{}<>]/g, " ")
    .replace(/[^\p{L}\p{N}./:@+-]+/gu, " ")
    .trim();

export const tokens = (s: string): string[] => normalize(s).split(/\s+/).filter((t) => t.length > 1);

export const jaccard = (a: string, b: string): number => {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
};

export const slug = (s: string, max = 48): string =>
  normalize(s)
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "") || "entry";

export const truncate = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * Tokens for search: compound words split (`dev-мода` → `dev`, `мода`) and cut to a 5-letter stem, a crude
 * stemmer that is enough to match `мод`/`мода`/`модов` or `reload`/`reloads` in a few dozen entries.
 */
export const searchTokens = (s: string): string[] =>
  tokens(s)
    .flatMap((t) => t.split(/[-./:@+]+/))
    .filter((t) => t.length > 1)
    .map((t) => t.slice(0, 5));

const stemSet = (s: string): Set<string> => new Set(searchTokens(s));

/** Similarity over word stems, so a paraphrase of the same fact still counts: Jaccard, and overlap over the smaller set. */
export const stemSimilarity = (a: string, b: string): { jaccard: number; overlap: number } => {
  const A = stemSet(a);
  const B = stemSet(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return { jaccard: inter / (A.size + B.size - inter || 1), overlap: inter / (Math.min(A.size, B.size) || 1) };
};

/** How much of `text` (its stems) `source` contains: 1 when every stem of the text is in the source. */
export const coverage = (text: string, source: string): number => {
  const A = stemSet(text);
  const B = stemSet(source);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size || 1);
};

/** Standards and formats that look like ticket numbers: UTF-8, SHA-256, ISO-8601, RFC-2119, TLS-13… */
const NOT_TICKETS = /^(UTF|UCS|ISO|SHA|MD|RFC|HTTP|TLS|SSL|IPV|IEEE|ECMA|ES|X|BASE|AES|RSA|CRC|PEP|JSR|KB|MB|GB)$/;

/**
 * A ticket reference (`ADANDTECH-2542`, `PROJ-12`), also inside a branch name (`tech/ADANDTECH-2542-uitests`).
 * An entry carrying one is tied to the task at hand and goes stale with it.
 */
export const ticketRef = (s: string): string | undefined => {
  for (const m of s.matchAll(/(?<![A-Za-z0-9])([A-Z][A-Z0-9]{1,14})-(\d{2,})(?!\d)/g)) if (!NOT_TICKETS.test(m[1]!)) return `${m[1]}-${m[2]}`;
  return undefined;
};

/** The first code span of a text, normalized: what a command entry actually tells to run. */
export const firstCode = (s: string): string | undefined => s.match(/`([^`]+)`/)?.[1]?.replace(/\s+/g, " ").trim();

/** Scores docs against a query; returns indexes sorted by score, best first, zero scores dropped. */
export const bm25 = (docs: string[], query: string, k1 = 1.2, b = 0.75): { index: number; score: number }[] => {
  const docTokens = docs.map(searchTokens);
  const avg = docTokens.reduce((s, d) => s + d.length, 0) / Math.max(docTokens.length, 1);
  const df = new Map<string, number>();
  for (const d of docTokens) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const q = [...new Set(searchTokens(query))];
  return docTokens
    .map((d, index) => {
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (docs.length - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / (avg || 1)));
      }
      return { index, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
};

/** Glob → RegExp for `**`, `*` and `?` (enough for scope paths). */
export const globToRegExp = (glob: string): RegExp => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};
