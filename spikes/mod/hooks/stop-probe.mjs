// Spike 2: command-hook delivery channels on Stop / UserPromptSubmit, each fired a bounded number of times.
//   sync   -> Stop returns {systemMessage}             (is it visible to the user in the desktop app?)
//   rewake -> async+asyncRewake Stop exits 2 once      (does Claude get it and does it keep working?)
//   ups    -> UserPromptSubmit returns {systemMessage} once
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const DIR = process.env.ARCH_SPIKE_DIR ?? "/tmp/archivist-spike";
const mode = process.argv[2];
let payload = {};
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch {}
const { session_id, transcript_path, cwd, last_assistant_message, ...rest } = payload;
appendFileSync(`${DIR}/stop-probe.jsonl`, JSON.stringify({ ts: Date.now(), mode, rest, lastLen: last_assistant_message?.length }) + "\n");

const count = (name) => {
  const f = `${DIR}/stop-probe.${name}.count`;
  const n = existsSync(f) ? Number(readFileSync(f, "utf8")) : 0;
  writeFileSync(f, String(n + 1));
  return n;
};

if (mode === "sync" && count("sync") < 2) {
  process.stdout.write(JSON.stringify({ systemMessage: "ARCHIVIST-SPIKE: Stop systemMessage (sync command hook)" }));
}
if (mode === "ups" && count("ups") < 1) {
  process.stdout.write(JSON.stringify({ systemMessage: "ARCHIVIST-SPIKE: UserPromptSubmit systemMessage" }));
}
if (mode === "rewake" && !payload.stop_hook_active && count("rewake") < 1) {
  await new Promise((r) => setTimeout(r, 3000));
  process.stderr.write(
    "ARCHIVIST-SPIKE asyncRewake report (informational; the task is done, do not continue it): " +
      "added 1 entry. Acknowledge in one short line.",
  );
  process.exit(2);
}
process.exit(0);
