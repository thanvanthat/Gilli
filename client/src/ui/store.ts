import { useSyncExternalStore } from 'react';
import type { ConnectionStatus, FieldLayout, GameEvent, RoomState } from '../net/types';
import type { HudFeed } from '../game/GameView';
import { loadSettings, saveSettings, type Settings } from './settings';

export type Screen = 'loading' | 'error' | 'menu' | 'play' | 'multiplayer' | 'controls' | 'settings' | 'room';

export interface Toast { id: number; text: string; kind: 'info' | 'good' | 'bad' }

export interface AppState {
  screen: Screen;
  /** where to go back to from controls/settings */
  returnTo: Screen;
  loading: { progress: number; label: string };
  fatal: string | null;
  layout: FieldLayout | null;
  connection: ConnectionStatus;
  room: RoomState | null;
  myId: string | null;
  paused: boolean;
  overlay: 'none' | 'controls' | 'settings';
  hud: HudFeed | null;
  toasts: Toast[];
  banner: { title: string; sub: string; kind: 'good' | 'bad' | 'info'; id: number } | null;
  feed: GameEvent[];
  settings: Settings;
  busy: boolean;
  error: string | null;
}

let state: AppState = {
  screen: 'loading', returnTo: 'menu', loading: { progress: 0, label: 'Starting' }, fatal: null, layout: null,
  connection: 'idle', room: null, myId: null, paused: false, overlay: 'none', hud: null, toasts: [], banner: null, feed: [],
  settings: loadSettings(), busy: false, error: null,
};
const listeners = new Set<() => void>();

export const store = {
  get: () => state,
  set(patch: Partial<AppState>) {
    state = { ...state, ...patch };
    if (patch.settings) saveSettings(patch.settings);
    for (const l of listeners) l();
  },
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3200) {
  const t = { id: ++toastId, text, kind };
  store.set({ toasts: [...state.toasts.slice(-3), t] });
  window.setTimeout(() => store.set({ toasts: state.toasts.filter(x => x.id !== t.id) }), ms);
}

let bannerId = 0;
export function showBanner(title: string, sub: string, kind: 'good' | 'bad' | 'info' = 'info', ms = 2600) {
  const id = ++bannerId;
  store.set({ banner: { title, sub, kind, id } });
  window.setTimeout(() => { if (state.banner?.id === id) store.set({ banner: null }); }, ms);
}

export function useStore<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(state));
}
