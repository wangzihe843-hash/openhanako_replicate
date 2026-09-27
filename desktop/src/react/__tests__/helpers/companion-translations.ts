import zh from '../../../locales/zh.json';
import zhTW from '../../../locales/zh-TW.json';
import en from '../../../locales/en.json';
import ja from '../../../locales/ja.json';
import ko from '../../../locales/ko.json';

export const companionPacks: Record<string, Record<string, unknown>> = {
  zh, 'zh-TW': zhTW, en, ja, ko,
};

export function companionTranslation(locale: string, key: string, vars: Record<string, string | number> = {}): string {
  const pack = companionPacks[locale] ?? zh;
  const value = key.split('.').reduce<unknown>((item, part) =>
    item && typeof item === 'object' && part in item ? (item as Record<string, unknown>)[part] : undefined,
  pack);
  return typeof value === 'string'
    ? value.replace(/\{([^}]+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match)
    : key;
}
