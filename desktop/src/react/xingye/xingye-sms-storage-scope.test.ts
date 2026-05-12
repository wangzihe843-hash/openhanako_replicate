/**
 * verify-scope（计划 P0）：列出本切片预期修改的 desktop 相对路径，供 PR 与 `git diff --name-only` 对照。
 * 禁止触碰：ChatArea、OpenHanako memory、/api/memories/import、memory ticker、`xingye-phone-ai` 内 SMS prompt 等（见收窄版计划）。
 */
import { describe, expect, it } from 'vitest';

/** 本轮 SMS monolith 契约与测试允许修改的文件（相对于 `desktop/`）。 */
export const SMS_STORAGE_SLICE_DESKTOP_PATHS = [
  'src/react/xingye/xingye-phone-store.ts',
  'src/react/xingye/xingye-phone-store.test.ts',
  'src/react/xingye/xingye-workspace-v2.ts',
  'src/react/xingye/xingye-workspace-v2.test.ts',
  'src/react/xingye/xingye-sms-storage-scope.test.ts',
] as const;

describe('SMS storage plan verify-scope', () => {
  it('exports a machine-readable allowlist for reviewers', () => {
    expect(SMS_STORAGE_SLICE_DESKTOP_PATHS.join('\n')).toContain('xingye-workspace-v2.ts');
  });
});
