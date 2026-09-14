import { useEffect, useMemo } from 'react';
import { getXingyePersistenceStorage } from './xingye-persistence';
import {
  useXingyePhoneStorageVersion,
  ensureDefaultUserContact,
  getPhoneContactMeta,
  XINGYE_PHONE_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_SMS_THREADS_STORAGE_KEY,
} from './xingye-phone-store';

const SNAPSHOT_KEYS = [
  XINGYE_PHONE_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_VIRTUAL_CONTACTS_STORAGE_KEY,
  XINGYE_PHONE_SMS_THREADS_STORAGE_KEY,
];

/** Subscribe to phone/persistence changes, then expose immutable read inputs to selectors. */
export function usePhoneStorageSnapshot(ownerAgentId = '') {
  const version = useXingyePhoneStorageVersion();
  useEffect(() => {
    const writableStorage = getXingyePersistenceStorage();
    if (!ownerAgentId || !writableStorage) return;
    try {
      ensureDefaultUserContact(ownerAgentId, writableStorage);
    } catch (error) {
      console.warn('[phone] default user initialization failed:', error);
    }
  }, [ownerAgentId, version]);
  const storage = getXingyePersistenceStorage();
  const serialized = JSON.stringify({ version, entries: SNAPSHOT_KEYS.map(key => {
    try {
      return [key, storage?.getItem(key) ?? null];
    } catch {
      // Match the existing phone readers' unavailable-storage fallback.
      return [key, null];
    }
  }) });
  const snapshot = useMemo(() => {
    const { entries } = JSON.parse(serialized) as { entries: Array<[string, string | null]> };
    const values = new Map(entries);
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: () => { throw new Error('Phone storage snapshots are read-only'); },
    };
  }, [serialized]);
  const defaultUser = getPhoneContactMeta(ownerAgentId, 'user', '__user__', snapshot);
  // Auto-generation must wait for the normalized persisted snapshot, otherwise
  // initialization's revision can queue a second generation before the first starts.
  const ready = !!defaultUser && defaultUser.status !== 'blocked' && defaultUser.status !== 'deleted';
  return { storage: snapshot, version, ready };
}
