/**
 * dream 分类的详情阅读器：与 SecretSpaceDreamFeed 同一墨晕夜色语言，
 * 取代默认 SecretSpaceRecordCard。
 *
 * 设计：
 *  - 暗夜底（与列表卡同色系）+ 墨团 SVG + 星点
 *  - 顶部 `NO.XX · 今夜/昨夜/周X · 子/丑时` kicker
 *  - 标题用毛笔字体，副标取 record.meta（如「梦中所见 · 海边」）
 *  - 正文 italic serif，逐段渐入；初始有"雾"，按住正文则消雾、字带微光
 *  - 标签作为「梦签」浮现，点击可点亮
 *  - 落款：「梦留 · M月D日 · 时辰」+ 来源
 *
 * 互动（纯前端、不动 storage/LLM）：
 *  1. 「再做一次这个梦」按钮 → 重新触发逐段渐入
 *  2. 按住正文（mousedown / touchstart）→ 暂时消雾、字体微光
 *  3. 点标签 → 切换该标签的"点亮"态
 *
 * 保留 `data-testid="secret-space-record-detail-${record.key}"`，
 * 兼容 SecretSpacePanel.test.tsx 的断言。
 */

import { useCallback, useMemo, useState } from 'react';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import styles from './XingyeShell.module.css';

const SHICHEN = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

/** 把小时映射到十二时辰。子时 = 23:00–01:00。 */
function shichenLabel(hour: number): string {
  const idx = Math.floor(((hour + 1) % 24) / 2);
  return `${SHICHEN[idx]}时`;
}

function nightLabel(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '——';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) return '今夜';
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return '昨夜';
    }
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return week;
  } catch {
    return '——';
  }
}

function formatDateChip(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${shichenLabel(d.getHours())}`;
  } catch {
    return iso;
  }
}

/** record.key → 稳定 0..mod hash，用来挑装饰位的种子。 */
function hashIndex(key: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return mod > 0 ? h % mod : 0;
}

/** 星点：固定 10 个位置（百分比），twinkle 周期由 hash 错开。 */
const STAR_POSITIONS: Array<{ cx: number; cy: number; r: number }> = [
  { cx: 8, cy: 14, r: 0.9 },
  { cx: 22, cy: 8, r: 0.6 },
  { cx: 36, cy: 22, r: 1.1 },
  { cx: 52, cy: 6, r: 0.7 },
  { cx: 70, cy: 16, r: 0.9 },
  { cx: 88, cy: 10, r: 0.6 },
  { cx: 14, cy: 78, r: 0.7 },
  { cx: 42, cy: 88, r: 0.9 },
  { cx: 64, cy: 80, r: 0.6 },
  { cx: 90, cy: 92, r: 1.0 },
];

export interface SecretSpaceDreamReaderProps {
  record: SecretSpaceSampleRecord;
}

export function SecretSpaceDreamReader({ record }: SecretSpaceDreamReaderProps) {
  const paragraphs = useMemo(() => {
    const text = (record.body || record.summary || '').trim();
    return text ? text.split(/\n{1,}/).map((s) => s.trim()).filter(Boolean) : [];
  }, [record.body, record.summary]);

  /** 重做这个梦：bump key 让正文每段重跑 fade-in 动画。 */
  const [replayKey, setReplayKey] = useState(0);
  /** 按住正文：消雾 + 字体微光。 */
  const [recalling, setRecalling] = useState(false);
  /** 点亮过的标签集合（每个标签是一颗"梦签灯"）。 */
  const [litTags, setLitTags] = useState<Set<string>>(() => new Set());

  const handleReplay = useCallback(() => {
    setReplayKey((k) => k + 1);
  }, []);

  const handleRecallStart = useCallback(() => setRecalling(true), []);
  const handleRecallEnd = useCallback(() => setRecalling(false), []);

  const toggleTag = useCallback((tag: string) => {
    setLitTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }, []);

  const createdDate = useMemo(() => new Date(record.createdAt), [record.createdAt]);
  const noLabel = String(hashIndex(record.key, 99) + 1).padStart(2, '0');
  const subtitle = (record.meta || '').trim();

  return (
    <article
      className={styles.secretSpaceDreamReader}
      data-testid={`secret-space-record-detail-${record.key}`}
      data-recall-active={recalling || undefined}
    >
      {/* 墨团 + 星点底图 */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
        className={styles.secretSpaceDreamReaderInk}
      >
        <defs>
          <radialGradient id={`xy-dream-reader-ink1-${record.key}`} cx="0.25" cy="0.25" r="0.55">
            <stop offset="0%" stopColor="#1d2548" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#1d2548" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={`xy-dream-reader-ink2-${record.key}`} cx="0.8" cy="0.75" r="0.6">
            <stop offset="0%" stopColor="#000" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="22" cy="18" rx="36" ry="28" fill={`url(#xy-dream-reader-ink1-${record.key})`} />
        <ellipse cx="78" cy="78" rx="38" ry="32" fill={`url(#xy-dream-reader-ink2-${record.key})`} />
        <g fill="#fff" className={styles.secretSpaceDreamReaderStars}>
          {STAR_POSITIONS.map((s, idx) => (
            <circle
              key={idx}
              cx={s.cx}
              cy={s.cy}
              r={s.r}
              style={{ animationDelay: `${(hashIndex(`${record.key}-${idx}`, 60) / 60) * 4}s` }}
            />
          ))}
        </g>
      </svg>

      {/* 头部条 */}
      <div className={styles.secretSpaceDreamReaderHead}>
        <span className={styles.secretSpaceDreamReaderKicker}>
          NO. {noLabel} · {nightLabel(record.createdAt)} · {shichenLabel(createdDate.getHours())}
        </span>
        <button
          type="button"
          className={styles.secretSpaceDreamReaderReplay}
          onClick={handleReplay}
          aria-label="再做一次这个梦"
          data-testid={`secret-space-dream-replay-${record.key}`}
        >
          <span aria-hidden className={styles.secretSpaceDreamReaderReplayIcon}>↻</span>
          再做一次这个梦
        </button>
      </div>

      {/* 标题 */}
      <h2 className={styles.secretSpaceDreamReaderTitle}>{record.title || '——'}</h2>

      {/* 副标（如「梦中所见 · 海边」） */}
      {subtitle ? (
        <p className={styles.secretSpaceDreamReaderSubtitle}>{subtitle}</p>
      ) : null}

      {/* 正文：按住消雾 */}
      <div
        key={replayKey}
        className={styles.secretSpaceDreamReaderBody}
        onMouseDown={handleRecallStart}
        onMouseUp={handleRecallEnd}
        onMouseLeave={handleRecallEnd}
        onTouchStart={handleRecallStart}
        onTouchEnd={handleRecallEnd}
        onTouchCancel={handleRecallEnd}
        title="按住回想"
      >
        {paragraphs.length === 0 ? (
          <p className={styles.secretSpaceDreamReaderParagraph} data-empty="true">
            梦里没留下什么字句……
          </p>
        ) : (
          paragraphs.map((p, idx) => (
            <p
              key={`${replayKey}-${idx}`}
              className={styles.secretSpaceDreamReaderParagraph}
              style={{ animationDelay: `${0.08 * idx + 0.05}s` }}
            >
              {p}
            </p>
          ))
        )}
        <span aria-hidden className={styles.secretSpaceDreamReaderMistHint}>
          按住回想 · 雾会散开
        </span>
      </div>

      {/* 标签 → 梦签 */}
      {record.tags && record.tags.length ? (
        <div className={styles.secretSpaceDreamReaderTags}>
          {record.tags.map((t) => {
            const lit = litTags.has(t);
            return (
              <button
                key={t}
                type="button"
                className={styles.secretSpaceDreamReaderTag}
                data-lit={lit || undefined}
                onClick={() => toggleTag(t)}
                aria-pressed={lit}
                aria-label={lit ? `熄灭梦签 ${t}` : `点亮梦签 ${t}`}
              >
                <span aria-hidden className={styles.secretSpaceDreamReaderTagDot} />
                {t}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* 落款 */}
      <div className={styles.secretSpaceDreamReaderFootnote}>
        <span>梦留 · {formatDateChip(record.createdAt)}</span>
        {record.source ? <span>· 自 {record.source}</span> : null}
      </div>
    </article>
  );
}
