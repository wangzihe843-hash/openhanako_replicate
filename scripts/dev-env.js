import { homedir } from "node:os";
import { join } from "node:path";

export function defaultDevHanaHome() {
  return join(homedir(), ".hanako-dev");
}

export function applyDevEnvironment(env = process.env, {
  nodeBin = process.execPath,
} = {}) {
  // 显式设置的 HANA_HOME 优先：让开发者能用 HANA_HOME=... 临时挂到自己的真数据目录上调试；
  // 没设则退回 dev 默认值，保持 upstream 「dev 默认隔离」的初衷。
  env.HANA_HOME = env.HANA_HOME || defaultDevHanaHome();
  env.HANA_DEV_NODE_BIN = nodeBin;
  return env;
}
