import { useCallback, useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Shared logic for floating panels:
 * - Visibility gated by activePanel
 * - loadFn called when panel opens
 * - close() resets activePanel to null
 *
 * loadFn must be stable (useCallback or a module function). reloadKey identifies
 * external ownership changes when the loader does not itself capture that owner.
 */
export function usePanel(name: string, loadFn?: () => void, reloadKey?: string | null) {
  const activePanel = useStore(s => s.activePanel);
  const visible = activePanel === name;

  useEffect(() => {
    if (visible && loadFn) loadFn();
  }, [visible, loadFn, reloadKey]);

  const close = useCallback(() => {
    useStore.getState().setActivePanel(null);
  }, []);

  return { visible, close };
}
