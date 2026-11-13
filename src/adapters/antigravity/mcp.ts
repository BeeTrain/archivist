import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

export const PANEL_RESOURCE_URI = "ui://archivist/panel.html";
export const PANEL_MIME_TYPE = "text/html;profile=mcp-app";
export const MCP_SERVER_VERSION = "1.9.2";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const APP_ONLY_META = { ui: { visibility: ["app"] } };

export const MCP_TOOLS = [
  {
    name: "archivist_panel",
    title: "Archivist",
    description:
      "Open the live Archivist knowledge base panel: browse and search project rules, add entries, accept or skip review proposals, view task reports, and control background analysis.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string", description: "Optional absolute path to a project directory" },
        tab: {
          type: "string",
          enum: ["entries", "proposals", "reports", "tools"],
          description: "Optional initial tab to open",
        },
      },
    },
    _meta: {
      ui: { resourceUri: PANEL_RESOURCE_URI },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Archivist" },
          { type: "global", title: "Archivist" },
        ],
      },
    },
  },
  {
    name: "panel_state",
    description: "Read current Archivist project snapshot for the UI panel.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        q: { type: "string" },
        type: { type: "string" },
      },
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_report",
    description: "Read a task analysis report markdown file.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        file: { type: "string" },
      },
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_init",
    description: "Initialize .archivist/ and seed project commands.",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string" } },
      required: ["root"],
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_project",
    description: "Register and focus a workspace root in the UI panel.",
    inputSchema: {
      type: "object",
      properties: { root: { type: "string" } },
      required: ["root"],
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_settle",
    description: "Apply or skip a review proposal with fingerprint validation.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        id: { type: "string" },
        fingerprint: { type: "string" },
        action: { type: "string", enum: ["apply", "skip"] },
      },
      required: ["root", "id", "fingerprint", "action"],
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_add",
    description: "Add a command, gotcha, decision, or procedure to the knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        type: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        rationale: { type: "string" },
        paths: { type: "string" },
      },
      required: ["root", "type", "title", "content"],
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_deprecate",
    description: "Deprecate an active knowledge base entry.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["root", "id"],
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_analysis",
    description: "Enable, disable, or run background analysis.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        action: { type: "string", enum: ["enable", "disable", "run"] },
      },
      required: ["root", "action"],
    },
    _meta: APP_ONLY_META,
  },
  {
    name: "panel_maintenance",
    description: "Run render or lint maintenance commands.",
    inputSchema: {
      type: "object",
      properties: {
        root: { type: "string" },
        action: { type: "string", enum: ["render", "lint"] },
      },
      required: ["root", "action"],
    },
    _meta: APP_ONLY_META,
  },
] as const;

const toolOk = (text: string, structuredContent: Record<string, unknown>) => ({
  content: [{ type: "text", text }],
  structuredContent,
});

const toolErr = (err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: { ok: false, error: message },
  };
};

const callTool = async (name: string, args: Record<string, unknown>) => {
  try {
    switch (name) {
      case "archivist_panel": {
        const rootArg = typeof args.root === "string" && args.root.trim() ? args.root.trim() : undefined;
        const tabArg =
          typeof args.tab === "string" && ["entries", "proposals", "reports", "tools"].includes(args.tab)
            ? args.tab
            : undefined;
        const snap = await uiSnapshot({ root: rootArg });
        const summary = snap.root
          ? `Archivist (${snap.project}): ${snap.counts.entries} active entries, ${snap.counts.review} pending review, ${snap.counts.reports} reports.`
          : "Archivist panel opened. No project selected yet — pick or add a project path in the panel.";
        return toolOk(summary, { ...snap, ...(tabArg ? { tab: tabArg } : {}) });
      }
      case "panel_state": {
        const snap = await uiSnapshot({
          root: typeof args.root === "string" && args.root.trim() ? args.root.trim() : undefined,
          query: typeof args.q === "string" ? args.q : "",
          type: typeof args.type === "string" ? args.type : undefined,
        });
        return toolOk("ok", { ok: true, ...snap });
      }
      case "panel_report": {
        if (typeof args.root !== "string" || !args.root.trim()) {
          return toolOk("Выберите проект.", { ok: true, file: null, text: "Выберите проект." });
        }
        const rep = await uiReport(args.root, typeof args.file === "string" ? args.file : undefined);
        return toolOk(rep.file ?? "no report", { ok: true, ...rep });
      }
      case "panel_init": {
        if (typeof args.root !== "string" || !args.root.trim()) throw new Error("Не указан путь к проекту");
        const res = await uiInit(args.root);
        return toolOk(`Инициализировано · команд добавлено: ${res.added}`, { ok: true, ...res });
      }
      case "panel_project": {
        if (typeof args.root !== "string" || !args.root.trim()) throw new Error("Укажите абсолютный путь к проекту");
        const res = await uiRegisterProject(args.root);
        return toolOk(`Открыт проект: ${res.root}`, { ok: true, ...res });
      }
      case "panel_settle": {
        if (typeof args.root !== "string") throw new Error("Не указан проект");
        const action = args.action === "apply" || args.action === "skip" ? args.action : undefined;
        if (!action || typeof args.id !== "string" || typeof args.fingerprint !== "string") {
          throw new Error("Некорректные параметры предложения");
        }
        const res = await uiSettle(args.root, { id: args.id, fingerprint: args.fingerprint, action });
        return toolOk(res.text, { ok: true, ...res });
      }
      case "panel_add": {
        if (typeof args.root !== "string") throw new Error("Не указан проект");
        const res = await uiAdd(args.root, {
          type: String(args.type ?? ""),
          title: String(args.title ?? ""),
          content: String(args.content ?? ""),
          rationale: typeof args.rationale === "string" ? args.rationale : undefined,
          paths: typeof args.paths === "string" ? args.paths : undefined,
        });
        return toolOk(res.text, { ok: true, ...res });
      }
      case "panel_deprecate": {
        if (typeof args.root !== "string") throw new Error("Не указан проект");
        const res = await uiDeprecate(args.root, {
          id: String(args.id ?? ""),
          reason: String(args.reason ?? ""),
        });
        return toolOk(res.text, { ok: true, ...res });
      }
      case "panel_analysis": {
        if (typeof args.root !== "string") throw new Error("Не указан проект");
        const action = args.action === "enable" || args.action === "disable" || args.action === "run" ? args.action : undefined;
        if (!action) throw new Error("Неизвестное действие анализа");
        const res = await uiAnalysis(args.root, action);
        return toolOk(res.text, { ok: true, ...res });
      }
      case "panel_maintenance": {
        if (typeof args.root !== "string") throw new Error("Не указан проект");
        const action = args.action === "render" || args.action === "lint" ? args.action : undefined;
        if (!action) throw new Error("Неизвестное действие обслуживания");
        const res = await uiMaintenance(args.root, action);
        return toolOk(res.text, { ok: true, ...res });
      }
      default:
        return toolErr(new Error(`Unknown tool: ${name}`));
    }
  } catch (err) {
    return toolErr(err);
  }
};

export const defaultPanelHtmlPath = (): string => {
  if (process.env.ARCHIVIST_PANEL_HTML?.trim()) return process.env.ARCHIVIST_PANEL_HTML.trim();
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "ui", "panel.html");
};

export const handleMcpMessage = async (
  msg: JsonRpcRequest,
  loadHtml: () => string = () => readFileSync(defaultPanelHtmlPath(), "utf8"),
): Promise<JsonRpcResponse | undefined> => {
  const method = msg.method;
  const hasId = msg.id !== undefined;
  if (!method) {
    return hasId ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Invalid Request" } } : undefined;
  }
  if (!hasId) return undefined;

  const id = msg.id ?? null;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-03-26";
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requested,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
          },
          serverInfo: { name: "archivist-panel", version: MCP_SERVER_VERSION },
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "resources/list":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: [
            {
              uri: PANEL_RESOURCE_URI,
              name: "Archivist",
              description: "Live Archivist knowledge base panel",
              mimeType: PANEL_MIME_TYPE,
              _meta: { ui: { prefersBorder: false } },
            },
          ],
        },
      };
    case "resources/templates/list":
      return { jsonrpc: "2.0", id, result: { resourceTemplates: [] } };
    case "resources/read": {
      const uri = typeof params.uri === "string" ? params.uri : "";
      if (uri !== PANEL_RESOURCE_URI) {
        return { jsonrpc: "2.0", id, error: { code: -32002, message: `Resource not found: ${uri}` } };
      }
      try {
        const text = loadHtml();
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri: PANEL_RESOURCE_URI,
                mimeType: PANEL_MIME_TYPE,
                text,
                _meta: { ui: { prefersBorder: false } },
              },
            ],
          },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        };
      }
    }
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };
    case "tools/call": {
      const toolName = typeof params.name === "string" ? params.name : "";
      const toolArgs =
        params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      const result = await callTool(toolName, toolArgs);
      return { jsonrpc: "2.0", id, result };
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
};

export const startBackgroundLoop = (): void => {
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
};

export const startMcpServer = (): void => {
  startBackgroundLoop();
  process.stdin.setEncoding("utf8");
  let buffer = "";

  const write = (res: JsonRpcResponse) => {
    process.stdout.write(JSON.stringify(res) + "\n");
  };

  const processLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    try {
      const response = await handleMcpMessage(parsed);
      if (response) write(response);
    } catch (err) {
      if (parsed.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        });
      }
    }
  };

  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      void processLine(line);
    }
  });

  process.stdin.on("end", () => {
    if (buffer.trim()) void processLine(buffer);
  });
};
