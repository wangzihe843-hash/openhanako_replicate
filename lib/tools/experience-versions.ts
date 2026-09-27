/** Reviewable work lessons that extend, rather than replace, the legacy Markdown experience library. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ExperienceVersion = {
  id: string;
  groupId: string;
  version: number;
  category: string;
  content: string;
  scope: { kind: 'workspace'; path: string };
  source: { reference: string; result: 'success' | 'failure' | 'partial' | 'unknown' };
  verification: { method: string; evidence: string | null };
  status: 'proposed' | 'verified' | 'active' | 'superseded' | 'revoked';
  replacesId: string | null;
  createdAt: string;
  verifiedAt: string | null;
  activatedAt: string | null;
  revokedAt: string | null;
};

const FILE_NAME = 'versions.json';
const ACTIVE_STATES = new Set(['proposed', 'verified', 'active']);

function fileFor(agentDir: string) { return path.join(agentDir, 'experience', FILE_NAME); }
function checkedText(value: unknown, name: string, max = 500) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || /[\0]/.test(text)) throw new Error(`${name} is required (1-${max} characters)`);
  return text;
}
function checkedCategory(value: unknown) {
  const text = checkedText(value, 'category', 100);
  if (text === '.' || text === '..' || text.includes('/') || text.includes('\\')
    || /[\r\n]/.test(text) || text.includes('..') || /^[A-Za-z]:/.test(text)) {
    throw new Error('invalid experience category');
  }
  return text;
}
export function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('absolute workspace path is required');
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function read(agentDir: string): ExperienceVersion[] {
  let content: string;
  try { content = fs.readFileSync(fileFor(agentDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const stored = JSON.parse(content);
  if (stored?.version !== 1 || !Array.isArray(stored?.versions)) throw new Error('invalid experience version store');
  return stored.versions as ExperienceVersion[];
}

function write(agentDir: string, versions: ExperienceVersion[]) {
  const file = fileFor(agentDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, versions }, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch {
      // Keep the original write or rename error if temporary cleanup fails.
    }
    throw error;
  }
}

export function listExperienceVersions(agentDir: string): ExperienceVersion[] {
  return read(agentDir);
}

export function proposeExperienceVersion(agentDir: string, input: {
  category: string; content: string; workspacePath: string;
  sourceReference: string; sourceResult: ExperienceVersion['source']['result'];
  verificationMethod: string; replacesId?: string | null;
}): ExperienceVersion {
  const category = checkedCategory(input.category);
  const content = checkedText(input.content, 'content');
  const workspacePath = normalizeWorkspacePath(input.workspacePath);
  const sourceReference = checkedText(input.sourceReference, 'sourceReference');
  const verificationMethod = checkedText(input.verificationMethod, 'verificationMethod');
  if (!['success', 'failure', 'partial', 'unknown'].includes(input.sourceResult)) throw new Error('invalid sourceResult');
  const versions = read(agentDir);
  const replaced = input.replacesId ? versions.find(row => row.id === input.replacesId) : null;
  if (input.replacesId && (!replaced || replaced.status !== 'active'
    || replaced.scope.path !== workspacePath || replaced.category !== category)) {
    throw new Error('replacement must be an active version in the same category and workspace');
  }
  const existing = versions.find(row => row.category === category && row.content === content
    && row.scope?.path === workspacePath && row.replacesId === (replaced?.id ?? null)
    && ACTIVE_STATES.has(row.status));
  if (existing) return existing;
  const now = new Date().toISOString();
  const groupId = replaced?.groupId ?? crypto.randomUUID();
  const row: ExperienceVersion = {
    id: crypto.randomUUID(), groupId,
    version: replaced ? Math.max(...versions.filter(item => item.groupId === groupId).map(item => item.version)) + 1 : 1,
    category, content, scope: { kind: 'workspace', path: workspacePath },
    source: { reference: sourceReference, result: input.sourceResult },
    verification: { method: verificationMethod, evidence: null },
    status: 'proposed', replacesId: replaced?.id ?? null,
    createdAt: now, verifiedAt: null, activatedAt: null, revokedAt: null,
  };
  versions.push(row);
  write(agentDir, versions);
  return row;
}

export function reviewExperienceVersion(agentDir: string, id: string, action: 'verify' | 'activate' | 'revoke', evidence?: string) {
  if (!['verify', 'activate', 'revoke'].includes(action)) throw new Error('invalid experience action');
  const versions = read(agentDir);
  const row = versions.find(item => item.id === id);
  if (!row) throw new Error('experience version not found');
  const now = new Date().toISOString();
  let restored: ExperienceVersion | null = null;
  if (action === 'verify') {
    if (row.status !== 'proposed') throw new Error('only proposed experience can be verified');
    row.verification.evidence = checkedText(evidence, 'verification evidence');
    row.status = 'verified';
    row.verifiedAt = now;
  } else if (action === 'activate') {
    if (row.status !== 'verified') throw new Error('only verified experience can be activated');
    if (row.replacesId) {
      const replaced = versions.find(item => item.id === row.replacesId);
      if (!replaced || replaced.status !== 'active') throw new Error('replacement is no longer active');
      replaced.status = 'superseded';
    }
    row.status = 'active';
    row.activatedAt = now;
  } else {
    if (!['proposed', 'verified', 'active'].includes(row.status)) throw new Error('experience is already inactive');
    const wasActive = row.status === 'active';
    row.status = 'revoked';
    row.revokedAt = now;
    if (wasActive) {
      restored = versions.filter(item => item.groupId === row.groupId && item.status === 'superseded')
        .sort((a, b) => b.version - a.version)[0] ?? null;
      if (restored) restored.status = 'active';
    }
  }
  write(agentDir, versions);
  return { version: row, restored };
}

export function activeExperienceVersions(agentDir: string, workspacePath: string, category?: string): ExperienceVersion[] {
  const normalized = normalizeWorkspacePath(workspacePath);
  return read(agentDir).filter(row => row.status === 'active' && row.scope?.kind === 'workspace'
    && row.scope.path === normalized && (!category || row.category === category));
}
