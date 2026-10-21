// Argument parsing shared by the CLI (argv) and the mod's /archivist command (one raw string).

/** Splits a command line the way a shell would for plain words, "double" and 'single' quotes. */
export const splitArgs = (s: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quote: string | undefined;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && (s[i + 1] === '"' || s[i + 1] === "\\")) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = "";
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
};

/** `--name value` options and the words around them; a `--flag` followed by another option or nothing is "true". */
export const parseOptions = (tokens: string[]): { words: string[]; opts: Record<string, string> } => {
  const words: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t.startsWith("--")) words.push(t);
    else if (i + 1 < tokens.length && !tokens[i + 1]!.startsWith("--")) opts[t.slice(2)] = tokens[++i]!;
    else opts[t.slice(2)] = "true";
  }
  return { words, opts };
};

export const commaList = (s: string | undefined): string[] => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);
