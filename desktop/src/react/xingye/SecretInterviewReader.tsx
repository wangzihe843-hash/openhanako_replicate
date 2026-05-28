/**
 * 「TA 的独家专访」阅读器。
 *
 * 页结构：
 *   intro     → 场记 + 演播室描述（hostIntro）
 *   q0..q4    → 5 个 Q&A，每页背景飘弹幕
 *   backstage → "相机关了"彩蛋（隐藏页：只能从 Q5 末尾点「相机关了之后…」按钮进入）
 *
 * 视觉系统：Film Noir 暗色胶片
 *  - .reader 根上叠加 grain / scanlines / sweep / vignette + 左右 sprocket
 *  - REC pill 在 header 右上；backstage 进场动画推进时 REC 闪烁→熄灭
 *  - 弹幕 toggle：默认 true，进 backstage 时强制 false；状态持久化到 localStorage
 *
 * Backstage 进场状态机：
 *   idle → recBlinking → recOff → dim → text → done
 *   节奏 100ms / 900ms / 1600ms / 2400ms / 4000ms
 *   离开 backstage 页时重置；下次再进重新跑一次。
 *
 * Backstage 物件互动（仅当 metadata.backstageProps 非空时）：
 *  - 物件按 x/y 百分比绝对定位；pulse 动画提示可点
 *  - 点击 → 浮卡显示 snippet；再点同物件关闭；已点物件保留"已揭开"描边
 *  - phase 推进到 text/done 才挂载物件，避免文字未出场就被物件干扰
 *
 * 鼠标晃动 / 散景：phase=done 且鼠标在 stage 内时启用；rAF 节流，避免 setState 风暴。
 *
 * 不读 / 不写"专访存储"；只渲染传入的 metadata。删除按钮由父组件（CategoryView 的 footer）处理。
 * 唯一持久化：弹幕开关 localStorage('xingye.interview.danmakuOn')。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import readerStyles from './SecretInterviewReader.module.css';
import type {
  SecretInterviewDanmaku,
  SecretInterviewMetadata,
  SecretInterviewProp,
  SecretInterviewPropIcon,
  SecretInterviewQuestion,
} from './xingye-secret-space-interview-types';

export interface SecretInterviewReaderProps {
  meta: SecretInterviewMetadata;
  /** 在底栏渲染额外动作（如"删除本期专访"）。 */
  renderFooterActions?: () => React.ReactNode;
}

type Page =
  | { kind: 'intro' }
  | { kind: 'qna'; index: number }
  | { kind: 'backstage' };

/**
 * Backstage 进场状态机。
 *  idle        - 初始静止（尚未进 backstage）
 *  recBlinking - 红色 REC 急促闪烁，提示"录制即将结束"
 *  recOff      - REC 灯熄灭
 *  dim         - 灯光收暗（黑色幕 opacity 上抬）
 *  text        - 文字开始浮现（CSS 控制 fade-in）
 *  done        - 文字到位 + 物件可点 + 鼠标晃动启用
 */
type BackstagePhase = 'idle' | 'recBlinking' | 'recOff' | 'dim' | 'text' | 'done';

const BACKSTAGE_PHASE_SCHEDULE: ReadonlyArray<{ phase: BackstagePhase; at: number }> = [
  { phase: 'recBlinking', at: 100 },
  { phase: 'recOff', at: 900 },
  { phase: 'dim', at: 1600 },
  { phase: 'text', at: 2400 },
  { phase: 'done', at: 4000 },
];

const DANMAKU_LANE_COUNT = 5;
// 整体周期 22-30 秒；CSS 里 55%/100% 让每条弹幕"飘 12-16s + 歇 10-14s"再来下一轮。
const DANMAKU_DURATION_RANGE = [22, 30] as const; // 秒

const DANMAKU_ON_STORAGE_KEY = 'xingye.interview.danmakuOn';

function pickLane(index: number): number {
  return index % DANMAKU_LANE_COUNT;
}

function pickDuration(index: number): number {
  const [min, max] = DANMAKU_DURATION_RANGE;
  // 确定性函数：同一条每次重渲都一样，避免抖动；不同条速度错开
  return min + ((index * 2.3) % (max - min));
}

function pickStartDelay(index: number): number {
  /*
   * 错开起始 delay：让首屏分散看到 2-3 条弹幕在不同位置，而不是全挤在最右边等出场。
   * 总周期 22-30s，所以 delay 错到 -1..-9 之间，覆盖各弹幕进入到飘动中段的不同时刻。
   * 同时配合 CSS keyframe 的 55% pause，让一些弹幕一进页面就在"歇"——节奏自然。
   */
  return -(((index * 1.7) % 8) + 1);
}

function DanmakuFloater({ danmaku }: { danmaku: SecretInterviewDanmaku[] }) {
  if (!danmaku.length) return null;
  return (
    <div className={readerStyles.danmakuLayer} aria-hidden>
      {danmaku.map((d, i) => {
        const lane = pickLane(i);
        const top = 8 + lane * 18; // 5 个 lane，每 lane 间隔 18% 高度
        const duration = pickDuration(i);
        const delay = pickStartDelay(i);
        const tagClass = readerStyles[`danmakuItem_${d.tag}`] ?? '';
        return (
          <span
            key={`${i}-${d.text}`}
            className={`${readerStyles.danmakuItem} ${tagClass}`}
            style={{
              top: `${top}%`,
              animationDuration: `${duration}s`,
              animationDelay: `${delay}s`,
            }}
          >
            {d.text}
          </span>
        );
      })}
    </div>
  );
}

/** 演播室剪影：立麦 + 沙发 + 落地灯 + 三脚架；纯 SVG path，不生图。 */
function StudioBackdrop({ variant }: { variant: 'studio' | 'aftermath' }) {
  return (
    <div className={readerStyles.stageBackdrop} aria-hidden>
      <svg viewBox="0 0 400 480" preserveAspectRatio="xMidYMid slice">
        {variant === 'studio' ? (
          <g stroke="#f2ecdd" strokeWidth="1.2" fill="none" opacity="0.85">
            {/* 沙发轮廓（中下） */}
            <path d="M 80 360 L 80 320 Q 80 300 100 300 L 300 300 Q 320 300 320 320 L 320 360" />
            <path d="M 60 360 L 340 360 L 340 400 L 60 400 Z" />
            <path d="M 100 360 L 100 400 M 200 360 L 200 400 M 300 360 L 300 400" />
            {/* 立麦（左前） */}
            <path d="M 70 260 L 70 410" />
            <ellipse cx="70" cy="240" rx="10" ry="14" />
            <path d="M 60 410 L 80 410 M 50 420 L 90 420" />
            {/* 落地灯（右后） */}
            <path d="M 350 110 L 350 410" />
            <path d="M 320 110 Q 350 70 380 110 Z" />
            <path d="M 340 410 L 360 410 M 330 420 L 370 420" />
            {/* 三脚架摄影机（右前） */}
            <path d="M 270 270 L 270 410 M 290 270 L 250 410 M 250 270 L 290 410" />
            <rect x="245" y="240" width="50" height="30" rx="3" />
            <circle cx="255" cy="255" r="5" />
            {/* 一个虚化光圈（远处的提示灯） */}
            <circle cx="200" cy="60" r="40" stroke="#c9a85a" strokeWidth="0.6" opacity="0.5" />
          </g>
        ) : (
          // backstage variant：散落麦克风线 + 半空水杯 + 倒地的反光板
          <g stroke="#c9a85a" strokeWidth="1.0" fill="none" opacity="0.75">
            {/* 散落的麦克风线（蜿蜒） */}
            <path d="M 40 380 Q 100 360 140 390 T 240 380 Q 290 370 340 395" />
            <path d="M 60 410 Q 120 430 180 410 T 300 420" />
            {/* 半空水杯 */}
            <path d="M 80 280 L 88 340 L 122 340 L 130 280 Z" />
            <path d="M 84 310 L 126 310" strokeDasharray="2 2" />
            {/* 倒下的麦克风（右下） */}
            <ellipse cx="280" cy="380" rx="14" ry="9" transform="rotate(30 280 380)" />
            <path d="M 268 388 L 200 420" />
            {/* 一道微弱的应急灯光 */}
            <circle cx="320" cy="120" r="22" stroke="#c9a85a" strokeWidth="0.6" opacity="0.35" />
          </g>
        )}
      </svg>
    </div>
  );
}

/** 现场物证 icon。所有 icon 都走 currentColor，便于配合 .backstageProp 的 revealed 态切色。 */
function PropIcon({ kind }: { kind: SecretInterviewPropIcon }) {
  switch (kind) {
    case 'button':
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="10" cy="10" r="1" fill="currentColor" />
          <circle cx="14" cy="10" r="1" fill="currentColor" />
          <circle cx="10" cy="14" r="1" fill="currentColor" />
          <circle cx="14" cy="14" r="1" fill="currentColor" />
        </svg>
      );
    case 'cup':
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M 6 6 L 7 20 L 17 20 L 18 6 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M 7 12 L 17 12" stroke="currentColor" strokeWidth="0.8" strokeDasharray="2 2" />
        </svg>
      );
    case 'cable':
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M 2 16 Q 6 10 10 16 T 18 16 Q 20 14 22 16" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="22" cy="16" r="1.4" fill="currentColor" />
        </svg>
      );
    case 'note':
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <path d="M 6 4 L 16 4 L 19 7 L 19 20 L 6 20 Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M 16 4 L 16 7 L 19 7" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M 9 11 L 16 11 M 9 14 L 16 14 M 9 17 L 13 17" stroke="currentColor" strokeWidth="0.9" />
        </svg>
      );
    case 'lighter':
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="7" y="11" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M 12 11 L 12 7 Q 12 4 14 4" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M 11 8 Q 12 5 14 6 Q 13 8 12 7" fill="currentColor" opacity="0.8" />
        </svg>
      );
    case 'card':
      return (
        <svg viewBox="0 0 24 24" aria-hidden>
          <rect x="3" y="7" width="18" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M 3 10 L 21 10" stroke="currentColor" strokeWidth="0.9" />
          <path d="M 7 14 L 12 14" stroke="currentColor" strokeWidth="0.9" />
        </svg>
      );
    default:
      return null;
  }
}

/** 安全读 localStorage（SSR / disabled storage 都不要崩）。 */
function readDanmakuOnFromStorage(defaultValue: boolean): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = window.localStorage.getItem(DANMAKU_ON_STORAGE_KEY);
    if (raw === null) return defaultValue;
    return raw === '1' || raw === 'true';
  } catch {
    return defaultValue;
  }
}

function writeDanmakuOnToStorage(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DANMAKU_ON_STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 忽略：私密模式 / 配额满 / disabled 都不该影响阅读
  }
}

export function SecretInterviewReader({ meta, renderFooterActions }: SecretInterviewReaderProps) {
  const [page, setPage] = useState<Page>({ kind: 'intro' });
  const [backstageVisited, setBackstageVisited] = useState(false);

  /* —— 弹幕开关 —— */
  // 默认开；用户手动切换持久化到 localStorage；进 backstage 强制关（剧情不应被打断）。
  const [danmakuOn, setDanmakuOn] = useState<boolean>(() => readDanmakuOnFromStorage(true));
  const toggleDanmaku = useCallback(() => {
    setDanmakuOn((prev) => {
      const next = !prev;
      writeDanmakuOnToStorage(next);
      return next;
    });
  }, []);

  /* —— Backstage 进场状态机 —— */
  const [backstagePhase, setBackstagePhase] = useState<BackstagePhase>('idle');

  useEffect(() => {
    if (page.kind !== 'backstage') {
      // 离开 backstage → 重置 phase，下次再进重新播一遍
      setBackstagePhase('idle');
      return undefined;
    }
    setBackstagePhase('idle');
    const timers = BACKSTAGE_PHASE_SCHEDULE.map(({ phase, at }) =>
      setTimeout(() => setBackstagePhase(phase), at),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [page.kind]);

  /* —— 鼠标跟随：仅 backstage phase=done 时启用 —— */
  // 用 ref 持有 raw cursor 百分比，state 只写最终用于 CSS 变量的值；rAF 节流。
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number; inside: boolean }>({
    x: 0.5,
    y: 0.5,
    inside: false,
  });
  const cursorRafRef = useRef<number | null>(null);
  const cursorLatestRef = useRef<{ x: number; y: number; inside: boolean }>({
    x: 0.5,
    y: 0.5,
    inside: false,
  });

  const flushCursor = useCallback(() => {
    cursorRafRef.current = null;
    setCursor(cursorLatestRef.current);
  }, []);

  const handleStageMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    cursorLatestRef.current = { x, y, inside: true };
    if (cursorRafRef.current === null) {
      cursorRafRef.current = requestAnimationFrame(flushCursor);
    }
  }, [flushCursor]);

  const handleStageMouseLeave = useCallback(() => {
    cursorLatestRef.current = { ...cursorLatestRef.current, inside: false };
    if (cursorRafRef.current === null) {
      cursorRafRef.current = requestAnimationFrame(flushCursor);
    }
  }, [flushCursor]);

  useEffect(() => {
    return () => {
      if (cursorRafRef.current !== null) {
        cancelAnimationFrame(cursorRafRef.current);
        cursorRafRef.current = null;
      }
    };
  }, []);

  /* —— 物件互动：已揭开集合 + 当前激活物件 —— */
  const [revealedProps, setRevealedProps] = useState<Set<string>>(() => new Set());
  const [activeProp, setActiveProp] = useState<string | null>(null);

  const togglePropReveal = useCallback((id: string) => {
    setActiveProp((cur) => (cur === id ? null : id));
    setRevealedProps((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Esc 关闭浮卡
  useEffect(() => {
    if (!activeProp) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveProp(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeProp]);

  /* —— 翻页 —— */
  const totalQuestions = meta.questions.length;

  const pageKey = useMemo(() => {
    if (page.kind === 'intro') return 'intro';
    if (page.kind === 'backstage') return 'backstage';
    return `q${page.index}`;
  }, [page]);

  const goNext = useCallback(() => {
    setPage((p) => {
      if (p.kind === 'intro') return { kind: 'qna', index: 0 };
      if (p.kind === 'qna') {
        if (p.index < totalQuestions - 1) return { kind: 'qna', index: p.index + 1 };
        return p; // 不自动进 backstage，需要点显式按钮
      }
      return p;
    });
  }, [totalQuestions]);

  const goPrev = useCallback(() => {
    setPage((p) => {
      if (p.kind === 'backstage') return { kind: 'qna', index: totalQuestions - 1 };
      if (p.kind === 'qna') {
        if (p.index === 0) return { kind: 'intro' };
        return { kind: 'qna', index: p.index - 1 };
      }
      return p;
    });
  }, [totalQuestions]);

  const revealBackstage = useCallback(() => {
    setBackstageVisited(true);
    setActiveProp(null);
    setRevealedProps(new Set());
    setPage({ kind: 'backstage' });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') goNext();
      else if (e.key === 'ArrowLeft') goPrev();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goNext, goPrev]);

  const isFirst = page.kind === 'intro';
  const isLastQ = page.kind === 'qna' && page.index === totalQuestions - 1;
  const isBackstage = page.kind === 'backstage';

  const recordedDateLabel = useMemo(() => {
    try {
      const d = new Date(meta.recordedAt);
      if (Number.isNaN(d.getTime())) return meta.recordedAt;
      return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
    } catch {
      return meta.recordedAt;
    }
  }, [meta.recordedAt]);

  const currentQ: SecretInterviewQuestion | null = page.kind === 'qna' ? meta.questions[page.index] ?? null : null;
  const currentDanmaku = currentQ?.danmaku ?? [];

  /* —— Backstage 派生量 —— */
  const backstageProps: SecretInterviewProp[] = meta.backstageProps ?? [];
  const hasProps = backstageProps.length > 0;

  const dimAmount = (() => {
    if (!isBackstage) return 0;
    switch (backstagePhase) {
      case 'idle': return 0;
      case 'recBlinking': return 0.1;
      case 'recOff': return 0.25;
      case 'dim': return 0.55;
      case 'text':
      case 'done':
      default:
        return 0.7;
    }
  })();

  // REC 状态：intro/qna 一直 on（保持录制感）；backstage 走 phase
  const recOn = !isBackstage || backstagePhase === 'idle' || backstagePhase === 'recBlinking';
  const recBlinkingFast = isBackstage && backstagePhase === 'recBlinking';

  // 物件挂载条件：phase 推进到 text 或 done 才显示物件锚点
  const propsMounted = isBackstage
    && hasProps
    && (backstagePhase === 'text' || backstagePhase === 'done');

  // 鼠标晃动：phase=done + cursor inside + backstage 才生效
  const shakeEnabled = isBackstage && backstagePhase === 'done' && cursor.inside;
  const shakeX = shakeEnabled ? (cursor.x - 0.5) * 4 : 0;
  const shakeY = shakeEnabled ? (cursor.y - 0.5) * 3 : 0;

  // 散景跟随：同上
  const bokehVisible = shakeEnabled;

  // backstage 渲染时弹幕强制关（剧情不应被打断）；UI 上保留 toggle 显示当前用户设置
  const showDanmaku = danmakuOn && page.kind === 'qna';

  // 当前激活物件的浮卡位置 / 方向（左半屏 → 浮卡向右；右半屏 → 浮卡向左）
  const activePropData = activeProp
    ? backstageProps.find((p) => p.id === activeProp) ?? null
    : null;
  const activePropSide: 'left' | 'right' = activePropData
    ? (activePropData.x < 60 ? 'right' : 'left')
    : 'right';

  return (
    <article
      className={readerStyles.reader}
      data-page={isBackstage ? 'backstage' : isFirst ? 'intro' : 'qna'}
      data-backstage-phase={isBackstage ? backstagePhase : 'idle'}
      data-testid="secret-interview-reader"
    >
      <StudioBackdrop variant={isBackstage ? 'aftermath' : 'studio'} />
      <div className={readerStyles.nameWatermark} aria-hidden>{meta.hostName}</div>

      {/* 弹幕层：仅 Q&A 页 + 弹幕开关 = on 时挂载（backstage 整体不挂，省 GPU） */}
      {showDanmaku ? (
        <DanmakuFloater key={`danmaku-${pageKey}`} danmaku={currentDanmaku} />
      ) : null}

      <header className={readerStyles.header}>
        <div className={readerStyles.headerRow}>
          <div className={readerStyles.kicker}>INTERVIEW · 独家专访</div>
          <div className={readerStyles.headerControls}>
            <button
              type="button"
              className={readerStyles.danmakuToggle}
              onClick={toggleDanmaku}
              data-testid="interview-toggle-danmaku"
              aria-pressed={danmakuOn}
              title={danmakuOn ? '关弹幕' : '开弹幕'}
            >
              {danmakuOn ? '关弹幕' : '开弹幕'}
            </button>
            <span
              className={`${readerStyles.recPill} ${recOn ? '' : readerStyles.recPill_off}`}
              aria-hidden
            >
              <span
                className={[
                  readerStyles.recDot,
                  recOn ? '' : readerStyles.recDot_off,
                  recBlinkingFast ? readerStyles.recDot_fast : '',
                ].filter(Boolean).join(' ')}
              />
              {recOn ? 'REC' : '—— OFF'}
            </span>
          </div>
        </div>
        <h3 className={readerStyles.title}>{meta.title}</h3>
        <div className={readerStyles.subtitle}>
          主持 / {meta.hostName} · 录于 {recordedDateLabel}
        </div>
      </header>

      <div className={readerStyles.stage} data-testid={`interview-stage-${pageKey}`}>
        {page.kind === 'intro' && (
          <>
            <div className={readerStyles.introMeta}>开场 · STUDIO LOG</div>
            <p className={readerStyles.introBody}>{meta.hostIntro}</p>
          </>
        )}

        {page.kind === 'qna' && currentQ && (
          <>
            <div className={readerStyles.qBlock} data-testid={`interview-q-${page.index}`}>
              <div className={readerStyles.qHeader}>
                <span className={readerStyles.qLabelBig}>Q{page.index + 1}</span>
                {meta.userQuestionIndex === page.index ? (
                  <span className={readerStyles.qBadgeUserQuestion}>你出的题</span>
                ) : null}
              </div>
              <p className={readerStyles.qTextBig}>{currentQ.q}</p>
            </div>
            <div className={readerStyles.aBlock} data-testid={`interview-a-${page.index}`}>
              <span className={readerStyles.aLabel}>A · TA 的回答</span>
              <p className={readerStyles.aText}>{currentQ.a}</p>
            </div>
          </>
        )}

        {page.kind === 'backstage' && (
          <div
            ref={stageRef}
            className={readerStyles.stageShell}
            style={{
              // CSS 变量驱动晃动 / 散景位置；inline style 不进 React state 树
              '--shake-x': `${shakeX}px`,
              '--shake-y': `${shakeY}px`,
              '--bokeh-x': `${cursor.x * 100}%`,
              '--bokeh-y': `${cursor.y * 100}%`,
            } as React.CSSProperties}
            onMouseMove={handleStageMouseMove}
            onMouseLeave={handleStageMouseLeave}
          >
            {/* 灯光收暗的黑色幕 */}
            <div
              className={readerStyles.backstageDim}
              style={{ '--dim-amount': dimAmount } as React.CSSProperties}
              aria-hidden
            />

            {/* 跟随鼠标的散景光斑 */}
            <div
              className={`${readerStyles.bokehFollow} ${bokehVisible ? readerStyles.bokehFollow_visible : ''}`}
              aria-hidden
            />

            <div className={readerStyles.offRecordBadge}>
              <span className={readerStyles.offRecordBadge_label}>OFF THE RECORD</span>
              <span className={readerStyles.offRecordBadge_sub}>· 相机关了之后</span>
            </div>
            <h4 className={`${readerStyles.backstageHeading} ${readerStyles.backstageHeadingFade}`}>
              TA 以为我们已经收工了——
            </h4>
            <p
              className={`${readerStyles.backstageBody} ${readerStyles.backstageBodyFade}`}
              data-testid="interview-backstage-body"
            >
              {meta.backstage}
            </p>
            {hasProps ? (
              <p className={readerStyles.backstageRevealHint}>
                · 点亮房间里的物件，看看主持人没说的细节 ·
              </p>
            ) : null}

            {/* 物件锚点 */}
            {propsMounted
              ? backstageProps.map((p) => {
                const revealed = revealedProps.has(p.id);
                const active = activeProp === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={readerStyles.backstageProp}
                    style={{ left: `${p.x}%`, top: `${p.y}%` }}
                    data-revealed={revealed ? 'true' : 'false'}
                    data-active={active ? 'true' : 'false'}
                    data-testid={`interview-backstage-prop-${p.id}`}
                    aria-label={p.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      togglePropReveal(p.id);
                    }}
                  >
                    <PropIcon kind={p.icon} />
                  </button>
                );
              })
              : null}

            {/* 浮卡：activeProp 存在时才挂载 */}
            {activePropData ? (
              <div
                className={[
                  readerStyles.propSnippet,
                  activePropSide === 'right'
                    ? readerStyles.propSnippet_right
                    : readerStyles.propSnippet_left,
                ].join(' ')}
                style={{
                  '--snippet-x': `${activePropData.x}%`,
                  '--snippet-y': `${activePropData.y}%`,
                } as React.CSSProperties}
                data-testid={`interview-backstage-snippet-${activePropData.id}`}
                role="dialog"
                aria-label={`物证 · ${activePropData.label}`}
              >
                <div className={readerStyles.propSnippet_kicker}>
                  现场物证 · {activePropData.label}
                </div>
                <p className={readerStyles.propSnippet_text}>{activePropData.snippet}</p>
                <div className={readerStyles.propSnippet_footer}>
                  {revealedProps.size}/{backstageProps.length} 已揭开 · 再点关闭
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      <footer className={readerStyles.footer}>
        <button
          type="button"
          className={readerStyles.navButton}
          onClick={goPrev}
          disabled={isFirst}
          data-testid="interview-prev"
        >
          ← 上一页
        </button>

        <div className={readerStyles.dotIndicator} aria-label="问题进度">
          {Array.from({ length: totalQuestions }).map((_, i) => {
            const isActive = page.kind === 'qna' && page.index === i;
            const isUserQ = meta.userQuestionIndex === i;
            const cls = [
              readerStyles.dot,
              isActive ? readerStyles.dot_active : '',
              isUserQ ? readerStyles.dot_userMarked : '',
            ]
              .filter(Boolean)
              .join(' ');
            return <span key={i} className={cls} />;
          })}
        </div>

        {isLastQ && !isBackstage ? (
          <button
            type="button"
            className={readerStyles.backstageReveal}
            onClick={revealBackstage}
            data-testid="interview-reveal-backstage"
          >
            相机关了之后 →
          </button>
        ) : isBackstage ? (
          <button
            type="button"
            className={readerStyles.navButton}
            onClick={() => setPage({ kind: 'qna', index: totalQuestions - 1 })}
            data-testid="interview-back-to-qna"
          >
            ← 回到正片
          </button>
        ) : (
          <button
            type="button"
            className={readerStyles.navButton}
            onClick={goNext}
            disabled={isLastQ}
            data-testid="interview-next"
          >
            下一页 →
          </button>
        )}
      </footer>

      {isLastQ && !backstageVisited ? (
        <div className={readerStyles.backstageHint}>· 似乎还有什么没结束 ·</div>
      ) : null}

      {/* —— 胶片视觉层：颗粒 / 扫描线 / 扫光 / 暗角 / sprocket —— */}
      <div className={readerStyles.filmVignette} aria-hidden />
      <div className={readerStyles.filmScanSweep} aria-hidden />
      <div className={readerStyles.filmScanlines} aria-hidden />
      <div className={readerStyles.filmGrain} aria-hidden />
      <div className={`${readerStyles.sprocketColumn} ${readerStyles.sprocketColumn_left}`} aria-hidden>
        {Array.from({ length: 12 }).map((_, i) => (
          <span key={i} className={readerStyles.sprocketHole} />
        ))}
      </div>
      <div className={`${readerStyles.sprocketColumn} ${readerStyles.sprocketColumn_right}`} aria-hidden>
        {Array.from({ length: 12 }).map((_, i) => (
          <span key={i} className={readerStyles.sprocketHole} />
        ))}
      </div>

      {renderFooterActions ? (
        <div style={{ position: 'relative', zIndex: 10, paddingTop: 8 }}>{renderFooterActions()}</div>
      ) : null}
    </article>
  );
}
