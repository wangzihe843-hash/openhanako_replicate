import type { ReactNode } from 'react';
import styles from './XingyeShell.module.css';

export type SecretSpaceCategoryId =
  | 'state'
  | 'draft_reply'
  | 'dream'
  | 'saved_item'
  | 'unsent_moment'
  | 'memory_fragment';

type ToneKey = 'state' | 'draft' | 'dream' | 'saved' | 'moment' | 'memory';

interface DrawerEntry {
  id: SecretSpaceCategoryId;
  label: string;
  /** monospace 副标，形如 "state · 此刻 / 心情" */
  hint: string;
  tone: ToneKey;
  /** 抽屉正面的"内容偷看" —— SVG 或迷你内容卡 */
  peek: ReactNode;
}

const TONE_CLASS_MAP: Record<ToneKey, string> = {
  state: 'secretSpaceHomeCard_state',
  draft: 'secretSpaceHomeCard_draft',
  dream: 'secretSpaceHomeCard_dream',
  saved: 'secretSpaceHomeCard_saved',
  moment: 'secretSpaceHomeCard_moment',
  memory: 'secretSpaceHomeCard_memory',
};

function StatePeek() {
  return (
    <div className={styles.secretSpaceHomePeek_state}>
      <svg viewBox="0 0 100 100" aria-hidden focusable="false">
        <path
          fill="#e58e8e"
          d="M50 82 L18 50 a18 18 0 1 1 32-22 a18 18 0 1 1 32 22 z"
        />
        <path fill="#fff" opacity="0.5" d="M40 38 a8 8 0 0 1 8-8" stroke="none" />
      </svg>
      <div className={styles.secretSpaceHomePeekCaption_state}>「想着你」</div>
    </div>
  );
}

function DraftPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_draft}>
      <span>
        其实那天<br />我也很想说……<br />
        <span className={styles.secretSpaceHomePeekFade}>（写到一半的话）</span>
      </span>
      <span aria-hidden className={styles.secretSpaceHomePeekCurl} />
    </div>
  );
}

function DreamPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_dream}>
      <svg viewBox="0 0 100 100" aria-hidden focusable="false">
        <defs>
          <radialGradient id="xingye-ink-a" cx="0.35" cy="0.4" r="0.5">
            <stop offset="0%" stopColor="#000" stopOpacity="0.7" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="xingye-ink-b" cx="0.7" cy="0.65" r="0.4">
            <stop offset="0%" stopColor="#0a0d1a" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#0a0d1a" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="38" cy="46" rx="28" ry="22" fill="url(#xingye-ink-a)" />
        <ellipse cx="68" cy="62" rx="20" ry="14" fill="url(#xingye-ink-b)" />
        <circle cx="78" cy="22" r="2" fill="#fff" opacity="0.7" />
        <circle cx="22" cy="20" r="1.5" fill="#fff" opacity="0.5" />
        <circle cx="86" cy="40" r="1" fill="#fff" opacity="0.4" />
      </svg>
      <div className={styles.secretSpaceHomePeekCaption_dream}>梦</div>
    </div>
  );
}

function SavedPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_saved}>
      <div aria-hidden className={styles.secretSpaceHomePeekWoodgrain} />
      <div className={styles.secretSpaceHomePeekCard}>
        「世间的好物
        不坚牢，<br />彩云易散琉璃脆。」
      </div>
      <div aria-hidden className={styles.secretSpaceHomePeekRibbon} />
    </div>
  );
}

function MomentPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_moment}>
      <div className={styles.secretSpaceHomePeekPhoto}>
        <div className={styles.secretSpaceHomePeekPhotoShade} />
        <div className={styles.secretSpaceHomePeekPhotoSun} />
      </div>
      <div className={styles.secretSpaceHomePeekMomentBody}>
        今天天气很好。<br />
        <span className={styles.secretSpaceHomePeekFade}>（最终没发出去）</span>
      </div>
    </div>
  );
}

function MemoryPeek() {
  return (
    <div className={styles.secretSpaceHomePeek_memory}>
      <svg viewBox="0 0 100 100" aria-hidden focusable="false">
        <g stroke="#7a5b48" strokeWidth="1.2" fill="none" opacity="0.7">
          <path d="M50 90 Q 50 60 50 20" />
          <path d="M50 70 Q 38 64 30 56" />
          <path d="M50 60 Q 62 56 70 48" />
          <path d="M50 50 Q 38 46 32 38" />
          <path d="M50 40 Q 62 38 68 30" />
        </g>
        <g fill="#c08294" opacity="0.85">
          <circle cx="50" cy="20" r="5" />
          <circle cx="46" cy="16" r="3.5" />
          <circle cx="54" cy="16" r="3.5" />
          <circle cx="50" cy="14" r="3" />
        </g>
        <g fill="#b89b6e" opacity="0.5">
          <ellipse cx="30" cy="56" rx="6" ry="3" transform="rotate(-30 30 56)" />
          <ellipse cx="70" cy="48" rx="6" ry="3" transform="rotate(30 70 48)" />
          <ellipse cx="32" cy="38" rx="5" ry="2.5" transform="rotate(-25 32 38)" />
          <ellipse cx="68" cy="30" rx="5" ry="2.5" transform="rotate(25 68 30)" />
        </g>
      </svg>
      <div className={styles.secretSpaceHomePeekStamp}>
        NO.07
        <br />
        2026.05
      </div>
    </div>
  );
}

const ENTRIES: DrawerEntry[] = [
  { id: 'state', label: 'TA 的状态', hint: 'state · 此刻 / 心情', tone: 'state', peek: <StatePeek /> },
  { id: 'draft_reply', label: 'TA 的草稿箱', hint: 'draft · 没说出口的话', tone: 'draft', peek: <DraftPeek /> },
  { id: 'dream', label: 'TA 的梦境', hint: 'dream · 不可解的片段', tone: 'dream', peek: <DreamPeek /> },
  { id: 'saved_item', label: 'TA 收藏的', hint: 'saved · 摘抄 / 片段', tone: 'saved', peek: <SavedPeek /> },
  { id: 'unsent_moment', label: '未发的朋友圈', hint: 'unsent · 草稿动态', tone: 'moment', peek: <MomentPeek /> },
  { id: 'memory_fragment', label: '私藏回忆', hint: 'memory · 碎片 / 标本', tone: 'memory', peek: <MemoryPeek /> },
];

interface SecretSpaceHomeProps {
  onSelectCategory: (id: SecretSpaceCategoryId) => void;
}

export function SecretSpaceHome({ onSelectCategory }: SecretSpaceHomeProps) {
  return (
    <div className={styles.secretSpaceHome} data-testid="secret-space-home">
      <div className={styles.secretSpaceHomeCabinetHeader}>
        <div className={styles.secretSpaceHomeCabinetKicker}>HER · SECRET CABINET</div>
        <h3 className={styles.secretSpaceHomeCabinetTitle}>TA 藏起来的那些东西</h3>
        <p className={styles.secretSpaceHomeCabinetSub}>
          —— 抽屉里有六个角落，请轻轻一格一格打开。
        </p>
      </div>
      <div className={styles.secretSpaceHomeCabinetBody}>
        <div className={styles.secretSpaceHomeGrid}>
          {ENTRIES.map((e) => {
            const toneClass = styles[TONE_CLASS_MAP[e.tone]];
            const className = toneClass
              ? `${styles.secretSpaceHomeCard} ${toneClass}`
              : styles.secretSpaceHomeCard;
            return (
              <button
                key={e.id}
                type="button"
                className={className}
                data-testid={`secret-space-entry-${e.id}`}
                data-tone={e.tone}
                onClick={() => onSelectCategory(e.id)}
              >
                <span aria-hidden className={styles.secretSpaceHomeCardHandle} />
                <div className={styles.secretSpaceHomeCardPeek}>{e.peek}</div>
                <div className={styles.secretSpaceHomeCardFooter}>
                  <div className={styles.secretSpaceHomeCardTitle}>{e.label}</div>
                  <div className={styles.secretSpaceHomeCardHint}>{e.hint}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
