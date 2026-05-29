import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../stores';
import { Tooltip } from '../../ui';
import { computeFloatingInputPosition } from '../floating-input/position';
import styles from './SelectionQuoteActionSurface.module.css';

const TOOLBAR_SIZE = 26;
const TOOLBAR_CROSS_AXIS_OFFSET = 20;
const TOOLTIP_DELAY_MS = 500;

function getViewportSize() {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

export function SelectionQuoteActionSurface() {
  const quoteCandidate = useStore(s => s.quoteCandidate);
  const addQuotedSelection = useStore(s => s.addQuotedSelection);
  const clearQuoteCandidate = useStore(s => s.clearQuoteCandidate);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const [viewport, setViewport] = useState(() => getViewportSize());
  const [scrollTick, setScrollTick] = useState(0);

  useEffect(() => {
    const handleResize = () => setViewport(getViewportSize());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        setScrollTick(tick => tick + 1);
      });
    };
    document.addEventListener('scroll', handleScroll, { capture: true, passive: true });
    return () => {
      document.removeEventListener('scroll', handleScroll, { capture: true });
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, []);

  const position = useMemo(() => {
    const liveAnchorRect = getLiveSelectionAnchorRect(quoteCandidate?.text, viewport);
    if (liveAnchorRect === null) return null;
    const anchorRect = liveAnchorRect ?? quoteCandidate?.anchorRect;
    if (!anchorRect || viewport.width <= 0 || viewport.height <= 0) return null;
    return computeFloatingInputPosition(
      anchorRect,
      viewport,
      { width: TOOLBAR_SIZE, height: TOOLBAR_SIZE },
      8,
      16,
      'top',
      TOOLBAR_CROSS_AXIS_OFFSET,
    );
  }, [quoteCandidate?.anchorRect, quoteCandidate?.text, viewport, scrollTick]);

  const handleAddQuote = useCallback(() => {
    if (!quoteCandidate) return;
    addQuotedSelection(quoteCandidate);
    clearQuoteCandidate();
    requestInputFocus();
  }, [addQuotedSelection, clearQuoteCandidate, quoteCandidate, requestInputFocus]);

  if (!quoteCandidate || !position) return null;

  const tooltipId = 'selection-quote-action-tooltip';
  const actions = [{
    id: 'quote',
    label: '引用到对话',
    onClick: handleAddQuote,
    icon: <QuoteIcon />,
  }];

  return (
    <div
      className={styles.surface}
      data-origin={position.origin}
      data-selection-ignore="true"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
    >
      {actions.map(action => (
        <Tooltip
          key={action.id}
          id={tooltipId}
          content={action.label}
          delayMs={TOOLTIP_DELAY_MS}
          placement={position.origin === 'top-center' ? 'bottom' : 'top'}
        >
          {({ ref, ...tooltipProps }) => (
            <button
              ref={(node) => ref(node)}
              type="button"
              className={styles.button}
              aria-label={action.label}
              onMouseDown={(event) => event.preventDefault()}
              onClick={action.onClick}
              {...tooltipProps}
            >
              {action.icon}
            </button>
          )}
        </Tooltip>
      ))}
    </div>
  );
}

function getLiveSelectionAnchorRect(candidateText: string | undefined, viewport: { width: number; height: number }) {
  if (!candidateText) return undefined;
  const sel = window.getSelection();
  const selectionText = sel?.toString().trim();
  if (!sel || sel.rangeCount === 0 || !selectionText) return undefined;
  if (selectionText !== candidateText && !selectionText.startsWith(candidateText)) return undefined;
  const range = sel.getRangeAt(0);
  if (typeof range.getBoundingClientRect !== 'function') return undefined;
  const rect = range.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) return undefined;
  if (rect.bottom < 0 || rect.top > viewport.height || rect.right < 0 || rect.left > viewport.width) {
    return null;
  }
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function QuoteIcon() {
  return (
    <svg
      className={styles.icon}
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M7.4 6.2C5.2 7.7 4 9.9 4 12.8V18h5.7v-5.7H7.1c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
      <path d="M16.4 6.2c-2.2 1.5-3.4 3.7-3.4 6.6V18h5.7v-5.7h-2.6c.1-1.6.9-2.8 2.3-3.8l-2-2.3Z" />
    </svg>
  );
}
