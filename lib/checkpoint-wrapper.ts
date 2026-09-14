import path from "path";
import { reportNonfatalError } from "./nonfatal-error.ts";

export function wrapWithCheckpoint(tools, { store, maxFileSizeKb, cwd, getSessionPath }) {
  return tools.map((tool) => {
    if (tool.name === "write" || tool.name === "edit") {
      return wrapPathTool(tool, store, maxFileSizeKb, cwd, getSessionPath);
    }
    if (tool.name === "bash" || tool.name === "exec_command") {
      return wrapCommandTool(tool, store, maxFileSizeKb, cwd, getSessionPath);
    }
    return tool;
  });
}

function resolvePath(rawPath, cwd) {
  if (!rawPath) return null;
  return path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(cwd, rawPath);
}

interface CheckpointOutcome {
  status: "created" | "skipped" | "failed";
  checkpointId: string | null;
  sessionPath: string | null;
  filePath: string;
  tool: string;
  message: string;
}

async function executeWithBackup(tool, store, maxFileSizeKb, getSessionPath, filePath, backupTool, toolCallId, params, rest) {
  let checkpoint: CheckpointOutcome | null = null;
  if (filePath) {
    let sessionPath: string | null = null;
    try {
      sessionPath = getSessionPath();
      const checkpointId = await store.save({
        sessionPath,
        tool: backupTool,
        source: "llm",
        reason: `tool-${backupTool.replace(":", "-")}`,
        filePath,
        maxSizeKb: maxFileSizeKb,
      });
      checkpoint = {
        status: checkpointId ? "created" : "skipped", checkpointId: checkpointId || null,
        sessionPath, filePath, tool: backupTool,
        message: checkpointId
          ? "Pre-edit checkpoint created."
          : "No checkpoint was created: the source is absent or excluded by the backup format/size policy.",
      };
    } catch (error) {
      checkpoint = {
        status: "failed", checkpointId: null, sessionPath, filePath, tool: backupTool,
        message: "The pre-edit backup failed; no checkpoint was confirmed for this operation.",
      };
      reportNonfatalError(`checkpoint backup failed (session=${sessionPath || "unresolved"}, tool=${backupTool}, file=${filePath})`, error);
    }
  }
  // Preserve an execution exception as-is; a backup warning must not replace it.
  const result = await tool.execute(toolCallId, params, ...rest);
  if (!checkpoint || !result || typeof result !== "object" || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: [
      ...result.content,
      ...(checkpoint.status === "failed"
        ? [{ type: "text", text: `Checkpoint warning: ${checkpoint.message} File: ${filePath}` }]
        : []),
    ],
    details: {
      ...result.details, checkpoint,
      ...(checkpoint.status === "failed" ? { checkpointWarning: checkpoint } : {}),
    },
  };
}

function wrapPathTool(tool, store, maxFileSizeKb, cwd, getSessionPath) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => executeWithBackup(
      tool, store, maxFileSizeKb, getSessionPath, resolvePath(params.path, cwd),
      tool.name, toolCallId, params, rest,
    ),
  };
}

const RM_PATTERN = /\brm\s+(?:-[^\s]*\s+)*([^\s|;&]+)/;
const MV_PATTERN = /\bmv\s+(?:-[^\s]*\s+)*([^\s|;&]+)\s+[^\s|;&]+/;

function commandFromParams(params) {
  if (typeof params?.command === "string") return params.command;
  if (typeof params?.cmd === "string") return params.cmd;
  return "";
}

function wrapCommandTool(tool, store, maxFileSizeKb, cwd, getSessionPath) {
  return {
    ...tool,
    execute: async (toolCallId, params, ...rest) => {
      const cmd = commandFromParams(params);

      const rm = RM_PATTERN.exec(cmd);
      const mv = rm ? null : MV_PATTERN.exec(cmd);
      const match = rm || mv;
      const filePath = match ? resolvePath(match[1], cwd) : null;
      const backupTool = `${tool.name}:${rm ? "rm" : "mv"}`;
      return executeWithBackup(tool, store, maxFileSizeKb, getSessionPath,
        filePath, backupTool, toolCallId, params, rest);
    },
  };
}
