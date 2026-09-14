// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../types';
import { useStore } from '../stores';
import { getPhoneContacts, getPhoneContactMeta, savePhoneContactMeta } from './xingye-phone-store';
import { PhoneContactsApp } from './PhoneContactsApp';
import { PhoneSmsApp } from './PhoneSmsApp';
import { generateVirtualContactsWithAI, generateSmsHistoryWithAI } from './xingye-phone-ai';

const memory = vi.hoisted(() => new Map<string, string>());
const writable = vi.hoisted(() => ({
  getItem: vi.fn((key: string) => memory.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { memory.set(key, value); }),
}));
vi.mock('./xingye-persistence', () => ({ getXingyePersistenceStorage: () => writable }));
vi.mock('./xingye-profile-store', () => ({ useXingyeRoleProfile: () => null }));
vi.mock('./xingye-phone-contact-drafts', () => ({
  listPhoneContactDrafts: vi.fn(async () => []), confirmPhoneContactDraft: vi.fn(), discardPhoneContactDraft: vi.fn(),
}));
vi.mock('./xingye-sms-drafts', () => ({ listSmsDrafts: vi.fn(async () => []), confirmSmsDraft: vi.fn(), discardSmsDraft: vi.fn() }));
vi.mock('./xingye-phone-ai', () => ({
  enrichContactsWithAI: vi.fn(async () => ({})), generateSmsUpdatesForChangedContactsWithAI: vi.fn(async () => ({})),
  generateVirtualContactsWithAI: vi.fn(async () => ({})), regenerateAllContactsWithAI: vi.fn(async () => ({})),
  rollbackAndUpdateContactsWithAI: vi.fn(async () => ({})), updateContactsFromRecentContextWithAI: vi.fn(async () => ({})),
  generateSmsHistoryWithAI: vi.fn(async () => ({})),
}));
vi.mock('./xingye-contact-profile-ai', () => ({ batchInitializeContactProfilesWithAI: vi.fn() }));
vi.mock('./PhoneContactDetail', () => ({ PhoneContactDetail: () => null }));
vi.mock('./PhoneContactSections', () => ({ PhoneContactSections: () => null }));
vi.mock('./PhoneContactsSectionView', () => ({
  PhoneContactsBlockedView: () => null, PhoneContactsDeletedView: () => null, PhoneContactsFactionsHomeView: () => null,
  PhoneContactsFactionDetailView: () => null, PhoneContactsGroupsView: () => null, PhoneContactsNewFriendsView: () => null,
  PhoneContactsTagDetailView: () => null, PhoneContactsTagsHomeView: () => null,
}));

const owner: Agent = { id: 'test-owner', name: 'Owner', yuan: 'hanako', isPrimary: true, hasAvatar: false };
const agents = [owner];
const profiles = {};
beforeEach(() => {
  memory.clear();
  vi.clearAllMocks();
  useStore.setState({ currentAgentId: owner.id, currentSessionPath: null, agents, sessions: [], chatSessions: {} });
});
afterEach(cleanup);

describe('real phone selectors with readonly render snapshots', () => {
  it.each(['missing', 'blocked', 'deleted'] as const)('reads %s default user without writing during rendering', condition => {
    if (condition !== 'missing') savePhoneContactMeta(owner.id, 'user', '__user__', { status: condition, remark: 'custom remark' }, writable, { markManualFields: false });
    writable.setItem.mockClear();
    const readonlyStorage = { getItem: writable.getItem, setItem: () => { throw new Error('render write'); } };
    const contacts = getPhoneContacts(owner.id, agents, profiles, { includeDeleted: true, readOnly: true }, readonlyStorage);
    expect(contacts[0]).toMatchObject({ targetType: 'user', status: 'active', remark: condition === 'missing' ? '你' : 'custom remark' });
    expect(writable.setItem).not.toHaveBeenCalled();
    expect(getPhoneContactMeta(owner.id, 'user', '__user__', writable)?.status ?? 'missing').toBe(condition);
  });

  it.each([
    ['contacts', 'missing'], ['contacts', 'blocked'], ['contacts', 'deleted'],
    ['sms', 'missing'], ['sms', 'blocked'], ['sms', 'deleted'],
  ] as const)('mounts %s with a %s default user and initializes writable storage exactly once', async (app, condition) => {
    if (condition !== 'missing') savePhoneContactMeta(owner.id, 'user', '__user__', { status: condition, remark: 'custom remark' }, writable, { markManualFields: false });
    writable.setItem.mockClear();
    render(app === 'contacts'
      ? <PhoneContactsApp ownerAgent={owner} agents={agents} profiles={profiles} channels={[]} onBack={() => {}} onOpenSms={() => {}} />
      : <PhoneSmsApp ownerAgent={owner} agents={agents} profiles={profiles} onBack={() => {}} />);
    await waitFor(() => expect(getPhoneContactMeta(owner.id, 'user', '__user__', writable)?.status).toBe('active'));
    expect(writable.setItem).toHaveBeenCalledTimes(1);
    expect(app === 'contacts' ? generateVirtualContactsWithAI : generateSmsHistoryWithAI).toHaveBeenCalledTimes(1);
    if (condition !== 'missing') expect(getPhoneContactMeta(owner.id, 'user', '__user__', writable)?.remark).toBe('custom remark');
  });
});
