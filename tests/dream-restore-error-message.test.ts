import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDreamRevision, restoreDreamRevision, snapshotDreamSections } from '../lib/memory/dream/revision-store.ts';
import { assembleWeekFromDaily, writeDailyEntryBody } from '../lib/memory/compile.ts';
import { createMemoryDreamRoute } from '../server/routes/memory-dream.ts';
import { restoreDream } from '../desktop/src/react/settings/tabs/agent/agent-memory-dream-actions.ts';
import { dreamErrorText } from '../desktop/src/react/settings/tabs/agent/dream-error-presenter.ts';

const translation = vi.hoisted(() => ({ locale: {} as Record<string, unknown> }));
vi.mock('../desktop/src/react/settings/helpers', () => ({
  t: (key: string) => key.split('.').reduce<unknown>((value, part) =>
    value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
  translation.locale) ?? key,
}));
vi.mock('../desktop/src/react/settings/store', () => ({
  useSettingsStore: { getState: () => ({ serverPort: 3000, serverToken: 'synthetic' }) },
}));
vi.mock('../core/llm-client.ts', () => ({
  callText: () => { throw new Error('This restore test must not call a model'); },
}));

const messages = {
  en: 'The Dream version could not be restored. Current memory may have changed. Please review it.',
  zh: '恢复 Dream 版本失败。当前记忆可能已发生变化，请检查当前内容。',
  'zh-TW': '恢復 Dream 版本失敗。目前記憶可能已變更，請檢查目前的內容。',
  ja: 'Dream バージョンを復元できませんでした。現在の記憶が変更されている可能性があります。内容を確認してください。',
  ko: 'Dream 버전을 복원하지 못했어요. 현재 기억이 변경되었을 수 있으니 내용을 확인해 주세요.',
};
const fallbackKey = 'settings.memory.dream.errors.restoreFailed';
const oldDate = '2026-10-17';
let memoryDir: string;

function useLocale(locale: string) {
  translation.locale = JSON.parse(fs.readFileSync(
    path.join(process.cwd(), 'desktop/src/locales', `${locale}.json`), 'utf8',
  ));
}

function connectRoute(restore: (revisionId: string) => unknown) {
  const app = new Hono();
  app.route('/api', createMemoryDreamRoute({
    getAgent: (id: string) => id === 'hana'
      ? { id, memoryTicker: { restoreDreamRevision: restore } }
      : null,
  }));
  // In-process transport: real route, hanaFetch error decoding, action and presenter.
  const fetch = vi.fn((input: string, init?: RequestInit) => app.request(input, init));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

beforeEach(() => {
  memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-error-copy-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  fs.rmSync(memoryDir, { recursive: true, force: true });
});

describe('Dream restore failure messages', () => {
  it.each(Object.entries(messages))('%s: reports a real partial-write failure without promising unchanged memory', async (locale, message) => {
    useLocale(locale);
    const daily = path.join(memoryDir, 'daily');
    writeDailyEntryBody(daily, oldDate, 'HISTORICAL_DAY');
    const revision = createDreamRevision(memoryDir, {
      runId: 'synthetic-copy-test', trigger: 'manual', before: snapshotDreamSections(memoryDir),
    });
    fs.unlinkSync(path.join(daily, `${oldDate}.md`));
    writeDailyEntryBody(daily, '2026-10-18', 'CURRENT_DAY');
    assembleWeekFromDaily(daily, path.join(memoryDir, 'week.md'));

    const rename = fs.renameSync;
    let injected = false;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!injected && String(to) === path.join(memoryDir, 'week.md')) {
        // The failure occurs after restore has already recreated a historical day.
        expect(fs.existsSync(path.join(daily, `${oldDate}.md`))).toBe(true);
        injected = true;
        throw new Error('synthetic week write failure');
      }
      return rename(from, to);
    });
    const fetch = connectRoute(id => restoreDreamRevision(memoryDir, id));
    const error = await restoreDream('hana', revision.revisionId).catch(error => error);

    expect(injected).toBe(true);
    expect(error).toMatchObject({ code: 'dream_restore_failed', message: 'synthetic week write failure' });
    expect(dreamErrorText(error, fallbackKey)).toBe(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(Object.entries(messages))('%s: uses the same cautious fallback when the response is unavailable', async (locale, message) => {
    useLocale(locale);
    const fetch = vi.fn().mockRejectedValue(new TypeError('synthetic connection failure'));
    vi.stubGlobal('fetch', fetch);
    const error = await restoreDream('hana', 'rev-1').catch(error => error);

    expect(error).toBeInstanceOf(TypeError);
    expect(dreamErrorText(error, fallbackKey)).toBe(message);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['DREAM_MEMORY_BUSY', 'dream_memory_busy', 'dreamMemoryBusy'],
    ['dream_revision_not_found', 'dream_revision_not_found', 'dreamRevisionNotFound'],
  ])('preserves the specific %s rejection instead of a partial-write warning', async (inputCode, code, key) => {
    useLocale('zh');
    connectRoute(() => { throw Object.assign(new Error('synthetic rejection'), { code: inputCode }); });
    const error = await restoreDream('hana', 'rev-1').catch(error => error);

    expect(error).toMatchObject({ code });
    const expected = (translation.locale.error as { code: Record<string, string> }).code[key];
    expect(dreamErrorText(error, fallbackKey)).toBe(expected);
    expect(expected).not.toBe(messages.zh);
    expect(fs.readdirSync(memoryDir)).toEqual([]);
  });
});
