// Spike hook: appends {event, ts, env, payload} to $ARCH_SPIKE_LOG.
// Behaviour switches (env, set per experiment):
//   ARCHIVIST_CHILD=1          -> exit 0 immediately (recursion guard check)
//   ARCH_SPIKE_STOP_MODE=...   -> what the Stop hook returns (see below)
//   ARCH_SPIKE_DETACH=1        -> SessionEnd spawns a detached process that writes a marker later
import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const event = process.argv[2] ?? "unknown";
const log = process.env.ARCH_SPIKE_LOG;
if (!log) process.exit(0);

let raw = "";
try { raw = readFileSync(0, "utf8"); } catch {}
let payload;
try { payload = JSON.parse(raw); } catch { payload = { _raw: raw }; }

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /^(CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|ARCHIVIST_CHILD|CLAUDE_ENV_FILE|CLAUDECODE)$/.test(k)),
);
appendFileSync(log, JSON.stringify({ event, ts: Date.now(), pid: process.pid, ppid: process.ppid, env, payload }) + "\n");

if (process.env.ARCHIVIST_CHILD === "1") process.exit(0);

if (event === "SessionEnd" && process.env.ARCH_SPIKE_DETACH === "1") {
  const marker = `${log}.detached`;
  const child = spawn(
    "/bin/sh",
    ["-c", `sleep 15; echo "alive ppid=$PPID $(date +%s)" >> "${marker}"`],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const mode = process.env.ARCH_SPIKE_STOP_MODE;
if (event === "Stop" && mode === "systemMessage") {
  process.stdout.write(JSON.stringify({ systemMessage: "ARCHIVIST-SPIKE: report via systemMessage" }));
}
// StopRewake is registered as a separate async+asyncRewake Stop handler in hooks.json
if (event === "StopRewake") {
  if (mode === "rewake" && !payload.stop_hook_active) {
    // async + asyncRewake hook: exit 2 delivers stderr to Claude as a system reminder
    await new Promise((r) => setTimeout(r, Number(process.env.ARCH_SPIKE_REWAKE_DELAY_MS ?? 3000)));
    process.stderr.write(
      "Archivist report (informational, the task is already done; do not continue working): " +
        "added 1 entry [command] `npm test -- <path>`. Relay this line to the user verbatim and stop.",
    );
    process.exit(2);
  }
}
if (event === "UserPromptSubmit" && process.env.ARCH_SPIKE_UPS_MSG === "1") {
  process.stdout.write(JSON.stringify({ systemMessage: "ARCHIVIST-SPIKE: report via UserPromptSubmit systemMessage" }));
}
process.exit(0);
