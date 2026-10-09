import { useEffect, useState } from 'react';
import { client } from '../net/GameClient';
import { store, useStore } from './store';
import { ConnectionChip } from './screens';

function useServerCountdown(deadline: number | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick(x => x + 1), 250); return () => window.clearInterval(t); }, []);
  if (deadline == null) return null;
  return Math.max(0, Math.ceil(deadline - client.serverNow()));
}

/** In-game heads-up display. Everything shown comes from the authoritative room state. */
export function Hud() {
  const room = useStore(s => s.room)!;
  const hud = useStore(s => s.hud);
  const me = useStore(s => s.myId);
  const banner = useStore(s => s.banner);
  const conn = useStore(s => s.connection);
  const showFps = useStore(s => s.settings.showFps);
  const m = room.match!;
  const name = (id: string | null) => room.players.find(p => p.id === id)?.name ?? '—';
  const left = useServerCountdown(m.attemptPhase === 'Ready' || m.attemptPhase === 'AwaitThrow' ? m.deadline : null);
  const r = m.lastResult;
  const showResult = r && (m.attemptPhase === 'Result' || m.attemptPhase === 'Ready') && r.attemptId >= m.attemptId - 1;
  const target = m.innings === m.totalInnings && !room.practice ? m.scores[m.fieldingTeam === 'A' ? 0 : 1] + 1 : null;
  const battingIdx = m.battingTeam === 'A' ? 0 : 1;

  return (
    <div className="hud">
      <header className="hud-top">
        <div className="scoreboard" aria-label="Scores">
          {(['A', 'B'] as const).map((t, i) => (
            <div key={t} className={`sb-team team-${t} ${m.battingTeam === t ? 'batting' : ''}`}>
              <span className="sb-name">{room.mode === 'VsComputer' ? (t === 'A' ? 'You' : 'Computer') : `Team ${t}`}{m.battingTeam === t ? ' · batting' : room.practice ? '' : ' · fielding'}</span>
              <span className="sb-score">{m.scores[i]}</span>
            </div>
          ))}
          {target !== null && <div className="sb-target">Target {target} · need {Math.max(0, target - m.scores[battingIdx])}</div>}
        </div>

        <div className="turn-card">
          <div><span className="lbl">Batter</span><b>{name(m.batterId)}{m.batterId === me ? ' (you)' : ''}</b></div>
          <div><span className="lbl">Fielding</span><b>{room.practice ? 'Nobody' : `Team ${m.fieldingTeam}`}</b></div>
          <div><span className="lbl">Attempt</span><b>{m.attemptNumber}{m.maxAttempts > 0 ? ` / ${m.maxAttempts}` : ''}</b></div>
          <div><span className="lbl">Misses</span>
            <span className="dots" aria-label={`${m.misses} consecutive misses of ${m.maxMisses}`}>
              {Array.from({ length: m.maxMisses }, (_, i) => <i key={i} className={i < m.misses ? 'on' : ''} />)}
            </span>
          </div>
          {!room.practice && <div><span className="lbl">Innings</span><b>{m.innings} / {m.totalInnings}</b></div>}
        </div>

        <div className="hud-right">
          <div className="row">
            <ConnectionChip status={conn} />
            <span className="chip">Room {room.code}</span>
            <button className="btn small" onClick={() => store.set({ paused: true })} aria-label="Pause">❚❚ Pause</button>
          </div>
          {!room.practice && (
            <ul className="mini-players">
              {room.players.filter(p => !p.left).map(p => (
                <li key={p.id} className={`team-${p.team} ${p.connected ? '' : 'offline'}`}>
                  <i />{p.name}{p.id === me ? ' (you)' : ''}{p.id === m.batterId ? ' 🏏' : ''}{!p.connected ? ' · offline' : ''}
                </li>
              ))}
            </ul>
          )}
          {showFps && hud && <span className="chip">{hud.fps} fps · {hud.drawCalls} draws</span>}
        </div>
      </header>

      {showResult && r && (
        <aside className={`last-result ${r.outcome.toLowerCase()}`} aria-live="polite">
          <span className="lbl">Last attempt · {name(r.batterId)}</span>
          {r.outcome === 'Safe' ? (
            <>
              <b>Safe · +{r.points}</b>
              <span>Distance {r.distance.toFixed(2)} m{r.landing ? ` (landed ${r.landing.distance.toFixed(1)} m)` : ''}</span>
              <span>{r.distancePoints} danda{r.distancePoints === 1 ? '' : 's'} + {r.bonus} bonus</span>
            </>
          ) : (
            <>
              <b>{r.outcome === 'Out' ? (r.outKind === 'AttemptLimit' || r.outKind === 'Retired' ? 'Retired' : 'OUT') : 'Miss'}</b>
              <span>{r.reason}</span>
              {r.rest && <span>Gilli stopped {r.rest.distance.toFixed(2)} m out · no points</span>}
            </>
          )}
        </aside>
      )}

      {m.landing && (m.attemptPhase === 'InFlight' || m.attemptPhase === 'AwaitThrow' || m.attemptPhase === 'Throwing') && (
        <aside className="distance-card">
          <span className="lbl">Gilli</span>
          <b>{m.rest ? `${m.rest.distance.toFixed(2)} m` : `landed ${m.landing.distance.toFixed(1)} m`}</b>
          {m.rest && <span>{Math.floor(Math.round(m.rest.distance * 100) / 100 / room.config.dandaLength + 1e-6)} dandas if safe</span>}
          {m.attemptPhase === 'AwaitThrow' && <span>{name(m.throwerId)} throws{left !== null ? ` · ${left}s` : ''}</span>}
        </aside>
      )}

      {banner && (
        <div key={banner.id} className={`banner ${banner.kind}`} role="status">
          <div className="banner-title">{banner.title}</div>
          {banner.sub && <div className="banner-sub">{banner.sub}</div>}
        </div>
      )}

      {hud && hud.role === 'batter' && hud.gilliHeight !== null && (
        <div className="gauge" aria-label="Gilli height">
          <div className="gauge-band" style={{ bottom: `${(hud.swingHeight - 0.05) / 1.4 * 100}%`, height: `${0.1 / 1.4 * 100}%` }} />
          <div className="gauge-gilli" style={{ bottom: `${Math.min(1, hud.gilliHeight / 1.4) * 100}%` }} />
          <span>swing<br />height</span>
        </div>
      )}

      {hud && hud.role === 'thrower' && (
        <div className="power" aria-label="Throw power">
          <span className="lbl">Power</span>
          <div className="power-bar"><div style={{ width: `${(hud.throwPower ?? 0) * 100}%` }} /></div>
          <span className="lbl">Height {Math.round(hud.throwPitch * 57.3)}°</span>
        </div>
      )}

      {hud?.prompt && (
        <div className={`prompt ${hud.canCatch ? 'urgent' : ''}`}>
          <b>{hud.prompt}</b>
          {hud.subPrompt && <span>{hud.subPrompt}</span>}
          {left !== null && m.attemptPhase === 'Ready' && m.batterId === me && <span>{left}s to flick</span>}
          {hud.role !== 'batter' && hud.role !== 'thrower' && !hud.pointerLocked && <span className="hint-inline">Click the field to use the mouse for the camera</span>}
        </div>
      )}

    </div>
  );
}
