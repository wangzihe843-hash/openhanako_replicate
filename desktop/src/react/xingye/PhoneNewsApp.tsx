import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Agent } from '../types';
import { useStore } from '../stores';
import shell from './XingyeShell.module.css';
import news from './PhoneNewsApp.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
  listAppEntries,
  updateAppEntry,
  type AppEntry,
} from './xingye-app-entry-store';
import {
  flattenNewsMetadataToContent,
  normalizeNewsEntryMetadata,
  NEWS_SECTION_REGISTRY,
  NEWS_COMMENTS_MAX,
  type NewsComment,
  type NewsEntryMetadata,
  type NewsLayoutSlot,
  type NewsSection,
  type NewsSectionKind,
} from './xingye-news-types';
import {
  generateHistoricalNewsDraftWithAI,
  generateNewsCommentWithAI,
  generateNewsDraftWithAI,
} from './xingye-news-ai';
import {
  TIMELINE_EVENTS_PER_ISSUE_TARGET,
  WORLD_TIMELINE_SCOPES,
  WORLD_TIMELINE_SCOPE_LABELS,
  computeIssueDatesForBackfill,
  computeTimelineShortfall,
  expandTimelineWithAI,
  extractWorldTimelineFromLore,
  partitionTimelineForIssues,
  type WorldTimelineEvent,
  type WorldTimelineScope,
} from './xingye-news-timeline';
import {
  confirmNewsDraftWithEntry,
  discardNewsDraft,
  listNewsDrafts,
  type XingyePendingNewsDraft,
} from './xingye-news-drafts';
import { resolveNewsEra, buildNewsEraAgentLike, type NewsEraId } from './xingye-news-era-resolver';
import type { XingyeRoleProfile } from './xingye-profile-store';

export interface PhoneNewsAppProps {
  ownerAgent: Agent | null;
  ownerProfile?: XingyeRoleProfile | null;
  displayName: string;
  onBack: () => void;
}

type NewsEntry = AppEntry & {
  appId: 'news';
  metadata: NewsEntryMetadata;
};

const NEWS_APP_ID = 'news';

function k(key: string): string {
  return (news as Record<string, string>)[key] ?? '';
}
function cx(...keys: string[]): string {
  return keys.map(k).filter(Boolean).join(' ');
}

function normalizeNewsEntry(entry: AppEntry): NewsEntry | null {
  const meta = normalizeNewsEntryMetadata(entry.metadata);
  if (!meta) return null;
  return { ...entry, appId: 'news', metadata: meta };
}

function formatIssueDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
}

const CN_NUM = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function cnNum(n: number): string {
  return String(n).split('').map((c) => CN_NUM[Number(c)] ?? c).join('');
}
function formatIssueDateClassical(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${cnNum(d.getFullYear())}年${cnNum(d.getMonth() + 1)}月${cnNum(d.getDate())}日`;
}

function formatIssueDateMono(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function excerpt(text: string, max = 60): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  return `${one.slice(0, Math.max(1, max - 1))}…`;
}

const EMPTY_SLOT_MAP = (): Record<NewsLayoutSlot, NewsSection[]> => ({
  masthead: [],
  left_column: [],
  right_column: [],
  footer_strip: [],
  margin_right: [],
});

function groupBySlot(sections: NewsSection[]): Record<NewsLayoutSlot, NewsSection[]> {
  const out = EMPTY_SLOT_MAP();
  for (const s of sections) {
    const slot = NEWS_SECTION_REGISTRY[s.kind]?.layoutSlot ?? 'left_column';
    out[slot].push(s);
  }
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
   AI 评论：高亮渲染 + 评论卡片（三 era 共用）
───────────────────────────────────────────────────────────────────────────── */

/**
 * 把 `body` 按 `marks` 切成 ReactNode[]——命中段裹 <mark> 加荧光笔背景，其它原样。
 *
 * 算法：每次找剩余 marks 中**最早出现位置**的一条做切分，然后递归处理剩余文本。
 * 处理 overlapping：如果两条 mark 重叠，只用最早出现的那条，重叠的另一条等下一轮再找。
 * 找不到任何 mark 时返回纯文本（数组里就一个字符串元素）。
 */
function renderBodyWithMarks(body: string, marks: NewsComment[] | undefined): ReactNode {
  if (!marks || marks.length === 0) return body;
  // 先在 body 里把每条 mark 的所有出现位置算出来，按位置升序排列；重叠时优先保留更早的
  type Hit = { start: number; end: number; comment: NewsComment };
  const hits: Hit[] = [];
  for (const m of marks) {
    if (!m.highlightText) continue;
    const idx = body.indexOf(m.highlightText);
    if (idx < 0) continue;
    hits.push({ start: idx, end: idx + m.highlightText.length, comment: m });
  }
  if (hits.length === 0) return body;
  hits.sort((a, b) => a.start - b.start);
  // 去重 overlap：保留最早出现且最长的
  const pruned: Hit[] = [];
  for (const h of hits) {
    const last = pruned[pruned.length - 1];
    if (last && h.start < last.end) continue; // 与前一段重叠，跳过
    pruned.push(h);
  }
  // 按 hits 切片
  const out: ReactNode[] = [];
  let cursor = 0;
  pruned.forEach((h, i) => {
    if (h.start > cursor) out.push(body.slice(cursor, h.start));
    out.push(
      <mark
        key={`m-${h.comment.id}-${i}`}
        className={news['news-mark']}
        data-comment-id={h.comment.id}
        title={h.comment.comment}
      >
        {body.slice(h.start, h.end)}
      </mark>,
    );
    cursor = h.end;
  });
  if (cursor < body.length) out.push(body.slice(cursor));
  return <>{out.map((node, i) => <Fragment key={i}>{node}</Fragment>)}</>;
}

function SectionCommentBlock({
  comments,
  agentName,
  onDelete,
}: {
  comments: NewsComment[];
  agentName: string;
  onDelete: (id: string) => void;
}) {
  if (!comments.length) return null;
  return (
    <div className={news['news-comments']} data-testid="phone-news-section-comments">
      <div className={news['news-comments-label']}>
        <span className={news['news-comments-label-dot']}>◆</span>
        <span>{agentName} 的批注</span>
      </div>
      {comments.map((c) => (
        <div key={c.id} className={news['news-comment']}>
          <div className={news['news-comment-head']}>
            <span className={news['news-comment-author']}>{agentName}</span>
            <button
              type="button"
              className={news['news-comment-delete']}
              onClick={() => onDelete(c.id)}
              aria-label="删除批注"
            >
              ×
            </button>
          </div>
          <p className={news['news-comment-text']}>{c.comment}</p>
          <p className={news['news-comment-quote']}>—— 批注于「{c.highlightText}」</p>
        </div>
      ))}
    </div>
  );
}

/** 按 sectionKind 把 comments 分组。同一 kind 下可能有多条评论。 */
/**
 * 「去和 TA 聊聊」专用：把整期报纸 + TA 已有的批注按段落交织成纯文本引用。
 * 不复用 flattenNewsMetadataToContent —— 后者只服务存储侧 `content`，
 * 把批注塞进去会污染历史数据；这里只是 UI 临时拼接。
 */
function buildNewsShareText(meta: NewsEntryMetadata): string {
  const commentsByKind = groupCommentsByKind(meta.comments);
  const parts: string[] = [meta.masthead];
  for (const section of meta.sections) {
    parts.push('');
    parts.push(`【${section.title}】`);
    parts.push(section.body);
    if (section.byline) parts.push(`—— ${section.byline}`);
    const sectionComments = commentsByKind.get(section.kind);
    if (sectionComments && sectionComments.length) {
      for (const c of sectionComments) {
        parts.push(`（TA 的批注：「${c.highlightText}」→ ${c.comment}）`);
      }
    }
  }
  return parts.join('\n').trim();
}

function groupCommentsByKind(comments: NewsComment[] | undefined): Map<NewsSectionKind, NewsComment[]> {
  const map = new Map<NewsSectionKind, NewsComment[]>();
  if (!comments) return map;
  for (const c of comments) {
    const arr = map.get(c.sectionKind);
    if (arr) arr.push(c);
    else map.set(c.sectionKind, [c]);
  }
  return map;
}

/* ─────────────────────────────────────────────────────────────────────────────
   ORIENTAL CLASSICAL — 民国小报闲笔体
───────────────────────────────────────────────────────────────────────────── */

function OrientalSectionTitle({ title, byline }: { title: string; byline?: string }) {
  return (
    <div className={k('or-sec-title')}>
      <span className={k('or-sec-title-mark')}>▍</span>
      <span className={k('or-sec-title-text')}>{title}</span>
      {byline ? <span className={k('or-sec-byline')}>{byline}</span> : null}
    </div>
  );
}

function OrientalDetail({
  meta,
  commentsByKind,
  agentName,
  onDeleteComment,
}: {
  meta: NewsEntryMetadata;
  commentsByKind: Map<NewsSectionKind, NewsComment[]>;
  agentName: string;
  onDeleteComment: (id: string) => void;
}) {
  const slots = groupBySlot(meta.sections);
  const head = slots.masthead[0];
  const hasBody = slots.left_column.length > 0 || slots.right_column.length > 0;
  const dateCn = formatIssueDateClassical(meta.issueDate);
  const d = new Date(meta.issueDate);
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][Number.isNaN(d.getTime()) ? 0 : d.getDay()];
  const twocolSingle = !(slots.left_column.length && slots.right_column.length);
  const cmtOf = (kind: NewsSectionKind): NewsComment[] => commentsByKind.get(kind) ?? [];
  return (
    <div className={k('or-paper')} data-testid="phone-news-detail">
      <div className={k('or-paperhead')}>
        <div className={k('or-paperhead-ruleD')} />
        <div className={k('or-paperhead-row')}>
          <div className={k('or-paperhead-side')}>
            <div className={k('or-paperhead-side-text')}>本期共肆版</div>
            <div className={k('or-paperhead-side-text')}>零售铜钱叁文</div>
          </div>
          <div className={k('or-paperhead-title')}>
            <div className={k('or-paperhead-titlecn')}>{meta.masthead}</div>
            <div className={k('or-paperhead-subtitle')}>XINGYE&nbsp;·&nbsp;HERALD</div>
          </div>
          <div className={cx('or-paperhead-side', 'or-paperhead-side-right')}>
            <div className={k('or-paperhead-stamp')}>
              <div className={k('or-paperhead-stamp-inner')}>
                <span>本</span><span>报</span><span>专</span><span>讯</span>
              </div>
            </div>
          </div>
        </div>
        <div className={k('or-paperhead-ruleD')} />
        <div className={k('or-paperhead-metarow')}>
          <span>{dateCn}</span>
          <span className={k('or-paperhead-meta-sep')}>·</span>
          <span>星期{weekday}</span>
          <span className={k('or-paperhead-meta-sep')}>·</span>
          <span>第 {meta.sections.length} 板</span>
        </div>
      </div>

      {head ? (
        <article
          className={k('or-headline-block')}
          data-slot="masthead"
          data-testid={`phone-news-section-${head.kind}`}
        >
          <OrientalSectionTitle title={head.title} byline={head.byline} />
          <p className={cx('or-body', 'or-body-lead')}>
            <span className={k('or-dropcap')}>{head.body.charAt(0)}</span>
            {renderBodyWithMarks(head.body.slice(1), cmtOf(head.kind))}
          </p>
          <SectionCommentBlock comments={cmtOf(head.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      {hasBody ? (
        <div className={cx('or-twocol', twocolSingle ? 'or-twocol-single' : '')}>
          {slots.left_column.map((s, i) => (
            <article
              key={`l-${i}`}
              className={cx('or-col', 'or-col-left')}
              data-slot="left_column"
              data-testid={`phone-news-section-${s.kind}`}
            >
              <OrientalSectionTitle title={s.title} byline={s.byline} />
              <p className={k('or-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
              <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
            </article>
          ))}
          {slots.left_column.length && slots.right_column.length ? (
            <div className={k('or-col-divider')} aria-hidden="true" />
          ) : null}
          {slots.right_column.map((s, i) => (
            <article
              key={`r-${i}`}
              className={cx('or-col', 'or-col-right')}
              data-slot="right_column"
              data-testid={`phone-news-section-${s.kind}`}
            >
              <OrientalSectionTitle title={s.title} byline={s.byline} />
              <p className={k('or-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
              <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
            </article>
          ))}
        </div>
      ) : null}

      {slots.margin_right.map((s, i) => (
        <aside
          key={`m-${i}`}
          className={k('or-ad')}
          data-slot="margin_right"
          data-testid={`phone-news-section-${s.kind}`}
        >
          <div className={k('or-ad-title')}>{s.title}</div>
          <div className={k('or-ad-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</div>
          <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </aside>
      ))}

      {slots.footer_strip.map((s, i) => (
        <section
          key={`f-${i}`}
          className={k('or-footer')}
          data-slot="footer_strip"
          data-testid={`phone-news-section-${s.kind}`}
        >
          <div className={k('or-footer-bar')} />
          <OrientalSectionTitle title={s.title} byline={s.byline} />
          <p className={cx('or-body', 'or-body-footer')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
          <div className={k('or-footer-bar')} />
          <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </section>
      ))}

      <div className={k('or-paperfoot')}>
        <span>· 本期完 ·</span>
      </div>
    </div>
  );
}

function OrientalListCard({ entry, onClick }: { entry: NewsEntry; onClick: () => void }) {
  const head = entry.metadata.sections.find((s) => s.kind === 'headline_world') || entry.metadata.sections[0];
  return (
    <button
      type="button"
      className={k('or-listcard')}
      onClick={onClick}
      data-testid={`phone-news-card-${entry.id}`}
    >
      <div className={k('or-listcard-rule')} />
      <div className={k('or-listcard-titlerow')}>
        <span className={k('or-listcard-title')}>{entry.metadata.masthead}</span>
        <span className={k('or-listcard-stamp')}>阅</span>
      </div>
      <div className={k('or-listcard-meta')}>
        <span>{formatIssueDateClassical(entry.metadata.issueDate)}</span>
        <span className={k('or-listcard-dot')}>·</span>
        <span>{entry.metadata.sections.length} 个板块</span>
      </div>
      <div className={k('or-listcard-rule')} />
      <p className={k('or-listcard-excerpt')}>{excerpt(head?.body ?? '', 64)}</p>
      {head?.byline ? <p className={k('or-listcard-byline')}>—— {head.byline}</p> : null}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   WESTERN FANTASY — 早期欧洲译文体
───────────────────────────────────────────────────────────────────────────── */

const WE_MONTHS = ['Ianuarius', 'Februarius', 'Martius', 'Aprilis', 'Maius', 'Iunius', 'Iulius', 'Augustus', 'September', 'October', 'November', 'December'];
const ROMAN_DIGITS: Array<[number, string]> = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];
function toRoman(n: number): string {
  let v = Math.max(0, Math.floor(n));
  let out = '';
  for (const [val, sym] of ROMAN_DIGITS) {
    while (v >= val) { out += sym; v -= val; }
  }
  return out || 'I';
}

function WesternSectionTitle({ title, byline }: { title: string; byline?: string }) {
  return (
    <header className={k('we-sec-header')}>
      <h3 className={k('we-sec-title')}>{title}</h3>
      {byline ? (
        <div className={k('we-sec-byline')}>
          <span className={k('we-sec-byline-fl')}>⁂</span>
          <span>{byline}</span>
        </div>
      ) : null}
      <div className={k('we-sec-rule')} />
    </header>
  );
}

function WesternDetail({
  meta,
  commentsByKind,
  agentName,
  onDeleteComment,
}: {
  meta: NewsEntryMetadata;
  commentsByKind: Map<NewsSectionKind, NewsComment[]>;
  agentName: string;
  onDeleteComment: (id: string) => void;
}) {
  const slots = groupBySlot(meta.sections);
  const head = slots.masthead[0];
  const hasBody = slots.left_column.length > 0 || slots.right_column.length > 0;
  const twocolSingle = !(slots.left_column.length && slots.right_column.length);
  const d = new Date(meta.issueDate);
  const isValid = !Number.isNaN(d.getTime());
  const month = isValid ? WE_MONTHS[d.getMonth()] : '';
  const die = isValid ? d.getDate() : 1;
  const year = isValid ? d.getFullYear() : new Date().getFullYear();
  const cmtOf = (kind: NewsSectionKind): NewsComment[] => commentsByKind.get(kind) ?? [];
  return (
    <div className={k('we-paper')} data-testid="phone-news-detail">
      <div className={k('we-paperhead')}>
        <div className={k('we-paperhead-fleurontop')}>❦</div>
        <h1 className={k('we-paperhead-title')}>{meta.masthead}</h1>
        <div className={cx('we-paperhead-rule', 'we-paperhead-rule-thick')} />
        <div className={k('we-paperhead-metarow')}>
          <span>VOL.&nbsp;{toRoman(((year - 2024) % 12) + 1)}</span>
          <span className={k('we-paperhead-meta-fl')}>❧</span>
          <span>{month}&nbsp;·&nbsp;DIE&nbsp;{die}</span>
          <span className={k('we-paperhead-meta-fl')}>❧</span>
          <span>A.D.&nbsp;{toRoman(year)}</span>
        </div>
        <div className={cx('we-paperhead-rule', 'we-paperhead-rule-thin')} />
        <div className={k('we-paperhead-tagline')}>
          “Of matters worldly &amp; of matters of the heart, faithfully translated.”
        </div>
      </div>

      {head ? (
        <article
          className={k('we-headline-block')}
          data-slot="masthead"
          data-testid={`phone-news-section-${head.kind}`}
        >
          <WesternSectionTitle title={head.title} byline={head.byline} />
          <p className={cx('we-body', 'we-body-lead')}>
            <span className={k('we-dropcap')}>{head.body.charAt(0)}</span>
            {renderBodyWithMarks(head.body.slice(1), cmtOf(head.kind))}
          </p>
          <SectionCommentBlock comments={cmtOf(head.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      <div className={k('we-fleuron-divider')}>
        <span className={k('we-fleuron-line')} />
        <span className={k('we-fleuron-mark')}>❦&nbsp;&nbsp;❧&nbsp;&nbsp;❦</span>
        <span className={k('we-fleuron-line')} />
      </div>

      {hasBody ? (
        <div className={cx('we-twocol', twocolSingle ? 'we-twocol-single' : '')}>
          {slots.left_column.map((s, i) => (
            <article
              key={`l-${i}`}
              className={cx('we-col', 'we-col-left')}
              data-slot="left_column"
              data-testid={`phone-news-section-${s.kind}`}
            >
              <WesternSectionTitle title={s.title} byline={s.byline} />
              <p className={k('we-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
              <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
            </article>
          ))}
          {slots.left_column.length && slots.right_column.length ? (
            <div className={k('we-col-divider')} aria-hidden="true" />
          ) : null}
          {slots.right_column.map((s, i) => (
            <article
              key={`r-${i}`}
              className={cx('we-col', 'we-col-right')}
              data-slot="right_column"
              data-testid={`phone-news-section-${s.kind}`}
            >
              <WesternSectionTitle title={s.title} byline={s.byline} />
              <p className={k('we-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
              <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
            </article>
          ))}
        </div>
      ) : null}

      {slots.margin_right.map((s, i) => (
        <aside
          key={`m-${i}`}
          className={k('we-ad')}
          data-slot="margin_right"
          data-testid={`phone-news-section-${s.kind}`}
        >
          <div className={k('we-ad-frame')}>
            <div className={k('we-ad-fleuron')}>⁂</div>
            <div className={k('we-ad-title')}>{s.title}</div>
            <div className={k('we-ad-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</div>
            <div className={cx('we-ad-fleuron', 'we-ad-fleuron-bottom')}>⁂</div>
          </div>
          <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </aside>
      ))}

      {slots.footer_strip.map((s, i) => (
        <section
          key={`f-${i}`}
          className={k('we-footer')}
          data-slot="footer_strip"
          data-testid={`phone-news-section-${s.kind}`}
        >
          <div className={k('we-fleuron-divider')}>
            <span className={k('we-fleuron-line')} />
            <span className={k('we-fleuron-mark')}>❦</span>
            <span className={k('we-fleuron-line')} />
          </div>
          <WesternSectionTitle title={s.title} byline={s.byline} />
          <p className={cx('we-body', 'we-body-footer')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
          <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </section>
      ))}

      <div className={k('we-paperfoot')}>
        <span>— FINIS —</span>
      </div>
    </div>
  );
}

function WesternListCard({ entry, onClick }: { entry: NewsEntry; onClick: () => void }) {
  const head = entry.metadata.sections.find((s) => s.kind === 'headline_world') || entry.metadata.sections[0];
  const d = new Date(entry.metadata.issueDate);
  const die = Number.isNaN(d.getTime()) ? 1 : d.getDate();
  const year = Number.isNaN(d.getTime()) ? new Date().getFullYear() : d.getFullYear();
  return (
    <button
      type="button"
      className={k('we-listcard')}
      onClick={onClick}
      data-testid={`phone-news-card-${entry.id}`}
    >
      <div className={cx('we-listcard-corner', 'we-listcard-corner-tl')} />
      <div className={cx('we-listcard-corner', 'we-listcard-corner-tr')} />
      <div className={cx('we-listcard-corner', 'we-listcard-corner-bl')} />
      <div className={cx('we-listcard-corner', 'we-listcard-corner-br')} />
      <div className={k('we-listcard-fleuron')}>❦</div>
      <div className={k('we-listcard-title')}>{entry.metadata.masthead}</div>
      <div className={k('we-listcard-meta')}>
        <span>A.D.&nbsp;{toRoman(year)}&nbsp;·&nbsp;DIE&nbsp;{die}</span>
        <span className={k('we-listcard-meta-fl')}>·</span>
        <span>{entry.metadata.sections.length}&nbsp;columnae</span>
      </div>
      <div className={k('we-listcard-rule')} />
      <p className={k('we-listcard-excerpt')}>
        <span className={k('we-listcard-dropcap')}>{(head?.body || '·').charAt(0)}</span>
        {excerpt((head?.body || '').slice(1), 60)}
      </p>
      {head?.byline ? <p className={k('we-listcard-byline')}>⁂ {head.byline}</p> : null}
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   MODERN OR FUTURE — 现代狗仔小报体（无图版）
───────────────────────────────────────────────────────────────────────────── */

function ModernSectionTitle({
  title,
  byline,
  accent,
  tag,
}: {
  title: string;
  byline?: string;
  accent?: boolean;
  tag?: string;
}) {
  return (
    <header className={k('mo-sec-header')}>
      <div className={cx('mo-sec-titlerow', accent ? 'mo-sec-titlerow-accent' : '')}>
        <span className={k('mo-sec-titlebadge')}>{title}</span>
        {tag ? <span className={k('mo-sec-tag')}>{tag}</span> : null}
        {byline ? <span className={k('mo-sec-byline')}>{byline}</span> : null}
      </div>
    </header>
  );
}

function WitnessCallout({ quote, attribution }: { quote: string; attribution: string }) {
  return (
    <aside className={k('mo-witness')} aria-label="witness quote">
      <div className={k('mo-witness-tape')}>
        <span className={k('mo-witness-tape-text')}>现场证词 · WITNESS</span>
      </div>
      <div className={k('mo-witness-body')}>
        <span className={k('mo-witness-quoteopen')}>「</span>
        <p className={k('mo-witness-text')}>{quote}</p>
        <span className={k('mo-witness-quoteclose')}>」</span>
      </div>
      <div className={k('mo-witness-attr')}>
        <span className={k('mo-witness-dash')}>——</span>
        <span>{attribution}</span>
      </div>
    </aside>
  );
}

function EvidenceTimeline({ items }: { items: Array<{ time: string; text: string }> }) {
  return (
    <ol className={k('mo-evidence')} aria-label="evidence timeline">
      <li className={k('mo-evidence-head')}>
        <span className={k('mo-evidence-head-dot')}>●</span>
        <span>EVIDENCE · 时间线</span>
      </li>
      {items.map((it, i) => (
        <li key={i} className={k('mo-evidence-item')}>
          <span className={k('mo-evidence-num')}>#{String(i + 1).padStart(2, '0')}</span>
          <span className={k('mo-evidence-time')}>{it.time}</span>
          <span className={k('mo-evidence-text')}>{it.text}</span>
        </li>
      ))}
    </ol>
  );
}

function ModernDetail({
  meta,
  commentsByKind,
  agentName,
  onDeleteComment,
}: {
  meta: NewsEntryMetadata;
  commentsByKind: Map<NewsSectionKind, NewsComment[]>;
  agentName: string;
  onDeleteComment: (id: string) => void;
}) {
  const cmtOf = (kind: NewsSectionKind): NewsComment[] => commentsByKind.get(kind) ?? [];
  const byKind: Partial<Record<NewsSection['kind'], NewsSection>> = {};
  for (const s of meta.sections) {
    if (!byKind[s.kind]) byKind[s.kind] = s;
  }
  const headline = byKind.headline_world;
  const second = byKind.second_news;
  const gossip = byKind.gossip_column;
  const review = byKind.review;
  const letters = byKind.letters_to_editor;
  const street = byKind.street_snap;
  const obituary = byKind.obituary;
  const weather = byKind.weather;
  const ad = byKind.advertisement;

  const witnessQuote = headline?.witness?.quote
    ?? (headline ? excerpt(headline.body, 42) : '');
  const witnessAttr = headline?.witness?.attribution
    ?? headline?.byline
    ?? '匿名目击者';
  const evidence = headline?.evidence;

  const d = new Date(meta.issueDate);
  const isValid = !Number.isNaN(d.getTime());
  const yyyy = isValid ? d.getFullYear() : new Date().getFullYear();
  const mm = isValid ? String(d.getMonth() + 1).padStart(2, '0') : '01';
  const dd = isValid ? String(d.getDate()).padStart(2, '0') : '01';

  return (
    <div className={k('mo-paper')} data-testid="phone-news-detail">
      <div className={k('mo-paperhead')}>
        <div className={k('mo-paperhead-toprow')}>
          <span className={k('mo-paperhead-breakingtag')}>EXCLUSIVE</span>
          <span className={k('mo-paperhead-issuetag')}>ISSUE&nbsp;#{toRoman(((yyyy - 2024) * 12 + Number(mm)) || 1).replace(/^M+/, '')}</span>
          <span className={k('mo-paperhead-spacer')} />
          <span className={k('mo-paperhead-date')}>{yyyy}.{mm}.{dd}</span>
        </div>
        <h1 className={k('mo-paperhead-title')}>{meta.masthead}</h1>
        <div className={k('mo-paperhead-bar')}>
          <span className={k('mo-paperhead-bar-mark')}>●</span>
          <span className={k('mo-paperhead-bar-text')}>夜城猎影&nbsp;·&nbsp;PAPARAZZI&nbsp;·&nbsp;凌晨3点&nbsp;爆点不断</span>
        </div>
      </div>

      {headline ? (
        <article
          className={k('mo-headline-block')}
          data-slot="masthead"
          data-testid={`phone-news-section-${headline.kind}`}
        >
          <ModernSectionTitle title={headline.title} byline={headline.byline} accent tag="头版" />
          <h2 className={k('mo-headline-h2')}>
            {headline.body.split('。')[0]}
            <span className={k('mo-headline-h2-tail')}>。</span>
          </h2>
          {witnessQuote ? <WitnessCallout quote={witnessQuote} attribution={witnessAttr} /> : null}
          <p className={cx('mo-body', 'mo-body-lead')}>{renderBodyWithMarks(headline.body, cmtOf(headline.kind))}</p>
          {evidence && evidence.length ? <EvidenceTimeline items={evidence} /> : null}
          <SectionCommentBlock comments={cmtOf(headline.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      {second ? (
        <article
          className={cx('mo-stack-block', 'mo-stack-second')}
          data-slot="right_column"
          data-testid={`phone-news-section-${second.kind}`}
        >
          <ModernSectionTitle title={second.title} byline={second.byline} tag="次条" />
          <p className={k('mo-body')}>{renderBodyWithMarks(second.body, cmtOf(second.kind))}</p>
          <SectionCommentBlock comments={cmtOf(second.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      {gossip ? (
        <article
          className={cx('mo-stack-block', 'mo-stack-gossip')}
          data-slot="left_column"
          data-testid={`phone-news-section-${gossip.kind}`}
        >
          <ModernSectionTitle title={gossip.title} byline={gossip.byline} tag="八卦" />
          <p className={cx('mo-body', 'mo-body-gossip')}>{renderBodyWithMarks(gossip.body, cmtOf(gossip.kind))}</p>
          <div className={k('mo-redacted-row')} aria-hidden="true">
            <span>消息源·</span><span className={k('mo-redacted')}>■■■■■■</span>
            <span>·频段</span><span className={k('mo-redacted')}>■■■.■■</span>
          </div>
          <SectionCommentBlock comments={cmtOf(gossip.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      {review ? (
        <article
          className={k('mo-stack-block')}
          data-slot="left_column"
          data-testid={`phone-news-section-${review.kind}`}
        >
          <ModernSectionTitle title={review.title} byline={review.byline} tag="评论" />
          <p className={k('mo-body')}>{renderBodyWithMarks(review.body, cmtOf(review.kind))}</p>
          <SectionCommentBlock comments={cmtOf(review.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      {letters ? (
        <article
          className={k('mo-stack-block')}
          data-slot="right_column"
          data-testid={`phone-news-section-${letters.kind}`}
        >
          <ModernSectionTitle title={letters.title} byline={letters.byline} tag="读者投书" />
          <p className={k('mo-body')}>{renderBodyWithMarks(letters.body, cmtOf(letters.kind))}</p>
          <SectionCommentBlock comments={cmtOf(letters.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </article>
      ) : null}

      {[ad, weather].filter((s): s is NewsSection => Boolean(s)).map((s, i) => (
        <aside
          key={`m-${i}`}
          className={k('mo-ad')}
          data-slot="margin_right"
          data-testid={`phone-news-section-${s.kind}`}
        >
          <div className={k('mo-ad-tag')}>{s.kind === 'weather' ? '天气 · WX' : '广告 · AD'}</div>
          <div className={k('mo-ad-title')}>{s.title}</div>
          <div className={k('mo-ad-body')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</div>
          <div className={k('mo-ad-stamp')}>{s.kind === 'weather' ? '☀' : '◢'}</div>
          <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </aside>
      ))}

      {[street, obituary].filter((s): s is NewsSection => Boolean(s)).map((s, i) => (
        <section
          key={`f-${i}`}
          className={k('mo-footer')}
          data-slot="footer_strip"
          data-testid={`phone-news-section-${s.kind}`}
        >
          <ModernSectionTitle title={s.title} byline={s.byline} tag={s.kind === 'obituary' ? '怀念' : '街角速写'} />
          <p className={cx('mo-body', 'mo-body-footer')}>{renderBodyWithMarks(s.body, cmtOf(s.kind))}</p>
          <SectionCommentBlock comments={cmtOf(s.kind)} agentName={agentName} onDelete={onDeleteComment} />
        </section>
      ))}

      <div className={k('mo-paperfoot')}>
        <span className={k('mo-paperfoot-dot')}>●</span>
        <span>更多爆点持续追踪</span>
        <span className={k('mo-paperfoot-dot')}>●</span>
      </div>
    </div>
  );
}

function ModernListCard({
  entry,
  onClick,
  featured,
}: {
  entry: NewsEntry;
  onClick: () => void;
  featured: boolean;
}) {
  const head = entry.metadata.sections.find((s) => s.kind === 'headline_world') || entry.metadata.sections[0];
  const dateMono = formatIssueDateMono(entry.metadata.issueDate);
  const headlineShort = excerpt((head?.body || '').split('。')[0], 26);
  return (
    <button
      type="button"
      className={cx('mo-listcard', featured ? 'mo-listcard-featured' : '')}
      onClick={onClick}
      data-testid={`phone-news-card-${entry.id}`}
    >
      {featured ? (
        <div className={k('mo-listcard-hero')}>
          <div className={k('mo-listcard-hero-stripes')} aria-hidden="true" />
          <div className={k('mo-listcard-hero-tag')}>
            <span className={k('mo-listcard-hero-dot')}>●</span>
            <span>今日头条 · TOP STORY</span>
          </div>
          <h3 className={k('mo-listcard-hero-headline')}>
            {headlineShort}
            <span className={k('mo-listcard-hero-tail')}>。</span>
          </h3>
          <div className={k('mo-listcard-hero-meta')}>
            <span>{head?.byline || '匿名'}</span>
            <span className={k('mo-listcard-hero-meta-dot')}>·</span>
            <span>{dateMono}</span>
          </div>
        </div>
      ) : null}
      <div className={k('mo-listcard-content')}>
        <div className={k('mo-listcard-toprow')}>
          <span className={k('mo-listcard-tag')}>EXCLUSIVE</span>
          <span className={k('mo-listcard-date')}>{dateMono}</span>
        </div>
        <div className={k('mo-listcard-title')}>{entry.metadata.masthead}</div>
        <p className={k('mo-listcard-excerpt')}>{excerpt(head?.body ?? '', 78)}</p>
        <div className={k('mo-listcard-bottomrow')}>
          <span className={k('mo-listcard-byline')}>{head?.byline || '匿名'}</span>
          <span className={k('mo-listcard-secs')}>{entry.metadata.sections.length} 板块 →</span>
        </div>
      </div>
    </button>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   Shared list shell — header + actions + cards, themed by era container class.
───────────────────────────────────────────────────────────────────────────── */

type EraVariant = {
  listClass: string;
  headClass: string;
  ruleTopClass?: string;
  ruleBotClass?: string;
  titleClass: string;
  subtitleClass: string;
  actionPrimaryClass: string;
  actionGhostClass: string;
  cardsClass: string;
  primaryLabel: (generating: boolean) => string;
  ghostLabel: (showIntent: boolean) => string;
  primaryDecoration?: 'or' | 'mo' | 'we';
  subtitleText: string;
};

const ERA_VARIANTS: Record<NewsEraId, EraVariant> = {
  oriental_classical: {
    listClass: 'or-list',
    headClass: 'or-list-head',
    ruleTopClass: 'or-list-rule-thick',
    ruleBotClass: 'or-list-rule-thin',
    titleClass: 'or-list-title',
    subtitleClass: 'or-list-subtitle',
    actionPrimaryClass: 'or-action-primary',
    actionGhostClass: 'or-action-ghost',
    cardsClass: 'or-list-cards',
    primaryLabel: (g) => (g ? '正在排版本期…' : '生 成 今 日 报 纸'),
    ghostLabel: (s) => (s ? '收起批注' : '加一句 批注'),
    primaryDecoration: 'or',
    subtitleText: '第三方报刊视角 · 民国闲笔体 · 每期 二至四 板',
  },
  western_fantasy: {
    listClass: 'we-list',
    headClass: 'we-list-head',
    ruleBotClass: 'we-list-rule',
    titleClass: 'we-list-title',
    subtitleClass: 'we-list-subtitle',
    actionPrimaryClass: 'we-action-primary',
    actionGhostClass: 'we-action-ghost',
    cardsClass: 'we-list-cards',
    primaryLabel: (g) => (g ? 'Composing…' : 'Issue a New Edition'),
    ghostLabel: (s) => (s ? 'Retract Note' : '致编者 附注'),
    primaryDecoration: 'we',
    subtitleText: '译文体 · 早期欧洲八卦小报 · 每期 二至四 板',
  },
  modern_or_future: {
    listClass: 'mo-list',
    headClass: 'mo-list-head',
    titleClass: 'mo-list-title',
    subtitleClass: 'mo-list-subtitle',
    actionPrimaryClass: 'mo-action-primary',
    actionGhostClass: 'mo-action-ghost',
    cardsClass: 'mo-list-cards',
    primaryLabel: (g) => (g ? '正在排版本期…' : '生成今日报纸'),
    ghostLabel: (s) => (s ? '收起提示' : '加一句提示'),
    primaryDecoration: 'mo',
    subtitleText: '第三方狗仔视角 · 每期 2-4 板块 · 凌晨3点不打烊',
  },
};

/* ─────────────────────────────────────────────────────────────────────────────
   Main component
───────────────────────────────────────────────────────────────────────────── */

export function PhoneNewsApp({ ownerAgent, ownerProfile, displayName, onBack }: PhoneNewsAppProps) {
  const ownerAgentId = ownerAgent?.id ?? '';
  const [entries, setEntries] = useState<NewsEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [commenting, setCommenting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [userIntent, setUserIntent] = useState('');
  const [showIntentBox, setShowIntentBox] = useState(false);
  // 心跳 agent 提议的「待确认报纸意图草稿」——确认时才跑生成。
  const [drafts, setDrafts] = useState<XingyePendingNewsDraft[]>([]);
  const [draftBusyId, setDraftBusyId] = useState<string | null>(null);

  /* ── 往期新闻面板状态 ─────────────────────────────────────────────────
   * 流程：closed → input（填天数/期数）→ review（看时间线、决定补全 / 手动加 / 一键生成）
   *
   * 时间线**不持久化**——每次打开「整理往期」都重跑 extractWorldTimelineFromLore。
   * 用户选择：lore 更新后下次进来会自动跟上。
   */
  type HistoryStep = 'closed' | 'input' | 'review';
  const [historyStep, setHistoryStep] = useState<HistoryStep>('closed');
  const [historyDaysBack, setHistoryDaysBack] = useState(30);
  const [historyIssueCount, setHistoryIssueCount] = useState(3);
  const [timeline, setTimeline] = useState<WorldTimelineEvent[]>([]);
  const [timelineBusy, setTimelineBusy] = useState<'idle' | 'extracting' | 'expanding' | 'generating'>('idle');
  const [historyError, setHistoryError] = useState<string | null>(null);
  // 「一键生成往期」时显示进度：「正在生成第 X / N 期…」
  const [historyProgress, setHistoryProgress] = useState<{ done: number; total: number } | null>(null);
  // 手动添加表单内联展开标志 + 表单字段
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDateLabel, setManualDateLabel] = useState('');
  const [manualTitle, setManualTitle] = useState('');
  const [manualSummary, setManualSummary] = useState('');
  const [manualScope, setManualScope] = useState<WorldTimelineScope>('region');
  /**
   * 「去和 TA 聊聊」点击后短暂显示确认文案的 entry id；4s 自动消失。
   * 与秘密空间草稿箱保持一致：不导航，引用走 stagedChatQuote 暂存槽，
   * 进入任意聊天时由 InputArea 挂载 useEffect 兑换。
   */
  const [sharedToChatId, setSharedToChatId] = useState<string | null>(null);

  const agentDisplayName = ownerProfile?.displayName?.trim() || ownerAgent?.name || displayName || 'TA';

  // 「外壳 era」：决定列表头部、列表 actions、空态、外层背景色用哪套主题。
  // **故意只看 profile**——与生成侧 xingye-news-ai.ts 的输入一致，所以同一个
  // agent 在生成端会算出同一个 era，UI 与生成不会再错位。
  //
  // 单期报纸的实际渲染走 detail/listcard 里的 `entry.metadata.era` 优先，
  // 这里只是 fallback 给「旧数据没存 era 的那几期」+ 列表外壳。
  const shellEra: NewsEraId = useMemo(() => {
    if (!ownerAgent) return 'modern_or_future';
    return resolveNewsEra(buildNewsEraAgentLike(ownerAgent, ownerProfile ?? null)).era;
  }, [ownerAgent, ownerProfile]);

  const variant = ERA_VARIANTS[shellEra];

  // 单期 era：metadata.era 优先；旧数据缺字段时 fallback 到外壳 era。
  // 这两条路径**永远**只看 profile，避免被 recent chat / keyword lore 污染。
  const eraOf = (entry: NewsEntry): NewsEraId => entry.metadata.era ?? shellEra;

  const reload = useCallback(async () => {
    if (!ownerAgentId) {
      setEntries([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const [rows, draftRows] = await Promise.all([
        listAppEntries(ownerAgentId, NEWS_APP_ID),
        listNewsDrafts(ownerAgentId),
      ]);
      const normalized = rows
        .map(normalizeNewsEntry)
        .filter((e): e is NewsEntry => Boolean(e))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setEntries(normalized);
      setDrafts(draftRows);
    } catch (err) {
      setMessage(`加载失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }, [ownerAgentId]);

  useEffect(() => {
    setSelectedId(null);
    setUserIntent('');
    setShowIntentBox(false);
    void reload();
  }, [ownerAgentId, reload]);

  const selected = useMemo(
    () => entries.find((e) => e.id === selectedId) ?? null,
    [entries, selectedId],
  );

  const handleGenerate = async () => {
    if (!ownerAgent || generating) return;
    setGenerating(true);
    setMessage(null);
    try {
      const issueDateIso = new Date().toISOString();
      const meta = await generateNewsDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: userIntent.trim() || undefined,
        issueDateIso,
      });
      const content = flattenNewsMetadataToContent(meta);
      const entry = await appendAppEntry(ownerAgentId, NEWS_APP_ID, {
        title: meta.masthead,
        content,
        source: 'user_generated',
        metadata: meta as unknown as Record<string, unknown>,
      });
      const normalized = normalizeNewsEntry(entry);
      if (normalized) {
        setEntries((prev) => [normalized, ...prev.filter((e) => e.id !== normalized.id)]);
        setSelectedId(normalized.id);
      }
      setUserIntent('');
      setShowIntentBox(false);
    } catch (err) {
      setMessage(`生成失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
    }
  };

  /**
   * 确认一条「待确认报纸草稿」：用草稿 angle 作为 userIntent 现跑 generateNewsDraftWithAI，
   * 生成整期报纸后调 confirmNewsDraftWithEntry 幂等落地 + 删草稿 + 发 news.draft_confirmed。
   */
  const handleConfirmNewsDraft = async (draft: XingyePendingNewsDraft) => {
    if (!ownerAgent || draftBusyId) return;
    setDraftBusyId(draft.id);
    setMessage(null);
    try {
      const meta = await generateNewsDraftWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        userIntent: draft.angle || undefined,
        issueDateIso: new Date().toISOString(),
      });
      const entry = await confirmNewsDraftWithEntry(ownerAgentId, draft.id, meta);
      const normalized = normalizeNewsEntry(entry);
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
      if (normalized) {
        setEntries((prev) => [normalized, ...prev.filter((e) => e.id !== normalized.id)]);
        setSelectedId(normalized.id);
      } else {
        await reload();
      }
    } catch (err) {
      setMessage(`确认出版失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDraftBusyId(null);
    }
  };

  const handleDiscardNewsDraft = async (draft: XingyePendingNewsDraft) => {
    if (!ownerAgentId || draftBusyId) return;
    setDraftBusyId(draft.id);
    try {
      await discardNewsDraft(ownerAgentId, draft.id);
      setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
    } catch (err) {
      setMessage(`丢弃草稿失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDraftBusyId(null);
    }
  };

  /* ── 往期新闻：handlers ───────────────────────────────────────────── */

  const closeHistoryPanel = () => {
    setHistoryStep('closed');
    setTimeline([]);
    setHistoryError(null);
    setHistoryProgress(null);
    setManualOpen(false);
    setManualDateLabel('');
    setManualTitle('');
    setManualSummary('');
    setManualScope('region');
    setTimelineBusy('idle');
  };

  const handleOpenHistoryPanel = () => {
    if (!ownerAgent) return;
    setHistoryStep('input');
    setHistoryError(null);
    setTimeline([]);
    setManualOpen(false);
    setHistoryProgress(null);
  };

  /**
   * 「整理时间线」——从 lore 现整理，按 issueCount × 3 作为目标条数。
   * 失败时停留在 input 步骤，error 显示出来；成功就跳到 review。
   */
  const handleExtractTimeline = async () => {
    if (!ownerAgent || timelineBusy !== 'idle') return;
    const issueCount = Math.max(1, Math.floor(historyIssueCount));
    const targetCount = issueCount * TIMELINE_EVENTS_PER_ISSUE_TARGET;
    setTimelineBusy('extracting');
    setHistoryError(null);
    try {
      const events = await extractWorldTimelineFromLore({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        requestedCount: targetCount,
      });
      setTimeline(events);
      setHistoryStep('review');
    } catch (err) {
      setHistoryError(`整理时间线失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTimelineBusy('idle');
    }
  };

  /**
   * 「AI 补全」——按缺口让模型再补 N 条；新增事件 append 到现有列表后面。
   */
  const handleAiExpandTimeline = async () => {
    if (!ownerAgent || timelineBusy !== 'idle') return;
    const shortfall = computeTimelineShortfall(timeline.length, historyIssueCount);
    if (shortfall <= 0) return;
    setTimelineBusy('expanding');
    setHistoryError(null);
    try {
      const extra = await expandTimelineWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        existing: timeline,
        neededExtra: shortfall,
      });
      if (extra.length === 0) {
        setHistoryError('AI 没有返回新增事件——可能是 lore 素材已经被穷尽。可以手动添加几条。');
      } else {
        setTimeline((prev) => [...prev, ...extra]);
      }
    } catch (err) {
      setHistoryError(`AI 补全失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTimelineBusy('idle');
    }
  };

  const handleManualAddTimeline = () => {
    const dateLabel = manualDateLabel.trim().slice(0, 32);
    const title = manualTitle.trim().slice(0, 24);
    const summary = manualSummary.trim().slice(0, 80);
    if (!dateLabel || !title || !summary) {
      setHistoryError('日期 / 标题 / 概述三项都需要填写。');
      return;
    }
    const id = `te_manual_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    setTimeline((prev) => [
      ...prev,
      { id, dateLabel, title, summary, scope: manualScope },
    ]);
    setManualDateLabel('');
    setManualTitle('');
    setManualSummary('');
    setManualScope('region');
    setManualOpen(false);
    setHistoryError(null);
  };

  const handleRemoveTimelineEvent = (id: string) => {
    setTimeline((prev) => prev.filter((e) => e.id !== id));
  };

  /**
   * 内联编辑：保存对某条事件的字段修改。
   * patch 里只放需要改的字段，其它保留原值；空字符串视为「没填」回退到原值。
   * 字段长度上限与 normalize 一致（dateLabel 32 / title 24 / summary 80）。
   */
  const handleUpdateTimelineEvent = (id: string, patch: Partial<Omit<WorldTimelineEvent, 'id'>>) => {
    setTimeline((prev) => prev.map((e) => {
      if (e.id !== id) return e;
      const dateLabel = patch.dateLabel != null ? patch.dateLabel.trim().slice(0, 32) : e.dateLabel;
      const title = patch.title != null ? patch.title.trim().slice(0, 24) : e.title;
      const summary = patch.summary != null ? patch.summary.trim().slice(0, 80) : e.summary;
      const scope = patch.scope ?? e.scope;
      // 三个文本字段都不能空——空就回退到原值，避免误清空。
      return {
        ...e,
        dateLabel: dateLabel || e.dateLabel,
        title: title || e.title,
        summary: summary || e.summary,
        scope,
      };
    }));
  };

  /**
   * 「一键生成往期新闻」——把时间线切成 N 期，按时间从远到近顺序生成。
   *
   * 顺序生成（不并发）：每期一个请求；服务器有 timeout 上限，
   * 并发会增加 503 / 限流风险，对用户体验也没好处（反正都要等到全部完成才能用）。
   *
   * 失败时停在已生成的部分——已落地的几期不会回滚，error 文案带"已生成 X / N"。
   */
  const handleGenerateHistoricalIssues = async () => {
    if (!ownerAgent || timelineBusy !== 'idle') return;
    const issueCount = Math.max(1, Math.floor(historyIssueCount));
    const daysBack = Math.max(1, Math.floor(historyDaysBack));
    if (timeline.length === 0) {
      setHistoryError('时间线是空的——请先整理或手动添加事件。');
      return;
    }
    const partitions = partitionTimelineForIssues(timeline, issueCount);
    const issueDates = computeIssueDatesForBackfill(daysBack, issueCount);
    setTimelineBusy('generating');
    setHistoryError(null);
    setHistoryProgress({ done: 0, total: issueCount });
    let succeeded = 0;
    try {
      for (let i = 0; i < issueCount; i += 1) {
        const seed = partitions[i];
        // 极端情况：某一期没分到事件（issueCount > events.length）—— 跳过该期。
        if (!seed || seed.length === 0) {
          setHistoryProgress({ done: i + 1, total: issueCount });
          continue;
        }
        const issueDateIso = issueDates[i];
        const meta = await generateHistoricalNewsDraftWithAI({
          agent: ownerAgent,
          ownerProfile: ownerProfile ?? null,
          issueDateIso,
          timelineSeed: seed,
        });
        const content = flattenNewsMetadataToContent(meta);
        const entry = await appendAppEntry(ownerAgentId, NEWS_APP_ID, {
          title: meta.masthead,
          content,
          source: 'user_generated',
          metadata: meta as unknown as Record<string, unknown>,
        });
        const normalized = normalizeNewsEntry(entry);
        if (normalized) {
          setEntries((prev) => [normalized, ...prev.filter((e) => e.id !== normalized.id)]);
        }
        succeeded += 1;
        setHistoryProgress({ done: i + 1, total: issueCount });
      }
      // 全部完成 → 关掉面板，列表自动按 createdAt 倒序，新生成的会排到前面。
      closeHistoryPanel();
    } catch (err) {
      setHistoryError(
        `生成往期报纸失败（已成功 ${succeeded} / ${issueCount} 期）：${err instanceof Error ? err.message : String(err)}`,
      );
      setTimelineBusy('idle');
      setHistoryProgress(null);
    }
  };

  /**
   * 把一份新 metadata（增/删 comment 后的结果）持久化到 entry，并更新本地 state。
   * 这里复用 updateAppEntry——会写 metadata + 同步刷新 content（flatten 后的纯文本）。
   */
  const persistEntryMeta = useCallback(
    async (entry: NewsEntry, nextMeta: NewsEntryMetadata) => {
      const content = flattenNewsMetadataToContent(nextMeta);
      const updated = await updateAppEntry(ownerAgentId, NEWS_APP_ID, entry.id, {
        title: nextMeta.masthead,
        content,
        metadata: nextMeta as unknown as Record<string, unknown>,
      });
      const normalized = updated ? normalizeNewsEntry(updated) : null;
      if (normalized) {
        setEntries((prev) => prev.map((e) => (e.id === normalized.id ? normalized : e)));
      }
    },
    [ownerAgentId],
  );

  useEffect(() => {
    if (!sharedToChatId) return undefined;
    const timer = setTimeout(() => setSharedToChatId(null), 4000);
    return () => clearTimeout(timer);
  }, [sharedToChatId]);

  const handleShareNewsToChat = useCallback(
    (entry: NewsEntry) => {
      const text = buildNewsShareText(entry.metadata);
      if (!text) return;
      useStore.getState().stageChatQuote({
        text,
        sourceTitle: `${agentDisplayName} 的小报 · ${formatIssueDate(entry.metadata.issueDate)}`,
        sourceKind: 'news',
        charCount: text.length,
        updatedAt: Date.now(),
      });
      setSharedToChatId(entry.id);
    },
    [agentDisplayName],
  );

  const handleGenerateComment = async (entry: NewsEntry) => {
    if (!ownerAgent || commenting) return;
    const existing = entry.metadata.comments ?? [];
    if (existing.length >= NEWS_COMMENTS_MAX) {
      setMessage(`这期已经积了 ${NEWS_COMMENTS_MAX} 条批注，先删一条再继续。`);
      return;
    }
    setCommenting(true);
    setMessage(null);
    try {
      const comment = await generateNewsCommentWithAI({
        agent: ownerAgent,
        ownerProfile: ownerProfile ?? null,
        meta: entry.metadata,
        existingComments: existing,
      });
      const nextMeta: NewsEntryMetadata = {
        ...entry.metadata,
        comments: [...existing, comment],
      };
      await persistEntryMeta(entry, nextMeta);
    } catch (err) {
      setMessage(`生成批注失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCommenting(false);
    }
  };

  const handleDeleteComment = async (entry: NewsEntry, commentId: string) => {
    if (!ownerAgentId) return;
    const existing = entry.metadata.comments ?? [];
    const next = existing.filter((c) => c.id !== commentId);
    if (next.length === existing.length) return;
    const nextMeta: NewsEntryMetadata = { ...entry.metadata };
    if (next.length) nextMeta.comments = next;
    else delete nextMeta.comments;
    try {
      await persistEntryMeta(entry, nextMeta);
    } catch (err) {
      setMessage(`删除批注失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDelete = async (entry: NewsEntry) => {
    if (!ownerAgentId) return;
    if (!window.confirm(`确定删除这期《${entry.metadata.masthead}》？`)) return;
    try {
      const ok = await deleteAppEntry(ownerAgentId, NEWS_APP_ID, entry.id);
      if (ok) {
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
        if (selectedId === entry.id) setSelectedId(null);
      } else {
        await reload();
      }
    } catch (err) {
      setMessage(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  if (!ownerAgentId) {
    return (
      <div className={shell.phoneShell} aria-label="报纸">
        <div className={shell.phoneStatusBar}>
          <button type="button" className={shell.phoneBackButton} onClick={onBack}>返回首页</button>
          <span>报纸</span>
        </div>
        <div className={shell.phoneBody}>
          <section className={shell.phoneAppCard}>
            <h3 className={shell.phoneAppTitle}>报纸不可用</h3>
            <p className={shell.phoneAppHint}>请选择有效角色后再打开报纸。</p>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={shell.phoneShell} aria-label="报纸">
      <div className={shell.phoneStatusBar}>
        {selected ? (
          <button type="button" className={shell.phoneBackButton} onClick={() => setSelectedId(null)}>返回列表</button>
        ) : (
          <button type="button" className={shell.phoneBackButton} onClick={onBack}>返回首页</button>
        )}
        <span>报纸</span>
      </div>

      <div className={shell.phoneBody}>
        {selected ? (
          <>
            {message ? (
              <p className={cx('notice', 'notice-error')} role="alert">{message}</p>
            ) : null}
            <DetailRenderer
              era={eraOf(selected)}
              meta={selected.metadata}
              commentsByKind={groupCommentsByKind(selected.metadata.comments)}
              agentName={agentDisplayName}
              onDeleteComment={(id) => { void handleDeleteComment(selected, id); }}
            />
            <div className={k('news-comment-actions')}>
              <button
                type="button"
                className={k('news-comment-action-button')}
                onClick={() => { void handleGenerateComment(selected); }}
                disabled={commenting || (selected.metadata.comments?.length ?? 0) >= NEWS_COMMENTS_MAX}
                data-testid="phone-news-generate-comment"
                title={`让 ${agentDisplayName} 对一段话写一句批注`}
              >
                {commenting
                  ? `${agentDisplayName} 正在批注…`
                  : (selected.metadata.comments?.length ?? 0) >= NEWS_COMMENTS_MAX
                    ? `已达上限 (${NEWS_COMMENTS_MAX})`
                    : `让 ${agentDisplayName} 批注一句`}
              </button>
              <button
                type="button"
                className={k('news-comment-action-button')}
                onClick={() => handleShareNewsToChat(selected)}
                data-testid="phone-news-share-to-chat"
                title={`把这期带到和 ${agentDisplayName} 的聊天里`}
              >
                去和 {agentDisplayName} 聊聊这期
              </button>
            </div>
            {sharedToChatId === selected.id ? (
              <p
                className={k('notice')}
                role="status"
                data-testid="phone-news-share-to-chat-notice"
              >
                已放进聊天输入框引用 —— 打开任意对话即可发出
              </p>
            ) : null}
            <div className={k('delete-row')}>
              <button
                type="button"
                className={k('delete-button')}
                onClick={() => handleDelete(selected)}
              >
                删除本期
              </button>
            </div>
          </>
        ) : (
          <section className={k(variant.listClass)} aria-label="报纸列表">
            <header className={k(variant.headClass)}>
              {variant.ruleTopClass ? <div className={k(variant.ruleTopClass)} /> : null}
              {shellEra === 'modern_or_future' ? (
                <div className={k('mo-list-bar')}>
                  <span className={k('mo-list-bar-dot')}>●</span>
                  <span>NEWS · 夜城频段</span>
                </div>
              ) : null}
              {shellEra === 'western_fantasy' ? <div className={k('we-list-fleurontop')}>❦</div> : null}
              <h2 className={k(variant.titleClass)}>
                {shellEra === 'western_fantasy'
                  ? `A Chronicle of ${displayName || ownerAgent?.name || 'a Heart'}`
                  : `${displayName || ownerAgent?.name || 'TA'} 的小报`}
              </h2>
              <p className={k(variant.subtitleClass)}>{variant.subtitleText}</p>
              {variant.ruleBotClass ? <div className={k(variant.ruleBotClass)} /> : null}
            </header>

            {message ? (
              <p className={cx('notice', 'notice-error')} role="alert">{message}</p>
            ) : null}

            {showIntentBox ? (
              <label className={k('intent-field')}>
                <span>今天想读什么（可空，给模型一句话提示）</span>
                <input
                  type="text"
                  value={userIntent}
                  onChange={(e) => setUserIntent(e.target.value)}
                  placeholder="例：写一期偏向都市夜生活的、感情专栏可以更暧昧一点"
                  disabled={generating}
                  data-testid="phone-news-intent-input"
                />
              </label>
            ) : null}

            <div className={shellEra === 'modern_or_future' ? k('mo-list-actions') : shellEra === 'western_fantasy' ? k('we-list-actions') : k('or-list-actions')}>
              <button
                type="button"
                className={k(variant.actionPrimaryClass)}
                onClick={() => void handleGenerate()}
                disabled={generating}
                data-testid="phone-news-generate"
              >
                {variant.primaryDecoration === 'or' ? <span className={k('or-action-mark')}>◆</span> : null}
                {variant.primaryDecoration === 'mo' ? <span className={k('mo-action-dot')}>●</span> : null}
                {variant.primaryDecoration === 'we' ? <span className={k('we-action-fl')}>❧</span> : null}
                <span>{variant.primaryLabel(generating)}</span>
              </button>
              <button
                type="button"
                className={k(variant.actionGhostClass)}
                onClick={() => setShowIntentBox((v) => !v)}
                disabled={generating}
              >
                {variant.ghostLabel(showIntentBox)}
              </button>
              <button
                type="button"
                className={k(variant.actionGhostClass)}
                onClick={handleOpenHistoryPanel}
                disabled={generating || historyStep !== 'closed'}
                data-testid="phone-news-open-history"
                title="按 agent lore 整理时间线，再一键生成几期往期报纸"
              >
                整理往期
              </button>
            </div>

            {historyStep !== 'closed' ? (
              <HistoryPanel
                step={historyStep}
                daysBack={historyDaysBack}
                issueCount={historyIssueCount}
                onDaysBackChange={setHistoryDaysBack}
                onIssueCountChange={setHistoryIssueCount}
                timeline={timeline}
                busy={timelineBusy}
                error={historyError}
                progress={historyProgress}
                manualOpen={manualOpen}
                manualDateLabel={manualDateLabel}
                manualTitle={manualTitle}
                manualSummary={manualSummary}
                manualScope={manualScope}
                onManualOpenChange={setManualOpen}
                onManualDateLabelChange={setManualDateLabel}
                onManualTitleChange={setManualTitle}
                onManualSummaryChange={setManualSummary}
                onManualScopeChange={setManualScope}
                onExtract={() => void handleExtractTimeline()}
                onAiExpand={() => void handleAiExpandTimeline()}
                onManualAdd={handleManualAddTimeline}
                onRemoveEvent={handleRemoveTimelineEvent}
                onUpdateEvent={handleUpdateTimelineEvent}
                onGenerate={() => void handleGenerateHistoricalIssues()}
                onClose={closeHistoryPanel}
              />
            ) : null}

            {drafts.length > 0 ? (
              <div
                className={k('news-drafts')}
                data-testid="phone-news-drafts"
                style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '12px 0' }}
              >
                <p style={{ fontWeight: 600, fontSize: 13, opacity: 0.8, margin: 0 }}>
                  待确认草稿 · {agentDisplayName} 想出一期报纸
                </p>
                {drafts.map((draft) => (
                  <div
                    key={draft.id}
                    data-testid={`phone-news-draft-${draft.id}`}
                    style={{
                      border: '1px dashed currentColor',
                      borderRadius: 8,
                      padding: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      opacity: 0.92,
                    }}
                  >
                    <p style={{ fontSize: 13, margin: 0 }}>
                      {draft.angle ? `角度：${draft.angle}` : '（没有特定角度，就是想出一期）'}
                    </p>
                    {draft.reason ? (
                      <p style={{ fontSize: 12, opacity: 0.7, margin: 0 }}>缘由：{draft.reason}</p>
                    ) : null}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        onClick={() => void handleConfirmNewsDraft(draft)}
                        disabled={draftBusyId !== null || generating}
                        data-testid={`phone-news-draft-confirm-${draft.id}`}
                      >
                        {draftBusyId === draft.id ? '正在排版本期…' : '确认出版'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDiscardNewsDraft(draft)}
                        disabled={draftBusyId !== null}
                        data-testid={`phone-news-draft-discard-${draft.id}`}
                      >
                        丢弃
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {loading && entries.length === 0 ? (
              <p className={k('notice')}>加载中…</p>
            ) : entries.length === 0 ? (
              <p className={k('empty')} data-testid="phone-news-empty">
                还没有任何一期。点「生成今日报纸」让模型出一期。
              </p>
            ) : (
              <div className={k(variant.cardsClass)}>
                {entries.map((entry, i) => {
                  // 每张卡片按它自己的 metadata.era 渲染（旧数据缺字段时 fallback 到外壳）。
                  // featured 只在外壳是现代时启用（外壳决定列表头部主题，模式才连贯）。
                  const cardEra = eraOf(entry);
                  return (
                    <ListCardRenderer
                      key={entry.id}
                      era={cardEra}
                      entry={entry}
                      featured={shellEra === 'modern_or_future' && cardEra === 'modern_or_future' && i === 0}
                      onClick={() => setSelectedId(entry.id)}
                    />
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function DetailRenderer({
  era,
  meta,
  commentsByKind,
  agentName,
  onDeleteComment,
}: {
  era: NewsEraId;
  meta: NewsEntryMetadata;
  commentsByKind: Map<NewsSectionKind, NewsComment[]>;
  agentName: string;
  onDeleteComment: (id: string) => void;
}) {
  if (era === 'oriental_classical') {
    return (
      <OrientalDetail
        meta={meta}
        commentsByKind={commentsByKind}
        agentName={agentName}
        onDeleteComment={onDeleteComment}
      />
    );
  }
  if (era === 'western_fantasy') {
    return (
      <WesternDetail
        meta={meta}
        commentsByKind={commentsByKind}
        agentName={agentName}
        onDeleteComment={onDeleteComment}
      />
    );
  }
  return (
    <ModernDetail
      meta={meta}
      commentsByKind={commentsByKind}
      agentName={agentName}
      onDeleteComment={onDeleteComment}
    />
  );
}

function ListCardRenderer({
  era,
  entry,
  featured,
  onClick,
}: {
  era: NewsEraId;
  entry: NewsEntry;
  featured: boolean;
  onClick: () => void;
}) {
  if (era === 'oriental_classical') return <OrientalListCard entry={entry} onClick={onClick} />;
  if (era === 'western_fantasy') return <WesternListCard entry={entry} onClick={onClick} />;
  return <ModernListCard entry={entry} onClick={onClick} featured={featured} />;
}

/* ─────────────────────────────────────────────────────────────────────────────
   往期新闻面板 —— 输入 / 时间线 review / 手动添加 / 一键生成
───────────────────────────────────────────────────────────────────────────── */

type HistoryPanelProps = {
  step: 'input' | 'review';
  daysBack: number;
  issueCount: number;
  onDaysBackChange: (n: number) => void;
  onIssueCountChange: (n: number) => void;
  timeline: WorldTimelineEvent[];
  busy: 'idle' | 'extracting' | 'expanding' | 'generating';
  error: string | null;
  progress: { done: number; total: number } | null;
  manualOpen: boolean;
  manualDateLabel: string;
  manualTitle: string;
  manualSummary: string;
  manualScope: WorldTimelineScope;
  onManualOpenChange: (v: boolean) => void;
  onManualDateLabelChange: (v: string) => void;
  onManualTitleChange: (v: string) => void;
  onManualSummaryChange: (v: string) => void;
  onManualScopeChange: (v: WorldTimelineScope) => void;
  onExtract: () => void;
  onAiExpand: () => void;
  onManualAdd: () => void;
  onRemoveEvent: (id: string) => void;
  onUpdateEvent: (id: string, patch: Partial<Omit<WorldTimelineEvent, 'id'>>) => void;
  onGenerate: () => void;
  onClose: () => void;
};

function HistoryPanel(props: HistoryPanelProps) {
  const {
    step, daysBack, issueCount, onDaysBackChange, onIssueCountChange,
    timeline, busy, error, progress,
    manualOpen, manualDateLabel, manualTitle, manualSummary, manualScope,
    onManualOpenChange, onManualDateLabelChange, onManualTitleChange,
    onManualSummaryChange, onManualScopeChange,
    onExtract, onAiExpand, onManualAdd, onRemoveEvent, onUpdateEvent, onGenerate, onClose,
  } = props;

  // 内联编辑态：editingId 非 null 时，对应那条事件用输入框渲染。
  // 编辑态草稿存在 HistoryPanel 内（UI-only state，不污染父组件 timeline）；
  // 点「保存」才同步回父组件，「取消」直接丢弃 draft。
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDateLabel, setEditDateLabel] = useState('');
  const [editTitle, setEditTitle] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [editScope, setEditScope] = useState<WorldTimelineScope>('region');

  const startEdit = (evt: WorldTimelineEvent) => {
    setEditingId(evt.id);
    setEditDateLabel(evt.dateLabel);
    setEditTitle(evt.title);
    setEditSummary(evt.summary);
    setEditScope(evt.scope);
  };
  const cancelEdit = () => {
    setEditingId(null);
  };
  const saveEdit = () => {
    if (!editingId) return;
    onUpdateEvent(editingId, {
      dateLabel: editDateLabel,
      title: editTitle,
      summary: editSummary,
      scope: editScope,
    });
    setEditingId(null);
  };

  const shortfall = computeTimelineShortfall(timeline.length, issueCount);
  const target = Math.max(1, Math.floor(issueCount)) * TIMELINE_EVENTS_PER_ISSUE_TARGET;
  const generating = busy === 'generating';
  const extracting = busy === 'extracting';
  const expanding = busy === 'expanding';
  const anyBusy = busy !== 'idle';

  return (
    <div
      data-testid="phone-news-history-panel"
      style={{
        border: '1px solid currentColor',
        borderRadius: 10,
        padding: 12,
        margin: '12px 0',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <strong style={{ fontSize: 14 }}>整理往期 · 按世界时间线还原</strong>
        <button
          type="button"
          onClick={onClose}
          disabled={generating}
          aria-label="关闭"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, opacity: 0.6 }}
        >
          ×
        </button>
      </div>

      {step === 'input' ? (
        <>
          <p style={{ fontSize: 12, opacity: 0.75, margin: 0 }}>
            按 agent 的 lore（设定库 + lore-memory.md）整理出 TA 所处世界的时间线，
            然后由你确认 / 调整后一键批量生成往期报纸。<br />
            <strong>不会涉及当下聊天 / 关系状态</strong>，也不会生成感情八卦类板块。
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ minWidth: 72 }}>最早几天前</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={daysBack}
              onChange={(e) => onDaysBackChange(Math.max(1, Math.min(3650, Number(e.target.value) || 1)))}
              disabled={anyBusy}
              data-testid="phone-news-history-days-input"
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12, opacity: 0.6 }}>天</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <span style={{ minWidth: 72 }}>生成几期</span>
            <input
              type="number"
              min={1}
              max={20}
              value={issueCount}
              onChange={(e) => onIssueCountChange(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
              disabled={anyBusy}
              data-testid="phone-news-history-count-input"
              style={{ width: 80 }}
            />
            <span style={{ fontSize: 12, opacity: 0.6 }}>期（会均匀分布在这段时间里）</span>
          </label>
          {error ? <p style={{ color: '#a4231a', fontSize: 12, margin: 0 }}>{error}</p> : null}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onExtract}
              disabled={anyBusy}
              data-testid="phone-news-history-extract"
            >
              {extracting ? '正在整理时间线…' : `整理时间线（目标 ${target} 条）`}
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, opacity: 0.75, margin: 0 }}>
            从 lore 整理出 <strong>{timeline.length}</strong> 条事件，将切成 <strong>{issueCount}</strong> 期、
            最早一期约 <strong>{daysBack}</strong> 天前。下面是事件列表——你可以删除、补全、或手动添加。
          </p>

          {shortfall > 0 ? (
            <div
              data-testid="phone-news-history-shortfall"
              style={{
                border: '1px dashed #a4231a',
                background: 'rgba(164, 35, 26, 0.06)',
                color: '#a4231a',
                borderRadius: 6,
                padding: '8px 10px',
                fontSize: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <span>
                事件数量不足：每期通常至少 {TIMELINE_EVENTS_PER_ISSUE_TARGET} 块版面（目标 {target} 条），
                还差 <strong>{shortfall}</strong> 条。
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={onAiExpand}
                  disabled={anyBusy}
                  data-testid="phone-news-history-ai-expand"
                >
                  {expanding ? `AI 正在补 ${shortfall} 条…` : `AI 按世界观补 ${shortfall} 条`}
                </button>
                <button
                  type="button"
                  onClick={() => onManualOpenChange(!manualOpen)}
                  disabled={anyBusy}
                  data-testid="phone-news-history-manual-toggle"
                >
                  {manualOpen ? '收起手动添加' : '手动添加一条'}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={() => onManualOpenChange(!manualOpen)}
                disabled={anyBusy}
                data-testid="phone-news-history-manual-toggle"
              >
                {manualOpen ? '收起手动添加' : '继续手动添加'}
              </button>
            </div>
          )}

          {manualOpen ? (
            <div
              data-testid="phone-news-history-manual-form"
              style={{
                border: '1px solid currentColor',
                borderRadius: 6,
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                fontSize: 12,
              }}
            >
              <p style={{ margin: 0, opacity: 0.7 }}>
                填写一条事件。<strong>示例</strong>——日期：「景和七年·秋」｜
                标题：「北境冰封」｜概述：「严冬封冻三月，商路断绝，灾民南下，朝廷开仓未济。」｜
                范围：地区级。
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ minWidth: 60 }}>日期</span>
                <input
                  type="text"
                  value={manualDateLabel}
                  onChange={(e) => onManualDateLabelChange(e.target.value)}
                  placeholder="景和七年·秋 / 2087-03-15 / 第三纪 217 年"
                  maxLength={32}
                  data-testid="phone-news-history-manual-date"
                  style={{ flex: 1 }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ minWidth: 60 }}>标题</span>
                <input
                  type="text"
                  value={manualTitle}
                  onChange={(e) => onManualTitleChange(e.target.value)}
                  placeholder="北境冰封 / 黑塔陨落 / 旧京失守"
                  maxLength={24}
                  data-testid="phone-news-history-manual-title"
                  style={{ flex: 1 }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ minWidth: 60, paddingTop: 4 }}>概述</span>
                <textarea
                  value={manualSummary}
                  onChange={(e) => onManualSummaryChange(e.target.value)}
                  placeholder="一句话事件经过（≤ 80 字）"
                  maxLength={80}
                  rows={2}
                  data-testid="phone-news-history-manual-summary"
                  style={{ flex: 1, resize: 'vertical' }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ minWidth: 60 }}>范围</span>
                <select
                  value={manualScope}
                  onChange={(e) => onManualScopeChange(e.target.value as WorldTimelineScope)}
                  data-testid="phone-news-history-manual-scope"
                >
                  {WORLD_TIMELINE_SCOPES.map((s) => (
                    <option key={s} value={s}>{WORLD_TIMELINE_SCOPE_LABELS[s]}</option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={onManualAdd}
                  data-testid="phone-news-history-manual-add"
                >
                  添加到时间线
                </button>
              </div>
            </div>
          ) : null}

          <div
            data-testid="phone-news-history-timeline-list"
            style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 320, overflowY: 'auto' }}
          >
            {timeline.length === 0 ? (
              <p style={{ fontSize: 12, opacity: 0.6, margin: 0 }}>
                时间线是空的。lore 里可能没有可整理的世界事件——可以手动添加或返回上一步重试。
              </p>
            ) : (
              timeline.map((evt) => {
                const isEditing = editingId === evt.id;
                return (
                  <div
                    key={evt.id}
                    data-testid={`phone-news-history-event-${evt.id}`}
                    style={{
                      border: '1px solid currentColor',
                      borderRadius: 6,
                      padding: '6px 8px',
                      fontSize: 12,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'flex-start',
                      opacity: 0.92,
                      background: isEditing ? 'rgba(164, 35, 26, 0.04)' : undefined,
                    }}
                  >
                    {isEditing ? (
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ minWidth: 36, opacity: 0.7 }}>日期</span>
                          <input
                            type="text"
                            value={editDateLabel}
                            onChange={(e) => setEditDateLabel(e.target.value)}
                            maxLength={32}
                            data-testid={`phone-news-history-event-${evt.id}-edit-date`}
                            style={{ flex: 1, fontSize: 12 }}
                          />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ minWidth: 36, opacity: 0.7 }}>标题</span>
                          <input
                            type="text"
                            value={editTitle}
                            onChange={(e) => setEditTitle(e.target.value)}
                            maxLength={24}
                            data-testid={`phone-news-history-event-${evt.id}-edit-title`}
                            style={{ flex: 1, fontSize: 12 }}
                          />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                          <span style={{ minWidth: 36, opacity: 0.7, paddingTop: 4 }}>概述</span>
                          <textarea
                            value={editSummary}
                            onChange={(e) => setEditSummary(e.target.value)}
                            maxLength={80}
                            rows={2}
                            data-testid={`phone-news-history-event-${evt.id}-edit-summary`}
                            style={{ flex: 1, fontSize: 12, resize: 'vertical' }}
                          />
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ minWidth: 36, opacity: 0.7 }}>范围</span>
                          <select
                            value={editScope}
                            onChange={(e) => setEditScope(e.target.value as WorldTimelineScope)}
                            data-testid={`phone-news-history-event-${evt.id}-edit-scope`}
                            style={{ fontSize: 12 }}
                          >
                            {WORLD_TIMELINE_SCOPES.map((s) => (
                              <option key={s} value={s}>{WORLD_TIMELINE_SCOPE_LABELS[s]}</option>
                            ))}
                          </select>
                        </label>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            type="button"
                            onClick={saveEdit}
                            data-testid={`phone-news-history-event-${evt.id}-save`}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={cancelEdit}
                            data-testid={`phone-news-history-event-${evt.id}-cancel`}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <span style={{ fontWeight: 600 }}>{evt.title}</span>
                            <span style={{ opacity: 0.7 }}>· {evt.dateLabel}</span>
                            <span
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 999,
                                border: '1px solid currentColor',
                                opacity: 0.6,
                              }}
                            >
                              {WORLD_TIMELINE_SCOPE_LABELS[evt.scope]}
                            </span>
                          </div>
                          <span style={{ opacity: 0.8 }}>{evt.summary}</span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          <button
                            type="button"
                            onClick={() => startEdit(evt)}
                            disabled={anyBusy || editingId !== null}
                            aria-label="编辑事件"
                            data-testid={`phone-news-history-event-${evt.id}-edit`}
                            title="编辑此条事件"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              opacity: 0.7,
                              fontSize: 12,
                              padding: '0 4px',
                            }}
                          >
                            改
                          </button>
                          <button
                            type="button"
                            onClick={() => onRemoveEvent(evt.id)}
                            disabled={anyBusy || editingId !== null}
                            aria-label="删除事件"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              opacity: 0.5,
                              fontSize: 14,
                              padding: '0 4px',
                            }}
                          >
                            ×
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {error ? <p style={{ color: '#a4231a', fontSize: 12, margin: 0 }}>{error}</p> : null}
          {progress ? (
            <p style={{ fontSize: 12, opacity: 0.8, margin: 0 }} data-testid="phone-news-history-progress">
              正在生成第 {progress.done} / {progress.total} 期…
            </p>
          ) : null}

          {editingId !== null ? (
            <p style={{ fontSize: 11, opacity: 0.65, margin: 0 }}>
              有一条事件正在编辑中——请先「保存」或「取消」再继续。
            </p>
          ) : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onGenerate}
              disabled={anyBusy || timeline.length === 0 || editingId !== null}
              data-testid="phone-news-history-generate"
            >
              {generating ? '正在生成往期…' : `一键生成 ${issueCount} 期往期报纸`}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={generating}
            >
              取消
            </button>
          </div>
        </>
      )}
    </div>
  );
}
