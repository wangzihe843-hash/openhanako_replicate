import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../stores';
import type { QuotedSelection } from '../../stores/input-slice';
import { sendFloatingSelectionPrompt } from '../../stores/floating-selection-actions';
import { useI18n } from '../../hooks/use-i18n';
import { FloatingInput } from './FloatingInput';

export const SELECTION_OPEN_DELAY_MS = 500;

function isInsideFloatingInput(root: HTMLDivElement | null, target: EventTarget | null): boolean {
  return !!root && target instanceof Node && root.contains(target);
}

export function SelectionFloatingInput() {
  const { t } = useI18n();
  const quotedSelection = useStore(s => s.quotedSelection);
  const connected = useStore(s => s.connected);
  const modelSwitching = useStore(s => s.modelSwitching);
  const isStreaming = useStore(s => s.streamingSessions.includes(s.currentSessionPath || ''));
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);
  const [activeSelection, setActiveSelection] = useState<QuotedSelection | null>(null);
  const [value, setValue] = useState('');
  const timerRef = useRef<number | null>(null);
  const floatingRootRef = useRef<HTMLDivElement | null>(null);
  const hasFloatingAnchor = !!quotedSelection?.anchorRect;

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    setActiveSelection(null);
    setValue('');

    if (!quotedSelection?.anchorRect) return;
    timerRef.current = window.setTimeout(() => {
      setActiveSelection(quotedSelection);
      timerRef.current = null;
    }, SELECTION_OPEN_DELAY_MS);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [quotedSelection]);

  const dismissFloatingInput = useCallback(() => {
    setActiveSelection(null);
    setValue('');
  }, []);

  const clearSelectionAndClose = useCallback(() => {
    dismissFloatingInput();
    clearQuotedSelection();
  }, [clearQuotedSelection, dismissFloatingInput]);

  const handleRootElementChange = useCallback((element: HTMLDivElement | null) => {
    floatingRootRef.current = element;
  }, []);

  useEffect(() => {
    if (!hasFloatingAnchor) return;

    const closeIfOutside = (event: Event) => {
      if (isInsideFloatingInput(floatingRootRef.current, event.target)) return;
      dismissFloatingInput();
    };
    const closeOnExternalScroll = (event: Event) => {
      if (isInsideFloatingInput(floatingRootRef.current, event.target)) return;
      dismissFloatingInput();
    };
    const closeOnWindowBlur = () => {
      dismissFloatingInput();
    };

    document.addEventListener('pointerdown', closeIfOutside, true);
    document.addEventListener('focusin', closeIfOutside, true);
    document.addEventListener('scroll', closeOnExternalScroll, true);
    window.addEventListener('scroll', closeOnExternalScroll, true);
    window.addEventListener('blur', closeOnWindowBlur);

    return () => {
      document.removeEventListener('pointerdown', closeIfOutside, true);
      document.removeEventListener('focusin', closeIfOutside, true);
      document.removeEventListener('scroll', closeOnExternalScroll, true);
      window.removeEventListener('scroll', closeOnExternalScroll, true);
      window.removeEventListener('blur', closeOnWindowBlur);
    };
  }, [dismissFloatingInput, hasFloatingAnchor]);

  const handleSubmit = useCallback(async (text: string) => {
    if (!activeSelection) return;
    const sent = await sendFloatingSelectionPrompt(text, activeSelection);
    if (!sent) return;
    clearSelectionAndClose();
  }, [activeSelection, clearSelectionAndClose]);

  const disabled = !connected || isStreaming || modelSwitching;

  return (
    <FloatingInput
      open={!!activeSelection}
      anchorRect={activeSelection?.anchorRect}
      value={value}
      onChange={setValue}
      onSubmit={handleSubmit}
      onClose={dismissFloatingInput}
      disabled={disabled}
      autoFocus={false}
      ariaLabel={t('input.floatingInput')}
      submitLabel={t('chat.send')}
      onRootElementChange={handleRootElementChange}
    />
  );
}
