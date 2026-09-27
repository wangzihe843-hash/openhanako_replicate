import fs from "fs";
import path from "path";
import { isValidAgentIdentityId } from "../../shared/agent-id.ts";

export function validateId(id) {
  return isValidAgentIdentityId(id);
}

export function agentExists(engine, id) {
  if (!validateId(id)) return false;
  const directory = path.join(engine.agentsDir, id);
  // Deletion retains config and data for possible recovery, but the tombstone
  // removes the agent from every live route that shares this guard.
  return engine.isAgentDeleted?.(id) !== true
    && !fs.existsSync(path.join(directory, ".deleted-agent.json"))
    && fs.existsSync(path.join(directory, "config.yaml"));
}
