import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Agent } from '../core/agent.ts';
import { guardMemoryScopeTools, memoryScopeFromBranch, SESSION_MEMORY_SCOPE_RECORD } from '../core/session-memory-scope.ts';
import { FactStore } from '../lib/memory/fact-store.ts';
import { createMemorySearchTool } from '../lib/memory/memory-search.ts';
import { addPinnedMemoryItem } from '../lib/memory/pinned-memory-store.ts';
import { ScopedDerivationStore } from '../lib/memory/scoped-derivation-store.ts';
import { normalizeMemoryScopeContext } from '../shared/memory-scope.ts';
import { readXingyeRuntimeLoreEntriesSync } from '../shared/xingye-runtime-lore-file.js';
import { readXingyeStableLoreMemoryForPromptSync, syncXingyeStableLoreMemoryFile } from '../shared/xingye-lore-memory-file.js';
import { buildXingyeAgentPhoneTurnContext } from '../shared/xingye-phone-context.js';

const story = normalizeMemoryScopeContext({ agentId: 'hana', realm: 'story', worldId: 'w1', branchId: 'b1' });
const alice = normalizeMemoryScopeContext({ ...story, knowledge: 'character', characterId: 'alice' });
const author = normalizeMemoryScopeContext({ ...story, viewpoint: 'author' });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function writeJson(filename: string, content: unknown) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, JSON.stringify(content));
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hana-l1-runtime-'));
  roots.push(root);
  const agentDir = path.join(root, 'agents', 'hana');
  const memoryDir = path.join(agentDir, 'memory');
  const productDir = path.join(root, 'product');
  const userDir = path.join(root, 'user');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(path.join(productDir, 'yuan'), { recursive: true });
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(productDir, 'yuan', 'hanako.md'), 'BASE_IDENTITY');
  fs.writeFileSync(path.join(agentDir, 'pinned.md'), 'LEGACY_PIN_MARKER');
  fs.writeFileSync(path.join(memoryDir, 'memory.md'), 'LEGACY_COMPILED_MARKER');
  fs.writeFileSync(path.join(userDir, 'user.md'), 'REAL_USER_PROFILE_MARKER');
  const agent = new Agent({ id: 'hana', agentsDir: path.join(root, 'agents'), productDir, userDir, channelsDir: undefined, searchConfigResolver: undefined });
  agent._config = { locale: 'en', agent: { name: 'Hana', yuan: 'hanako' }, memory: { enabled: true }, experience: { enabled: false } };
  agent.agentName = 'Hana';
  agent.userName = 'User';
  agent._memoryMasterEnabled = true;
  agent._memorySessionEnabled = true;
  agent._experienceEnabled = false;
  return { root, agentDir, memoryDir, agent };
}
function lore(id: string, memoryScope?: unknown, mode = 'keyword') {
  return { id, agentId: 'hana', title: id, content: id, category: 'background', keywords: ['observatory'],
    enabled: true, visibility: 'canonical', insertionMode: mode, updatedAt: '2026-10-01', memoryScope };
}
function addArtifact(store: ScopedDerivationStore, id: string, scope: unknown) {
  const dependency = store.registerSource({ sessionId: id, revision: 'r1', memoryScope: scope });
  expect(store.commitArtifact({ kind: 'today', slot: id, memoryScope: scope, body: id, dependencies: [dependency] })).not.toBeNull();
}

describe('L1 actual model context boundary', () => {
  it('assembles scoped pins and compiled memory without legacy, other-agent, other-world or other-character content', () => {
    const f = fixture();
    const store = new ScopedDerivationStore(f.memoryDir, { agentId: 'hana' });
    const scopes = [
      ['SHARED', story], ['ALICE', alice], ['BOB', { ...alice, characterId: 'bob' }],
      ['AUTHOR', { ...story, knowledge: 'author' }], ['OTHER_WORLD', { ...story, worldId: 'w2' }],
      ['OTHER_BRANCH', { ...story, branchId: 'b2' }],
    ] as const;
    for (const [label, scope] of scopes) {
      addPinnedMemoryItem(f.agentDir, `${label}_PIN_MARKER`, { memoryScope: scope });
      addArtifact(store, `${label}_COMPILED_MARKER`, scope);
    }
    const legacy = f.agent.buildSystemPrompt();
    expect(legacy).toContain('LEGACY_PIN_MARKER');
    expect(legacy).toContain('LEGACY_COMPILED_MARKER');
    expect(legacy).not.toContain('ALICE_PIN_MARKER');
    const prompt = f.agent.buildSystemPrompt({ memoryScope: alice });
    for (const label of ['SHARED', 'ALICE']) {
      expect(prompt).toContain(`${label}_PIN_MARKER`);
      expect(prompt).toContain(`${label}_COMPILED_MARKER`);
    }
    for (const label of ['LEGACY', 'BOB', 'AUTHOR', 'OTHER_WORLD', 'OTHER_BRANCH']) {
      expect(prompt).not.toContain(`${label}_PIN_MARKER`);
      expect(prompt).not.toContain(`${label}_COMPILED_MARKER`);
    }
    expect(prompt).not.toContain('REAL_USER_PROFILE_MARKER');
    expect(prompt).toContain('BASE_IDENTITY');
    const authorsPrompt = f.agent.buildSystemPrompt({ memoryScope: author });
    expect(authorsPrompt).toContain('BOB_COMPILED_MARKER');
    expect(authorsPrompt).toContain('AUTHOR_COMPILED_MARKER');
    expect(authorsPrompt).not.toContain('OTHER_WORLD_COMPILED_MARKER');
    const reflection = f.agent.buildMemoryReflectionSnapshot({ memoryScope: alice });
    expect(reflection.existingMemory).toContain('ALICE_COMPILED_MARKER');
    expect(reflection.existingMemory).not.toContain('LEGACY_COMPILED_MARKER');
    expect(reflection.existingMemory).not.toContain('BOB_COMPILED_MARKER');
    expect(reflection.userProfile).toBe('');
    store.invalidateSource('ALICE_COMPILED_MARKER');
    expect(f.agent.buildSystemPrompt({ memoryScope: alice })).not.toContain('ALICE_COMPILED_MARKER');
    expect(() => f.agent.buildSystemPrompt({ memoryScope: { ...alice, agentId: 'other' } })).toThrow();
  });

  it.each([
    ['story', story],
    ['reality', normalizeMemoryScopeContext({ agentId: 'hana', realm: 'reality' })],
  ] as const)('scrubs persisted %s cache on the first prompt and reflection read before maintenance', (_realm, memoryScope) => {
    const f = fixture();
    const store = new ScopedDerivationStore(f.memoryDir, { agentId: 'hana' });
    const dependency = store.registerSource({ sessionId: 'old-cache', revision: 'original-source-v1', memoryScope });
    const secret = 'sk-SYNTHETICOLDCACHEKEY1234567890';
    const artifact = store.commitArtifact({ kind: 'facts', slot: 'old-cache', memoryScope, body: `Old key ${secret}`, dependencies: [dependency] });
    const before = fs.readFileSync(store.manifestPath, 'utf8');
    // A new Agent must be safe before its first background compilation runs.
    const agent = new Agent({ id: 'hana', agentsDir: path.join(f.root, 'agents'), productDir: path.join(f.root, 'product'),
      userDir: path.join(f.root, 'user'), channelsDir: undefined, searchConfigResolver: undefined });
    agent._config = f.agent._config;
    agent.agentName = 'Hana';
    agent.userName = 'User';
    agent._memoryMasterEnabled = true;
    agent._memorySessionEnabled = true;
    agent._experienceEnabled = false;
    const prompt = agent.buildSystemPrompt({ memoryScope });
    expect(prompt).toContain('Old key [REDACTED]');
    expect(prompt).not.toContain(secret);
    const reflection = agent.buildMemoryReflectionSnapshot({ memoryScope });
    expect(reflection.existingMemory).toContain('Old key [REDACTED]');
    expect(reflection.existingMemory).not.toContain(secret);
    const reopened = new ScopedDerivationStore(f.memoryDir, { agentId: 'hana' });
    expect(reopened.getArtifact('facts', 'old-cache', memoryScope)).toEqual(artifact);
    expect(reopened.getSourceDependency('old-cache')).toEqual(dependency);
    expect(fs.readFileSync(store.manifestPath, 'utf8')).toBe(before);
  });

  it('filters actual canonical stable and keyword lore before labeling final sections', () => {
    const f = fixture();
    const values = [
      ['LEGACY_LORE_MARKER', undefined], ['SHARED_LORE_MARKER', story], ['ALICE_LORE_MARKER', alice],
      ['AUTHOR_LORE_MARKER', { ...story, knowledge: 'author' }], ['BOB_LORE_MARKER', { ...alice, characterId: 'bob' }],
      ['OTHER_WORLD_LORE_MARKER', { ...story, worldId: 'w2' }], ['OTHER_BRANCH_LORE_MARKER', { ...story, branchId: 'b2' }],
      ['OTHER_AGENT_LORE_MARKER', { ...story, agentId: 'other' }],
    ] as const;
    const entries = values.flatMap(([label, scope]) => [lore(`${label}_STABLE`, scope, 'always'), lore(`${label}_KEYWORD`, scope)]);
    writeJson(path.join(f.agentDir, 'xingye', 'lore', 'entries.json'), Object.fromEntries(entries.map(entry => [entry.id, entry])));
    writeJson(path.join(f.agentDir, 'xingye', 'profile.json'), { scenario: 'UNSCOPED_SCENE_MARKER', relationshipLabel: 'UNSCOPED_RELATION_MARKER' });
    const prompt = f.agent.buildSystemPrompt({ memoryScope: alice, userText: 'observatory' });
    for (const label of ['SHARED', 'ALICE']) {
      expect(prompt).toContain(`${label}_LORE_MARKER_STABLE`);
      expect(prompt).toContain(`${label}_LORE_MARKER_KEYWORD`);
    }
    for (const label of ['LEGACY', 'AUTHOR', 'BOB', 'OTHER_WORLD', 'OTHER_BRANCH', 'OTHER_AGENT']) expect(prompt).not.toContain(`${label}_LORE_MARKER`);
    expect(prompt).not.toContain('UNSCOPED_SCENE_MARKER');
    expect(prompt).not.toContain('UNSCOPED_RELATION_MARKER');
    const authorsPrompt = f.agent.buildSystemPrompt({ memoryScope: author, userText: 'observatory' });
    expect(authorsPrompt).toContain('AUTHOR_LORE_MARKER_STABLE');
    expect(authorsPrompt).toContain('BOB_LORE_MARKER_KEYWORD');
    expect(authorsPrompt).not.toContain('OTHER_BRANCH_LORE_MARKER');
    const legacy = f.agent.buildSystemPrompt({ userText: 'observatory' });
    expect(legacy).toContain('LEGACY_LORE_MARKER');
    expect(legacy).not.toContain('AUTHOR_LORE_MARKER');
  });

  it('cannot recover hidden lore through workspace or managed markdown mirrors', async () => {
    const f = fixture();
    const unscoped = lore('LEGACY_MIRROR_MARKER', undefined, 'always');
    await syncXingyeStableLoreMemoryFile({ hanakoHome: f.root, agentId: 'hana', entries: [unscoped, lore('STORY_MIRROR_MARKER', alice, 'always')] });
    expect(fs.readFileSync(path.join(f.agentDir, 'xingye', 'lore-memory.md'), 'utf8')).not.toContain('STORY_MIRROR_MARKER');
    expect(readXingyeStableLoreMemoryForPromptSync({ hanakoHome: f.root, agentId: 'hana', memoryScope: alice })).toBe('');
    writeJson(path.join(f.root, '.xingye', 'agents', 'hana', 'lore.json'), [lore('WORKSPACE_ALICE_MARKER', alice), lore('WORKSPACE_AUTHOR_MARKER', { ...story, knowledge: 'author' })]);
    const prompt = f.agent.buildSystemPrompt({ memoryScope: alice, userText: 'observatory', xingyeWorkspaceRoot: f.root });
    expect(prompt).toContain('WORKSPACE_ALICE_MARKER');
    expect(prompt).not.toContain('WORKSPACE_AUTHOR_MARKER');
    expect(prompt).not.toContain('LEGACY_MIRROR_MARKER');
    writeJson(path.join(f.agentDir, 'xingye', 'lore', 'entries.json'), {});
    expect(readXingyeRuntimeLoreEntriesSync({ workspaceRoot: f.root, agentDir: f.agentDir, agentId: 'hana', memoryScope: alice })).toEqual([]);
    fs.writeFileSync(path.join(f.agentDir, 'xingye', 'lore', 'entries.json'), '{broken');
    expect(readXingyeRuntimeLoreEntriesSync({ workspaceRoot: f.root, agentDir: f.agentDir, agentId: 'hana', memoryScope: alice })).toEqual([]);
  });

  it('keeps ordinary phone mirror context legacy instead of importing story-only lore', () => {
    const f = fixture();
    const entries = [lore('PHONE_LEGACY_MARKER'), lore('PHONE_STORY_SECRET_MARKER', alice), lore('PHONE_AUTHOR_SECRET_MARKER', { ...story, knowledge: 'author' })];
    writeJson(path.join(f.agentDir, 'xingye', 'lore', 'entries.json'), Object.fromEntries(entries.map(entry => [entry.id, entry])));
    writeJson(path.join(f.agentDir, 'xingye', 'profile.json'), { memoryScope: alice, scenario: 'PHONE_STORY_SCENE_MARKER', backgroundSummary: 'PHONE_STORY_PROFILE_MARKER' });
    const context = buildXingyeAgentPhoneTurnContext({ agentId: 'hana', agentDir: f.agentDir, hanakoHome: f.root,
      agentName: 'Hana', locale: 'en', messageText: 'observatory', peerRefs: [] });
    expect(context).toContain('PHONE_LEGACY_MARKER');
    expect(context).not.toContain('PHONE_STORY_SECRET_MARKER');
    expect(context).not.toContain('PHONE_AUTHOR_SECRET_MARKER');
    expect(context).not.toContain('PHONE_STORY_SCENE_MARKER');
    expect(context).not.toContain('PHONE_STORY_PROFILE_MARKER');
  });

  it('uses durable branch metadata and blocks all narrative side-effect tools before execution', async () => {
    const f = fixture();
    const db = new FactStore(':memory:', { agentId: 'hana' });
    try {
      db.add({ fact: 'SCOPED_SEARCH_ALLOWED', tags: ['marker'], memoryScope: story });
      db.add({ fact: 'AUTHOR_SEARCH_HIDDEN', tags: ['marker'], memoryScope: { ...story, knowledge: 'author' } });
      const branch = [{ type: 'custom', customType: SESSION_MEMORY_SCOPE_RECORD, data: { memoryScope: alice } }];
      let context = memoryScopeFromBranch(branch, 'hana');
      const output = path.join(f.root, 'side-effect.txt');
      const guarded = guardMemoryScopeTools([
        createMemorySearchTool(db, { getMemoryScope: () => context }),
        { name: 'unrecognized_plugin_mutation', execute: async () => { fs.writeFileSync(output, 'executed'); return 'ok'; } },
      ], () => context);
      expect(JSON.stringify(await guarded[0].execute('call', { query: '', tags: ['marker'], memoryScope: author }))).toContain('SCOPED_SEARCH_ALLOWED');
      expect(JSON.stringify(await guarded[0].execute('call', { query: '', tags: ['marker'] }))).not.toContain('AUTHOR_SEARCH_HIDDEN');
      await expect(guarded[1].execute('call', {})).rejects.toThrow('story_tool_disabled');
      expect(fs.existsSync(output)).toBe(false);
      context = normalizeMemoryScopeContext({ agentId: 'hana', realm: 'reality' });
      await expect(guarded[1].execute('call', {})).resolves.toBe('ok');
      expect(fs.readFileSync(output, 'utf8')).toBe('executed');
      expect(() => memoryScopeFromBranch([...branch, { type: 'custom', customType: SESSION_MEMORY_SCOPE_RECORD, data: {} }], 'hana')).toThrow();
      expect(() => memoryScopeFromBranch([{ type: 'custom', customType: SESSION_MEMORY_SCOPE_RECORD, data: { memoryScope: { ...story, agentId: 'other' } } }], 'hana')).toThrow();
    } finally { db.close(); }
  });
});
