/**
 * 「TA 的独家专访」阅读器。
 *
 * 页结构：
 *   intro     → 场记 + 演播室描述（hostIntro）
 *   q0..q4    → 5 个 Q&A，每页背景飘弹幕
 *   backstage → "相机关了"彩蛋（隐藏页：只能从 Q5 末尾点「相机关了之后…」按钮进入）
 *
 * 弹幕：每页对应 question.danmaku 列表，CSS animation 横向滚动；进入页面时
 * 重新挂载 key 让动画 from 0 重启，避免上一页弹幕残留视觉。
 *
 * 不读 / 不写存储；只渲染传入的 metadata。删除按钮由父组件（CategoryView 的 footer）处理。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import readerStyles from './SecretInterviewReader.module.css';
import type {
  SecretInterviewDanmaku,
  SecretInterviewMetadata,
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

const DANMAKU_LANE_COUNT = 5;
const DANMAKU_DURATION_RANGE = [10, 16] as const; // 秒

function pickLane(index: number): number {
  return index % DANMAKU_LANE_COUNT;
}

function pickDuration(index: number): number {
  const [min, max] = DANMAKU_DURATION_RANGE;
  // 简单确定性函数让每条速度不同，但同一条每次都一样（避免重渲染抖动）
  return min + ((index * 1.7) % (max - min));
}

function pickStartDelay(index: number): number {
  // 同一页内首屏要看到几条已经飘到中间，错开 -0.6s..-3.6s
  return -(((index * 0.9) % 3) + 0.6);
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

export function SecretInterviewReader({ meta, renderFooterActions }: SecretInterviewReaderProps) {
  const [page, setPage] = useState<Page>({ kind: 'intro' });
  const [backstageVisited, setBackstageVisited] = useState(false);

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

  return (
    <article
      className={readerStyles.reader}
      data-page={isBackstage ? 'backstage' : isFirst ? 'intro' : 'qna'}
      data-testid="secret-interview-reader"
    >
      <StudioBackdrop variant={isBackstage ? 'aftermath' : 'studio'} />
      <div className={readerStyles.nameWatermark} aria-hidden>{meta.hostName}</div>

      {/* 弹幕层：仅 Q&A 页渲染（intro / backstage 用 CSS visibility 隐藏） */}
      <DanmakuFloater key={`danmaku-${pageKey}`} danmaku={currentDanmaku} />

      <header className={readerStyles.header}>
        <div className={readerStyles.kicker}>INTERVIEW · 独家专访</div>
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
              <span className={readerStyles.qLabel}>Q{page.index + 1}</span>
              {meta.userQuestionIndex === page.index ? (
                <span className={readerStyles.userQuestionBadge}>你出的题</span>
              ) : null}
              <p className={readerStyles.qText}>{currentQ.q}</p>
            </div>
            <div className={readerStyles.aBlock} data-testid={`interview-a-${page.index}`}>
              <span className={readerStyles.aLabel}>A · TA 的回答</span>
              <p className={readerStyles.aText}>{currentQ.a}</p>
            </div>
          </>
        )}

        {page.kind === 'backstage' && (
          <>
            <div className={readerStyles.backstageMark}>OFF THE RECORD · 相机关了之后</div>
            <h4 className={readerStyles.backstageHeading}>TA 以为我们已经收工了——</h4>
            <p className={readerStyles.backstageBody} data-testid="interview-backstage-body">{meta.backstage}</p>
          </>
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

      {renderFooterActions ? (
        <div style={{ position: 'relative', zIndex: 2, paddingTop: 8 }}>{renderFooterActions()}</div>
      ) : null}
    </article>
  );
}
