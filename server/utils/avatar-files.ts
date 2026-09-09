import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const AVATAR_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const pendingMutations = new Map<string, Promise<void>>();

// Both avatar route aliases share this queue. A format change must finish removing
// its old files before another upload/delete can publish or remove the next avatar.
async function mutateAvatar(dir: string, role: string, operation: () => Promise<void>) {
  const resolved = path.resolve(dir, role);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = pendingMutations.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  pendingMutations.set(key, current);
  try {
    await current;
  } finally {
    if (pendingMutations.get(key) === current) pendingMutations.delete(key);
  }
}

async function unlinkIfPresent(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function writeAvatar(dir: string, role: string, ext: string, data: Buffer) {
  await mutateAvatar(dir, role, async () => {
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${role}.${ext}`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, data, { flag: "wx" });
      await fs.rename(temporary, target);
    } finally {
      await unlinkIfPresent(temporary);
    }
    // Preserve the previous avatar until the new file has been published completely.
    for (const oldExt of AVATAR_EXTENSIONS) {
      if (oldExt !== ext) await unlinkIfPresent(path.join(dir, `${role}.${oldExt}`));
    }
  });
}

export async function deleteAvatar(dir: string, role: string) {
  await mutateAvatar(dir, role, async () => {
    for (const ext of AVATAR_EXTENSIONS) {
      await unlinkIfPresent(path.join(dir, `${role}.${ext}`));
    }
  });
}
