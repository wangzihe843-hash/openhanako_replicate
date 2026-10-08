import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { clampPetBounds, normalizePetOptions, isPetPlatformSupported, petPlatformWindowOptions } = require('../desktop/src/shared/pet-window-state.cjs');

const primary = { id: 1, workArea: { x: 0, y: 40, width: 1440, height: 860 }, scaleFactor: 1 };
const secondary = { id: 2, workArea: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 };

describe('desktop pet platform and bounds', () => {
  it('enables Windows and macOS while retaining the unsupported-platform fallback', () => {
    expect(isPetPlatformSupported('win32')).toBe(true);
    expect(isPetPlatformSupported('darwin')).toBe(true);
    expect(isPetPlatformSupported('linux')).toBe(false);
    expect(isPetPlatformSupported(undefined)).toBe(false);
  });

  it('uses a nonactivating macOS panel without changing Windows window options', () => {
    expect(petPlatformWindowOptions('darwin')).toEqual({
      type: 'panel', acceptFirstMouse: true, minimizable: false, hiddenInMissionControl: true,
    });
    expect(petPlatformWindowOptions('win32')).toEqual({});
    expect(petPlatformWindowOptions('linux')).toEqual({});
  });

  it('respects a Retina work area below the menu bar and beside a left-side Dock', () => {
    const retina = { id: 4, workArea: { x: 72, y: 38, width: 1440, height: 906 }, scaleFactor: 2 };
    expect(clampPetBounds({ x: -10, y: -10 }, [retina])).toEqual({
      x: 72, y: 38, width: 220, height: 252,
    });
  });

  it('keeps a saved pet on an above-primary Retina display in DIP coordinates', () => {
    const above = { id: 5, workArea: { x: 0, y: -982, width: 1512, height: 944 }, scaleFactor: 2 };
    expect(clampPetBounds({ x: 1000, y: -70, width: 220, height: 252 }, [primary, above])).toEqual({
      x: 1000, y: 40, width: 220, height: 252,
    });
    expect(clampPetBounds({ x: 1200, y: -700, width: 220, height: 252 }, [primary, above])).toEqual({
      x: 1200, y: -700, width: 220, height: 252,
    });
  });

  it('keeps the full drag bar within a selected secondary display in DIP space', () => {
    expect(clampPetBounds({ x: -35, y: 680 }, [primary, secondary])).toEqual({
      x: -220, y: 468, width: 220, height: 252,
    });
  });

  it('moves a pet back into the visible work area when its display is disconnected', () => {
    expect(clampPetBounds({ x: -1150, y: 500 }, [primary])).toEqual({
      x: 0, y: 500, width: 220, height: 252,
    });
  });

  it('fits a small work area after a display metrics change and keeps toggles explicit', () => {
    expect(clampPetBounds({ x: 800, y: 400 }, [{ id: 3, workArea: { x: 20, y: 30, width: 180, height: 200 } }])).toEqual({
      x: 20, y: 30, width: 180, height: 200,
    });
    expect(normalizePetOptions({ visible: true, paused: true, clickThrough: true, alwaysOnTop: false })).toEqual({
      visible: true, paused: true, clickThrough: true, alwaysOnTop: false,
    });
  });
});
