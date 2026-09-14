import readline from "readline";
import { createTerminalTheme, ansi, paint } from "./terminal-theme.ts";

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function createCliChatPromptMessage(identity, text) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  if (!sessionId || !sessionPath || typeof text !== "string") return null;
  return { type: "prompt", text, sessionId, sessionPath };
}

export function createCliChatAbortMessage(identity) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  const streamId = nonEmptyString(identity?.streamId);
  if (!sessionId || !sessionPath || !streamId) return null;
  return { type: "abort", sessionId, sessionPath, streamId };
}

export function cliChatMessageMatchesSession(identity, msg) {
  const sessionId = nonEmptyString(identity?.sessionId);
  const sessionPath = nonEmptyString(identity?.sessionPath);
  const messageSessionId = nonEmptyString(msg?.sessionId);
  const messageSessionPath = nonEmptyString(msg?.sessionPath);
  if (sessionId && messageSessionId && messageSessionId !== sessionId) return false;
  if (sessionPath && messageSessionPath && messageSessionPath !== sessionPath) return false;
  return true;
}

export function reduceCliChatStreamIdentity(current, msg) {
  const state = {
    sessionId: nonEmptyString(current?.sessionId),
    sessionPath: nonEmptyString(current?.sessionPath),
    streamId: nonEmptyString(current?.streamId),
    isStreaming: current?.isStreaming === true,
  };
  if (!cliChatMessageMatchesSession(state, msg)) return state;

  const messageStreamId = nonEmptyString(msg?.streamId);
  if (msg?.type === "abort_rejected") {
    return messageStreamId
      ? { ...state, streamId: messageStreamId, isStreaming: true }
      : state;
  }
  if (msg?.type === "status") {
    if (msg.isStreaming === true && messageStreamId) {
      return { ...state, streamId: messageStreamId, isStreaming: true };
    }
    if (msg.isStreaming === false) {
      if (state.streamId && (!messageStreamId || messageStreamId !== state.streamId)) return state;
      return { ...state, streamId: null, isStreaming: false };
    }
  }
  if (msg?.type === "turn_end") {
    if (state.streamId && (!messageStreamId || messageStreamId !== state.streamId)) return state;
    return { ...state, streamId: null, isStreaming: false };
  }
  if (msg?.type === "error") {
    if (state.streamId && messageStreamId && messageStreamId !== state.streamId) return state;
    return { ...state, streamId: null, isStreaming: false };
  }
  if (messageStreamId) {
    return { ...state, streamId: messageStreamId, isStreaming: true };
  }
  return state;
}

export async function printStatus(client, connection) {
  const [health, identity] = await Promise.all([
    client.health(),
    client.identity().catch(() => null),
  ]);
  const theme = createTerminalTheme(health.agentYuan);
  console.log(`${paint(theme, theme.symbol)} HanaAgent Server`);
  console.log(`  ${ansi.dim}URL${ansi.reset}       ${connection.baseUrl}`);
  console.log(`  ${ansi.dim}Version${ansi.reset}   ${identity?.version || health.version || "unknown"}`);
  console.log(`  ${ansi.dim}Studio${ansi.reset}    ${identity?.studioLabel || identity?.studioId || "local"}`);
  console.log(`  ${ansi.dim}Agent${ansi.reset}     ${health.agent || "Agent"} · ${theme.yuan} · ${theme.symbol}`);
  console.log(`  ${ansi.dim}Model${ansi.reset}     ${health.model || "not set"}`);
  console.log(`  ${ansi.dim}Auth${ansi.reset}      ${identity?.credentialKind || connection.source || "unknown"}`);
}

export async function printSessions(client, { limit = 20 } = {}) {
  const sessions = await client.sessions();
  if (!sessions.length) {
    console.log(`${ansi.dim}No sessions yet.${ansi.reset}`);
    return [];
  }
  for (const [idx, session] of sessions.slice(0, limit).entries()) {
    console.log(formatSessionLine(session, idx + 1));
  }
  return sessions;
}

export async function startChat(client, connection, opts: { session?: any; target?: any; plain?: boolean } = {}) {
  const ctx = await loadContext(client);
  let theme = createTerminalTheme(ctx.agentYuan);
  let session = await resolveChatSession(client, opts.session || opts.target);
  let sessionPath = session.path;
  let sessionId = session.sessionId || null;
  const ws = client.createWebSocket();
  const plain = opts.plain === true || !process.stdin.isTTY;

  let streaming = false;
  let activeStreamId = null;
  let abortRequestedStreamId = null;
  let currentMood = "";
  let thinkingTimer = null;
  let thinkingFrame = 0;
  let ready = false;
  let closed = false;
  let inputEnded = false;
  let draining = false;
  let keypressHandler = null;
  const inputQueue: string[] = [];
  let queuedBytes = 0;
  let lastCompletedStreamId = null;
  let failedTurn = false;
  const connectionTimer = setTimeout(() => {
    console.error("WebSocket connection timed out.");
    closeAndExit(1);
  }, 30_000);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  function renderHeader() {
    console.log("");
    console.log(`${paint(theme, theme.symbol)} ${ctx.agentName} ${ansi.dim}· ${theme.yuan} · ${connection.baseUrl}${ansi.reset}`);
    console.log(`${ansi.dim}Session · ${session.title || session.firstMessage || session.path}${ansi.reset}`);
    console.log(`${ansi.dim}Type /help for commands.${plain ? " Plain mode is line-oriented." : " Ctrl+C aborts or exits."}${ansi.reset}\n`);
  }

  function prompt() {
    if (closed || !ready || inputEnded) return;
    process.stdout.write(`${paint(theme, ctx.userName || "you")} ${ansi.dim}›${ansi.reset} `);
  }

  function startThinking() {
    if (thinkingTimer) return;
    const frames = [
      `${theme.symbol} ${ctx.agentName} 正在思考`,
      `${theme.symbol} ${ctx.agentName} 正在整理上下文`,
      `${theme.symbol} ${ctx.agentName} 正在看工具轨迹`,
    ];
    const tick = () => {
      const text = frames[thinkingFrame++ % frames.length];
      process.stdout.write(`\r${ansi.dim}${text}${".".repeat((thinkingFrame % 3) + 1)}${ansi.reset}\x1b[K`);
    };
    tick();
    thinkingTimer = setInterval(tick, 500);
  }

  function stopThinking() {
    if (!thinkingTimer) return;
    clearInterval(thinkingTimer);
    thinkingTimer = null;
    process.stdout.write("\r\x1b[K");
  }

  async function refreshTheme() {
    const next = await loadContext(client).catch(() => null);
    if (!next) return;
    ctx.agentName = next.agentName;
    ctx.userName = next.userName;
    ctx.agentYuan = next.agentYuan;
    theme = createTerminalTheme(ctx.agentYuan);
  }

  async function switchTo(target) {
    session = await resolveChatSession(client, target);
    sessionPath = session.path;
    sessionId = session.sessionId || null;
    activeStreamId = null;
    abortRequestedStreamId = null;
    streaming = false;
    await refreshTheme();
    console.log(`${ansi.dim}Continued session:${ansi.reset} ${session.title || session.firstMessage || session.path}`);
    prompt();
  }

  async function handleCommand(line) {
    const [cmd, ...parts] = line.slice(1).trim().split(/\s+/);
    if (cmd === "q" || cmd === "quit" || cmd === "exit") {
      closeAndExit(0);
      return;
    }
    if (cmd === "help" || cmd === "h") {
      console.log(`
${paint(theme, "/sessions")}          list recent sessions
${paint(theme, "/continue <n|path>")} continue a session
${paint(theme, "/new")}               create a new session
${paint(theme, "/status")}            show server status
${paint(theme, "/quit")}              exit
`);
      prompt();
      return;
    }
    if (cmd === "sessions") {
      await printSessions(client);
      prompt();
      return;
    }
    if (cmd === "continue") {
      await switchTo(parts.join(" "));
      return;
    }
    if (cmd === "new") {
      const created = await client.newSession();
      session = {
        ...created,
        path: created.path,
        title: null,
        firstMessage: "",
      };
      sessionPath = created.path;
      sessionId = created.sessionId || null;
      activeStreamId = null;
      abortRequestedStreamId = null;
      streaming = false;
      console.log(`${paint(theme, theme.symbol)} New session`);
      prompt();
      return;
    }
    if (cmd === "status") {
      await printStatus(client, connection);
      prompt();
      return;
    }
    console.log(`${ansi.dim}Unknown command: /${cmd}${ansi.reset}`);
    prompt();
  }

  function closeAndExit(code) {
    if (closed) return;
    closed = true;
    ready = false;
    clearTimeout(connectionTimer);
    stopThinking();
    if (inputQueue.length) {
      console.error(`${inputQueue.length} queued input line(s) not sent or executed.`);
    }
    if (keypressHandler) process.stdin.off("keypress", keypressHandler);
    try { rl.close(); } catch (error) { console.error("Failed to close chat input:", error.message); }
    try { ws.close(); } catch (error) { console.error("Failed to close chat connection:", error.message); }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch (error) { console.error("Failed to restore terminal input mode:", error.message); }
    }
    // EOF can finish a piped chat while stdout still has buffered response
    // bytes. Flush both streams before exiting so the final answer survives.
    process.stdout.write("", () => {
      process.stderr.write("", () => process.exit(code));
    });
  }

  ws.on("open", () => {
    if (closed) return;
    ready = true;
    clearTimeout(connectionTimer);
    renderHeader();
    prompt();
    void drainInput();
  });

  ws.on("message", async (data) => {
    if (closed) return;
    const msg = safeParse(data.toString());
    if (!msg) return;
    if (msg.type === "app_event" && (
      msg.event?.type === "agent-switched"
      || msg.event?.type === "agent-updated"
    )) {
      await refreshTheme();
      return;
    }
    if (!cliChatMessageMatchesSession({ sessionId, sessionPath }, msg)) return;
    // A turn may end with both status(false) and turn_end. Once the next
    // prompt is sent, the previous turn's trailing packet cannot release it.
    if (streaming && !activeStreamId && (
      (msg.streamId && msg.streamId === lastCompletedStreamId)
      || (msg.type === "status" && msg.isStreaming === false && !msg.streamId)
    )) return;
    const wasStreaming = streaming;
    const tracked = reduceCliChatStreamIdentity({
      sessionId,
      sessionPath,
      streamId: activeStreamId,
      isStreaming: streaming,
    }, msg);
    activeStreamId = tracked.streamId;
    streaming = tracked.isStreaming;
    if (wasStreaming && !streaming) lastCompletedStreamId = nonEmptyString(msg.streamId);
    switch (msg.type) {
      case "text_delta":
        stopThinking();
        if (!wasStreaming) {
          process.stdout.write("\n");
        }
        process.stdout.write(msg.delta || "");
        break;
      case "mood_start":
        currentMood = "";
        break;
      case "mood_text":
        currentMood += msg.delta || "";
        break;
      case "mood_end":
        if (currentMood.trim()) {
          process.stdout.write(`\n${theme.accent}${ansi.italic}${theme.moodLabel}${ansi.reset} ${ansi.dim}${currentMood.trim()}${ansi.reset}\n`);
        }
        currentMood = "";
        break;
      case "thinking_start":
        startThinking();
        break;
      case "thinking_end":
        stopThinking();
        break;
      case "tool_start":
        stopThinking();
        process.stdout.write(`\n${theme.accent}◇${ansi.reset} ${ansi.dim}${msg.name || "tool"}${ansi.reset}`);
        break;
      case "tool_end":
        process.stdout.write(msg.success === false ? ` ${ansi.red}failed${ansi.reset}\n` : ` ${ansi.green}done${ansi.reset}\n`);
        break;
      case "turn_end":
        if (streaming) return;
        stopThinking();
        abortRequestedStreamId = null;
        process.stdout.write("\n");
        prompt();
        break;
      case "error":
        if (streaming) return;
        failedTurn = true;
        stopThinking();
        abortRequestedStreamId = null;
        process.stdout.write(`\n${ansi.red}${msg.message || "error"}${ansi.reset}\n`);
        prompt();
        break;
      case "status":
        if (!streaming) {
          stopThinking();
          abortRequestedStreamId = null;
        }
        break;
      case "abort_rejected":
        abortRequestedStreamId = null;
        process.stdout.write(`\n${ansi.yellow}Stop request ignored because the active stream changed.${ansi.reset}\n`);
        break;
      default:
        break;
    }
    if (!streaming) void drainInput();
  });

  ws.on("close", () => {
    if (closed) return;
    console.log(`\n${ansi.dim}Disconnected.${ansi.reset}`);
    closeAndExit(!ready || streaming || inputQueue.length || draining ? 1 : 0);
  });

  ws.on("error", (err) => {
    if (closed) return;
    console.error(`\n${ansi.red}${err.message}${ansi.reset}`);
    closeAndExit(1);
  });

  // Serialize both commands and prompts. In particular /new must finish
  // before the next piped prompt captures its session identity.
  async function drainInput() {
    if (closed || !ready || draining || streaming) return;
    draining = true;
    try {
      while (!closed && ready && !streaming && inputQueue.length) {
        const line = inputQueue[0];
        if (line.startsWith("/")) {
          inputQueue.shift();
          queuedBytes -= Buffer.byteLength(line);
          try { await handleCommand(line); } catch (err) {
            if (closed) return;
            console.error(`${ansi.red}${err.message}${ansi.reset}`);
            if (inputEnded || !process.stdin.isTTY) { closeAndExit(1); return; }
            prompt();
          }
          continue;
        }
        const message = createCliChatPromptMessage({ sessionId, sessionPath }, line);
        if (!message) throw new Error("Session identity unavailable; reconnect or choose another session.");
        // Set busy before send, not after the server's first status packet.
        streaming = true;
        ws.send(JSON.stringify(message), (err) => {
          if (!err || closed) return;
          console.error(`${ansi.red}Message delivery failed: ${err.message}${ansi.reset}`);
          closeAndExit(1);
        });
        if (closed) return;
        inputQueue.shift();
        queuedBytes -= Buffer.byteLength(line);
      }
    } catch (err) {
      console.error(`${ansi.red}${err.message}${ansi.reset}`);
      closeAndExit(1);
    } finally {
      draining = false;
    }
    if (!closed && inputEnded && !streaming && !inputQueue.length) closeAndExit(failedTurn ? 1 : 0);
  }

  rl.on("line", (input) => {
    if (closed) return;
    const line = input.trim();
    if (!line) {
      prompt();
      return;
    }
    if (inputQueue.length >= 1024 || queuedBytes + Buffer.byteLength(line) > 1024 * 1024) {
      console.error("Input queue limit exceeded; incoming line was not sent.");
      closeAndExit(1);
      return;
    }
    inputQueue.push(line);
    queuedBytes += Buffer.byteLength(line);
    void drainInput();
  });

  rl.on("close", () => {
    if (closed) return;
    inputEnded = true;
    void drainInput();
  });

  readline.emitKeypressEvents(process.stdin, rl);
  if (!plain && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    const requestAbort = () => {
      if (closed || !ready) return false;
      const message = createCliChatAbortMessage({ sessionId, sessionPath, streamId: activeStreamId });
      if (!message) {
        process.stdout.write(`\n${ansi.yellow}Stop unavailable until the active stream identity is known.${ansi.reset}\n`);
        return false;
      }
      if (abortRequestedStreamId === message.streamId) return true;
      try { ws.send(JSON.stringify(message)); } catch (err) {
        console.error(`${ansi.red}${err.message}${ansi.reset}`);
        closeAndExit(1);
        return false;
      }
      abortRequestedStreamId = message.streamId;
      process.stdout.write(`\n${ansi.dim}Stop requested…${ansi.reset}\n`);
      return true;
    };
    keypressHandler = (_str, key) => {
      if (!key) return;
      if (key.name === "escape" && streaming) {
        requestAbort();
      }
      if (key.ctrl && key.name === "c") {
        if (streaming) {
          requestAbort();
        } else {
          closeAndExit(0);
        }
      }
    };
    process.stdin.on("keypress", keypressHandler);
  }
}

async function loadContext(client) {
  const [health, agentsResult] = await Promise.all([
    client.health(),
    client.agents().catch(() => ({ agents: [] })),
  ]);
  const agents = Array.isArray(agentsResult.agents) ? agentsResult.agents : [];
  const current = agents.find((agent) => agent.id === health.agentId)
    || agents.find((agent) => agent.name === health.agent)
    || agents[0]
    || null;
  return {
    agentId: health.agentId || current?.id || null,
    agentName: health.agent || current?.name || "Hana",
    agentYuan: health.agentYuan || current?.yuan || "hanako",
    userName: health.user || "you",
  };
}

async function resolveChatSession(client, target) {
  if (target) {
    const sessions = await client.sessions();
    const found = selectSession(sessions, target);
    if (!found) throw new Error(`Session not found: ${target}`);
    await client.switchSession(found.path);
    return found;
  }

  const sessions = await client.sessions();
  if (sessions[0]) {
    await client.switchSession(sessions[0].path);
    return sessions[0];
  }
  const created = await client.newSession();
  return { ...created, path: created.path, title: null, firstMessage: "" };
}

export function selectSession(sessions, target) {
  if (!target) return sessions[0] || null;
  const trimmed = String(target).trim();
  const maybeIndex = Number.parseInt(trimmed, 10);
  if (String(maybeIndex) === trimmed && maybeIndex > 0) {
    return sessions[maybeIndex - 1] || null;
  }
  return sessions.find((session) => session.path === trimmed) || null;
}

export function formatSessionLine(session, index) {
  const title = session.title || session.firstMessage || "Untitled";
  const agent = session.agentName || session.agentId || "Agent";
  const modified = session.modified ? new Date(session.modified).toLocaleString() : "";
  return `${ansi.dim}${String(index).padStart(2, " ")}.${ansi.reset} ${title.slice(0, 72)} ${ansi.dim}· ${agent}${modified ? ` · ${modified}` : ""}${ansi.reset}`;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
