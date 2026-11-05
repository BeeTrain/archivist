import { isExcluded, redact } from "./privacy.js";

export const safeText = (value: unknown, excluded: string[], root: string, max = 6000): string => {
  if (typeof value !== "string") return "";
  const lines = value.slice(0, 60000).split("\n").filter((line) => !line.split(/[\s\x60"'<>()[\]{},;=]+/).some((word) => {
    const path = word.replace(root + "/", "").replace(/^\.\//, "").replace(/[:.!?]+$/, "");
    return path && isExcluded(path, excluded);
  }));
  return redact(lines.join("\n")).text.slice(0, max);
};
