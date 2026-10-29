import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mem0Scope, normalizeRemote } from "../src/core/mem0-scope.js";

const hash10 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 10);
const scope = (rawRemote: string | undefined, over: { projectIdEnv?: string; userIdCandidates?: (string | undefined)[]; root?: string; topLevel?: string } = {}) =>
  mem0Scope({ rawRemote, root: over.root ?? "/work/my-app", topLevel: over.topLevel, projectIdEnv: over.projectIdEnv, userIdCandidates: over.userIdCandidates ?? [] });

const remotes: [string, string, string][] = [
  ["git@github.com:BeeTrain/archivist.git", "BeeTrain-archivist", "https://github.com/BeeTrain/archivist"],
  ["https://user:tok@GitHub.com/BeeTrain/Archivist/", "BeeTrain-Archivist", "https://github.com/BeeTrain/Archivist"],
  ["ssh://git@git.example.com:2222/team/app.git", "team-app", "ssh://git.example.com:2222/team/app"],
];

describe("the mem0 scope", () => {
  it.each(remotes)("normalizes %s the way the mem0 plugin does", (raw, _appId, identity) => {
    expect(normalizeRemote(raw)).toBe(identity);
  });

  it.each(remotes)("gives %s the mem0 plugin's app_id and agent_id", async (raw, appId, identity) => {
    expect(await scope(raw)).toMatchObject({ appId, agentId: `${appId}-${hash10(identity)}` });
  });

  it.each([
    ["https://user@[::1]:8080/o/r.git", "https://::1:8080/o/r"],
    ["https://[2001:DB8::1]/o/r", "https://2001:db8::1/o/r"],
    ["https://host:0/o/r", "https://host/o/r"],
  ])("normalizes %s the way Python's urlsplit rebuilds it", (raw, identity) => {
    expect(normalizeRemote(raw)).toBe(identity);
  });

  it("hashes the git top-level folder, not the folder the session started in", async () => {
    expect(await scope(undefined, { root: "/work/my-app/src", topLevel: "/work/my-app\n" })).toMatchObject({ appId: "my-app", agentId: `local-my-app-${hash10("/work/my-app")}` });
  });

  it("names a folder without a remote by its path", async () => {
    expect(await scope(undefined)).toMatchObject({ appId: "my-app", agentId: `local-my-app-${hash10("/work/my-app")}` });
  });

  it("takes MEM0_PROJECT_ID as the app_id, but not a wildcard", async () => {
    expect((await scope(remotes[0]![0], { projectIdEnv: "shared-app" })).agentId).toBe(`shared-app-${hash10(remotes[0]![2])}`);
    expect((await scope(remotes[0]![0], { projectIdEnv: "**" })).appId).toBe("BeeTrain-archivist");
  });

  it("takes the first user id that is set and is not a wildcard, else default", async () => {
    expect((await scope(undefined, { userIdCandidates: [undefined, " ", "*", "dev-user", "other"] })).userId).toBe("dev-user");
    expect((await scope(undefined)).userId).toBe("default");
  });
});
