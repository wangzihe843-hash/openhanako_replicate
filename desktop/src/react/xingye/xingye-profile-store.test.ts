import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import {
  XINGYE_ROLE_PROFILES_STORAGE_KEY,
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
      shortBio: 'OpenHanako Agent: hanako',
    });
  });

  it('ignores malformed storage content', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    storage.setItem(XINGYE_ROLE_PROFILES_STORAGE_KEY, '{bad json');

    expect(loadXingyeRoleProfiles(storage)).toEqual({});
    expect(getXingyeRoleProfile('agent-1', storage)).toBeNull();
  });
});
