/**
 * saved_item 分类的详情阅读器：与 SecretSpaceSavedList 同一书签 / 摘抄页语言，
 * 取代默认 SecretSpaceRecordCard。
 *
 * 设计：
 *  - 米黄羊皮纸底（与列表卡同色系，按 kind 取 paper / ribbon 颜色）
 *  - 左侧粗 ribbon 条 + 顶右一角的"书签飘带"，沿用列表卡视觉
 *  - 顶上 KIND uppercase mono kicker（同列表 .secretSpaceSavedKind 但更大）
 *  - 「 」 大号引号包正文，serif 大字 + 宽行距
 *  - 落款行右对齐 italic serif（meta 去掉 kind 后的剩余部分）
 *  - 底部一行 mono 小字：NO.编号 · 创建日期 · 来源
 *  - 左下朱红"印"：与古籍善本一致的视觉锚点
 *  - 标签若有，浮在落款下方做一排"标签纸"
 *
 * 互动（纯前端、不动 storage/LLM）：
 *  - 点正文 → 复制到剪贴板 + 一句"已抄录"小提示（自动消失）
 *
 * 保留 `data-testid="secret-space-record-detail-${record.key}"`，
 * 与默认 RecordCard 行为一致。
 */

import { useCallback, useMemo, useState } from 'react';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import styles from './XingyeShell.module.css';

const RIBBON_BY_KIND: Record<string, string> = {
  句子: '#9b1c2e',
  对话: '#b07a37',
  瞬间: '#3a6a5a',
  片段: '#c2616d',
};
const PAPER_BY_KIND: Record<string, string> = {
  句子: '#fbf3df',
  对话: '#fef6e0',
  瞬间: '#f5efd6',
  片段: '#fef0eb',
};
const SEAL_GLYPH_BY_KIND: Record<string, string> = {
  句子: '抄',
  对话: '语',
  瞬间: '存',
  片段: '忆',
};
const RIBBON_FALLBACK = ['#9b1c2e', '#b07a37', '#3a6a5a', '#6a4a8a', '#c2616d'];

function splitMeta(meta: string | undefined): string[] {
  if (!meta) return [];
  return meta.split(' · ').map((s) => s.trim()).filter(Boolean);
}

function hashIndex(key: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return mod > 0 ? h % mod : 0;
}

function formatLongDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${y}.${m}.${day} · ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

export interface SecretSpaceSavedReaderProps {
  record: SecretSpaceSampleRecord;
}

export function SecretSpaceSavedReader({ record }: SecretSpaceSavedReaderProps) {
  const parts = useMemo(() => splitMeta(record.meta), [record.meta]);
  const kind = parts[0] || '片段';
  const attribution = parts.length > 1 ? parts.slice(1).join(' · ') : '';
  const ribbon = RIBBON_BY_KIND[kind] || RIBBON_FALLBACK[hashIndex(record.key, RIBBON_FALLBACK.length)];
  const paper = PAPER_BY_KIND[kind] || '#fbf3df';
  const sealGlyph = SEAL_GLYPH_BY_KIND[kind] || '藏';
  const no = String(hashIndex(record.key, 99) + 1).padStart(2, '0');

  const body = (record.body || record.summary || '').trim();
  const paragraphs = useMemo(
    () => (body ? body.split(/\n{1,}/).map((s) => s.trim()).filter(Boolean) : []),
    [body],
  );

  /**
   * 标题与正文重复时压隐：列表里 title 经常就是 body 的前 48 字，
   * 详情页再印一遍只会割裂阅读节奏。
   */
  const titleIsBodyPrefix = useMemo(() => {
    if (!record.title) return true;
    const t = record.title.replace(/…$/, '').trim();
    if (!t) return true;
    return body.startsWith(t) && (t.length / Math.max(1, body.length)) > 0.45;
  }, [record.title, body]);

  const [copyFlash, setCopyFlash] = useState<string | null>(null);
  const handleCopyBody = useCallback(() => {
    if (!body) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(body);
        setCopyFlash('已抄录到剪贴板');
      } else {
        setCopyFlash('当前环境不支持复制');
      }
    } catch {
      setCopyFlash('复制失败');
    }
    window.setTimeout(() => setCopyFlash(null), 2200);
  }, [body]);

  return (
    <article
      className={styles.secretSpaceSavedReader}
      data-testid={`secret-space-record-detail-${record.key}`}
      style={{
        background: paper,
        borderLeftColor: ribbon,
      }}
    >
      {/* 顶右书签飘带 —— 与列表卡同款 */}
      <span
        aria-hidden
        className={styles.secretSpaceSavedReaderRibbon}
        style={{ background: ribbon }}
      />

      {/* 顶部一行：KIND 戳 + NO. + 复制按钮 */}
      <div className={styles.secretSpaceSavedReaderHead}>
        <div className={styles.secretSpaceSavedReaderHeadLeft}>
          <span
            className={styles.secretSpaceSavedReaderKind}
            style={{ color: ribbon, borderColor: ribbon }}
          >
            {kind}
          </span>
          <span className={styles.secretSpaceSavedReaderNo}>NO. {no}</span>
        </div>
        <button
          type="button"
          className={styles.secretSpaceSavedReaderCopy}
          onClick={handleCopyBody}
          disabled={!body}
          aria-label="抄录到剪贴板"
          data-testid={`secret-space-saved-copy-${record.key}`}
        >
          <span aria-hidden>✦</span>
          抄录
        </button>
      </div>

      {/* 标题：仅当不是正文前缀时显示 */}
      {!titleIsBodyPrefix ? (
        <h2 className={styles.secretSpaceSavedReaderTitle}>{record.title}</h2>
      ) : null}

      {/* 正文 —— 带大号引号 */}
      <div className={styles.secretSpaceSavedReaderBodyWrap}>
        <span aria-hidden className={styles.secretSpaceSavedReaderQuoteOpen}>
          「
        </span>
        <div className={styles.secretSpaceSavedReaderBody}>
          {paragraphs.length === 0 ? (
            <p
              className={styles.secretSpaceSavedReaderParagraph}
              data-empty="true"
            >
              这页没留下字句。
            </p>
          ) : (
            paragraphs.map((p, idx) => (
              <p key={idx} className={styles.secretSpaceSavedReaderParagraph}>
                {p}
              </p>
            ))
          )}
        </div>
        <span aria-hidden className={styles.secretSpaceSavedReaderQuoteClose}>
          」
        </span>
      </div>

      {/* 落款（来自 meta 去 kind 部分；标准格式：—— 某人 · 场景） */}
      {attribution ? (
        <div className={styles.secretSpaceSavedReaderAttribution}>
          {attribution.startsWith('——') || attribution.startsWith('—')
            ? attribution
            : `—— ${attribution}`}
        </div>
      ) : null}

      {/* 标签 */}
      {record.tags && record.tags.length ? (
        <div className={styles.secretSpaceSavedReaderTags}>
          {record.tags.map((t) => (
            <span key={t} className={styles.secretSpaceSavedReaderTag}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {/* 底部 footnote：日期 + 来源 + （可选）抄录提示 */}
      <div className={styles.secretSpaceSavedReaderFootnote}>
        <span>抄于 · {formatLongDate(record.createdAt)}</span>
        {record.source ? (
          <span className={styles.secretSpaceSavedReaderFootnoteDot}>·</span>
        ) : null}
        {record.source ? <span>自 {record.source}</span> : null}
        {copyFlash ? (
          <span
            className={styles.secretSpaceSavedReaderCopyFlash}
            role="status"
            data-testid={`secret-space-saved-copy-flash-${record.key}`}
          >
            {copyFlash}
          </span>
        ) : null}
      </div>

      {/* 朱印 —— 左下视觉锚点 */}
      <span aria-hidden className={styles.secretSpaceSavedReaderSeal}>
        <span className={styles.secretSpaceSavedReaderSealGlyph}>{sealGlyph}</span>
      </span>
    </article>
  );
}
