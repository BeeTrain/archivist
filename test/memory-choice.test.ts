import { describe, expect, it } from "vitest";
import { chooseMemory, cloudAllowedBy, memorySyncBlock, memoryWhere, readMemoryOptions, storeNameFor, withCloudProject, withoutCloudProject, type MemoryOptions } from "../src/core/memory-choice.js";
import { config } from "./helpers.js";

const project = "github.com/beetrain/archivist";
const ov = "plugin:openviking-memory:openviking";
const options = (over: Partial<MemoryOptions> = {}): MemoryOptions => ({ memory: "auto", url: "", apiKey: "", cloudProjects: [], ...over });
const choose = (over: Partial<MemoryOptions>, more: { envKey?: string; openVikingServer?: string } = {}) =>
  chooseMemory({ options: options(over), project, envKey: more.envKey, openVikingServer: more.openVikingServer });

describe("the plugin options", () => {
  it("reads what /config stores and fills the gaps with defaults", () => {
    expect(readMemoryOptions({ memory: "mem0", memory_url: " http://localhost:8888 ", memory_api_key: " k-1 ", memory_cloud_projects: "GitHub.com/BeeTrain/*, ,github.com/a/b,\n" })).toEqual({
      memory: "mem0",
      url: "http://localhost:8888",
      apiKey: "k-1",
      cloudProjects: ["GitHub.com/BeeTrain/*", "github.com/a/b"],
    });
    expect(readMemoryOptions({ memory: "something else" })).toEqual(options());
  });

  it("reads a host that passes no options as the defaults", () => {
    expect(readMemoryOptions(undefined)).toEqual(options());
  });

  it("takes the project list as a list too, and drops repeats whatever their case", () => {
    expect(readMemoryOptions({ memory_cloud_projects: ["github.com/a/b", " GitHub.com/A/B ", "", "github.com/c/*"] }).cloudProjects).toEqual(["github.com/a/b", "github.com/c/*"]);
  });
});

describe("projects sent to cloud memory", () => {
  it.each<[string, string | undefined]>([
    [project, project],
    ["GitHub.com/BeeTrain/*", "GitHub.com/BeeTrain/*"],
    ["*", "*"],
    ["github.com/beetrain/archivist-docs", undefined],
    ["github.com/beetrain", undefined],
  ])("entry %s lets the project through: %s", (entry, by) => expect(cloudAllowedBy(project, [entry])).toBe(by));

  it("adds this project once and removes only its own entry", () => {
    expect(withCloudProject(["github.com/a/*"], project)).toEqual(["github.com/a/*", project]);
    expect(withCloudProject([project.toUpperCase()], project)).toEqual([project.toUpperCase()]);
    expect(withoutCloudProject(["github.com/beetrain/*", "GitHub.com/BeeTrain/Archivist"], project)).toEqual(["github.com/beetrain/*"]);
  });
});

describe("choosing the memory", () => {
  it("keeps entries in files only when memory is off, even with OpenViking connected", () => {
    expect(choose({ memory: "off" }, { openVikingServer: ov })).toMatchObject({ kind: "none" });
  });

  it("finds OpenViking on auto and never picks mem0 there, even with MEM0_API_KEY set", () => {
    expect(choose({}, { openVikingServer: ov, envKey: "k-env" })).toEqual({ kind: "openviking", server: ov });
    expect(choose({}, { envKey: "k-env" })).toMatchObject({ kind: "none" });
  });

  it("says OpenViking is not connected when it is chosen and missing", () => {
    expect(choose({ memory: "openviking" })).toEqual({ kind: "none", why: expect.stringContaining("not connected") });
  });

  it("takes the mem0 cloud for an empty address, with the key from the options or else MEM0_API_KEY", () => {
    expect(choose({ memory: "mem0", apiKey: "k-1", cloudProjects: [project] }, { envKey: "k-env" })).toEqual({ kind: "mem0", base: "https://api.mem0.ai", cloud: true, key: "k-1", allowed: true });
    expect(choose({ memory: "mem0", cloudProjects: [project] }, { envKey: "k-env" })).toMatchObject({ key: "k-env" });
  });

  it("asks for a key when the mem0 cloud has none", () => {
    expect(choose({ memory: "mem0" })).toEqual({ kind: "none", why: expect.stringContaining("MEM0_API_KEY") });
  });

  it("does not let a project into the cloud until the list has it", () => {
    expect(choose({ memory: "mem0", apiKey: "k-1" })).toMatchObject({ kind: "mem0", allowed: false });
  });

  it("takes an own server for any other address, for every project, and never gives it MEM0_API_KEY", () => {
    expect(choose({ memory: "mem0", url: "http://localhost:8888" }, { envKey: "k-env" })).toEqual({ kind: "mem0", base: "http://localhost:8888", cloud: false, key: undefined, allowed: true });
  });

  it("refuses an address that is not an http URL, or that carries a user name or password, without repeating it", () => {
    expect(choose({ memory: "mem0", url: "localhost:8888" })).toEqual({ kind: "none", why: expect.stringContaining("http://") });
    const withPassword = choose({ memory: "mem0", url: "https://me:s3cret@mem0.corp.example" });
    expect(withPassword).toEqual({ kind: "none", why: expect.stringContaining("user name or password") });
    expect(JSON.stringify(withPassword)).not.toContain("s3cret");
  });

  it("names the store and the place from the options alone", () => {
    expect(storeNameFor(options({ memory: "off" }))).toBeUndefined();
    expect(storeNameFor(options())).toBe("openviking");
    expect(storeNameFor(options({ memory: "mem0", url: "http://localhost:8888" }))).toBe("mem0-localhost-8888");
    expect(memoryWhere(choose({ memory: "mem0", url: "http://localhost:8888" }))).toBe("mem0 at http://localhost:8888");
    expect(memoryWhere(choose({ memory: "mem0", apiKey: "k-1" }))).toBe("mem0 cloud");
  });
});

describe("when not to sync", () => {
  const cloud = { kind: "mem0", base: "https://api.mem0.ai", cloud: true, key: "k-1", allowed: false } as const;

  it("stops for memory.enabled false even when the project is let in", () => {
    expect(memorySyncBlock({ ...config(), memory: { ...config().memory, enabled: false } }, { ...cloud, allowed: true }, project)).toContain("memory.enabled");
  });

  it("says how to send a project the cloud does not take yet", () => {
    expect(memorySyncBlock(config(), cloud, project)).toBe(`mem0 cloud is chosen, but ${project} is not sent there: /archivist memory on sends it.`);
  });

  it("lets a sync run when nothing stands in the way", () => {
    expect(memorySyncBlock(config(), { kind: "openviking", server: ov }, project)).toBeUndefined();
  });
});
