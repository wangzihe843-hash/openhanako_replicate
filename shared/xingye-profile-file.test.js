import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildXingyeAgentPhoneProfileContext,
  buildXingyeAgentGenderPreamble,
  readXingyeAgentPhoneProfileContextSync,
  readXingyeAgentGenderPreambleSync,
  readXingyeProfileJsonSync,
} from './xingye-profile-file.js';

let tempRoot;

async function writeProfile(agentId, profile) {
  const dir = path.join(tempRoot, 'agents', agentId, 'xingye');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'profile.json'), JSON.stringify(profile), 'utf8');
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingye-profile-file-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('readXingyeProfileJsonSync', () => {
  it('reads valid profile.json', async () => {
    await writeProfile('agent-a', { agentId: 'agent-a', gender: 'female', displayName: '林雾' });
    const result = readXingyeProfileJsonSync({ hanakoHome: tempRoot, agentId: 'agent-a' });
    expect(result?.gender).toBe('female');
    expect(result?.displayName).toBe('林雾');
  });

  it('missing file → returns null', () => {
    const result = readXingyeProfileJsonSync({ hanakoHome: tempRoot, agentId: 'agent-missing' });
    expect(result).toBeNull();
  });

  it('corrupted JSON → returns null (does not throw)', async () => {
    const dir = path.join(tempRoot, 'agents', 'agent-broken', 'xingye');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'profile.json'), '{ not valid json', 'utf8');
    expect(readXingyeProfileJsonSync({ hanakoHome: tempRoot, agentId: 'agent-broken' })).toBeNull();
  });

  it('rejects unsafe agentId', () => {
    expect(readXingyeProfileJsonSync({ hanakoHome: tempRoot, agentId: '../escape' })).toBeNull();
    expect(readXingyeProfileJsonSync({ hanakoHome: tempRoot, agentId: '.' })).toBeNull();
    expect(readXingyeProfileJsonSync({ hanakoHome: tempRoot, agentId: '' })).toBeNull();
  });
});

describe('buildXingyeAgentGenderPreamble', () => {
  it('gender=female (zh) → 女性代词约束段，明禁男性指代', () => {
    const out = buildXingyeAgentGenderPreamble({
      profile: { gender: 'female' },
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh-CN',
    });
    expect(out?.title).toBe('# 角色性别与代词约束');
    expect(out?.body).toContain('林雾');
    expect(out?.body).toContain('女性');
    expect(out?.body).toContain('「她」');
    expect(out?.body).toContain('莫子');
    expect(out?.body).toContain('不要把自己当成男性');
    expect(out?.body).toContain('不要预设');
  });

  it('gender=male (zh) → 男性代词约束段', () => {
    const out = buildXingyeAgentGenderPreamble({
      profile: { gender: 'male' },
      agentName: '陈砚',
      userName: '小希',
      locale: 'zh',
    });
    expect(out?.body).toContain('男性');
    expect(out?.body).toContain('「他」');
    expect(out?.body).toContain('不要把自己当成女性');
  });

  it('gender=nonbinary (zh) → 中性代词「TA」 + 禁二元', () => {
    const out = buildXingyeAgentGenderPreamble({
      profile: { gender: 'nonbinary' },
      agentName: 'Kael',
      userName: '莫子',
      locale: 'zh-CN',
    });
    expect(out?.body).toContain('非二元');
    expect(out?.body).toContain('「TA」');
    expect(out?.body).toContain('避免「他 / 她」二元代词');
  });

  it('gender=unspecified → null（不注入）', () => {
    expect(
      buildXingyeAgentGenderPreamble({
        profile: { gender: 'unspecified' },
        agentName: '林雾',
        userName: '莫子',
        locale: 'zh',
      }),
    ).toBeNull();
  });

  it('gender 缺省 / profile=null → null', () => {
    expect(buildXingyeAgentGenderPreamble({ profile: {}, locale: 'zh' })).toBeNull();
    expect(buildXingyeAgentGenderPreamble({ profile: null, locale: 'zh' })).toBeNull();
  });

  it('非法 gender 字符串 → null（不注入；防御 profile 损坏）', () => {
    expect(
      buildXingyeAgentGenderPreamble({
        profile: { gender: 'wtf' },
        locale: 'zh',
      }),
    ).toBeNull();
  });

  it('英文 locale → 英文版 preamble', () => {
    const out = buildXingyeAgentGenderPreamble({
      profile: { gender: 'female' },
      agentName: 'Lin Wu',
      userName: 'Mozi',
      locale: 'en',
    });
    expect(out?.title).toBe('# Role Gender and Pronoun Rules');
    expect(out?.body).toContain('"she"');
    expect(out?.body).toContain('Lin Wu');
    expect(out?.body).toContain('Mozi');
  });

  it('agentName / userName 缺省 → fallback 占位', () => {
    const out = buildXingyeAgentGenderPreamble({ profile: { gender: 'female' }, locale: 'zh' });
    expect(out?.body).toContain('当前角色');
    expect(out?.body).toContain('用户');
  });
});

describe('readXingyeAgentGenderPreambleSync (integration)', () => {
  it('完整链路：写 profile.json → 读出 zh 中文 preamble', async () => {
    await writeProfile('agent-a', { agentId: 'agent-a', gender: 'female' });
    const out = readXingyeAgentGenderPreambleSync({
      hanakoHome: tempRoot,
      agentId: 'agent-a',
      agentName: '林雾',
      userName: '莫子',
      locale: 'zh-CN',
    });
    expect(out?.title).toBe('# 角色性别与代词约束');
    expect(out?.body).toContain('「她」');
  });

  it('profile.json 不存在 → null（不抛错）', () => {
    const out = readXingyeAgentGenderPreambleSync({
      hanakoHome: tempRoot,
      agentId: 'agent-missing',
      locale: 'zh',
    });
    expect(out).toBeNull();
  });

  it('profile.json 没填 gender → null', async () => {
    await writeProfile('agent-no-gender', { agentId: 'agent-no-gender', displayName: '某人' });
    expect(
      readXingyeAgentGenderPreambleSync({
        hanakoHome: tempRoot,
        agentId: 'agent-no-gender',
        locale: 'zh',
      }),
    ).toBeNull();
  });
});

describe('Agent Phone dynamic profile context', () => {
  it('injects bounded current card scene/examples without archived metadata or greetings', async () => {
    await writeProfile('card-role', { scenario: '{{char}} meets the moon', messageExample: '{{char}}: Sample', firstMessage: 'GREETING_NOT_HISTORY', characterCardCompatibility: { sourceCard: { data: { system_prompt: 'INERT_CONTROL', creator_notes: 'INERT_NOTES' } } } });
    const read = () => readXingyeAgentPhoneProfileContextSync({ hanakoHome: tempRoot, agentId: 'card-role', agentName: 'Luna', locale: 'en' });
    expect(read()).toContain('Luna meets the moon');
    expect(read()).toContain('Luna: Sample');
    expect(read()).not.toMatch(/INERT_|GREETING_NOT_HISTORY/);
    await writeProfile('card-role', { scenario: '', messageExample: '' });
    expect(read()).not.toContain('meets the moon');
  });

  it('includes the full narrative profile and excludes operational/media fields', () => {
    const out = buildXingyeAgentPhoneProfileContext({
      profile: {
        displayName: '林雾',
        identitySummary: '北境守钟人',
        personalitySummary: '克制，但会保护亲近的人',
        behaviorLogic: '先观察，再行动',
        values: '守诺',
        taboos: '不拿朋友的秘密取乐',
        speakingStyle: '短句，熟人面前会放松',
        relationshipMode: '与用户互相信任',
        allowProactiveDM: true,
        avatarDataUrl: 'data:image/png;base64,secret',
      },
      agentName: '林雾',
      locale: 'zh-CN',
    });

    expect(out).toContain('你自己的最新角色资料');
    expect(out).toContain('北境守钟人');
    expect(out).toContain('先观察，再行动');
    expect(out).toContain('短句，熟人面前会放松');
    expect(out).not.toContain('allowProactiveDM');
    expect(out).not.toContain('base64');
  });

  it('reads the latest profile from disk for each phone turn', async () => {
    await writeProfile('agent-phone', { displayName: '旧名', speakingStyle: '旧语气' });
    expect(readXingyeAgentPhoneProfileContextSync({
      hanakoHome: tempRoot,
      agentId: 'agent-phone',
      locale: 'zh',
    })).toContain('旧语气');

    await writeProfile('agent-phone', { displayName: '新名', speakingStyle: '新语气' });
    const refreshed = readXingyeAgentPhoneProfileContextSync({
      hanakoHome: tempRoot,
      agentId: 'agent-phone',
      locale: 'zh',
    });
    expect(refreshed).toContain('新语气');
    expect(refreshed).not.toContain('旧语气');
  });

  it('caps every free-text field and the complete phone profile context', () => {
    const huge = '超长字段'.repeat(2_000);
    const profile = Object.fromEntries([
      'displayName', 'shortBio', 'identitySummary', 'backgroundSummary', 'personalitySummary',
      'behaviorLogic', 'values', 'taboos', 'speakingStyle', 'relationshipLabel', 'relationshipMode',
    ].map((key) => [key, `${key}:${huge}`]));
    const out = buildXingyeAgentPhoneProfileContext({ profile, agentName: huge, locale: 'zh' });
    expect(out.length).toBeLessThanOrEqual(4_800);
    expect(out).toContain('身份');
    expect(out).toContain('与用户的相处模式');
    expect(out).not.toContain(huge);
  });
});
