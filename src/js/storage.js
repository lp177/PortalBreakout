// PortalBreakout — settings & progress persistence (see CONTRACT.md)

import { STORAGE_SETTINGS, STORAGE_PROGRESS } from './constants.js';

const prefersReduced = typeof matchMedia === 'function'
  && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const DEFAULT_SETTINGS = Object.freeze({
  binds: Object.freeze({
    bottomLeft: 'ArrowLeft', bottomRight: 'ArrowRight', bottomFire: 'ArrowUp',
    topLeft: 'KeyA', topRight: 'KeyD', topFire: 'KeyW',
    launch: 'Space', pause: 'Escape',
  }),
  audio: Object.freeze({ master: 0.8, music: 0.5, sfx: 0.9, muted: false }),
  effects: prefersReduced ? 'reduced' : 'full',
  assist: false,
  playerName: '',
});

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode) — play without persistence
  }
}

export function loadSettings() {
  const saved = read(STORAGE_SETTINGS) ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    binds: { ...DEFAULT_SETTINGS.binds, ...(saved.binds ?? {}) },
    audio: { ...DEFAULT_SETTINGS.audio, ...(saved.audio ?? {}) },
  };
}

export function saveSettings(patch) {
  const merged = {
    ...loadSettings(),
    ...patch,
    binds: { ...loadSettings().binds, ...(patch.binds ?? {}) },
    audio: { ...loadSettings().audio, ...(patch.audio ?? {}) },
  };
  write(STORAGE_SETTINGS, merged);
  return merged;
}

export function loadProgress() {
  const saved = read(STORAGE_PROGRESS);
  return saved && typeof saved.levels === 'object' && saved.levels !== null
    ? saved : { levels: {} };
}

export function recordLevelResult(idx, { score = 0, timeMs = 0, completed = false }) {
  const progress = loadProgress();
  const prev = progress.levels[idx] ?? { completed: false, bestScore: 0, bestTimeMs: null };
  progress.levels[idx] = {
    completed: prev.completed || completed,
    bestScore: Math.max(prev.bestScore, score),
    bestTimeMs: completed && (prev.bestTimeMs === null || timeMs < prev.bestTimeMs)
      ? timeMs : prev.bestTimeMs,
  };
  write(STORAGE_PROGRESS, progress);
  return progress;
}

export function isUnlocked(idx, progress = loadProgress()) {
  if (idx === 0) return true;
  return Boolean(progress.levels[idx - 1]?.completed);
}
