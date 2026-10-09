import { useState } from 'react';
import { actions, go } from './controller';
import { store, useStore } from './store';
import type { Quality, Settings } from './settings';

export function Kolam({ size = 64 }: { size?: number }) {
  // a small dot-and-loop kolam motif used as the brand mark
  const dots = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) dots.push(<circle key={`${i}${j}`} cx={16 + i * 16} cy={16 + j * 16} r={2.2} />);
  return (
    <svg className="kolam" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <g fill="currentColor">{dots}</g>
      <g fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="24" cy="24" r="9" /><circle cx="40" cy="24" r="9" /><circle cx="24" cy="40" r="9" /><circle cx="40" cy="40" r="9" />
        <circle cx="32" cy="32" r="29" strokeDasharray="3 4" />
      </g>
    </svg>
  );
}

export function Title({ small = false }: { small?: boolean }) {
  return (
    <div className={small ? 'title small' : 'title'}>
      <Kolam size={small ? 40 : 64} />
      <div>
        <h1>GILLI</h1>
        <p className="tamil" lang="ta">கில்லி · கிட்டிப்புள்</p>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  const { progress, label } = useStore(s => s.loading);
  return (
    <div className="screen center loading">
      <Title />
      <div className="progress" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <p className="muted">{label}…</p>
    </div>
  );
}

export function ErrorScreen() {
  const fatal = useStore(s => s.fatal);
  return (
    <div className="screen center">
      <div className="card narrow">
        <Title small />
        <h2>Gilli can't start</h2>
        <p>{fatal}</p>
        <div className="row">
          <button className="btn primary" onClick={() => window.location.reload()}>Retry</button>
          <a className="btn ghost" href="/classic.html">Play the classic offline version</a>
        </div>
      </div>
    </div>
  );
}

export function MainMenu() {
  const conn = useStore(s => s.connection);
  return (
    <div className="screen menu-screen">
      <div className="menu-panel">
        <Title />
        <p className="tagline">The village street game of Tamil Nadu, in 3D. Flick the gilli, strike it far, and dodge the fielders.</p>
        <nav className="menu-buttons">
          <button className="btn primary big" onClick={() => go('play')}>Play</button>
          <button className="btn" onClick={() => { store.set({ returnTo: 'menu' }); go('controls'); }}>How to play</button>
          <button className="btn" onClick={() => { store.set({ returnTo: 'menu' }); go('settings'); }}>Settings</button>
        </nav>
        <p className="footnote">Server: <ConnectionChip status={conn === 'idle' ? 'connected' : conn} label={conn === 'idle' ? 'reachable' : undefined} /> · <a href="/classic.html">Classic version</a></p>
      </div>
    </div>
  );
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>Your name</span>
      <input value={value} maxLength={16} placeholder="e.g. Kavin" autoComplete="nickname"
        onChange={e => onChange(e.target.value)} />
    </label>
  );
}

function useName() {
  const settings = useStore(s => s.settings);
  const [name, setName] = useState(settings.name);
  const valid = name.trim().length >= 1 && name.trim().length <= 16 && !/[<>]/.test(name);
  const commit = () => { if (name !== settings.name) store.set({ settings: { ...settings, name: name.trim() } }); };
  return { name, setName, valid, commit };
}

export function PlayMenu() {
  const { name, setName, valid, commit } = useName();
  const busy = useStore(s => s.busy);
  const error = useStore(s => s.error);
  const [level, setLevel] = useState<'Easy' | 'Normal' | 'Hard'>('Normal');
  const [size, setSize] = useState(1);
  const levelNote = {
    Easy: 'Slow CPU fielders who drop half their catches and throw wide. The CPU batters miss often.',
    Normal: 'Steady CPU fielders and batters. A fair contest.',
    Hard: 'Fast fielders who rarely drop a catch and throw close to the danda. CPU batters time their strikes well.',
  }[level];
  return (
    <div className="screen center">
      <div className="card wide">
        <Title small />
        <h2>Play</h2>
        <NameField value={name} onChange={setName} />
        <section className="panel solo">
          <h3>Single player · vs Computer</h3>
          <p className="muted">A full match against CPU players: toss, two innings, catches, throws at the danda and a winner.
            {size > 1 ? ` Your ${size - 1} teammate${size > 2 ? 's are' : ' is'} CPU too.` : ''}</p>
          <div className="solo-options">
            <label className="field"><span>Difficulty</span>
              <div className="seg">
                {(['Easy', 'Normal', 'Hard'] as const).map(l => <button key={l} aria-pressed={level === l} onClick={() => setLevel(l)}>{l}</button>)}
              </div>
            </label>
            <label className="field"><span>Players per team</span>
              <div className="seg">
                {[1, 2, 3].map(n => <button key={n} aria-pressed={size === n} onClick={() => setSize(n)}>{n}</button>)}
              </div>
            </label>
          </div>
          <p className="hint">{levelNote}</p>
          <button className="btn primary big" disabled={!valid || busy} onClick={() => { commit(); void actions.startVsComputer(name.trim(), level, size); }}>
            {busy ? 'Starting…' : 'Play vs Computer'}
          </button>
        </section>
        <div className="choice-grid">
          <button className="choice" disabled={!valid || busy} onClick={() => { commit(); void actions.startPractice(name.trim()); }}>
            <strong>Practice</strong>
            <span>Bat alone on the maidan. Real physics, real scoring, no fielders. Three misses in a row ends the session.</span>
          </button>
          <button className="choice accent" disabled={!valid || busy} onClick={() => { commit(); go('multiplayer'); }}>
            <strong>Online multiplayer</strong>
            <span>2 or 4 players in two teams. Create a room and share the code.</span>
          </button>
        </div>
        {!valid && <p className="hint">Enter a name (1–16 characters) to play.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row"><button className="btn ghost" onClick={() => go('menu')}>Back</button></div>
      </div>
    </div>
  );
}

export function MultiplayerMenu() {
  const { name, setName, valid, commit } = useName();
  const [code, setCode] = useState('');
  const busy = useStore(s => s.busy);
  const error = useStore(s => s.error);
  const codeOk = /^[A-HJ-NP-Z2-9]{5}$/.test(code);
  return (
    <div className="screen center">
      <div className="card wide">
        <Title small />
        <h2>Online multiplayer</h2>
        <NameField value={name} onChange={setName} />
        <div className="split">
          <section className="panel">
            <h3>Create room</h3>
            <p className="muted">You will be the host. Share the 5-letter code with up to 3 friends.</p>
            <button className="btn primary" disabled={!valid || busy} onClick={() => { commit(); void actions.createRoom(name.trim(), false); }}>
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </section>
          <section className="panel">
            <h3>Join room</h3>
            <form onSubmit={e => { e.preventDefault(); if (valid && codeOk) { commit(); void actions.joinRoom(code, name.trim()); } }}>
              <label className="field">
                <span>Room code</span>
                <input className="code-input" value={code} maxLength={5} placeholder="ABCDE" autoCapitalize="characters" spellCheck={false}
                  onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
              </label>
              {code.length > 0 && !codeOk && <p className="hint">Codes are 5 letters/digits (no O, 0, I or 1).</p>}
              <button className="btn primary" type="submit" disabled={!valid || !codeOk || busy}>{busy ? 'Joining…' : 'Join room'}</button>
            </form>
          </section>
        </div>
        {!valid && <p className="hint">Enter a name (1–16 characters) first.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row"><button className="btn ghost" onClick={() => go('play')}>Back</button></div>
      </div>
    </div>
  );
}

export function ControlsGuide({ onClose }: { onClose: () => void }) {
  const cfg = useStore(s => s.room?.config);
  const unit = cfg?.dandaLength ?? 0.75;
  return (
    <div className="card wide scroll">
      <h2>How to play</h2>
      <div className="split">
        <section>
          <h3>Batting</h3>
          <ul className="keys">
            <li><kbd>A</kbd><kbd>D</kbd> / mouse — aim left or right</li>
            <li><kbd>Space</kbd> / click — <b>flick</b> the gilli up out of the pit</li>
            <li><kbd>Space</kbd> / click again — <b>strike</b> it while it is in the air</li>
          </ul>
          <p className="muted">The server simulates the real collision between danda and gilli. Strike near the top of its rise; the height gauge shows the swing height. Too early or too late and you miss.</p>
          <h3>Fielding</h3>
          <ul className="keys">
            <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> — run · <kbd>Shift</kbd> sprint</li>
            <li>Mouse (click the game to capture it) or <kbd>Q</kbd><kbd>E</kbd> — turn the camera</li>
            <li><kbd>Space</kbd> / <kbd>F</kbd> / click — catch (green ring = your reach)</li>
            <li>Throw: hold <kbd>Space</kbd> to charge, release · <kbd>A</kbd><kbd>D</kbd> aim, <kbd>W</kbd><kbd>S</kbd> height</li>
          </ul>
          <p className="muted"><kbd>Esc</kbd> / <kbd>P</kbd> — pause menu (the online match keeps running).</p>
        </section>
        <section>
          <h3>Rules used in this game</h3>
          <ul className="rules">
            <li>A toss decides who bats; the winner chooses bat or field.</li>
            <li>Each batter keeps batting until out. A missed strike, a gilli that drops, or a mishit (behind the line or under 2 m) is a <b>miss</b>.</li>
            <li><b>3 misses in a row</b> = out. A safe hit resets the miss count.</li>
            <li>A fielder <b>catching</b> the gilli before it lands = out.</li>
            <li>Otherwise the nearest fielder throws from where the gilli stopped. <b>Hitting the danda</b> across the pit (or landing within {cfg?.targetRadius ?? 1} m of it) = out.</li>
            <li>Missed throw = <b>safe</b>: points = floor(distance ÷ {unit} m danda) + 1 bonus.</li>
            <li>After {cfg?.maxAttempts ?? 8} attempts a batter retires. When every batter is done, the teams swap. The chasing team wins as soon as it passes the target.</li>
          </ul>
          <p className="muted">These are this game's chosen rules; village rules for Gilli-Danda / Kitti Pull vary across Tamil Nadu.</p>
        </section>
      </div>
      <div className="row"><button className="btn primary" onClick={onClose}>Got it</button></div>
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const s = useStore(st => st.settings);
  const set = (patch: Partial<Settings>) => actions.applySettings({ ...s, ...patch });
  return (
    <div className="card">
      <h2>Settings</h2>
      <div className="settings">
        <label className="field"><span>Graphics quality</span>
          <div className="seg">
            {(['low', 'medium', 'high'] as Quality[]).map(q => (
              <button key={q} aria-pressed={s.quality === q} onClick={() => set({ quality: q })}>{q[0].toUpperCase() + q.slice(1)}</button>
            ))}
          </div>
        </label>
        <label className="field"><span>Mouse sensitivity · {s.sensitivity.toFixed(1)}</span>
          <input type="range" min={0.2} max={3} step={0.1} value={s.sensitivity} onChange={e => set({ sensitivity: Number(e.target.value) })} />
        </label>
        <label className="field"><span>Field of view · {s.fov}°</span>
          <input type="range" min={45} max={75} step={1} value={s.fov} onChange={e => set({ fov: Number(e.target.value) })} />
        </label>
        <label className="field"><span>Sound volume · {Math.round(s.volume * 100)}%</span>
          <input type="range" min={0} max={1} step={0.05} value={s.volume} onChange={e => set({ volume: Number(e.target.value) })} />
        </label>
        <label className="check"><input type="checkbox" checked={s.mouseLook} onChange={e => set({ mouseLook: e.target.checked })} /> Capture the mouse for camera and aim</label>
        <label className="check"><input type="checkbox" checked={s.invertY} onChange={e => set({ invertY: e.target.checked })} /> Invert vertical mouse</label>
        <label className="check"><input type="checkbox" checked={s.showFps} onChange={e => set({ showFps: e.target.checked })} /> Show frame rate</label>
      </div>
      <div className="row"><button className="btn primary" onClick={onClose}>Done</button></div>
    </div>
  );
}

export function ConnectionChip({ status, label }: { status: string; label?: string }) {
  const text = label ?? ({ connected: 'Online', connecting: 'Connecting…', reconnecting: 'Reconnecting…', disconnected: 'Offline', idle: 'Not connected' } as Record<string, string>)[status] ?? status;
  return <span className={`chip conn-${status}`} role="status"><i />{text}</span>;
}
