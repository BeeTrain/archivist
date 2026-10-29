export interface Mem0Scope {
  appId: string;
  agentId: string;
  userId: string;
}

export const normalizeRemote = (remote: string): string => {
  let r = remote.trim();
  if (r.startsWith("git@") && r.includes(":")) r = `https://${r.slice(4).replace(":", "/")}`;
  if (r.endsWith(".git")) r = r.slice(0, -4);
  const url = r.match(/^([^:/?#]+):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (url) {
    const [, scheme, netloc, path, query = "", fragment = ""] = url;
    const [, host = "", port] = netloc!.slice(netloc!.lastIndexOf("@") + 1).match(/^(.*?)(?::(\d+))?$/)!;
    r = `${scheme!.toLowerCase()}://${host.toLowerCase()}${port ? `:${Number(port)}` : ""}${path}${query.length > 1 ? query : ""}${fragment.length > 1 ? fragment : ""}`;
  }
  return r.replace(/\/+$/, "");
};

const scopeValue = (raw: string | undefined): string => {
  const value = (raw ?? "").trim();
  return /^\*+$/.test(value) ? "" : value;
};

const appIdOf = (rawRemote: string, identity: string, root: string, configured: string | undefined): string => {
  const fixed = scopeValue(configured);
  if (fixed) return fixed;
  let remote = (rawRemote || (identity.startsWith("local:") ? "" : identity)).trim();
  if (remote.endsWith(".git")) remote = remote.slice(0, -4);
  const prefix = ["https://", "http://", "ssh://", "git://"].find((p) => remote.startsWith(p));
  remote = prefix ? remote.slice(prefix.length) : remote.replace(/^git@/, "");
  const parts = remote.replace(":", "/").split("/").filter(Boolean);
  const name = parts.length >= 2 ? `${parts.at(-2)}-${parts.at(-1)}` : parts.at(-1);
  return name ? name.replaceAll("/", "-").replaceAll(":", "-") : root.split("/").filter(Boolean).at(-1) || "unknown";
};

const hash10 = async (text: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 10);
};

export const mem0Scope = async (args: {
  rawRemote: string | undefined;
  root: string;
  projectIdEnv: string | undefined;
  userIdCandidates: readonly (string | undefined)[];
}): Promise<Mem0Scope> => {
  const rawRemote = args.rawRemote ?? "";
  const identity = normalizeRemote(rawRemote) || `local:${args.root}`;
  const appId = appIdOf(rawRemote, identity, args.root, args.projectIdEnv);
  const agentId = identity.startsWith("local:") ? `local-${appId}-${await hash10(args.root)}` : `${appId}-${await hash10(identity)}`;
  const userId = args.userIdCandidates.map(scopeValue).find(Boolean) ?? "default";
  return { appId, agentId, userId };
};
