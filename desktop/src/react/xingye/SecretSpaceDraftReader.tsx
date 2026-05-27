/**
 * draft_reply 分类的详情阅读器:用「写了一半又删掉的信笺」语义取代默认 SecretSpaceRecordCard。
 *
 * 设计:
 *  - 横线笺纸 + 左侧红色装订线,模仿信纸 / 学生作业本
 *  - 顶部 2-3 条「划掉重写」的开场白(装饰性,从固定池里按 record.key hash 出来,稳定不变)
 *  - 抬头 = record.meta(原"备注"字段,通常是「给 XXX」)
 *  - 正文 = record.body,手写体落在横线上
 *  - 末尾签名/落款 = "于 YYYY/MM/DD 夜里"
 *  - 角落「未送出」橡皮印章 + 回形针 + 涂改痕迹
 *
 * 不修改 jsonl,只换视觉。所有划掉/补丁/印章都是基于 record.key 的确定性装饰,
 * 同一条记录每次打开看到的"涂改痕迹"是一样的。
 *
 * 保留 `data-testid="secret-space-record-detail-${record.key}"` 以兼容
 * SecretSpacePanel.test.tsx 里的断言。
 */

import type { SecretSpaceSampleRecord } from './secret-space-record-types';
import {
  extractDraftRevisionsFromMetadata,
  type SecretSpaceDraftPatch,
  type SecretSpaceStruckLine,
} from './secret-space-draft-revisions';
import styles from './XingyeShell.module.css';

/**
 * 装饰用「划掉的开场白」池。表达 TA 写过又删的犹豫:
 * 太矫情 / 不像我 / 假装没看见 / 改个语气 / 算了……
 * 选 2-3 条出来按 hash 顺序排在正文上方,模拟 TA 涂了几行才落笔。
 */
const STRUCK_OPENERS: string[] = [
  '算了,这样太矫情了',
  '不发了,你又要笑我',
  '删了重写',
  '改成「在吗?」?',
  '其实……',
  '怎么开口才不奇怪',
  '当我没说',
  '等下次见面再当面讲',
  '不,这话不该我先说',
  '改个口气',
];

/**
 * 装饰用「夹在中间的小补丁」:像作者写到一半被自己叫停,改写的痕迹。
 * 选 1 条出来塞在正文中段(分段之后)。
 */
const STRUCK_PATCHES: string[] = [
  '←这里改了三遍',
  '这句话其实想了很久',
  '又删了',
  '到底要不要写这一段',
];

/** 装饰用边角小批注(竖排在右侧空白)。 */
const MARGIN_SCRIBBLES: string[] = [
  '……',
  '?',
  '???',
  '不知道',
  '别发',
];

/** record.key → 稳定的 0..N hash,避免每次重渲染装饰位置都变。 */
function hashIndex(key: string, mod: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return mod > 0 ? h % mod : 0;
}

/** 从池里挑 count 个不重复元素,按 record.key 决定起点。 */
function pickStable<T>(pool: T[], count: number, key: string, offset = 0): T[] {
  if (pool.length === 0 || count <= 0) return [];
  const start = (hashIndex(key, pool.length) + offset) % pool.length;
  const out: T[] = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    out.push(pool[(start + i) % pool.length]);
  }
  return out;
}

function formatLetterDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const hour = d.getHours();
    const period =
      hour >= 22 || hour < 5
        ? '深夜'
        : hour >= 18
        ? '夜里'
        : hour >= 12
        ? '午后'
        : hour >= 6
        ? '清晨'
        : '凌晨';
    return `${y} 年 ${m} 月 ${day} 日 · ${period}`;
  } catch {
    return iso;
  }
}

export interface SecretSpaceDraftReaderProps {
  record: SecretSpaceSampleRecord;
}

export function SecretSpaceDraftReader({ record }: SecretSpaceDraftReaderProps) {
  const recipient = (record.meta || '').trim();
  const body = (record.body || record.summary || '').trim();
  const paragraphs = body ? body.split(/\n{2,}/) : [];
  const dateLabel = formatLetterDate(record.createdAt);

  /**
   * 优先用 record.metadata.draftRevisions(LLM / heartbeat 给的角色化涂改痕迹);
   * 缺失或解析失败时回退到 record.key hash 出来的装饰池(老数据/手动追加)。
   *
   * 真数据的 struck/patches 每条带可选 reason —— 这是 TA 自己内心活动,
   * 渲染时作为 title (悬停提示) + 旁边小字呈现。
   */
  const revisions = extractDraftRevisionsFromMetadata(record.metadata);

  const realStruck: SecretSpaceStruckLine[] | null = revisions?.struck?.length ? revisions.struck : null;
  const realPatches: SecretSpaceDraftPatch[] | null = revisions?.patches?.length ? revisions.patches : null;
  const realMarginNotes: string[] | null = revisions?.marginNotes?.length ? revisions.marginNotes : null;

  /** 装饰兜底(只在对应真数据缺失时使用)。 */
  const fallbackOpeners = realStruck
    ? null
    : pickStable(STRUCK_OPENERS, 2 + hashIndex(record.key, 2), record.key);
  const fallbackPatch = realPatches ? null : pickStable(STRUCK_PATCHES, 1, record.key, 3)[0];
  const fallbackScribble = realMarginNotes
    ? null
    : pickStable(MARGIN_SCRIBBLES, 1, record.key, 5)[0];

  /** patches 按 afterParagraphIndex 分组,落到对应段后;越界 clamp 到末尾。 */
  const patchesByIndex = new Map<number, SecretSpaceDraftPatch[]>();
  if (realPatches) {
    const lastIdx = Math.max(0, paragraphs.length - 1);
    for (const p of realPatches) {
      const idx = Math.min(p.afterParagraphIndex, lastIdx);
      const bucket = patchesByIndex.get(idx);
      if (bucket) bucket.push(p);
      else patchesByIndex.set(idx, [p]);
    }
  }

  const renderRealPatch = (p: SecretSpaceDraftPatch, key: string) => (
    <div
      key={key}
      className={styles.draftLetterPatch}
      title={p.reason || undefined}
      data-testid={`draft-letter-patch-${key}`}
    >
      <span className={styles.draftLetterPatchArrow}>↑</span>
      <span>{p.text}</span>
      {p.reason ? <em className={styles.draftLetterPatchReason}>· {p.reason}</em> : null}
    </div>
  );

  const renderBody = () => {
    if (paragraphs.length === 0) {
      return (
        <p className={styles.draftLetterParagraph} data-empty="true">
          ……
        </p>
      );
    }
    return paragraphs.map((p, idx) => {
      const realsHere = patchesByIndex.get(idx) ?? [];
      const useFallbackPatch = !realPatches && idx === 0 && paragraphs.length > 1 && fallbackPatch;
      return (
        <div key={idx}>
          <p className={styles.draftLetterParagraph}>{p}</p>
          {realsHere.map((rp, i) => renderRealPatch(rp, `${idx}-${i}`))}
          {useFallbackPatch ? (
            <div className={styles.draftLetterPatch} aria-hidden>
              <span className={styles.draftLetterPatchArrow}>↑</span>
              <span>{fallbackPatch}</span>
            </div>
          ) : null}
        </div>
      );
    });
  };

  return (
    <article
      className={styles.secretSpaceDraftReader}
      data-testid={`secret-space-record-detail-${record.key}`}
    >
      {/* 左上回形针 */}
      <span aria-hidden className={styles.draftLetterPaperclip} />

      {/* 右上"未送出"印章 */}
      <span aria-hidden className={styles.draftLetterStamp}>
        未 · 送 · 出
      </span>

      <div className={styles.draftLetterPaper}>
        {/* 顶部:划掉的开场白 — 优先用 metadata.draftRevisions.struck,
            带 reason 时 title 给悬停 + reason 紧跟在划掉行后做小字 */}
        {realStruck ? (
          <div
            className={styles.draftLetterStruckLines}
            data-testid="draft-letter-struck-real"
          >
            {realStruck.map((line, idx) => (
              <span
                key={idx}
                className={styles.draftLetterStruckLine}
                data-index={idx}
                title={line.reason || undefined}
              >
                {line.text}
                {line.reason ? (
                  <em className={styles.draftLetterStruckReason}>—— {line.reason}</em>
                ) : null}
              </span>
            ))}
          </div>
        ) : fallbackOpeners && fallbackOpeners.length ? (
          <div className={styles.draftLetterStruckLines} aria-hidden>
            {fallbackOpeners.map((line, idx) => (
              <span key={idx} className={styles.draftLetterStruckLine} data-index={idx}>
                {line}
              </span>
            ))}
          </div>
        ) : null}

        {/* 抬头 */}
        {recipient ? (
          <div className={styles.draftLetterSalutation}>
            <span>{recipient}</span>
            <span className={styles.draftLetterSalutationComma}>,</span>
          </div>
        ) : null}

        {/* 标题作为隐性副标(很多时候和正文头部重复,做小一号、灰一些) */}
        {record.title && record.title !== body ? (
          <p className={styles.draftLetterSubject}>
            <span className={styles.draftLetterSubjectLabel}>关于</span>
            {record.title}
          </p>
        ) : null}

        {/* 正文 */}
        <div className={styles.draftLetterBody}>{renderBody()}</div>

        {/* 落款 */}
        <div className={styles.draftLetterFooter}>
          <span className={styles.draftLetterSignDots}>……</span>
          <span className={styles.draftLetterSignAction}>
            <s>点发送</s> <em>← 终究还是没点</em>
          </span>
          <span className={styles.draftLetterSignDate}>{dateLabel}</span>
        </div>
      </div>

      {/* 右侧空白处的边角批注(竖排);真数据可有 1–3 条 */}
      {realMarginNotes ? (
        <div className={styles.draftLetterMarginNotes} data-testid="draft-letter-margin-real">
          {realMarginNotes.map((note, idx) => (
            <span key={idx} className={styles.draftLetterMarginNote} data-index={idx}>
              {note}
            </span>
          ))}
        </div>
      ) : fallbackScribble ? (
        <span aria-hidden className={styles.draftLetterMarginNote}>
          {fallbackScribble}
        </span>
      ) : null}

      {/* 右下橡皮擦痕(纯装饰) */}
      <span aria-hidden className={styles.draftLetterSmudge} />

      {/* 隐式来源/时间:小到角落,不抢主视觉 */}
      <div className={styles.draftLetterFootnote}>
        {record.source ? <span>来源 · {record.source}</span> : null}
        <span>创建 · {new Date(record.createdAt).toLocaleString()}</span>
      </div>
    </article>
  );
}
