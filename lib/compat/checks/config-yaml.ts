/**
 * Check basic config structure, preserving the original before recovery.
 */
import fs from "fs";
import path from "path";
import { randomUUID } from "node:crypto";
import { t } from "../../i18n.ts";
import { writeSecretFileSync } from "../../../shared/secret-fs.ts";

export function checkConfigYaml({ agentDir }: { agentDir: string; hanakoHome?: string }) {
  const configPath = path.join(agentDir, "config.yaml");
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // A read/permission failure is not evidence of corrupt user configuration.
    throw error;
  }
  if (content.trim() && content.includes(":")) return;

  const message = t(content.trim() ? "error.compatConfigInvalid" : "error.compatConfigEmpty");
  const backupPath = configPath + `.bak-${Date.now()}-${randomUUID()}`;
  // If preservation fails, leave the original in place and report the failure.
  fs.renameSync(configPath, backupPath);

  const templatePath = path.join(path.dirname(path.dirname(agentDir)), "..", "lib", "config.example.yaml");
  let template: string;
  try {
    template = fs.readFileSync(templatePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // The original really was moved: allow the normal missing-config fallback.
    return { fixed: true, message: t("error.compatConfigBackedUp", { msg: message, backup: path.basename(backupPath) }) };
  }
  // A failed publication preserves the backup and propagates to the compat runner.
  writeSecretFileSync(configPath, template);
  return { fixed: true, message: t("error.compatConfigCorrupted", { msg: message }) };
}
