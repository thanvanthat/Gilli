export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  quality: Quality;
  sensitivity: number; // 0.2 .. 3
  invertY: boolean;
  mouseLook: boolean;
  volume: number;      // 0 .. 1
  fov: number;
  showFps: boolean;
  name: string;
}

const KEY = 'gilli.settings';

export const DEFAULT_SETTINGS: Settings = {
  quality: 'medium', sensitivity: 1, invertY: false, mouseLook: true, volume: 0.8, fov: 55, showFps: false, name: '',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable: settings last for this visit */ }
}
