/**
 * @vitest-environment jsdom
 *
 * 渲染端 confirmSecondhandDraft 的 **action='update'** 路径：把状态迁移补丁 merge 到
 * 已有挂牌上，**保持 entryId 不变**（这正是买家聊天得以延续的前提）。
 *
 * 用一个有状态的内存 postXingyeStorage mock 模拟整套 jsonl 存储（listJsonl / appendJsonl /
 * writeJsonl / deleteJsonlRecord / readJson / writeJson），覆盖 confirm 流程里
 * listAppEntries → listSecondhandDrafts → updateAppEntry → 删草稿 → 事件日志 的全部调用。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const postMock = vi.hoisted(() => vi.fn());

vi.mock('./xingye-storage-api', () => ({
  postXingyeStorage: postMock,
}));

import { appendAppEntry, listAppEntries } from './xingye-app-entry-store';
import {
  confirmSecondhandDraft,
  XINGYE_SECONDHAND_DRAFTS_JSONL,
} from './xingye-secondhand-drafts';
import { createAgentXingyeStorageBackend } from './xingye-storage-backend';
import { __resetDraftConfirmLockForTests } from './xingye-draft-confirm-lock';

const AID = 'agent-x';

// ── 有状态内存存储 ──────────────────────────────────────────
const jsonl = new Map<string, string[]>();
const json = new Map<string, string>();
const keyOf = (c: { agentId?: string; relativePath?: string }) => `${c.agentId}::${c.relativePath}`;

function installStatefulStore() {
  jsonl.clear();
  json.clear();
  postMock.mockReset();
  postMock.mockImplementation(async (c: any) => {
    switch (c.action) {
      case 'listJsonl':
        return { ok: true, records: (jsonl.get(keyOf(c)) ?? []).map((s) => JSON.parse(s)) };
      case 'appendJsonl': {
        const arr = jsonl.get(keyOf(c)) ?? [];
        arr.push(JSON.stringify(c.data));
        jsonl.set(keyOf(c), arr);
        return { ok: true };
      }
      case 'writeJsonl': {
        jsonl.set(keyOf(c), (c.records ?? []).map((r: unknown) => JSON.stringify(r)));
        return { ok: true };
      }
      case 'deleteJsonlRecord': {
        const arr = jsonl.get(keyOf(c)) ?? [];
        const next = arr.filter((s) => {
          const o = JSON.parse(s);
          return o.id !== c.recordId && o.key !== c.recordId;
        });
        jsonl.set(keyOf(c), next);
        return { ok: true, deleted: next.length !== arr.length };
      }
      case 'readJson': {
        const raw = json.get(keyOf(c));
        return raw ? { ok: true, data: JSON.parse(raw) } : { ok: true, missing: true };
      }
      case 'writeJson': {
        json.set(keyOf(c), JSON.stringify(c.data));
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  });
}

/** 直接往 drafts.jsonl 落一条 update 草稿（渲染端 appendSecondhandDraft 只做 add，故绕过它）。 */
async function seedUpdateDraft(row: Record<string, unknown>) {
  const backend = createAgentXingyeStorageBackend(postMock as never);
  await backend.appendJsonl(AID, XINGYE_SECONDHAND_DRAFTS_JSONL, { key: row.id, ...row });
}

beforeEach(() => {
  installStatefulStore();
  __resetDraftConfirmLockForTests();
});

describe('confirmSecondhandDraft · action=update', () => {
  it('merges patch onto the existing listing and keeps the same entryId', async () => {
    const seeded = await appendAppEntry(AID, 'secondhand', {
      title: '灰色长款风衣',
      content: '买回来只穿过两次。',
      metadata: {
        status: 'negotiating',
        platformStyle: 'xianyu',
        itemName: '灰色长款风衣',
        askingPrice: '¥120',
        buyer: '一个问得很细的人',
      },
    });

    await seedUpdateDraft({
      id: 'd-upd',
      action: 'update',
      matchName: '灰色长款风衣',
      patch: { status: 'sold', buyer: '巷口收旧衣的', contentAppend: '出掉了，对方挺满意。' },
      itemName: '灰色长款风衣',
      source: 'xingye-heartbeat-tool',
    });

    const entry = await confirmSecondhandDraft(AID, 'd-upd');

    // entryId 必须保持不变（买家聊天按 entryId 存，靠这一点延续）
    expect(entry.id).toBe(seeded.id);
    expect(entry.metadata.status).toBe('sold');
    expect(entry.metadata.buyer).toBe('巷口收旧衣的');
    // 未在 patch 内的字段保留
    expect(entry.metadata.askingPrice).toBe('¥120');
    expect(entry.metadata.itemName).toBe('灰色长款风衣');
    // contentAppend 追加到正文末尾，不覆盖原文
    expect(entry.content).toBe('买回来只穿过两次。\n\n出掉了，对方挺满意。');

    // 仍然只有一条 entry（没有 add 出重复条目）
    const all = await listAppEntries(AID, 'secondhand');
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(seeded.id);
  });

  it('resolves the target by explicit targetEntryId', async () => {
    const seeded = await appendAppEntry(AID, 'secondhand', {
      title: '旧相机',
      content: '',
      metadata: { status: 'listed', platformStyle: 'generic', itemName: '旧相机' },
    });
    await seedUpdateDraft({
      id: 'd-by-id',
      action: 'update',
      targetEntryId: seeded.id,
      matchName: '名字对不上也没关系',
      patch: { status: 'sold' },
      itemName: '名字对不上也没关系',
      source: 'xingye-heartbeat-tool',
    });

    const entry = await confirmSecondhandDraft(AID, 'd-by-id');
    expect(entry.id).toBe(seeded.id);
    expect(entry.metadata.status).toBe('sold');
  });

  it('throws when the target listing cannot be found', async () => {
    await seedUpdateDraft({
      id: 'd-orphan',
      action: 'update',
      matchName: '清单里没有的东西',
      patch: { status: 'sold' },
      itemName: '清单里没有的东西',
      source: 'xingye-heartbeat-tool',
    });
    await expect(confirmSecondhandDraft(AID, 'd-orphan')).rejects.toThrow(/目标挂牌已不存在/);
  });
});
