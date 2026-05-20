import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Agent } from '../types';
import shell from './XingyeShell.module.css';
import news from './PhoneNewsApp.module.css';
import {
  appendAppEntry,
  deleteAppEntry,
  listAppEntries,
  type AppEntry,
} from './xingye-app-entry-store';
import {
  flattenNewsMetadataToContent,
  normalizeNewsEntryMetadata,
  NEWS_SECTION_REGISTRY,
  type NewsEntryMetadata,
  type NewsLayoutSlot,
  type NewsSection,
} from './xingye-news-types';
import { generateNewsDraftWithAI } from './xingye-news-ai';
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

function OrientalDetail({ meta }: { meta: NewsEntryMetadata }) {
  const slots = groupBySlot(meta.sections);
  const head = slots.masthead[0];
  const hasBody = slots.left_column.length > 0 || slots.right_column.length > 0;
  const dateCn = formatIssueDateClassical(meta.issueDate);
  const d = new Date(meta.issueDate);
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][Number.isNaN(d.getTime()) ? 0 : d.getDay()];
  const twocolSingle = !(slots.left_column.length && slots.right_column.length);
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
            {head.body.slice(1)}
          </p>
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
              <p className={k('or-body')}>{s.body}</p>
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
              <p className={k('or-body')}>{s.body}</p>
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
          <div className={k('or-ad-body')}>{s.body}</div>
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
          <p className={cx('or-body', 'or-body-footer')}>{s.body}</p>
          <div className={k('or-footer-bar')} />
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

function WesternDetail({ meta }: { meta: NewsEntryMetadata }) {
  const slots = groupBySlot(meta.sections);
  const head = slots.masthead[0];
  const hasBody = slots.left_column.length > 0 || slots.right_column.length > 0;
  const twocolSingle = !(slots.left_column.length && slots.right_column.length);
  const d = new Date(meta.issueDate);
  const isValid = !Number.isNaN(d.getTime());
  const month = isValid ? WE_MONTHS[d.getMonth()] : '';
  const die = isValid ? d.getDate() : 1;
  const year = isValid ? d.getFullYear() : new Date().getFullYear();
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
            {head.body.slice(1)}
          </p>
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
              <p className={k('we-body')}>{s.body}</p>
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
              <p className={k('we-body')}>{s.body}</p>
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
            <div className={k('we-ad-body')}>{s.body}</div>
            <div className={cx('we-ad-fleuron', 'we-ad-fleuron-bottom')}>⁂</div>
          </div>
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
          <p className={cx('we-body', 'we-body-footer')}>{s.body}</p>
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

function ModernDetail({ meta }: { meta: NewsEntryMetadata }) {
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
          <p className={cx('mo-body', 'mo-body-lead')}>{headline.body}</p>
          {evidence && evidence.length ? <EvidenceTimeline items={evidence} /> : null}
        </article>
      ) : null}

      {second ? (
        <article
          className={cx('mo-stack-block', 'mo-stack-second')}
          data-slot="right_column"
          data-testid={`phone-news-section-${second.kind}`}
        >
          <ModernSectionTitle title={second.title} byline={second.byline} tag="次条" />
          <p className={k('mo-body')}>{second.body}</p>
        </article>
      ) : null}

      {gossip ? (
        <article
          className={cx('mo-stack-block', 'mo-stack-gossip')}
          data-slot="left_column"
          data-testid={`phone-news-section-${gossip.kind}`}
        >
          <ModernSectionTitle title={gossip.title} byline={gossip.byline} tag="八卦" />
          <p className={cx('mo-body', 'mo-body-gossip')}>{gossip.body}</p>
          <div className={k('mo-redacted-row')} aria-hidden="true">
            <span>消息源·</span><span className={k('mo-redacted')}>■■■■■■</span>
            <span>·频段</span><span className={k('mo-redacted')}>■■■.■■</span>
          </div>
        </article>
      ) : null}

      {review ? (
        <article
          className={k('mo-stack-block')}
          data-slot="left_column"
          data-testid={`phone-news-section-${review.kind}`}
        >
          <ModernSectionTitle title={review.title} byline={review.byline} tag="评论" />
          <p className={k('mo-body')}>{review.body}</p>
        </article>
      ) : null}

      {letters ? (
        <article
          className={k('mo-stack-block')}
          data-slot="right_column"
          data-testid={`phone-news-section-${letters.kind}`}
        >
          <ModernSectionTitle title={letters.title} byline={letters.byline} tag="读者投书" />
          <p className={k('mo-body')}>{letters.body}</p>
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
          <div className={k('mo-ad-body')}>{s.body}</div>
          <div className={k('mo-ad-stamp')}>{s.kind === 'weather' ? '☀' : '◢'}</div>
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
          <p className={cx('mo-body', 'mo-body-footer')}>{s.body}</p>
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
  const [message, setMessage] = useState<string | null>(null);
  const [userIntent, setUserIntent] = useState('');
  const [showIntentBox, setShowIntentBox] = useState(false);

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
      const rows = await listAppEntries(ownerAgentId, NEWS_APP_ID);
      const normalized = rows
        .map(normalizeNewsEntry)
        .filter((e): e is NewsEntry => Boolean(e))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      setEntries(normalized);
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
            <DetailRenderer era={eraOf(selected)} meta={selected.metadata} />
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
            </div>

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

function DetailRenderer({ era, meta }: { era: NewsEraId; meta: NewsEntryMetadata }) {
  if (era === 'oriental_classical') return <OrientalDetail meta={meta} />;
  if (era === 'western_fantasy') return <WesternDetail meta={meta} />;
  return <ModernDetail meta={meta} />;
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
