// Synthetic loopback servers only. No application main process or user profile is loaded.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { X509Certificate, createHash } = require('node:crypto');
const { createServerConnectionProbe } = require('../../desktop/server-connection-probe.cjs');
const output = process.argv[2];
const root = path.resolve(__dirname, '../..');
app.setPath('userData', path.join(output, 'user-data'));
app.setPath('sessionData', path.join(output, 'session-data'));
app.disableHardwareAcceleration();
const windows = [];
const servers = [];
const sockets = new Set();
const targets = [];
const report = { electron: process.versions.electron, node: process.versions.node, platform: process.platform, pid: process.pid, cases: [], senderChecks: [] };
fs.writeFileSync(path.join(output, 'started.json'), JSON.stringify(report, null, 2));
let finished = false;
const fixture = path.join(output, 'settings.html');
// loadFile's url.format leaves '~' literal and treats '%' as an escape, unlike
// pathToFileURL. Fix the trusted URL before loading and pass that exact URL to
// Electron; never derive authority from a window's current document URL.
const fixtureURL = pathToFileURL(fixture).href;
const untrustedURL = pathToFileURL(path.join(output, 'untrusted.html')).href;
const csp = pathToFileURL(path.join(root, 'desktop/src/modules/connection-csp.js')).href;
fs.writeFileSync(fixture, `<!doctype html><html><head><script src="${csp}"></script><script src="connection.js"></script></head><body>Connection fixture</body></html>`);
fs.writeFileSync(path.join(output, 'untrusted.html'), '<!doctype html><title>Untrusted fixture</title>');
// Diagnostic labels distinguish supplied vs real paths without exposing the host
// profile or temp directory. These aliases never participate in authorization.
const fixtureURLs = new Map();
for (const [label, directory] of [['real-output', fs.realpathSync(output)], ['provided-output', output]]) {
  for (const name of ['settings.html', 'untrusted.html']) {
    fixtureURLs.set(pathToFileURL(path.join(directory, name)).href, `file:///<${label}>/${name}`);
  }
}
function documentURL(value) {
  try {
    const url = new URL(value);
    url.search = url.hash = '';
    return url.href;
  } catch { return null; }
}
function describeURL(value) {
  return fixtureURLs.get(documentURL(value)) || '<unrecognized-document>';
}
function frameIdentity(frame) {
  return frame ? { processId: frame.processId, routingId: frame.routingId, frameTreeNodeId: frame.frameTreeNodeId } : null;
}
const preload = path.join(output, 'preload.cjs');
fs.writeFileSync(preload, `const {contextBridge, ipcRenderer} = require('electron'); contextBridge.exposeInMainWorld('fixtureProbe', input => ipcRenderer.invoke('probe-server-connection', input));`);
const probe = createServerConnectionProbe(() => targets);
ipcMain.handle('probe-server-connection', async (event, input) => {
  // Snapshot synchronously at IPC entry. Only the unchanged production probe
  // decides trust, including its later checks across asynchronous requests.
  const check = { phase: report.phase, outcome: 'pending' };
  report.senderChecks.push(check);
  try {
    const frame = event.senderFrame;
    const senderURL = documentURL(frame?.url);
    check.senderId = event.sender.id;
    check.senderFrame = frameIdentity(frame);
    check.senderURL = describeURL(frame?.url);
    check.targets = targets.map(({ webContents, url, scheme, navigation }) => {
      const windowAlive = Boolean(webContents && !webContents.isDestroyed());
      const mainFrame = windowAlive ? webContents.mainFrame : null;
      const trustedURL = documentURL(url);
      return {
        scheme, navigation, webContentsId: webContents.id,
        mainFrame: frameIdentity(mainFrame), trustedURL: describeURL(url),
        // Diagnostic only: compare the entire fixed URL and expose no path.
        // This must never supply or normalize the production probe's targets.
        documentURLComparison: senderURL === null || trustedURL === null ? 'invalid'
          : senderURL === trustedURL ? 'equal'
            : senderURL === trustedURL.replace(/%7E/gi, '~') ? 'literal-vs-encoded-tilde' : 'different',
        predicates: {
          windowAlive,
          webContentsSame: event.sender === webContents,
          mainFrameSame: Boolean(frame && frame === mainFrame),
          documentURLSame: senderURL !== null && senderURL === documentURL(url),
        },
      };
    });
  } catch {
    // Diagnostic reads of a disposed frame must not replace the probe's result.
    check.snapshotUnavailable = true;
  }
  try {
    const result = await probe(event, input);
    check.outcome = 'resolved';
    return result;
  } catch (error) {
    check.outcome = 'rejected';
    throw error;
  }
});
const cert = fs.readFileSync(path.join(__dirname, 'server-connection-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'server-connection-key.pem'));
const fingerprint = new X509Certificate(cert).fingerprint256;
function assert(condition, message) { if (!condition) throw new Error(message); }
function finish(code) {
  if (finished) return;
  finished = true;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  for (const socket of sockets) socket.destroy();
  for (const server of servers) server.close(() => {});
  app.exit(code);
}
function fail(error) {
  report.error = String(error.stack || error);
  process.stderr.write(`${report.error}\n`);
  clearTimeout(watchdog);
  finish(1);
}
const watchdog = setTimeout(() => fail(new Error('CSP fixture timed out')), 25_000);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', fail);
      resolve();
    });
  });
}
const blockedFetch = (window, url) => window.webContents.executeJavaScript(`(async () => {
  const violations = [];
  const listener = event => violations.push(event.effectiveDirective);
  document.addEventListener('securitypolicyviolation', listener);
  let blocked = false;
  try { await fetch(${JSON.stringify(url)}); } catch { blocked = true; }
  await new Promise(resolve => setTimeout(resolve, 20));
  document.removeEventListener('securitypolicyviolation', listener);
  return { blocked, violations };
})()`);
app.whenReady().then(async () => {
  for (const scheme of ['http', 'https']) {
    const requests = [];
    const unapprovedRequests = [];
    report.inProgress = { scheme, requests, unapprovedRequests };
    let failedResponseClosed = false;
    const trap = http.createServer((req, res) => {
      unapprovedRequests.push(req.url);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end('{"ok":true}');
    });
    trap.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    servers.push(trap);
    await listen(trap);
    // localhost is absent from connect-src's initial loopback allowlist. Separate
    // ports retain distinct origins without requiring macOS loopback aliases.
    const unapprovedOrigin = `http://localhost:${trap.address().port}`;
    const handler = (req, res) => {
      requests.push({ method: req.method, path: req.url, cookie: req.headers.cookie || null });
      const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'null', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'authorization, content-type' };
      if (req.url.startsWith('/redirect/')) { res.writeHead(307, { ...headers, Location: `${unapprovedOrigin}/redirect-target` }); res.end(); return; }
      if (req.url.startsWith('/streaming-denied/')) {
        res.once('close', () => { failedResponseClosed = true; });
        res.writeHead(401, headers);
        res.write('{"error":"synthetic denial"}');
        return;
      }
      if (req.url.startsWith('/denied/')) { res.writeHead(401, headers); res.end('{}'); return; }
      if (req.url.endsWith('/login')) headers['Set-Cookie'] = 'fixture_session=synthetic; Path=/; HttpOnly; SameSite=Strict';
      res.writeHead(200, headers);
      res.end(JSON.stringify(req.url.endsWith('/identity') ? {
        connectionKind: 'lan', serverId: 'fixture', studioId: 'fixture', label: 'Synthetic fixture', capabilities: ['chat'],
      } : { ok: true }));
    };
    const server = scheme === 'https' ? https.createServer({ cert, key }, handler) : http.createServer(handler);
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket) => {
      requests.push({ method: 'WS', path: req.url, cookie: req.headers.cookie || null });
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    servers.push(server);
    await listen(server);
    const origin = `${scheme}://localhost:${server.address().port}`;
    const isolated = session.fromPartition(`connection-${scheme}-${Date.now()}`);
    // Trust only this synthetic certificate inside this disposable session.
    isolated.setCertificateVerifyProc(({ hostname, certificate }, callback) => callback(
      hostname === 'localhost' && new X509Certificate(certificate.data).fingerprint256 === fingerprint ? 0 : -3,
    ));
    const window = new BrowserWindow({ show: false, webPreferences: { preload, session: isolated, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    windows.push(window);
    const target = { webContents: window.webContents, url: fixtureURL, scheme, navigation: 'created' };
    targets.push(target);
    window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (isMainFrame) target.navigation = 'did-start-navigation';
    });
    window.webContents.on('did-finish-load', () => { target.navigation = 'did-finish-load'; });
    report.phase = `${scheme}:loading-fixture`;
    await window.loadURL(fixtureURL);
    const before = await blockedFetch(window, `${origin}/api/web-auth/login`);
    assert(before.blocked && before.violations.includes('connect-src') && requests.length === 0, 'First renderer connection must be blocked by real CSP');
    report.phase = `${scheme}:initial-handshake`;
    const connection = await window.webContents.executeJavaScript(`(async () => {
      const result = await connectionApi.connectDeviceServerConnection({ baseUrl: ${JSON.stringify(origin + '/prefix/')}, credential: 'synthetic-key', probeIdentity: window.fixtureProbe });
      connectionApi.persistServerConnectionSelection(result);
      return result;
    })()`);
    assert(connection.serverId === 'fixture', 'Controlled connection must succeed');
    assert(requests.some(item => item.path === '/prefix/api/server/identity'), 'Identity request must preserve reverse proxy prefix');
    const cookies = await isolated.cookies.get({ url: origin });
    assert(cookies.some(cookie => cookie.name === 'fixture_session' && cookie.value === 'synthetic'), 'Probe must retain login cookies in the initiating session');
    const stillBlocked = await blockedFetch(window, `${origin}/api/server/identity`);
    assert(stillBlocked.blocked && stillBlocked.violations.includes('connect-src'), 'Probe must not relax the live renderer CSP');
    report.phase = `${scheme}:reloading-fixture`;
    await window.loadURL(fixtureURL);
    const allowed = await window.webContents.executeJavaScript(`fetch(${JSON.stringify(origin + '/api/server/identity')}).then(response => response.status)`);
    assert(allowed === 200, 'Saved origin must work after reloading the unchanged policy');
    const wsUrl = `${scheme === 'https' ? 'wss' : 'ws'}://localhost:${server.address().port}`;
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const ws = new WebSocket(${JSON.stringify(wsUrl)}); ws.onopen = () => { ws.close(); resolve(true); }; ws.onerror = () => reject(new Error('WebSocket blocked')); })`);
    const unrelated = await blockedFetch(window, `${unapprovedOrigin}/unapproved`);
    assert(unrelated.blocked && unrelated.violations.includes('connect-src'), 'Unapproved origins must remain blocked');
    for (const prefix of ['redirect', 'denied', 'streaming-denied']) {
      report.phase = `${scheme}:${prefix}`;
      const error = await window.webContents.executeJavaScript(`window.fixtureProbe({baseUrl: ${JSON.stringify(origin) } + '/${prefix}', credential: 'synthetic-key'}).then(() => null, error => String(error))`);
      assert(error, `${prefix} must fail rather than continuing the handshake`);
    }
    for (let wait = 0; !failedResponseClosed && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(failedResponseClosed, 'Failed probes must terminate unfinished response streams');
    assert(unapprovedRequests.length === 0, 'Neither renderer requests nor redirects may reach the unapproved origin');
    report.phase = `${scheme}:loading-untrusted-document`;
    await window.loadURL(untrustedURL);
    const beforeUntrusted = requests.length;
    report.phase = `${scheme}:untrusted-document`;
    const untrustedError = await window.webContents.executeJavaScript(`window.fixtureProbe({baseUrl: ${JSON.stringify(origin)}, credential: 'synthetic-key'}).then(() => null, error => String(error))`);
    assert(untrustedError && requests.length === beforeUntrusted, 'A navigated application window must lose probe authority');
    report.cases.push({ scheme, before, connectionId: connection.connectionId, retainedCookie: true, stillBlocked, allowed, websocketConnected: true, unrelated, rejectedUntrustedDocument: true, failedResponseClosed, unapprovedRequests, requests });
    delete report.inProgress;
  }
  report.phase = 'complete';
  clearTimeout(watchdog);
  finish(0);
}).catch(fail);
