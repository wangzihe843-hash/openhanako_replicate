import { useLayoutEffect, useMemo, useRef } from 'react';
import { hanaFetch } from '../api';
import { useSettingsStore } from '../store';
import { resolveServerConnection, type ServerConnection } from '../../services/server-connection';

/** Captures a settings connection and one mounted owner lifetime, including A -> B -> A. */
export function useSettingsAsyncScope(ownerKey: string) {
  const connectionKey = useSettingsStore(state => JSON.stringify(resolveServerConnection(state)));
  const scope = useMemo(() => ({
    key: JSON.stringify([connectionKey, ownerKey]),
    connectionKey,
    connection: JSON.parse(connectionKey) as ServerConnection | null,
    controller: null as AbortController | null,
  }), [connectionKey, ownerKey]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useLayoutEffect(() => {
    const controller = new AbortController();
    scope.controller = controller;
    return () => { controller.abort(); };
  }, [scope]);
  return useMemo(() => ({
    key: scope.key,
    capture: () => {
      const controller = scope.controller;
      const isCurrent = () => !!controller && !controller.signal.aborted
        && scope.controller === controller && currentScope.current === scope
        && scope.connectionKey === JSON.stringify(resolveServerConnection(useSettingsStore.getState()));
      return {
        isCurrent,
        fetch: (path: string, options: Parameters<typeof hanaFetch>[1] = {}) => {
          if (!isCurrent()) return Promise.reject(new DOMException('Settings owner changed', 'AbortError'));
          return hanaFetch(path, { ...options, ...(scope.connection ? { connection: scope.connection } : {}), signal: controller?.signal });
        },
      };
    },
  }), [scope]);
}
