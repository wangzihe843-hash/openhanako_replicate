import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildXingyeAgentRelationshipPreamble,
  readXingyeAgentRelationshipPreambleSync,
} from './xingye-relationship-preamble.js';

let tempRoot;

async function writeProfile(agentId, profile) {
  const dir = path.join(tempRoot, 'agents', agentId, 'xingye');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'profile.json'), JSON.stringify(profile), 'utf8');
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingye-relationship-preamble-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('buildXingyeAgentRelationshipPreamble', () => {
  it('仅 relationshipLabel 存在 (zh) → 输出关系标签段，明示这是「当前」关系', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: { relationshipLabel: '恋人' },
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh-CN',
    });
    expect(out?.title).toBe('# 你对 user 的关系与态度');
    expect(out?.body).toContain('林雾');
    expect(out?.body).toContain('莫子');
    expect(out?.body).toContain('**恋人**');
    expect(out?.body).toContain('「当前」');
    expect(out?.body).toContain('以本段为准');
  });

  it('label + mode 同时存在 → 两段都在 body 里', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: {
        relationshipLabel: '知己相照',
        relationshipMode: '互相知道彼此最难启齿的部分，话不必说全。',
      },
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh',
    });
    expect(out?.body).toContain('**知己相照**');
    expect(out?.body).toContain('互相知道彼此最难启齿的部分');
  });

  it('仅 relationshipMode 存在（label 为空）→ 只输出 mode 段，不输出 label 段', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: { relationshipMode: '保持职业距离，不越界。' },
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh',
    });
    expect(out).not.toBeNull();
    expect(out?.body).toContain('保持职业距离');
    expect(out?.body).not.toMatch(/当前关系：\*\*/); // 没有 label 行
  });

  it('两个字段都为空 → null（不注入空段）', () => {
    expect(
      buildXingyeAgentRelationshipPreamble({
        profile: { relationshipLabel: '', relationshipMode: '' },
        locale: 'zh',
      }),
    ).toBeNull();
    expect(
      buildXingyeAgentRelationshipPreamble({ profile: {}, locale: 'zh' }),
    ).toBeNull();
  });

  it('profile=null / 非对象 → null', () => {
    expect(buildXingyeAgentRelationshipPreamble({ profile: null, locale: 'zh' })).toBeNull();
    expect(buildXingyeAgentRelationshipPreamble({ profile: 'string', locale: 'zh' })).toBeNull();
  });

  it('agentName / userName 缺省 → fallback 占位（zh）', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: { relationshipLabel: '朋友' },
      locale: 'zh',
    });
    expect(out?.body).toContain('当前角色');
    expect(out?.body).toContain('用户');
  });

  it('英文 locale → 英文版 preamble', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: { relationshipLabel: 'lover', relationshipMode: 'Long-term, exclusive.' },
      agentName: 'Lin Wu',
      userName: 'Mozi',
      locale: 'en',
    });
    expect(out?.title).toBe('# Your Relationship with User');
    expect(out?.body).toContain('Lin Wu');
    expect(out?.body).toContain('Mozi');
    expect(out?.body).toContain('**lover**');
    expect(out?.body).toContain('CURRENT relationship');
    expect(out?.body).toContain('Long-term, exclusive.');
  });

  it('对立关系（如「水火不容」）也被输出，且明确"不要假装亲热"', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: { relationshipLabel: '水火不容' },
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh',
    });
    expect(out?.body).toContain('**水火不容**');
    expect(out?.body).toContain('不要假装亲热');
  });

  it('label 前后多余空白会被 trim', () => {
    const out = buildXingyeAgentRelationshipPreamble({
      profile: { relationshipLabel: '  恋人  ' },
      locale: 'zh',
    });
    expect(out?.body).toContain('**恋人**');
    expect(out?.body).not.toContain('**  恋人');
  });
});

describe('readXingyeAgentRelationshipPreambleSync (integration)', () => {
  it('完整链路：profile.json 有 relationshipLabel → 读出 zh preamble', async () => {
    await writeProfile('agent-a', {
      agentId: 'agent-a',
      relationshipLabel: '恋人',
      relationshipMode: '互相把对方当成回家的方向。',
    });
    const out = readXingyeAgentRelationshipPreambleSync({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh-CN',
    });
    expect(out?.title).toBe('# 你对 user 的关系与态度');
    expect(out?.body).toContain('**恋人**');
    expect(out?.body).toContain('回家的方向');
  });

  it('profile.json 不存在 → null（不抛错）', () => {
    const out = readXingyeAgentRelationshipPreambleSync({
      hanakoHome: tempRoot,
      agentId: 'agent-missing',
      locale: 'zh',
    });
    expect(out).toBeNull();
  });

  it('profile.json 不含关系字段 → null（不污染 prompt）', async () => {
    await writeProfile('agent-no-rel', {
      agentId: 'agent-no-rel',
      displayName: '某人',
      gender: 'female',
    });
    expect(
      readXingyeAgentRelationshipPreambleSync({
        hanakoHome: tempRoot,
        agentId: 'agent-no-rel',
        locale: 'zh',
      }),
    ).toBeNull();
  });

  it('rejects unsafe agentId (转交底层 readXingyeProfileJsonSync)', () => {
    expect(
      readXingyeAgentRelationshipPreambleSync({
        hanakoHome: tempRoot,
        agentId: '../escape',
        locale: 'zh',
      }),
    ).toBeNull();
  });
});
