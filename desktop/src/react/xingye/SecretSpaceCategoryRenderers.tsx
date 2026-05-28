/**
 * Per-category 内页渲染组件。每个组件接受 (records, onOpen)，
 * 渲染对应分类的"标志性"布局（便签纸 / 书签卡 / 朋友圈 / 标本 / 墨晕梦记）。
 *
 * 通过 SecretSpaceCategoryView 的 `renderRecordList` prop 注入；
 * 没有传入时回退到 `SecretSpaceRecordListItem` 的默认列表。
 */

import type { ReactNode } from 'react';
import type { Agent } from '../types';
import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import { normalizeSecretInterviewMetadata } from './xingye-secret-space-interview-types';
import { XingyeAgentAvatar } from './XingyeAgentAvatar';
import styles from './XingyeShell.module.css';

export interface CategoryRendererProps {
  records: SecretSpaceSampleRecord[];
  onOpen: (recordKey: string) => void;
}

function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1))}…`;
}

/** 从 record.id / key 派生一个稳定的 0-N 索引。 */
function stableIndex(key: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return h % mod;
}

/** 把 meta 字段（可能带 " · " 分隔）拆成多段。 */
function splitMeta(meta: string | undefined): string[] {
  if (!meta) return [];
  return meta.split(' · ').map((s) => s.trim()).filter(Boolean);
}

// =============================================================================
// 1. draft_reply — sticky-note board
// =============================================================================

const STICKY_COLORS = ['#fff39a', '#c6e7c0', '#ffd6da', '#c2dcef', '#f0d5b0', '#e3d4ef'];
const STICKY_ROTATIONS = [-2.4, 1.8, -1.2, 2.5, -3, 1];

function formatDraftDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return `今天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return `昨天 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${d.getMonth() + 1}/${d.getDate()}`;
  } catch {
    return '';
  }
}

export function SecretSpaceDraftGrid({ records, onOpen }: CategoryRendererProps): ReactNode {
  return (
    <div className={styles.secretSpaceDraftGrid}>
      {records.map((rec, idx) => {
        const color = STICKY_COLORS[idx % STICKY_COLORS.length];
        const rotate = STICKY_ROTATIONS[idx % STICKY_ROTATIONS.length];
        const pin = idx % 4 === 0;
        const small = idx >= 4;
        const recipient = splitMeta(rec.meta)[0] || '给 你';
        const dateText = formatDraftDate(rec.createdAt);
        return (
          <button
            key={rec.key}
            type="button"
            className={`${styles.secretSpaceDraftSticky}${small ? ` ${styles.secretSpaceDraftStickySmall}` : ''}`}
            style={{ background: color, transform: `rotate(${rotate}deg)` }}
            onClick={() => onOpen(rec.key)}
            data-testid={`secret-space-record-row-${rec.key}`}
          >
            {pin ? (
              <span aria-hidden className={styles.secretSpaceDraftStickyPin} />
            ) : (
              <span aria-hidden className={styles.secretSpaceDraftStickyCurl} />
            )}
            <div className={styles.secretSpaceDraftStickyMeta}>
              <span>{recipient}</span>
              <span>{dateText || '——'}</span>
            </div>
            {rec.title ? (
              <div className={styles.secretSpaceDraftStickyTitle}>{rec.title}</div>
            ) : null}
            <div
              className={`${styles.secretSpaceDraftStickyBody}${small ? ` ${styles.secretSpaceDraftStickyBodySmall}` : ''}`}
            >
              {excerpt(rec.body || rec.summary || rec.title, small ? 28 : 48)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// 2. saved_item — book + ribbon bookmarks
// =============================================================================

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
const RIBBON_FALLBACK = ['#9b1c2e', '#b07a37', '#3a6a5a', '#6a4a8a', '#c2616d'];

export function SecretSpaceSavedList({ records, onOpen }: CategoryRendererProps): ReactNode {
  return (
    <div className={styles.secretSpaceSavedList}>
      {records.map((rec, idx) => {
        const parts = splitMeta(rec.meta);
        const kind = parts[0] || '片段';
        const source = parts.length > 1 ? parts.slice(1).join(' · ') : '';
        const ribbon = RIBBON_BY_KIND[kind] || RIBBON_FALLBACK[idx % RIBBON_FALLBACK.length];
        const paper = PAPER_BY_KIND[kind] || '#fbf3df';
        const body = rec.body || rec.summary || rec.title;
        const short = body.length < 32;
        return (
          <button
            key={rec.key}
            type="button"
            className={styles.secretSpaceSavedCard}
            style={{ background: paper, borderLeftColor: ribbon }}
            onClick={() => onOpen(rec.key)}
            data-testid={`secret-space-record-row-${rec.key}`}
          >
            <span
              aria-hidden
              className={`${styles.secretSpaceSavedRibbon}${short ? ` ${styles.secretSpaceSavedRibbonShort}` : ''}`}
              style={{ background: ribbon }}
            />
            <div className={styles.secretSpaceSavedKind} style={{ color: ribbon }}>
              {kind}
            </div>
            <blockquote className={styles.secretSpaceSavedExcerpt}>{body}</blockquote>
            {source ? <div className={styles.secretSpaceSavedSource}>{source}</div> : null}
          </button>
        );
      })}
    </div>
  );
}

// =============================================================================
// 3. unsent_moment — Moments-app timeline
// =============================================================================

function formatMomentTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    if (sameDay) return `今天 ${hh}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (
      d.getFullYear() === yesterday.getFullYear() &&
      d.getMonth() === yesterday.getMonth() &&
      d.getDate() === yesterday.getDate()
    ) {
      return `昨天 ${hh}`;
    }
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}`;
  } catch {
    return '';
  }
}

export interface MomentsFeedProps extends CategoryRendererProps {
  displayName: string;
  avatarChar: string;
  agent?: Agent | null;
  coverBackgroundUrl?: string;
}

export function SecretSpaceMomentsFeed({
  records,
  onOpen,
  displayName,
  avatarChar,
  agent,
  coverBackgroundUrl,
}: MomentsFeedProps): ReactNode {
  const coverStyle = coverBackgroundUrl
    ? { backgroundImage: `url("${coverBackgroundUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined;
  return (
    <div className={styles.secretSpaceMomentsRoot}>
      <div className={styles.secretSpaceMomentsCover} style={coverStyle}>
        <div className={styles.secretSpaceMomentsCoverGlow} />
        <div className={styles.secretSpaceMomentsCoverIdentity}>
          <div className={styles.secretSpaceMomentsCoverName}>{displayName}</div>
          <div className={styles.secretSpaceMomentsCoverAvatar}>
            {agent ? <XingyeAgentAvatar agent={agent} alt={displayName} /> : avatarChar}
          </div>
        </div>
      </div>
      <div className={styles.secretSpaceMomentsCaption}>
        <div className={styles.secretSpaceMomentsCaptionTitle}>
          未发出的朋友圈 · {records.length} 条
        </div>
        <div className={styles.secretSpaceMomentsCaptionSub}>这些只有 TA 自己能看见</div>
      </div>
      <div className={styles.secretSpaceMomentsFeed}>
        {records.map((rec) => {
          const why = rec.meta?.trim() || '';
          const time = formatMomentTime(rec.createdAt);
          return (
            <button
              key={rec.key}
              type="button"
              className={styles.secretSpaceMomentPost}
              onClick={() => onOpen(rec.key)}
              data-testid={`secret-space-record-row-${rec.key}`}
            >
              <div className={styles.secretSpaceMomentAvatar}>
                {agent ? <XingyeAgentAvatar agent={agent} alt={displayName} /> : avatarChar}
              </div>
              <div className={styles.secretSpaceMomentBody}>
                <div className={styles.secretSpaceMomentAuthor}>{displayName}</div>
                <div className={styles.secretSpaceMomentText}>{rec.body || rec.summary || rec.title}</div>
                <div className={styles.secretSpaceMomentFooter}>
                  <span>{time}</span>
                  <span className={styles.secretSpaceMomentBadge}>UNSENT</span>
                </div>
                {why ? <div className={styles.secretSpaceMomentWhy}>{why}</div> : null}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// 4. memory_fragment — pressed-flower specimen cards
// =============================================================================

const SPECIMEN_SHAPES: Array<'bloom' | 'leaf' | 'dot'> = ['bloom', 'leaf', 'dot'];
const SPECIMEN_COLORS = ['#c08294', '#7a8c5c', '#b89b6e', '#6a8aa4', '#9b6a92'];

function specimenSvg(shape: 'bloom' | 'leaf' | 'dot', color: string, size: number): ReactNode {
  if (shape === 'bloom') {
    return (
      <svg viewBox="0 0 60 60" width={size} height={size} aria-hidden focusable="false">
        <g stroke="#7a5b48" strokeWidth="0.8" fill="none">
          <path d="M30 56 L30 18" />
          <path d="M30 38 Q 20 34 12 28" />
          <path d="M30 30 Q 42 28 50 22" />
        </g>
        <g fill={color} opacity="0.85">
          <circle cx="30" cy="18" r="5" />
          <circle cx="26" cy="14" r="3.5" />
          <circle cx="34" cy="14" r="3.5" />
          <circle cx="30" cy="11" r="3" />
        </g>
        <ellipse cx="12" cy="28" rx="5" ry="2.5" fill={color} opacity="0.5" transform="rotate(-30 12 28)" />
        <ellipse cx="50" cy="22" rx="5" ry="2.5" fill={color} opacity="0.5" transform="rotate(30 50 22)" />
      </svg>
    );
  }
  if (shape === 'leaf') {
    return (
      <svg viewBox="0 0 60 60" width={size} height={size} aria-hidden focusable="false">
        <g stroke="#7a5b48" strokeWidth="0.8" fill="none">
          <path d="M30 54 Q 30 32 30 16" />
        </g>
        <path d="M30 16 Q 50 20 50 34 Q 40 50 30 54 Q 20 50 10 34 Q 10 20 30 16 Z" fill={color} opacity="0.7" />
        <path d="M30 16 L 30 54 M 30 24 L 22 30 M 30 32 L 38 38 M 30 40 L 22 44" stroke="#7a5b48" strokeWidth="0.6" fill="none" opacity="0.7" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 60 60" width={size} height={size} aria-hidden focusable="false">
      <circle cx="30" cy="30" r="18" fill={color} opacity="0.85" />
      <circle cx="30" cy="30" r="12" fill="none" stroke="#fbf3df" strokeWidth="1.5" opacity="0.6" />
      <text x="30" y="35" textAnchor="middle" fontFamily="var(--xingye-font-brush)" fontSize="14" fill="#fbf3df" opacity="0.85">忆</text>
    </svg>
  );
}

function formatMemoryDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y} · ${m} · ${day}`;
  } catch {
    return '';
  }
}

export function SecretSpaceMemoryGrid({ records, onOpen }: CategoryRendererProps): ReactNode {
  const [hero, ...rest] = records;
  return (
    <div className={styles.secretSpaceMemoryRoot}>
      {hero ? (
        <button
          type="button"
          className={styles.secretSpaceMemoryFeatured}
          onClick={() => onOpen(hero.key)}
          data-testid={`secret-space-record-row-${hero.key}`}
        >
          <div className={styles.secretSpaceMemoryStamp}>
            NO. {String(stableIndex(hero.key, 99) + 1).padStart(2, '0')}
            <br />
            {formatMemoryDate(hero.createdAt)}
          </div>
          <div className={styles.secretSpaceMemoryFeaturedRow}>
            {specimenSvg(
              SPECIMEN_SHAPES[stableIndex(hero.key, SPECIMEN_SHAPES.length)],
              SPECIMEN_COLORS[stableIndex(hero.key, SPECIMEN_COLORS.length)],
              56,
            )}
            <div className={styles.secretSpaceMemoryFeaturedHead}>
              {hero.meta ? (
                <div className={styles.secretSpaceMemoryWhere}>{splitMeta(hero.meta)[0]}</div>
              ) : null}
              <div className={styles.secretSpaceMemoryFeaturedTitle}>{hero.title}</div>
            </div>
          </div>
          <p className={styles.secretSpaceMemoryFeaturedBody}>
            {excerpt(hero.body || hero.summary || '', 140)}
          </p>
        </button>
      ) : null}
      {rest.length ? (
        <div className={styles.secretSpaceMemoryGrid}>
          {rest.map((rec) => {
            const shape = SPECIMEN_SHAPES[stableIndex(rec.key, SPECIMEN_SHAPES.length)];
            const color = SPECIMEN_COLORS[stableIndex(rec.key, SPECIMEN_COLORS.length)];
            const where = splitMeta(rec.meta)[0] || '';
            return (
              <button
                key={rec.key}
                type="button"
                className={styles.secretSpaceMemoryCard}
                onClick={() => onOpen(rec.key)}
                data-testid={`secret-space-record-row-${rec.key}`}
              >
                <div className={styles.secretSpaceMemoryCardTop}>
                  {specimenSvg(shape, color, 36)}
                  <span className={styles.secretSpaceMemoryNo}>
                    NO. {String(stableIndex(rec.key, 99) + 1).padStart(2, '0')}
                  </span>
                </div>
                <div className={styles.secretSpaceMemoryCardTitle}>{rec.title}</div>
                <p className={styles.secretSpaceMemoryCardBody}>
                  {excerpt(rec.body || rec.summary || '', 56)}
                </p>
                <div className={styles.secretSpaceMemoryCardFooter}>
                  <span>{where || '——'}</span>
                  <span>{formatMemoryDate(rec.createdAt)}</span>
                </div>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// =============================================================================
// 5. dream — ink-wash dark theme cards
// =============================================================================

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

// =============================================================================
// 6. interview — film-noir poster wall
//    多期专访的归档墙。每张海报 3:4 抽屉式封面，自带 sprocket 片孔 + 单麦剪影。
// =============================================================================

function formatInterviewDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  } catch {
    return '';
  }
}

export function SecretSpaceInterviewGrid({ records, onOpen }: CategoryRendererProps): ReactNode {
  return (
    <div className={styles.secretSpaceInterviewGrid}>
      {records.map((rec, idx) => {
        /*
         * record.metadata 是 SecretInterviewMetadata 的 jsonl 行——可能字段缺失或损坏；
         * normalize 失败时退到 record 本身的 title / createdAt 字段，确保海报始终能渲染。
         */
        const meta = rec.metadata ? normalizeSecretInterviewMetadata(rec.metadata) : null;
        const title = meta?.title || rec.title || '未命名一期';
        const hostName = meta?.hostName || '本刊记者';
        const dateLabel = formatInterviewDate(meta?.recordedAt || rec.createdAt);
        // 期数：用最新的在前 → records.length - idx
        const no = String(records.length - idx).padStart(2, '0');
        const gradientId = `xingye-poster-spot-${rec.key.replace(/[^a-z0-9]/gi, '')}`;
        return (
          <button
            key={rec.key}
            type="button"
            className={styles.secretSpaceInterviewPoster}
            onClick={() => onOpen(rec.key)}
            data-testid={`secret-space-record-row-${rec.key}`}
          >
            {/* sprocket holes 左右两列（视觉装饰）*/}
            <span className={`${styles.secretSpaceInterviewPosterSprocket} ${styles.secretSpaceInterviewPosterSprocket_left}`} aria-hidden>
              {Array.from({ length: 8 }).map((_, i) => <span key={i} />)}
            </span>
            <span className={`${styles.secretSpaceInterviewPosterSprocket} ${styles.secretSpaceInterviewPosterSprocket_right}`} aria-hidden>
              {Array.from({ length: 8 }).map((_, i) => <span key={i} />)}
            </span>

            {/* 单麦特写 + 顶部光圈 */}
            <span className={styles.secretSpaceInterviewPosterArt} aria-hidden>
              <svg viewBox="0 0 200 280" preserveAspectRatio="xMidYMid slice">
                <defs>
                  <radialGradient id={gradientId} cx="0.5" cy="0.25" r="0.6">
                    <stop offset="0%" stopColor="#c9a85a" stopOpacity="0.45" />
                    <stop offset="100%" stopColor="#c9a85a" stopOpacity="0" />
                  </radialGradient>
                </defs>
                <rect width="200" height="280" fill={`url(#${gradientId})`} />
                <g stroke="#c9a85a" fill="none" strokeWidth="1.1" opacity="0.7">
                  <ellipse cx="100" cy="80" rx="22" ry="28" />
                  <path d="M 100 108 L 100 200" />
                  <path d="M 80 205 L 120 205" />
                </g>
              </svg>
            </span>

            <span className={styles.secretSpaceInterviewPosterTopRow}>
              <span className={styles.secretSpaceInterviewPosterNo}>NO.{no}</span>
            </span>

            <span className={styles.secretSpaceInterviewPosterBottom}>
              <span className={styles.secretSpaceInterviewPosterKicker}>INTERVIEW</span>
              <span className={styles.secretSpaceInterviewPosterTitle}>{title}</span>
              <span className={styles.secretSpaceInterviewPosterMeta}>
                <span>{hostName}</span>
                {dateLabel ? (
                  <>
                    <span className={styles.secretSpaceInterviewPosterMetaSep}>·</span>
                    <span>{dateLabel}</span>
                  </>
                ) : null}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SecretSpaceDreamFeed({ records, onOpen }: CategoryRendererProps): ReactNode {
  return (
    <div className={styles.secretSpaceDreamRoot}>
      <svg
        viewBox="0 0 400 700"
        preserveAspectRatio="none"
        aria-hidden
        className={styles.secretSpaceDreamInkLayer}
      >
        <defs>
          <radialGradient id="xingye-dream-ink1" cx="0.3" cy="0.2" r="0.6">
            <stop offset="0%" stopColor="#1d2548" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#1d2548" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="xingye-dream-ink2" cx="0.8" cy="0.6" r="0.7">
            <stop offset="0%" stopColor="#000" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="120" cy="120" rx="180" ry="140" fill="url(#xingye-dream-ink1)" />
        <ellipse cx="320" cy="380" rx="180" ry="160" fill="url(#xingye-dream-ink2)" />
        <g fill="#fff">
          <circle cx="60" cy="90" r="0.9" opacity="0.65" />
          <circle cx="190" cy="40" r="0.6" opacity="0.45" />
          <circle cx="280" cy="160" r="1.1" opacity="0.7" />
          <circle cx="350" cy="60" r="0.7" opacity="0.55" />
          <circle cx="40" cy="320" r="0.8" opacity="0.5" />
          <circle cx="220" cy="270" r="1.0" opacity="0.7" />
          <circle cx="360" cy="500" r="0.7" opacity="0.5" />
          <circle cx="80" cy="560" r="0.6" opacity="0.4" />
        </g>
      </svg>
      <div className={styles.secretSpaceDreamFeed}>
        {records.map((rec, idx) => (
          <button
            key={rec.key}
            type="button"
            className={styles.secretSpaceDreamCard}
            onClick={() => onOpen(rec.key)}
            data-testid={`secret-space-record-row-${rec.key}`}
          >
            <div className={styles.secretSpaceDreamCardHead}>
              <span className={styles.secretSpaceDreamCardKicker}>
                NO. {String(records.length - idx).padStart(2, '0')} · {nightLabel(rec.createdAt)}
              </span>
              <span aria-hidden className={styles.secretSpaceDreamCardDot} />
            </div>
            <h3 className={styles.secretSpaceDreamCardTitle}>{rec.title || '——'}</h3>
            <div className={styles.secretSpaceDreamCardBody}>{rec.body || rec.summary}</div>
            {rec.tags && rec.tags.length ? (
              <div className={styles.secretSpaceDreamCardTags}>
                {rec.tags.map((t) => (
                  <span key={t} className={styles.secretSpaceDreamCardTag}>
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
