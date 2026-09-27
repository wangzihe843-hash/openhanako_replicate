import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { clampPetBounds, normalizePetOptions } = require('../desktop/src/shared/pet-window-state.cjs');

const primary = { id: 1, workArea: { x: 0, y: 40, width: 1440, height: 860 }, scaleFactor: 1 };
const secondary = { id: 2, workArea: { x: -1280, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 };

describe('Windows pet window bounds', () => {
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
