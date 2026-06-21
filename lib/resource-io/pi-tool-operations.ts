import path from "path";
import { constants } from "fs";
import type { ResourceIO } from "./resource-io.ts";

type ToolOperationsOptions = {
  cwd: string;
  resourceIO: ResourceIO;
  getSessionPath?: () => string | null;
  detectImageMimeType?: (filePath: string) => Promise<string | undefined> | string | undefined;
};

function localRef(filePath: string) {
  return { kind: "local-file" as const, path: filePath };
}

function filePathFromRefPath(filePath: string, cwd: string): string {
  return path.isAbsolute(filePath) ? path.normalize(filePath) : path.resolve(cwd, filePath);
}

function statLike(result: Awaited<ReturnType<ResourceIO["stat"]>>) {
  return {
    isDirectory: () => result.isDirectory,
    isFile: () => result.exists && !result.isDirectory,
    size: result.version?.size ?? 0,
    mtimeMs: result.version?.mtimeMs ?? 0,
  };
}

export function createResourceIoToolOperations({
  cwd,
  resourceIO,
  getSessionPath = () => null,
  detectImageMimeType,
}: ToolOperationsOptions) {
  const readFile = async (filePath: string) => {
    const result = await resourceIO.read(localRef(filePath));
    return result.content;
  };

  const access = async (filePath: string, _mode = constants.R_OK) => {
    const stat = await resourceIO.stat(localRef(filePath));
    if (!stat.exists) throw new Error(`Path not found: ${filePath}`);
  };

  const writeFile = async (filePath: string, content: string | Buffer) => {
    await resourceIO.write(localRef(filePath), content, {
      source: "agent_tool",
      reason: "agent_write",
      sessionPath: getSessionPath(),
    });
  };

  const editWriteFile = async (filePath: string, content: string | Buffer) => {
    await resourceIO.write(localRef(filePath), content, {
      source: "agent_tool",
      reason: "agent_edit",
      sessionPath: getSessionPath(),
    });
  };

  const mkdir = async (dirPath: string) => {
    const absolute = filePathFromRefPath(dirPath, cwd);
    const stat = await resourceIO.stat(localRef(absolute));
    if (stat.exists) return;
    await resourceIO.mkdir(localRef(absolute), {
      emit: false,
      source: "agent_tool",
      sessionPath: getSessionPath(),
    });
  };

  return {
    read: {
      readFile,
      access: (filePath: string) => access(filePath, constants.R_OK),
      detectImageMimeType: detectImageMimeType
        ? async (filePath: string) => detectImageMimeType(filePath)
        : undefined,
    },
    write: {
      writeFile,
      mkdir,
    },
    edit: {
      readFile,
      writeFile: editWriteFile,
      access: async (filePath: string) => {
        const stat = await resourceIO.stat(localRef(filePath));
        if (!stat.exists) throw new Error(`Path not found: ${filePath}`);
      },
    },
    ls: {
      exists: async (filePath: string) => (await resourceIO.stat(localRef(filePath))).exists,
      stat: async (filePath: string) => statLike(await resourceIO.stat(localRef(filePath))),
      readdir: async (dirPath: string) => {
        const result = await resourceIO.list(localRef(dirPath));
        return result.items.map((item) => item.name);
      },
    },
    grep: {
      isDirectory: async (filePath: string) => (await resourceIO.stat(localRef(filePath))).isDirectory,
      readFile: async (filePath: string) => (await resourceIO.read(localRef(filePath))).content.toString("utf-8"),
    },
    find: {
      exists: async (filePath: string) => (await resourceIO.stat(localRef(filePath))).exists,
    },
  };
}
