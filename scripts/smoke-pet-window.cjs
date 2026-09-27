/** Manual Electron smoke for the built desktop pet; does not start the app server. */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const state = {
  supported: true, visible: true, paused: false, clickThrough: false, alwaysOnTop: true,
  context: {
    agentId: 'smoke-agent', agentName: 'Smoke Character', sessionPath: '/smoke-session', sessionId: null,
    connected: false, streaming: false, awaitingApproval: false, inlineError: false,
  },
};

ipcMain.handle('pet-state', () => state);
ipcMain.handle('pet-connection', () => null);
ipcMain.handle('pet-hide', () => ({ ...state, visible: false }));
ipcMain.handle('pet-open-main', () => undefined);
ipcMain.handle('pet-set-options', (_event, options) => {
  Object.assign(state, options);
  return state;
});

async function waitFor(win, expression, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 220, height: 252, show: false, frame: false, transparent: true,
    webPreferences: {
      preload: path.resolve(__dirname, '../desktop/src/pet-preload.cjs'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  try {
    await win.loadFile(path.resolve(__dirname, '../desktop/dist-renderer/pet.html'));
    await waitFor(win, 'document.body.innerText.includes("Smoke Character")');
    const bridgeReady = await win.webContents.executeJavaScript('typeof window.hanaPet?.getState === "function"');
    if (!bridgeReady) throw new Error('Pet preload bridge is missing');
    const cspReady = await win.webContents.executeJavaScript('!!document.querySelector("meta[http-equiv=Content-Security-Policy]")');
    if (!cspReady) throw new Error('Pet CSP is missing');
    await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "暂停")?.click()');
    await waitFor(win, 'document.body.innerText.includes("动作已暂停")');
    process.stdout.write('pet Electron smoke: preload, CSP, React, and pause IPC passed\n');
    app.exit(0);
  } catch (error) {
    process.stderr.write(`pet Electron smoke failed: ${error.stack || error}\n`);
    app.exit(1);
  }
}).catch((error) => {
  process.stderr.write(`pet Electron smoke startup failed: ${error.stack || error}\n`);
  app.exit(1);
});
