import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock 整个 profile-store：state-store 在 update/reset 关系变化时会
 * fire-and-forget 调 saveXingyeRoleProfile 把 relationshipLabel 同步回详情页。
 * 这里把它替换成 vi.fn() 让我们可以断言「同步是否被触发 / 传了什么」。
 *
 * 注：vi.mock 被 vitest 提升到文件顶部，所以引用的 mock 工厂必须用 vi.hoisted
 * 一起提升 —— 否则会撞 "Cannot access 'X' before initialization"。
 */
const { mockSaveXingyeRoleProfile } = vi.hoisted(() => ({
  mockSaveXingyeRoleProfile: vi.fn(async () => ({ agentId: 'mock', updatedAt: new Date().toISOString() })),
}));
vi.mock('./xingye-profile-store', () => ({
  saveXingyeRoleProfile: mockSaveXingyeRoleProfile,
}));

import {
  XINGYE_RELATIONSHIP_STATES_STORAGE_KEY,
  clampRelationshipState,
  deriveInitialAffectionFromLabel,
  deriveRelationshipStage,
  ensureRelationshipState,
  getRelationshipLabelFromStage,
  getRelationshipState,
  getStateDisplayBadges,
  resetRelationshipState,
  saveRelationshipState,
  updateRelationshipState,
  type XingyeRelationshipState,
} from './xingye-state-store';
import {
  deriveInitialLoyaltyFromAffection,
  deriveInitialTrustFromAffection,
} from './xingye-state-init';

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

describe('xingye-state-store', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
    mockSaveXingyeRoleProfile.mockClear();
  });

  it('derives initial affection from the role relationship label', () => {
    expect(deriveInitialAffectionFromLabel('恋人')).toBe(90);
    expect(deriveInitialAffectionFromLabel('水火不容')).toBe(-80);
    expect(deriveInitialAffectionFromLabel('知己相照')).toBe(60);
    expect(deriveInitialAffectionFromLabel('普通搭子')).toBe(0);
  });

  it('maps affection to the required stage labels', () => {
    expect(deriveRelationshipStage(-60)).toBe('enemy');
    expect(deriveRelationshipStage(-20)).toBe('estranged');
    expect(deriveRelationshipStage(19)).toBe('stranger');
    expect(deriveRelationshipStage(49)).toBe('friend');
    expect(deriveRelationshipStage(79)).toBe('close_friend');
    expect(deriveRelationshipStage(119)).toBe('lover');
    expect(deriveRelationshipStage(120)).toBe('bond');
    expect(getRelationshipLabelFromStage('bond')).toBe('朝夕相许');
  });

  it('creates one agent-to-user state and persists it in localStorage', () => {
    const state = ensureRelationshipState(
      'agent-1',
      { relationshipLabel: '恋人' },
      storage,
    );

    expect(state).toMatchObject({
      agentId: 'agent-1',
      targetType: 'user',
      targetId: '__user__',
      affection: 90,
      // 信任 / 忠诚机械跟好感走（恋人不再是 0 信任 0 忠诚）；醋意是当下情绪态、初始仍 0；
      // 黑化无 profile/lore 信号 → 0。
      trust: deriveInitialTrustFromAffection(90),
      loyalty: deriveInitialLoyaltyFromAffection(90),
      jealousy: 0,
      corruption: 0,
      mood: '平静',
      relationshipKey: 'lover',
      relationshipLabel: '情愫暗生',
      source: 'initial',
    });
    expect(getRelationshipState('agent-1', storage)).toEqual(state);
    expect(storage.getItem(XINGYE_RELATIONSHIP_STATES_STORAGE_KEY)).toContain('agent-1');
  });

  it('黑化初始化：profile.corruptionTendency（LLM/用户显式档位）优先播种', () => {
    const state = ensureRelationshipState(
      'agent-dark',
      { relationshipLabel: '朋友', corruptionTendency: 'marked' },
      storage,
    );
    expect(state.corruption).toBe(28);
  });

  it('黑化初始化：无显式档位时，扫 profile 自由文本关键词兜底', () => {
    const state = ensureRelationshipState(
      'agent-latent',
      { relationshipLabel: '朋友', personalitySummary: '有点占有欲，缺乏安全感' },
      storage,
    );
    expect(state.corruption).toBeGreaterThan(0);
    // 没有任何阴暗信号 → 仍是 0
    const clean = ensureRelationshipState(
      'agent-clean',
      { relationshipLabel: '朋友', personalitySummary: '温和、理性、尊重边界' },
      storage,
    );
    expect(clean.corruption).toBe(0);
  });

  it('clamps deltas and re-derives the stage after updates', () => {
    ensureRelationshipState('agent-1', { relationshipLabel: '仇敌' }, storage);

    const updated = updateRelationshipState(
      'agent-1',
      {
        affectionDelta: 500,
        trustDelta: -500,
        loyaltyDelta: 500,
        jealousyDelta: 500,
        corruptionDelta: 500,
        mood: '安心',
        stateSummary: '已经重新靠近，但仍保留边界。',
        reason: '用户接受了本次状态建议。',
      },
      storage,
    );

    expect(updated).toMatchObject({
      affection: 150,
      trust: -100,
      loyalty: 100,
      jealousy: 100,
      corruption: 100,
      mood: '安心',
      relationshipKey: 'bond',
      relationshipLabel: '朝夕相许',
      stateSummary: '已经重新靠近，但仍保留边界。',
      lastReason: '用户接受了本次状态建议。',
      source: 'accepted_ai_suggestion',
    });
  });

  it('keeps the previous state as collapsed UI history after an update', () => {
    const previous = saveRelationshipState(
      clampRelationshipState({
        agentId: 'agent-1',
        targetType: 'user',
        targetId: '__user__',
        affection: 10,
        trust: 1,
        loyalty: 2,
        jealousy: 3,
        corruption: 4,
        mood: 'old mood',
        relationshipKey: 'stranger',
        relationshipLabel: 'ignored',
        stateSummary: 'old summary',
        lastReason: 'old reason',
        source: 'manual',
        updatedAt: '2026-05-13T00:00:00.000Z',
      }),
      storage,
    );

    const updated = updateRelationshipState(
      'agent-1',
      {
        affectionDelta: 5,
        trustDelta: 3,
        loyaltyDelta: 2,
        jealousyDelta: 0,
        corruptionDelta: 0,
        mood: 'new mood',
        stateSummary: 'new summary',
        reason: 'new reason',
      },
      storage,
    );

    expect(updated.stateSummary).toBe('new summary');
    expect(updated.previousStates).toHaveLength(1);
    expect(updated.previousStates?.[0]).toMatchObject({
      affection: previous.affection,
      trust: previous.trust,
      loyalty: previous.loyalty,
      mood: 'old mood',
      stateSummary: 'old summary',
      lastReason: 'old reason',
    });
    expect(getRelationshipState('agent-1', storage)?.previousStates?.[0].stateSummary).toBe('old summary');
  });

  it('normalizes malformed saved state and reset rebuilds from the profile label', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw: Record<string, Partial<XingyeRelationshipState>> = {
      'agent-1': {
        agentId: 'agent-1',
        targetType: 'user',
        targetId: '__user__',
        affection: 999,
        trust: -999,
        loyalty: 999,
        jealousy: -1,
        corruption: 999,
        mood: '',
        relationshipKey: 'stranger',
        relationshipLabel: '',
        updatedAt: 'bad-date',
      },
    };
    storage.setItem(XINGYE_RELATIONSHIP_STATES_STORAGE_KEY, JSON.stringify(raw));

    const normalized = getRelationshipState('agent-1', storage);
    expect(normalized).toMatchObject({
      affection: 150,
      trust: -100,
      loyalty: 100,
      jealousy: 0,
      corruption: 100,
      mood: '平静',
      relationshipKey: 'bond',
      relationshipLabel: '朝夕相许',
    });

    const reset = resetRelationshipState('agent-1', { relationshipLabel: '朋友' }, storage);
    expect(reset.affection).toBe(30);
    expect(reset.relationshipKey).toBe('friend');
    expect(reset.relationshipLabel).toBe('君子之交');
  });

  it('saves explicit states and exposes compact display badges', () => {
    const saved = saveRelationshipState(
      clampRelationshipState({
        agentId: 'agent-1',
        targetType: 'user',
        targetId: '__user__',
        affection: 50,
        trust: 10,
        loyalty: 8,
        jealousy: 3,
        corruption: 0,
        mood: '愉快',
        relationshipKey: 'stranger',
        relationshipLabel: 'ignored',
        updatedAt: '2026-05-11T00:00:00.000Z',
      }),
      storage,
    );

    expect(saved.relationshipKey).toBe('close_friend');
    expect(saved.relationshipLabel).toBe('知己相照');
    expect(getStateDisplayBadges(saved)).toEqual(
      expect.arrayContaining([
        { label: '关系', value: '知己相照' },
        { label: '心情', value: '愉快' },
        { label: '好感度', value: '50' },
      ]),
    );
  });

  /**
   * 契约：5 个数值 metric 的字段集合。
   *
   * 这个 set 写死在测试里——任何 PR 改 `affection / trust / loyalty / jealousy / corruption`
   * 五者之一的字段名都会让本测试红。
   *
   * Why：state 落盘到 relationship-state.json（per-agent），读盘时 normalizeState 用
   * `asFiniteNumber(value.X)` 兜底，缺失字段悄悄变 0。如果有人重命名 metric（比如
   * loyalty → respect）没写迁移，老用户的 loyalty: 75 数据会读成 respect: 0，无声丢失。
   *
   * 真要重命名时：必须主动改这个 set + 加迁移逻辑（读盘时把老字段名 map 到新的）。
   * 改了 set 但没加迁移就当 review-time 卡点——目前没有 schema version，这是最便宜的
   * 守门。
   */
  it('contract: relationship-state numeric metric set is stable (rename → must add migration)', () => {
    /** keyof 安全：TS 会确保下面的 array 包含的字符串都是 XingyeRelationshipState 的实际字段。 */
    const numericMetricKeys: ReadonlyArray<keyof XingyeRelationshipState> = [
      'affection',
      'trust',
      'loyalty',
      'jealousy',
      'corruption',
    ];

    /** 落一个 state，验证这五个字段确实都是 number（保证 normalize+clamp 没漏 metric）。 */
    const saved = saveRelationshipState(
      clampRelationshipState({
        agentId: 'contract-agent',
        targetType: 'user',
        targetId: '__user__',
        affection: 42,
        trust: 11,
        loyalty: 22,
        jealousy: 5,
        corruption: 3,
        mood: '试探',
        relationshipKey: 'friend',
        relationshipLabel: '君子之交',
        updatedAt: '2026-05-17T00:00:00.000Z',
      }),
      storage,
    );

    for (const key of numericMetricKeys) {
      expect(
        typeof saved[key],
        `metric ${key} must be a number — rename should fail this test and force a migration discussion`,
      ).toBe('number');
    }
    /** 数量也卡——加新 metric 也要主动改 set。 */
    expect(numericMetricKeys.length).toBe(5);
  });

  /**
   * 「秘密空间 TA 状态」与「详情页关系」的同步契约。
   *
   * 用户在秘密空间接受 AI 状态建议 → updateRelationshipState 根据 affection 重算
   * relationshipLabel。如果阶段跳了（朋友→知己），详情页 profile.relationshipLabel
   * 必须自动跟进 —— 否则主对话 system prompt 还在用旧 label 渲染态度，体感"白点了"。
   *
   * 这条同步通过 fire-and-forget 调用 saveXingyeRoleProfile（已在文件顶部 mock）实现。
   */
  describe('updateRelationshipState → profile sync', () => {
    it('relationshipLabel 跨阶段跳变时，自动 sync 到详情页 profile', () => {
      // 初始：朋友（affection=30, friend → 君子之交）
      ensureRelationshipState('agent-1', { relationshipLabel: '朋友' }, storage);
      mockSaveXingyeRoleProfile.mockClear();

      // +25 原始冲量 → 经关系曲线重塑（君子之交早期≈+29）→ 59 → close_friend → 知己相照（跨阶段）
      updateRelationshipState('agent-1', { affectionDelta: 25, mood: '靠近' }, storage);

      expect(mockSaveXingyeRoleProfile).toHaveBeenCalledTimes(1);
      expect(mockSaveXingyeRoleProfile).toHaveBeenCalledWith('agent-1', {
        relationshipLabel: '知己相照',
      });
    });

    it('阶段没跳的微调（同阶段内 +/- 几点）不触发 profile sync —— 避免无意义写盘', () => {
      ensureRelationshipState('agent-1', { relationshipLabel: '朋友' }, storage);
      mockSaveXingyeRoleProfile.mockClear();

      // 朋友 30 → 朋友 32（friend 区间内 0..49，不跨阶段）
      updateRelationshipState('agent-1', { affectionDelta: 2 }, storage);

      expect(mockSaveXingyeRoleProfile).not.toHaveBeenCalled();
    });

    it('多次跨阶段累加 → 每次跨阶段都触发一次 sync，传的是最新 label', () => {
      ensureRelationshipState('agent-1', { relationshipLabel: '朋友' }, storage);
      mockSaveXingyeRoleProfile.mockClear();

      updateRelationshipState('agent-1', { affectionDelta: 25 }, storage); // 朋友→知己
      updateRelationshipState('agent-1', { affectionDelta: 40 }, storage); // 知己→恋人

      expect(mockSaveXingyeRoleProfile).toHaveBeenCalledTimes(2);
      expect(mockSaveXingyeRoleProfile).toHaveBeenNthCalledWith(1, 'agent-1', { relationshipLabel: '知己相照' });
      expect(mockSaveXingyeRoleProfile).toHaveBeenNthCalledWith(2, 'agent-1', { relationshipLabel: '情愫暗生' });
    });

    it('resetRelationshipState：reset 后 label 与 reset 前不同时也触发 sync', () => {
      // 把状态先推到「恋人」
      ensureRelationshipState('agent-1', { relationshipLabel: '恋人' }, storage);
      mockSaveXingyeRoleProfile.mockClear();

      // reset，profile 改成「朋友」初始值
      resetRelationshipState('agent-1', { relationshipLabel: '朋友' }, storage);

      expect(mockSaveXingyeRoleProfile).toHaveBeenCalledTimes(1);
      expect(mockSaveXingyeRoleProfile).toHaveBeenCalledWith('agent-1', { relationshipLabel: '君子之交' });
    });

    it('saveRelationshipState（底层 save）单独使用时不触发 sync', () => {
      // 底层 save 是 reset / update 复用的纯落盘函数；reset / update 上层才决定要不要 sync。
      // 这条 case 守住：单独调 saveRelationshipState（比如未来 importState 之类）不会
      // 错误地反向覆盖详情页用户填的 relationshipLabel。
      saveRelationshipState(
        clampRelationshipState({
          agentId: 'agent-1',
          targetType: 'user',
          targetId: '__user__',
          affection: 90,
          trust: 0,
          loyalty: 0,
          jealousy: 0,
          corruption: 0,
          mood: '平静',
          relationshipKey: 'lover',
          relationshipLabel: '情愫暗生',
          updatedAt: new Date().toISOString(),
        }),
        storage,
      );

      expect(mockSaveXingyeRoleProfile).not.toHaveBeenCalled();
    });

    it('saveXingyeRoleProfile 抛错时，updateRelationshipState 仍返回正确 next（不影响主流程）', async () => {
      // 静默 catch 里的 warn：state-store 的 syncRelationshipLabelToProfile 是
      // fire-and-forget（void promise.catch），失败走 .catch → console.warn。
      // 必须 await 一个微任务 tick 让 .catch 回调跑完后再 restore，否则 warn 漏到 stderr。
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      ensureRelationshipState('agent-1', { relationshipLabel: '朋友' }, storage);
      mockSaveXingyeRoleProfile.mockClear();
      mockSaveXingyeRoleProfile.mockImplementationOnce(async () => {
        throw new Error('boom (offline / 写盘失败)');
      });

      const next = updateRelationshipState('agent-1', { affectionDelta: 25 }, storage);

      expect(next.relationshipLabel).toBe('知己相照');
      expect(mockSaveXingyeRoleProfile).toHaveBeenCalledTimes(1);

      // 等 fire-and-forget 的 .catch 回调跑完，再撤 spy
      await Promise.resolve();
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[xingye-state-store] failed to sync relationshipLabel to profile'),
        expect.any(Error),
      );
      warnSpy.mockRestore();
    });
  });
});
