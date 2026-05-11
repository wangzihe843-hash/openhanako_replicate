import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  XINGYE_ROLE_PROFILES_STORAGE_KEY,
  buildOpenHanakoAgentSyncPayload,
  buildOpenHanakoIdentity,
  buildOpenHanakoIshiki,
  getXingyeRoleProfile,
  getXingyeRoleProfileDisplay,
  loadXingyeRoleProfiles,
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

describe('xingye-profile-store', () => {
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

  it('saves one local Xingye profile per OpenHanako agent id', () => {
    const saved = saveXingyeRoleProfile(
      'agent-1',
      {
        displayName: '星野花子',
        shortBio: '会认真记住你的偏好。',
        relationshipLabel: '同伴',
        speakingStyle: '温柔直接',
        allowAutoMoments: true,
        allowProactiveDM: false,
      },
      storage,
    );

    expect(saved).toMatchObject({
      agentId: 'agent-1',
      displayName: '星野花子',
      shortBio: '会认真记住你的偏好。',
      relationshipLabel: '同伴',
      speakingStyle: '温柔直接',
      allowAutoMoments: true,
      allowProactiveDM: false,
    });
    expect(saved.updatedAt).toEqual(expect.any(String));
    expect(getXingyeRoleProfile('agent-1', storage)).toEqual(saved);
    expect(Object.keys(loadXingyeRoleProfiles(storage))).toEqual(['agent-1']);
    expect(storage.getItem(XINGYE_ROLE_PROFILES_STORAGE_KEY)).toContain('星野花子');
  });

  it('stores and clears a Xingye-only chat background data url', () => {
    const saved = saveXingyeRoleProfile(
      'agent-1',
      {
        chatBackgroundDataUrl: 'data:image/webp;base64,background',
      },
      storage,
    );

    expect(saved.chatBackgroundDataUrl).toBe('data:image/webp;base64,background');
    expect(getXingyeRoleProfileDisplay(agent, saved).chatBackgroundDataUrl).toBe('data:image/webp;base64,background');
    expect(buildOpenHanakoAgentSyncPayload(agent, saved).identity).not.toContain('data:image');
    expect(buildOpenHanakoAgentSyncPayload(agent, saved).ishiki).not.toContain('data:image');

    const cleared = saveXingyeRoleProfile(
      'agent-1',
      {
        chatBackgroundDataUrl: undefined,
      },
      storage,
    );

    expect(cleared.chatBackgroundDataUrl).toBeUndefined();
  });

  it('falls back to OpenHanako agent fields when local fields are blank', () => {
    const profile = saveXingyeRoleProfile(
      'agent-1',
      {
        displayName: '   ',
        shortBio: '',
      },
      storage,
    );

    expect(profile.displayName).toBeUndefined();
    expect(profile.shortBio).toBeUndefined();
    expect(getXingyeRoleProfileDisplay(agent, profile)).toMatchObject({
      displayName: 'Hanako',
      shortBio: '尚未填写角色简介。',
    });
  });

  it('ignores malformed storage content', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storage.setItem(XINGYE_ROLE_PROFILES_STORAGE_KEY, '{bad json');

    expect(loadXingyeRoleProfiles(storage)).toEqual({});
    expect(getXingyeRoleProfile('agent-1', storage)).toBeNull();
  });

  it('builds an OpenHanako sync payload from text persona fields only', () => {
    const payload = buildOpenHanakoAgentSyncPayload(agent, {
      agentId: 'agent-1',
      displayName: '星野花子',
      shortBio: '会认真记住用户偏好的搭子。',
      relationshipLabel: '同伴',
      speakingStyle: '温柔直接，回答简短。',
      avatarDataUrl: 'data:image/png;base64,avatar',
      chatBackgroundDataUrl: 'data:image/png;base64,bg',
      allowAutoMoments: true,
      allowProactiveDM: true,
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(payload.identity).toContain('星野花子');
    expect(payload.identity).toContain('会认真记住用户偏好的搭子。');
    expect(payload.ishiki).toContain('同伴');
    expect(payload.ishiki).toContain('温柔直接，回答简短。表达清楚、稳定，不刻意夸张。');
    expect(payload.identity).not.toContain('data:image');
    expect(payload.ishiki).not.toContain('data:image');
    expect(payload.identity).not.toContain('allowAutoMoments');
    expect(payload.ishiki).not.toContain('allowProactiveDM');
  });

  it('expands thin Xingye fields into a structured Chinese OpenHanako persona', () => {
    const payload = buildOpenHanakoAgentSyncPayload(agent, {
      agentId: 'agent-1',
      displayName: '空',
      shortBio: 'test_01',
      relationshipLabel: '朋友',
      speakingStyle: 'deepseek原本风格',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(payload.identity).toContain('# 空');
    expect(payload.identity).toContain('身份尚未完全确定');
    expect(payload.identity).not.toContain('Xingye Persona');
    expect(payload.identity).not.toContain('synced from');
    expect(payload.identity).not.toContain('test_01');

    expect(payload.ishiki).toContain('# 人格定义');
    expect(payload.ishiki).toContain('## 角色是谁');
    expect(payload.ishiki).toContain('## 与用户关系');
    expect(payload.ishiki).toContain('## 说话风格');
    expect(payload.ishiki).toContain('## 互动方式');
    expect(payload.ishiki).toContain('## 稳定人设要求');
    expect(payload.ishiki).toContain('## 边界');
    expect(payload.ishiki).toContain('你与用户的关系是：朋友。');
    expect(payload.ishiki).toContain('理性、直接、克制，有判断力，解释清楚但不过度卖萌。');
    expect(payload.ishiki).toContain('你不编造没有依据的现实经历或外部事实。');
    expect(payload.ishiki).not.toContain('Xingye Persona Definition');
    expect(payload.ishiki).not.toContain('Use this persona as');
    expect(payload.ishiki).not.toContain('test_01');
  });

  it('uses a natural fallback when shortBio is blank', () => {
    const payload = buildOpenHanakoAgentSyncPayload(agent, {
      agentId: 'agent-1',
      displayName: '空',
      shortBio: '',
      relationshipLabel: '',
      speakingStyle: '',
      updatedAt: '2026-05-10T00:00:00.000Z',
    });

    expect(payload.identity).toContain('身份尚未完全确定');
    expect(payload.ishiki).toContain('你与用户的关系是：朋友。');
    expect(payload.ishiki).toContain('理性、直接、克制，有判断力，解释清楚但不过度卖萌。');
  });

  it('does not emit product or engineering terms in OpenHanako formatter output', () => {
    const profile = {
      agentId: 'agent-1',
      displayName: '林雾',
      shortBio: '',
      relationshipLabel: '朋友',
      speakingStyle: '',
      identitySummary: '',
      backgroundSummary: '',
      personalitySummary: '',
      behaviorLogic: '',
      values: '',
      taboos: '',
      relationshipMode: '',
      updatedAt: '2026-05-10T00:00:00.000Z',
    };
    const combined = [
      buildOpenHanakoIdentity(agent, profile),
      buildOpenHanakoIshiki(agent, profile),
      buildOpenHanakoAgentSyncPayload(agent, profile).identity,
      buildOpenHanakoAgentSyncPayload(agent, profile).ishiki,
    ].join('\n');

    for (const term of [
      '星野模式',
      '创建的角色',
      '个人助手',
      '长期陪伴型角色',
      '设定库',
      '同步',
      'OpenHanako',
      'memory',
      'RAG',
      'prompt',
      '工程配置',
      '长期陪伴用户的个人助手',
      '用户在星野模式中创建的角色',
    ]) {
      expect(combined).not.toContain(term);
    }
  });
});
