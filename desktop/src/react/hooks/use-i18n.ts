/**
 * 响应式 i18n hook
 *
 * 订阅 store.locale，locale 变化时自动重渲染。
 * 用法：const { t, locale } = useI18n();
 */
import { useMemo } from 'react';
import { useStore } from '../stores';

const fallbackTranslate = (path: string) => path;

export function useI18n() {
  // 订阅 locale 字段，locale 变化 → 触发重渲染 → t() 取到新值
  const locale = useStore(s => s.locale);
  const translator = window.t ?? fallbackTranslate;
  return useMemo(() => ({
    t: (...args: Parameters<typeof translator>) => translator(...args),
    locale,
    i18n: window.i18n,
  }), [locale, translator]);
}
