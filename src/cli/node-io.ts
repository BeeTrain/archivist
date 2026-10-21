import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../core/io.js";

export const nodeIo = (root: string): Io => ({
  root,
  async read(p) {
    try {
      return await readFile(join(root, p), "utf8");
    } catch {
      return undefined;
    }
  },
  async write(p, text) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await writeFile(join(root, p), text);
  },
  async exists(p) {
    return existsSync(join(root, p));
  },
  async list(dir) {
    try {
      return await readdir(join(root, dir));
    } catch {
      return [];
    }
  },
  async remove(p) {
    await rm(join(root, p), { force: true });
  },
});

/** The project root: the nearest ancestor with .git or .archivist, else the start directory. */
export const findRoot = (start: string): string => {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, ".archivist"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start);
    dir = up;
  }
};
