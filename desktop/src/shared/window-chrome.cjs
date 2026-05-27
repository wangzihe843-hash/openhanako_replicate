/**
 * window-chrome.cjs — 窗口框架/图标的纯平台分支函数集合。
 *
 * 从 main.cjs 抽出便于单测：upstream 改了平台分支后能立刻发现。
 * 用 dirname 注入而不是 __dirname：让测试不依赖 main.cjs 的物理位置，
 * 调用方明确传 `desktop/` 目录即可。
 */
const path = require("node:path");

const APP_USER_MODEL_ID = "com.hanako.app"; // Keep in sync with package.json build.appId.

function windowIconOpts({ desktopDir, platform = process.platform } = {}) {
  if (!desktopDir) throw new Error("windowIconOpts requires desktopDir");
  if (platform === "win32") {
    return { icon: path.join(desktopDir, "src", "icon.ico") };
  }
  if (platform === "linux") {
    return { icon: path.join(desktopDir, "src", "icon.png") };
  }
  return {};
}

function titleBarOpts({ trafficLight = { x: 16, y: 16 }, platform = process.platform } = {}) {
  if (platform === "darwin") {
    return { titleBarStyle: "hiddenInset", trafficLightPosition: trafficLight };
  }
  return { frame: false };
}

module.exports = {
  APP_USER_MODEL_ID,
  windowIconOpts,
  titleBarOpts,
};
