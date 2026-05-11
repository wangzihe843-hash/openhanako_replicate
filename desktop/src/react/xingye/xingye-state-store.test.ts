import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      trust: 0,
      loyalty: 0,
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
});
