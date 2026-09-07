import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildXingyeAgentPhoneTurnContext } from './xingye-phone-context.js';

let hanakoHome;
let agentDir;

function writeJson(relativePath, data) {
  const filePath = path.join(agentDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function loreEntry(id, category, keywords, content) {
  return {
    id,
    agentId: 'alice',
    title: id,
    content,
    category,
    keywords,
    enabled: true,
    visibility: 'canonical',
    insertionMode: 'keyword',
    priority: 50,
  };
}

beforeEach(() => {
  hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-phone-context-'));
  agentDir = path.join(hanakoHome, 'agents', 'alice');
  writeJson('xingye/profile.json', {
    displayName: 'Alice',
    identitySummary: '守钟人',
    speakingStyle: '熟人面前说话更松弛',
  });
  writeJson('xingye/lore/entries.json', {
    bob: loreEntry('bob', 'relationship', ['Bob', 'bob'], 'Bob 是 Alice 多年的挚友。'),
    carol: loreEntry('carol', 'character', ['Carol', 'carol'], 'Carol 与 Alice 是宿敌。'),
    city: loreEntry('city', 'location', ['旧城区'], '旧城区入夜后会敲三次钟。'),
  });
});

afterEach(() => {
  fs.rmSync(hanakoHome, { recursive: true, force: true });
});

describe('buildXingyeAgentPhoneTurnContext', () => {
  it('combines latest self profile, real-speaker relationship, and topical keyword lore', () => {
    const out = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice',
      agentDir,
      hanakoHome,
      agentName: 'Alice',
      locale: 'zh-CN',
      messageText: '[now] bob: 我刚从旧城区回来，Carol 也在那里。',
      peerRefs: [{ id: 'bob', name: 'Bob' }],
    });

    expect(out).toContain('守钟人');
    expect(out).toContain('熟人面前说话更松弛');
    expect(out).toContain('用户”是使用产品的人');
    expect(out).toContain('Bob（bob）');
    expect(out).toContain('其他独立 AI agent，不是用户，也不是你自己');
    expect(out).toContain('不得把亲友、情敌、同事等关系转移到用户身上');
    expect(out).toContain('Bob 是 Alice 多年的挚友');
    expect(out).toContain('旧城区入夜后会敲三次钟');
    expect(out).not.toContain('Carol 与 Alice 是宿敌');
  });

  it('does not let a mentioned third-party character bypass real-sender isolation', () => {
    const out = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice',
      agentDir,
      hanakoHome,
      locale: 'zh',
      messageText: '[now] bob: Carol 刚才也在这里。',
      peerRefs: [{ id: 'bob', name: 'Bob' }],
    });
    expect(out).toContain('Bob 是 Alice 多年的挚友');
    expect(out).not.toContain('Carol 与 Alice 是宿敌');
  });

  it('does not inject a relationship merely because an unrelated peer has no lore', () => {
    const out = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice',
      agentDir,
      hanakoHome,
      locale: 'zh',
      messageText: '[now] dave: hello',
      peerRefs: [{ id: 'dave', name: 'Dave' }],
    });
    expect(out).toContain('守钟人');
    expect(out).not.toContain('## 你与本轮发言者');
    expect(out).not.toContain('Bob 是 Alice 多年的挚友');
  });

  it('re-reads every category of always lore on each phone turn', () => {
    const entries = {
      alwaysPlace: {
        ...loreEntry('always-place', 'location', [], 'The clocktower is painted blue.'),
        insertionMode: 'always',
      },
    };
    writeJson('xingye/lore/entries.json', entries);
    const first = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice',
      agentDir,
      hanakoHome,
      locale: 'en',
      messageText: '[now] bob: hello',
      peerRefs: [{ id: 'bob', name: 'Bob' }],
    });
    expect(first).toContain('Current Always Lore');
    expect(first).toContain('The clocktower is painted blue.');

    entries.alwaysPlace.content = 'The clocktower is painted red.';
    writeJson('xingye/lore/entries.json', entries);
    const second = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice',
      agentDir,
      hanakoHome,
      locale: 'en',
      messageText: '[now] bob: hello again',
      peerRefs: [{ id: 'bob', name: 'Bob' }],
    });
    expect(second).toContain('The clocktower is painted red.');
    expect(second).not.toContain('The clocktower is painted blue.');
  });

  it('enforces a hard total budget for dynamic phone context', () => {
    writeJson('xingye/profile.json', Object.fromEntries([
      'displayName', 'shortBio', 'identitySummary', 'backgroundSummary', 'personalitySummary',
      'behaviorLogic', 'values', 'taboos', 'speakingStyle', 'relationshipLabel', 'relationshipMode',
    ].map((key) => [key, `${key}:${'很长的资料'.repeat(2_000)}`])));
    const out = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice',
      agentDir,
      hanakoHome,
      locale: 'zh',
      messageText: '[now] bob: 我刚从旧城区回来。',
      peerRefs: [{ id: 'bob', name: 'Bob' }],
    });
    expect(out.length).toBeLessThanOrEqual(14_400);
    expect(out).toContain('Bob 是 Alice 多年的挚友');
  });

  it('renders a legacy always peer relationship only once', () => {
    writeJson('xingye/lore/entries.json', {
      bob: { ...loreEntry('bob', 'relationship', ['bob'], 'UNIQUE LEGACY PEER RELATION'), insertionMode: 'always' },
    });
    const out = buildXingyeAgentPhoneTurnContext({
      agentId: 'alice', agentDir, hanakoHome, locale: 'en', messageText: 'hello', peerRefs: [{ id: 'bob' }],
    });
    expect(out.split('UNIQUE LEGACY PEER RELATION')).toHaveLength(2);
  });
});
