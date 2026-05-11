import { useRef, useState, type ChangeEvent } from 'react';
import {
  MAX_CHAT_BACKGROUND_WIDTH,
  processChatBackgroundFile,
} from './image-utils';
import styles from './XingyeShell.module.css';

interface BackgroundPickerProps {
  value?: string;
  onChange: (dataUrl: string | undefined) => void | Promise<void>;
}

export function BackgroundPicker({ value, onChange }: BackgroundPickerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<'idle' | 'processing' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setState('processing');
    setMessage(null);
    try {
      const processed = await processChatBackgroundFile(file);
      await onChange(processed.dataUrl);
      setState('idle');
      setMessage(`已压缩到 ${processed.width} x ${processed.height}px 并保存到星野本地资料。`);
    } catch (error) {
      console.error('[Xingye] Failed to process chat background', error);
      setState('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleClear = async () => {
    setState('processing');
    setMessage(null);
    try {
      await onChange(undefined);
      setState('idle');
      setMessage('已清除聊天背景。');
    } catch (error) {
      console.error('[Xingye] Failed to process chat background', error);
      setState('error');
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={styles.backgroundPicker}>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className={styles.hiddenFileInput}
        onChange={handleFileChange}
      />
      <div
        className={styles.backgroundPreview}
        style={value ? { backgroundImage: `url("${value}")` } : undefined}
        aria-label="星野聊天背景预览"
      >
        {!value && <span>未设置聊天背景</span>}
      </div>
      <div className={styles.backgroundPickerBody}>
        <div>
          <h4>聊天背景</h4>
          <p>支持 png/jpg/webp，最大 3MB，保存前会压缩到宽度 {MAX_CHAT_BACKGROUND_WIDTH}px 以内。</p>
        </div>
        <div className={styles.backgroundPickerActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => fileInputRef.current?.click()}
            disabled={state === 'processing'}
          >
            {state === 'processing' ? '处理中...' : '上传背景'}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={handleClear}
            disabled={state === 'processing' || !value}
          >
            清除背景
          </button>
        </div>
        {message && (
          <span className={state === 'error' ? styles.syncError : styles.saveStatus}>
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
