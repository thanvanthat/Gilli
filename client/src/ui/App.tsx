import { useEffect, useRef } from 'react';
import { actions, boot, go, view } from './controller';
import { store, useStore } from './store';
import { ControlsGuide, ErrorScreen, LoadingScreen, MainMenu, MultiplayerMenu, PlayMenu, SettingsPanel } from './screens';
import { RoomScreen } from './room';

export function App() {
  const stage = useRef<HTMLDivElement>(null);
  const screen = useStore(s => s.screen);
  const toasts = useStore(s => s.toasts);
  const returnTo = useStore(s => s.returnTo);
  const inMatch = useStore(s => s.screen === 'room' && s.room?.phase === 'Playing');

  useEffect(() => {
    if (stage.current) void boot(stage.current);
  }, []);

  return (
    <div className={`app ${inMatch ? 'in-match' : ''}`}>
      <div className="stage" ref={stage} />
      {screen === 'loading' && <LoadingScreen />}
      {screen === 'error' && <ErrorScreen />}
      {screen === 'menu' && <MainMenu />}
      {screen === 'play' && <PlayMenu />}
      {screen === 'multiplayer' && <MultiplayerMenu />}
      {screen === 'controls' && <div className="screen center"><ControlsGuide onClose={() => go(returnTo)} /></div>}
      {screen === 'settings' && <div className="screen center"><SettingsPanel onClose={() => go(returnTo)} /></div>}
      {screen === 'room' && <RoomScreen />}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

// development-only test hook for browser automation; not shipped in production builds
if (import.meta.env.DEV) {
  (window as unknown as { __gilli: unknown }).__gilli = { get state() { return store.get(); }, get view() { return view; }, actions };
}
