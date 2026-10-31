import { appendFileSync } from "node:fs";
import process from "node:process";
import { isMainThread, threadId } from "node:worker_threads";

const phaseFile = process.env.HANA_FEISHU_TEST_PHASE_FILE;
let writeFailed = false;

// Synchronous file writes survive a silent child exit without relying on stdout
// flushes. No timers, handles, payloads or credentials are added by this probe.
export function markFeishuWorkerPhase(stage, details = {}) {
  if (!phaseFile) return;
  try {
    appendFileSync(phaseFile, JSON.stringify({
      scenario: process.env.HANA_FEISHU_TEST_SCENARIO, pid: process.pid, threadId, isMainThread,
      utc: new Date().toISOString(), atNs: process.hrtime.bigint().toString(), stage, ...details,
    }) + "\n");
  } catch {
    if (!writeFailed) {
      writeFailed = true;
      process.stderr.write("FEISHU_WORKER_PHASE_WRITE_FAILED\n");
    }
  }
}

if (phaseFile) {
  markFeishuWorkerPhase("preload:enter");
  process.on("beforeExit", code => markFeishuWorkerPhase("process:beforeExit", {
    code, resources: process.getActiveResourcesInfo(), memory: process.memoryUsage(),
  }));
  process.once("exit", code => markFeishuWorkerPhase("process:exit", {
    code, resources: process.getActiveResourcesInfo(),
  }));
  // Monitoring must not turn an uncaught exception into a handled exception.
  process.on("uncaughtExceptionMonitor", (error, origin) => markFeishuWorkerPhase("process:uncaughtException", {
    origin, name: error.name, code: error.code ?? null,
  }));
}
