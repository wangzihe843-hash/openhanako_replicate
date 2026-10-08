export type ShortcutKeyboardEvent = Pick<KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

function isMacPlatform(platform: string): boolean {
  return platform.toLowerCase().includes('mac');
}

export function shortcutKeyLabel(key: string, platform: string): string {
  if (key === 'CommandOrControl') return isMacPlatform(platform) ? '⌘' : 'Ctrl';
  if (key === 'Control') return 'Ctrl';
  if (key === 'Alt') return isMacPlatform(platform) ? '⌥' : 'Alt';
  if (key === 'Shift') return 'Shift';
  if (key === 'Space') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

export function shortcutFromKeyboardEvent(event: ShortcutKeyboardEvent, platform: string): string | null {
  if (event.key === 'Escape') return null;
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return null;

  const parts: string[] = [];
  if (isMacPlatform(platform)) {
    // CommandOrControl means Command on macOS, so Control must stay explicit.
    if (event.ctrlKey) parts.push('Control');
    if (event.metaKey) parts.push('CommandOrControl');
  } else if (event.metaKey || event.ctrlKey) {
    parts.push('CommandOrControl');
  }
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const rawKey = keyTokenFromKeyboardEvent(event);
  if (!rawKey) return null;
  const key = rawKey.length === 1 ? rawKey.toUpperCase() : rawKey;
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
  if (parts.length === 0 && !isFunctionKey) return null;
  parts.push(key);
  return parts.join('+');
}

function keyTokenFromKeyboardEvent(event: ShortcutKeyboardEvent): string | null {
  if (event.code === 'Space' || event.key === ' ' || event.key === '\u00A0' || event.key === 'Spacebar') {
    return 'Space';
  }
  const keyMap: Record<string, string> = {
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
  };
  if (keyMap[event.code]) return keyMap[event.code];
  if (keyMap[event.key]) return keyMap[event.key];
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  const key = event.key || '';
  return key.length === 1 ? key : key || null;
}
