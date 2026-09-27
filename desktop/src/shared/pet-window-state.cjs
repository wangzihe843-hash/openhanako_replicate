"use strict";

const DEFAULT_PET_WIDTH = 220;
const DEFAULT_PET_HEIGHT = 252;

function finite(value) { return typeof value === "number" && Number.isFinite(value); }
function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }

/** Electron screen workArea and BrowserWindow bounds both use DIP coordinates. */
function choosePetDisplay(bounds, displays, preferredDisplayId = null) {
  const list = (Array.isArray(displays) ? displays : []).filter((display) => {
    const area = display?.workArea || display?.bounds;
    return area && finite(area.x) && finite(area.y) && finite(area.width) && finite(area.height)
      && area.width > 0 && area.height > 0;
  });
  if (!list.length) return { workArea: { x: 0, y: 0, width: 800, height: 600 } };
  const preferred = list.find((display) => display.id === preferredDisplayId);
  if (!bounds || !finite(bounds.x) || !finite(bounds.y)) return preferred || list[0];
  const centerX = bounds.x + (finite(bounds.width) ? bounds.width / 2 : 0);
  const centerY = bounds.y + (finite(bounds.height) ? bounds.height / 2 : 0);
  return list.slice().sort((a, b) => {
    const distance = (display) => {
      const area = display.workArea || display.bounds;
      const nearestX = clamp(centerX, area.x, area.x + area.width);
      const nearestY = clamp(centerY, area.y, area.y + area.height);
      return (nearestX - centerX) ** 2 + (nearestY - centerY) ** 2;
    };
    return distance(a) - distance(b);
  })[0];
}

function clampPetBounds(saved, displays, preferredDisplayId = null) {
  const display = choosePetDisplay(saved, displays, preferredDisplayId);
  const area = display.workArea || display.bounds;
  const width = Math.min(DEFAULT_PET_WIDTH, Math.round(area.width));
  const height = Math.min(DEFAULT_PET_HEIGHT, Math.round(area.height));
  const defaultX = area.x + area.width - width - 24;
  const defaultY = area.y + area.height - height - 24;
  return {
    x: Math.round(clamp(finite(saved?.x) ? saved.x : defaultX, area.x, area.x + area.width - width)),
    y: Math.round(clamp(finite(saved?.y) ? saved.y : defaultY, area.y, area.y + area.height - height)),
    width,
    height,
  };
}

function normalizePetOptions(saved) {
  return {
    visible: saved?.visible === true,
    paused: saved?.paused === true,
    clickThrough: saved?.clickThrough === true,
    alwaysOnTop: saved?.alwaysOnTop !== false,
  };
}

module.exports = { clampPetBounds, choosePetDisplay, normalizePetOptions, DEFAULT_PET_WIDTH, DEFAULT_PET_HEIGHT };
