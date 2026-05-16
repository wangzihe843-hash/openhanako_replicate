import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type AuthState = 'checking' | 'login' | 'ready';
type Panel = 'chat' | 'files';

interface Principal {
  scopes?: string[];
}

interface ServerIdentity {
  label?: string;
  studioLabel?: string;
  userLabel?: string;
  connectionKind?: string;
  trustState?: string;
  credentialKind?: string;
  capabilities?: string[];
}

interface SessionSummary {
  path: string;
  title?: string | null;
  firstMessage?: string | null;
  modified?: string | null;
  messageCount?: number;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  timestamp?: string | number;
}

interface WorkbenchFile {
  name: string;
  isDir: boolean;
  size: number | null;
  mtime?: string;
}

interface FilePreview {
  file: WorkbenchFile;
  kind: 'text' | 'image' | 'video' | 'pdf' | 'download';
  url: string;
  text?: string;
}

export function MobileApp(): React.ReactElement {
  const [authState, setAuthState] = useState<AuthState>('checking');
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [identity, setIdentity] = useState<ServerIdentity | null>(null);
  const [loginSecret, setLoginSecret] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionPath, setCurrentSessionPath] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [streamingText, setStreamingText] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>('chat');
  const [files, setFiles] = useState<WorkbenchFile[]>([]);
  const [subdir, setSubdir] = useState('');
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [newText, setNewText] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const currentSessionPathRef = useRef<string | null>(null);

  useEffect(() => {
    currentSessionPathRef.current = currentSessionPath;
  }, [currentSessionPath]);

  const loadMessages = useCallback(async (path: string) => {
    const data = await apiJson<{ messages: ChatMessage[] }>(
      `/api/sessions/messages?path=${encodeURIComponent(path)}&all=1`,
    );
    setMessages(Array.isArray(data.messages) ? data.messages : []);
  }, []);

  const loadSessions = useCallback(async () => {
    const data = await apiJson<SessionSummary[]>('/api/sessions');
    const next = Array.isArray(data) ? data : [];
    setSessions(next);
    if (!currentSessionPathRef.current && next[0]?.path) {
      setCurrentSessionPath(next[0].path);
      await loadMessages(next[0].path);
    }
  }, [loadMessages]);

  const loadFiles = useCallback(async (nextSubdir = subdir) => {
    const qs = nextSubdir ? `?subdir=${encodeURIComponent(nextSubdir)}` : '';
    const data = await apiJson<{ files: WorkbenchFile[]; subdir: string }>(`/api/mobile/workbench/files${qs}`);
    setFiles(Array.isArray(data.files) ? data.files : []);
    setSubdir(data.subdir || '');
    setFileError(null);
  }, [subdir]);

  const connectWs = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${scheme}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const sessionPath = typeof msg.sessionPath === 'string' ? msg.sessionPath : null;
      if (sessionPath && sessionPath !== currentSessionPathRef.current) return;

      if (msg.type === 'text_delta' && typeof msg.delta === 'string') {
        setStreamingText((text) => text + msg.delta);
      } else if (msg.type === 'turn_end') {
        setStreamingText('');
        const target = currentSessionPathRef.current;
        if (target) loadMessages(target).catch(() => null);
        loadSessions().catch(() => null);
        setBusy(false);
      } else if (msg.type === 'status') {
        setBusy(msg.isStreaming === true);
      } else if (msg.type === 'error') {
        setBusy(false);
        setStreamingText('');
        setMessages((items) => [
          ...items,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: typeof msg.message === 'string' ? msg.message : '请求失败',
          },
        ]);
      }
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [loadMessages, loadSessions]);

  const bootstrap = useCallback(async () => {
    const session = await apiJson<{ authenticated: boolean; principal: Principal | null }>('/api/web-auth/session');
    if (!session.authenticated) {
      setAuthState('login');
      return;
    }
    setPrincipal(session.principal);
    const serverIdentity = await apiJson<ServerIdentity>('/api/server/identity');
    setIdentity(serverIdentity);
    setAuthState('ready');
    await Promise.all([loadSessions(), loadFiles('')]);
    connectWs();
  }, [connectWs, loadFiles, loadSessions]);

  useEffect(() => {
    bootstrap().catch(() => setAuthState('login'));
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [bootstrap]);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoginError(null);
    try {
      await apiJson('/api/web-auth/login', {
        method: 'POST',
        body: JSON.stringify({ credential: loginSecret.trim() }),
      });
      setLoginSecret('');
      await bootstrap();
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : '登录失败');
    }
  };

  const selectSession = async (path: string) => {
    setCurrentSessionPath(path);
    setStreamingText('');
    await loadMessages(path);
  };

  const createSession = async () => {
    const data = await apiJson<{ path: string }>('/api/sessions/new', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (data.path) {
      setCurrentSessionPath(data.path);
      setMessages([]);
      await loadSessions();
    }
  };

  const sendPrompt = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    let sessionPath = currentSessionPath;
    if (!sessionPath) {
      const data = await apiJson<{ path: string }>('/api/sessions/new', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      sessionPath = data.path;
      setCurrentSessionPath(sessionPath);
    }
    connectWs();
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setTimeout(() => sendWsPrompt(sessionPath, text), 100);
    } else {
      sendWsPrompt(sessionPath, text);
    }
    setDraft('');
    setBusy(true);
    setMessages((items) => [
      ...items,
      { id: `local-${Date.now()}`, role: 'user', content: text, timestamp: Date.now() },
    ]);
  };

  const sendWsPrompt = (sessionPath: string | null, text: string) => {
    if (!sessionPath || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setBusy(false);
      return;
    }
    wsRef.current.send(JSON.stringify({ type: 'prompt', sessionPath, text }));
  };

  const openFile = async (file: WorkbenchFile) => {
    if (file.isDir) {
      const next = subdir ? `${subdir}/${file.name}` : file.name;
      setPreview(null);
      await loadFiles(next);
      return;
    }
    const url = contentUrl(subdir, file.name);
    const kind = previewKind(file.name);
    if (kind === 'text') {
      const res = await fetch(url, { credentials: 'same-origin' });
      setPreview({ file, kind, url, text: await res.text() });
    } else {
      setPreview({ file, kind, url });
    }
  };

  const goUp = async () => {
    const parts = subdir.split('/').filter(Boolean);
    parts.pop();
    await loadFiles(parts.join('/'));
    setPreview(null);
  };

  const runFileAction = async (body: Record<string, unknown>) => {
    await apiJson('/api/mobile/workbench/actions', {
      method: 'POST',
      body: JSON.stringify({ subdir, ...body }),
    });
    setNewItemName('');
    setNewText('');
    setPreview(null);
    await loadFiles(subdir);
  };

  const uploadFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;
    const payload = [];
    for (const file of Array.from(fileList)) {
      const base64 = await fileToBase64(file);
      payload.push({ name: file.name, contentBase64: base64 });
    }
    await apiJson('/api/mobile/workbench/upload', {
      method: 'POST',
      body: JSON.stringify({ subdir, files: payload }),
    });
    await loadFiles(subdir);
  };

  const pathLabel = useMemo(() => subdir || '工作台', [subdir]);

  if (authState === 'checking') {
    return <div className="mobile-loading">正在连接 Hana...</div>;
  }

  if (authState === 'login') {
    return (
      <main className="mobile-login">
        <form className="mobile-login-panel" onSubmit={login}>
          <img src="./assets/Hanako.png" alt="" className="mobile-login-avatar" />
          <h1>手机访问 Hana</h1>
          <p>输入桌面端为这台设备生成的访问密钥。登录后会改用 HttpOnly 会话 cookie。</p>
          <label>
            访问密钥
            <input
              value={loginSecret}
              onChange={(event) => setLoginSecret(event.target.value)}
              autoComplete="one-time-code"
              spellCheck={false}
            />
          </label>
          {loginError && <div className="mobile-error">{loginError}</div>}
          <button type="submit" disabled={!loginSecret.trim()}>登录</button>
        </form>
      </main>
    );
  }

  return (
    <main className="mobile-app">
      <header className="mobile-topbar">
        <div>
          <div className="mobile-kicker">{identity?.connectionKind || 'local'} · {identity?.trustState || 'trusted'}</div>
          <h1>{identity?.studioLabel || identity?.label || 'Hana Studio'}</h1>
        </div>
        <div className="mobile-scope">{principal?.scopes?.includes('files.write') ? '可写' : '只读'}</div>
      </header>

      <nav className="mobile-tabs" aria-label="手机导航">
        <button className={panel === 'chat' ? 'active' : ''} onClick={() => setPanel('chat')}>会话</button>
        <button className={panel === 'files' ? 'active' : ''} onClick={() => setPanel('files')}>工作台</button>
      </nav>

      {panel === 'chat' ? (
        <section className="mobile-chat">
          <aside className="mobile-session-list">
            <button className="mobile-new-session" onClick={createSession}>新会话</button>
            {sessions.map((session) => (
              <button
                key={session.path}
                className={session.path === currentSessionPath ? 'mobile-session active' : 'mobile-session'}
                onClick={() => selectSession(session.path)}
              >
                <strong>{session.title || session.firstMessage || '未命名会话'}</strong>
                <span>{session.messageCount || 0} 条消息</span>
              </button>
            ))}
          </aside>

          <section className="mobile-thread" aria-live="polite">
            <div className="mobile-messages">
              {messages.length === 0 && !streamingText ? (
                <div className="mobile-empty">选择一个会话，或直接开始新的对话。</div>
              ) : null}
              {messages.map((message) => (
                <article key={message.id} className={`mobile-message ${message.role}`}>
                  <div className="mobile-message-role">{message.role === 'user' ? '我' : 'Hana'}</div>
                  {message.thinking && <pre className="mobile-thinking">{message.thinking}</pre>}
                  <p>{message.content}</p>
                </article>
              ))}
              {streamingText && (
                <article className="mobile-message assistant streaming">
                  <div className="mobile-message-role">Hana</div>
                  <p>{streamingText}</p>
                </article>
              )}
            </div>
            <form className="mobile-composer" onSubmit={sendPrompt}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="发消息给 Hana"
                rows={1}
              />
              <button type="submit" disabled={!draft.trim() || busy}>{busy ? '等待' : '发送'}</button>
            </form>
          </section>
        </section>
      ) : (
        <section className="mobile-files">
          <div className="mobile-files-header">
            <button onClick={goUp} disabled={!subdir}>上一级</button>
            <strong>{pathLabel}</strong>
            <button onClick={() => loadFiles(subdir)}>刷新</button>
          </div>

          <div className="mobile-file-actions">
            <input
              value={newItemName}
              onChange={(event) => setNewItemName(event.target.value)}
              placeholder="名称"
            />
            <button disabled={!newItemName.trim()} onClick={() => runFileAction({ action: 'mkdir', name: newItemName })}>新文件夹</button>
            <button disabled={!newItemName.trim()} onClick={() => runFileAction({ action: 'create', name: newItemName, content: newText })}>新文本</button>
            <label className="mobile-upload">
              上传
              <input type="file" multiple onChange={(event) => uploadFiles(event.target.files)} />
            </label>
          </div>
          <textarea
            className="mobile-new-text"
            value={newText}
            onChange={(event) => setNewText(event.target.value)}
            placeholder="新文本内容，可留空"
            rows={3}
          />

          {fileError && <div className="mobile-error">{fileError}</div>}

          <div className="mobile-file-list">
            {files.map((file) => (
              <button key={file.name} className="mobile-file-row" onClick={() => openFile(file).catch((err) => setFileError(String(err)))}>
                <span className="mobile-file-icon">{file.isDir ? '□' : fileIcon(file.name)}</span>
                <span>
                  <strong>{file.name}</strong>
                  <small>{file.isDir ? '文件夹' : formatBytes(file.size || 0)}</small>
                </span>
              </button>
            ))}
          </div>

          {preview && (
            <section className="mobile-preview">
              <div className="mobile-preview-header">
                <strong>{preview.file.name}</strong>
                <button onClick={() => setPreview(null)}>关闭</button>
              </div>
              {preview.kind === 'text' && (
                <>
                  <textarea
                    value={preview.text || ''}
                    onChange={(event) => setPreview({ ...preview, text: event.target.value })}
                    rows={12}
                  />
                  <div className="mobile-preview-actions">
                    <button onClick={() => runFileAction({ action: 'writeText', name: preview.file.name, content: preview.text || '' })}>保存</button>
                    <button onClick={() => runFileAction({ action: 'safeDelete', name: preview.file.name })}>移到回收区</button>
                  </div>
                </>
              )}
              {preview.kind === 'image' && <img src={preview.url} alt={preview.file.name} />}
              {preview.kind === 'video' && <video src={preview.url} controls />}
              {preview.kind === 'pdf' && <iframe title={preview.file.name} src={preview.url} />}
              {preview.kind === 'download' && <a href={preview.url} target="_blank" rel="noreferrer">打开文件</a>}
            </section>
          )}
        </section>
      )}
    </main>
  );
}

async function apiJson<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('Accept', 'application/json');
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      detail = data.detail || data.error || detail;
    } catch {}
    throw new Error(detail);
  }
  return await res.json() as T;
}

function contentUrl(subdir: string, name: string): string {
  const params = new URLSearchParams();
  if (subdir) params.set('subdir', subdir);
  params.set('name', name);
  return `/api/mobile/workbench/content?${params.toString()}`;
}

function previewKind(name: string): FilePreview['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['txt', 'md', 'markdown', 'json', 'js', 'ts', 'tsx', 'css', 'html', 'csv', 'log'].includes(ext)) return 'text';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video';
  if (ext === 'pdf') return 'pdf';
  return 'download';
}

function fileIcon(name: string): string {
  const kind = previewKind(name);
  if (kind === 'image') return '◇';
  if (kind === 'video') return '▷';
  if (kind === 'pdf') return 'P';
  if (kind === 'text') return 'T';
  return '·';
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => {
      const value = String(reader.result || '');
      resolve(value.includes(',') ? value.slice(value.indexOf(',') + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}
