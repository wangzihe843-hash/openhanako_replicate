import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  shortcutFromKeyboardEvent,
  shortcutKeyLabel,
  type ShortcutKeyboardEvent,
} from '../quick-chat-shortcut.ts';
import { normalizeQuickChatPreferences } from '../../../../../../shared/quick-chat-preferences.ts';

function keyEvent(overrides: Partial<ShortcutKeyboardEvent> = {}): ShortcutKeyboardEvent {
  return { key: 'k', code: 'KeyK', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe('quick-chat shortcut platform modifiers', () => {
  const macCases: { name: string; modifiers: Partial<ShortcutKeyboardEvent>; shortcut: string; label: string }[] = [
    { name: 'Control', modifiers: { ctrlKey: true }, shortcut: 'Control+K', label: 'CtrlK' },
    { name: 'Command', modifiers: { metaKey: true }, shortcut: 'CommandOrControl+K', label: '⌘K' },
    { name: 'Control and Command', modifiers: { ctrlKey: true, metaKey: true }, shortcut: 'Control+CommandOrControl+K', label: 'Ctrl⌘K' },
    { name: 'Control with Option and Shift', modifiers: { ctrlKey: true, altKey: true, shiftKey: true }, shortcut: 'Control+Alt+Shift+K', label: 'Ctrl⌥ShiftK' },
    { name: 'Command with Option and Shift', modifiers: { metaKey: true, altKey: true, shiftKey: true }, shortcut: 'CommandOrControl+Alt+Shift+K', label: '⌘⌥ShiftK' },
    { name: 'all four modifiers', modifiers: { ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }, shortcut: 'Control+CommandOrControl+Alt+Shift+K', label: 'Ctrl⌘⌥ShiftK' },
  ];

  for (const { name, modifiers, shortcut, label } of macCases) {
    it(`preserves macOS ${name} through capture, normalization and display`, () => {
      const actual = shortcutFromKeyboardEvent(keyEvent(modifiers), 'MacIntel');
      assert.equal(actual, shortcut);
      assert.equal(normalizeQuickChatPreferences({ shortcut: actual }).shortcut, shortcut);
      assert.equal(shortcut.split('+').map(part => shortcutKeyLabel(part, 'MacIntel')).join(''), label);
    });
  }

  for (const platform of ['Win32', 'Linux x86_64', '']) {
    it(`preserves existing Control, Meta and combined serialization on ${platform || 'unknown platforms'}`, () => {
      for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }]) {
        assert.equal(shortcutFromKeyboardEvent(keyEvent(modifiers), platform), 'CommandOrControl+K');
        assert.equal(shortcutFromKeyboardEvent(keyEvent({ ...modifiers, altKey: true, shiftKey: true }), platform), 'CommandOrControl+Alt+Shift+K');
      }
      assert.equal(shortcutKeyLabel('CommandOrControl', platform), 'Ctrl');
      assert.equal(shortcutKeyLabel('Control', platform), 'Ctrl');
      assert.equal(shortcutKeyLabel('Alt', platform), 'Alt');
    });
  }

  it('uses the same case-insensitive Mac platform check for capture and display', () => {
    assert.equal(shortcutFromKeyboardEvent(keyEvent({ ctrlKey: true }), 'MACIntel'), 'Control+K');
    assert.equal(shortcutKeyLabel('CommandOrControl', 'MACIntel'), '⌘');
  });
});

describe('quick-chat shortcut existing key contracts', () => {
  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    it(`retains Option/Alt+Space normalization and the default on ${platform}`, () => {
      for (const key of [' ', '\u00A0', 'Spacebar']) {
        assert.equal(shortcutFromKeyboardEvent(keyEvent({ key, code: '', altKey: true }), platform), 'Alt+Space');
      }
      assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: 'Unidentified', code: 'Space', altKey: true }), platform), 'Alt+Space');
      assert.equal(normalizeQuickChatPreferences().shortcut, 'Alt+Space');
      assert.equal(shortcutKeyLabel('Space', platform), 'Space');
    });

    it(`keeps Escape, bare modifiers and unmodified non-function keys out of capture on ${platform}`, () => {
      for (const key of ['Escape', 'Shift', 'Control', 'Alt', 'Meta']) {
        assert.equal(shortcutFromKeyboardEvent(keyEvent({ key, code: '', ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), platform), null);
      }
      for (const [key, code] of [['k', 'KeyK'], [' ', 'Space'], ['ArrowUp', 'ArrowUp'], ['F25', 'F25']]) {
        assert.equal(shortcutFromKeyboardEvent(keyEvent({ key, code }), platform), null);
      }
      assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: '', code: '', ctrlKey: true }), platform), null);
    });

    it(`preserves function, navigation and physical character key tokens on ${platform}`, () => {
      for (const key of ['F1', 'F12', 'F24']) {
        assert.equal(shortcutFromKeyboardEvent(keyEvent({ key, code: key }), platform), key);
      }
      for (const [key, expected] of [['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['ArrowLeft', 'Left'], ['ArrowRight', 'Right'], ['Enter', 'Enter'], ['Tab', 'Tab'], ['Backspace', 'Backspace'], ['Delete', 'Delete']]) {
        assert.equal(shortcutFromKeyboardEvent(keyEvent({ key, code: key, altKey: true }), platform), `Alt+${expected}`);
      }
      assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: '˚', code: 'KeyK', altKey: true }), platform), 'Alt+K');
      assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: '!', code: 'Digit1', shiftKey: true }), platform), 'Shift+1');
      assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: 'k', code: '', altKey: true }), platform), 'Alt+K');
    });
  }

  it('leaves host registration responsible for reserved or unsupported combinations', () => {
    assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: ' ', code: 'Space', metaKey: true }), 'MacIntel'), 'CommandOrControl+Space');
    assert.equal(shortcutFromKeyboardEvent(keyEvent({ key: 'Unidentified', code: '', ctrlKey: true }), 'MacIntel'), 'Control+Unidentified');
  });
});
