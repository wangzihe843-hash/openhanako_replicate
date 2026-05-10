import { beforeEach, describe, expect, it } from 'vitest';
import type { Agent } from '../types';
import {
  buildOpenHanakoIdentity,
  buildOpenHanakoIshiki,
  saveXingyeRoleProfile,
} from './xingye-profile-store';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe('xingye layered role profile formatter', () => {
  let storage: MemoryStorage;
  const agent: Agent = {
    id: 'agent-1',
    name: 'Hanako',
    yuan: 'hanako',
    isPrimary: true,
  };

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  it('saves layered Xingye profile fields locally', () => {
    const saved = saveXingyeRoleProfile(
      'agent-1',
      {
        identitySummary: '旧王国的守夜人',
        backgroundSummary: '在王国崩塌后仍守着边境灯塔。',
        personalitySummary: '冷静、重承诺，但对熟悉的人很柔软。',
        behaviorLogic: '先确认风险，再给出可执行建议。',
        values: '守信、克制、保护弱者。',
        taboos: '不要轻易背叛约定，不把苦难当玩笑。',
        relationshipMode: '与用户是互相信任的旅伴。',
      },
      storage,
    );

    expect(saved).toMatchObject({
      identitySummary: '旧王国的守夜人',
      backgroundSummary: '在王国崩塌后仍守着边境灯塔。',
      personalitySummary: '冷静、重承诺，但对熟悉的人很柔软。',
      behaviorLogic: '先确认风险，再给出可执行建议。',
      values: '守信、克制、保护弱者。',
      taboos: '不要轻易背叛约定，不把苦难当玩笑。',
      relationshipMode: '与用户是互相信任的旅伴。',
    });
  });

  it('builds layered identity and ishiki without injecting full lore content', () => {
    const profile = {
      agentId: 'agent-1',
      displayName: '灯塔守夜人',
      shortBio: '边境灯塔的守夜人。',
      relationshipLabel: '旅伴',
      speakingStyle: 'deepseek原本风格',
      identitySummary: '旧王国边境的守夜人，人类，负责守护最后一座灯塔。',
      backgroundSummary: '王国崩塌后仍留在边境，等待失散的同伴归来。',
      personalitySummary: '克制、可靠、重视承诺。',
      behaviorLogic: '遇事先判断风险，再给出清楚可执行的选择。',
      values: '守信、保护重要的人、不滥用力量。',
      taboos: '不轻易背叛约定，不把他人的痛苦当玩笑。',
      relationshipMode: '把用户视为同行的旅伴，亲近但保留边界。',
      updatedAt: '2026-05-10T00:00:00.000Z',
    };
    const fullLore = '这里是一整段很长的完整背景故事原文，包含灯塔、旧王国、战争、组织和地点细节。';

    const identity = buildOpenHanakoIdentity(agent, profile, [{ content: fullLore }]);
    const ishiki = buildOpenHanakoIshiki(agent, profile, [{ content: fullLore }]);

    expect(identity).toContain('# 灯塔守夜人');
    expect(identity).toContain('身份定位：旧王国边境的守夜人，人类，负责守护最后一座灯塔。');
    expect(identity).toContain('与用户关系：旅伴');
    expect(identity).toContain('核心背景：王国崩塌后仍留在边境，等待失散的同伴归来。');
    expect(identity).toContain('角色简介：边境灯塔的守夜人。');
    expect(identity).toContain('基本边界：');
    expect(identity).not.toContain(fullLore);

    expect(ishiki).toContain('# 人格与行动逻辑');
    expect(ishiki).toContain('你的性格基础：克制、可靠、重视承诺。');
    expect(ishiki).toContain('你的说话风格：理性、直接、克制，有判断力，解释清楚但不过度卖萌。');
    expect(ishiki).toContain('你的行事逻辑：遇事先判断风险，再给出清楚可执行的选择。');
    expect(ishiki).toContain('你的价值观：守信、保护重要的人、不滥用力量。');
    expect(ishiki).toContain('你的关系模式：把用户视为同行的旅伴，亲近但保留边界。');
    expect(ishiki).toContain('这些经历会影响你当前的反应：王国崩塌后仍留在边境，等待失散的同伴归来。');
    expect(ishiki).not.toContain(fullLore);
    expect(ishiki).not.toContain('Xingye Persona Definition');
    expect(ishiki).not.toContain('Use this persona as');
  });
});
