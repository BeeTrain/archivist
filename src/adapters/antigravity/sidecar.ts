import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Provided at runtime by Antigravity's sidecar Node host
import { SidecarApp, Response } from "sidecar_sdk";
import { loadConfig } from "../../core/config.js";
import { nodeIo } from "../../cli/node-io.js";
import { runWorker } from "./queue.js";
import { readRegistry } from "./registry.js";
import {
  uiAdd,
  uiAnalysis,
  uiDeprecate,
  uiInit,
  uiMaintenance,
  uiRegisterProject,
  uiReport,
  uiSettle,
  uiSnapshot,
} from "./sidecar-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC: Record<string, [string, string]> = {
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "application/javascript; charset=utf-8"],
};

const app = new SidecarApp();

app.page("/", () => readFileSync(join(__dirname, "index.html"), "utf-8"));

for (const [route, [file, contentType]] of Object.entries(STATIC)) {
  app.api(
    route,
    () => new Response(readFileSync(join(__dirname, file), "utf-8"), { contentType }),
    "GET",
  );
}

const errorJson = (err: unknown, status = 400) =>
  new Response(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }), {
    status,
    contentType: "application/json; charset=utf-8",
  });

app.api(
  "/api/state",
  async (data: Record<string, unknown>) => {
    try {
      const conversationId =
        (typeof data.conversationId === "string" && data.conversationId) ||
        (typeof app.config?.conversationId === "string" && app.config.conversationId) ||
        undefined;
      return await uiSnapshot({
        root: typeof data.root === "string" ? data.root : undefined,
        conversationId,
        query: typeof data.q === "string" ? data.q : "",
        type: typeof data.type === "string" ? data.type : undefined,
      });
    } catch (err) {
      return errorJson(err, 500);
    }
  },
  "GET",
);

app.api(
  "/api/report",
  async (data: Record<string, unknown>) => {
    try {
      if (typeof data.root !== "string" || !data.root.trim()) return { file: null, text: "Выберите проект." };
      return await uiReport(data.root, typeof data.file === "string" ? data.file : undefined);
    } catch (err) {
      return errorJson(err, 500);
    }
  },
  "GET",
);

app.api("/api/init", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string" || !data.root.trim()) throw new Error("Не указан путь к проекту");
    return { ok: true, ...(await uiInit(data.root)) };
  } catch (err) {
    return errorJson(err);
  }
});

app.api("/api/project", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string" || !data.root.trim()) throw new Error("Укажите абсолютный путь к проекту");
    const conversationId =
      (typeof data.conversationId === "string" && data.conversationId) ||
      (typeof app.config?.conversationId === "string" && app.config.conversationId) ||
      undefined;
    return { ok: true, ...(await uiRegisterProject(data.root, conversationId)) };
  } catch (err) {
    return errorJson(err);
  }
});

app.api("/api/settle", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string") throw new Error("Не указан проект");
    const action = data.action === "apply" || data.action === "skip" ? data.action : undefined;
    if (!action || typeof data.id !== "string" || typeof data.fingerprint !== "string") {
      throw new Error("Некорректные параметры предложения");
    }
    return { ok: true, ...(await uiSettle(data.root, { id: data.id, fingerprint: data.fingerprint, action })) };
  } catch (err) {
    return errorJson(err);
  }
});

app.api("/api/add", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string") throw new Error("Не указан проект");
    return {
      ok: true,
      ...(await uiAdd(data.root, {
        type: String(data.type ?? ""),
        title: String(data.title ?? ""),
        content: String(data.content ?? ""),
        rationale: typeof data.rationale === "string" ? data.rationale : undefined,
        paths: typeof data.paths === "string" ? data.paths : undefined,
      })),
    };
  } catch (err) {
    return errorJson(err);
  }
});

app.api("/api/deprecate", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string") throw new Error("Не указан проект");
    return {
      ok: true,
      ...(await uiDeprecate(data.root, {
        id: String(data.id ?? ""),
        reason: String(data.reason ?? ""),
      })),
    };
  } catch (err) {
    return errorJson(err);
  }
});

app.api("/api/analysis", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string") throw new Error("Не указан проект");
    const action = data.action === "enable" || data.action === "disable" || data.action === "run" ? data.action : undefined;
    if (!action) throw new Error("Неизвестное действие анализа");
    return { ok: true, ...(await uiAnalysis(data.root, action)) };
  } catch (err) {
    return errorJson(err);
  }
});

app.api("/api/maintenance", async (data: Record<string, unknown>) => {
  try {
    if (typeof data.root !== "string") throw new Error("Не указан проект");
    const action = data.action === "render" || data.action === "lint" ? data.action : undefined;
    if (!action) throw new Error("Неизвестное действие обслуживания");
    return { ok: true, ...(await uiMaintenance(data.root, action)) };
  } catch (err) {
    return errorJson(err);
  }
});

// Gentle background loop inside the sidecar to process due tasks for registered workspaces.
let polling = false;
setInterval(() => {
  if (polling) return;
  polling = true;
  void (async () => {
    try {
      const reg = await readRegistry();
      for (const proj of reg.projects.slice(0, 5)) {
        if (!existsSync(proj.root)) continue;
        const io = nodeIo(proj.root, "antigravity");
        const cfg = await loadConfig(io);
        if (cfg.enabled && cfg.antigravity.enabled) {
          await runWorker(proj.root, undefined, { once: true });
        }
      }
    } catch {
      // ignore transient errors in background tick
    } finally {
      polling = false;
    }
  })();
}, 5000).unref();

app.run();
