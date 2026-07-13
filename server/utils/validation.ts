import fs from "fs";
import path from "path";
import { isValidAgentIdentityId } from "../../shared/agent-id.ts";

export function validateId(id) {
  return isValidAgentIdentityId(id);
}

export function agentExists(engine, id) {
  return fs.existsSync(path.join(engine.agentsDir, id, "config.yaml"));
}
