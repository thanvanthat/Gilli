import { useEffect, useState } from 'react';
import { client } from '../net/GameClient';
import type { PlayerDto, RoomState, TeamId } from '../net/types';
import { actions } from './controller';
import { store, toast, useStore } from './store';
import { ConnectionChip, ControlsGuide, SettingsPanel, Title } from './screens';
import { Hud } from './hud';

function useCountdown(deadline: number | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick(x => x + 1), 250); return () => window.clearInterval(t); }, []);
  if (deadline == null) return null;
  return Math.max(0, Math.ceil(deadline - client.serverNow()));
}

export function RoomScreen() {
  const room = useStore(s => s.room);
  const overlay = useStore(s => s.overlay);
  const paused = useStore(s => s.paused);
  const conn = useStore(s => s.connection);
  if (!room) return <div className="screen center"><p className="muted">Joining room…</p></div>;
  const close = () => store.set({ overlay: 'none' });
  return (
    <>
      {room.phase === 'Lobby' && <Lobby room={room} />}
      {room.phase === 'Toss' && <Toss room={room} />}
      {room.phase === 'Playing' && <Hud />}
      {room.phase === 'Playing' && paused && overlay === 'none' && <PauseMenu room={room} />}
      {room.phase === 'Finished' && <Result room={room} />}
      {overlay !== 'none' && (
        <div className="screen center dim">
          {overlay === 'controls' ? <ControlsGuide onClose={close} /> : <SettingsPanel onClose={close} />}
        </div>
      )}
      {conn === 'disconnected' && (
        <div className="screen center dim">
          <div className="card narrow">
            <h2>Connection lost</h2>
            <p>The game server cannot be reached. Your seat is kept for a short time.</p>
            <div className="row">
              <button className="btn primary" onClick={() => void actions.retryConnection()}>Reconnect</button>
              <button className="btn ghost" onClick={() => void actions.leave()}>Main menu</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PlayerRow({ p, me, room }: { p: PlayerDto; me: string | null; room: RoomState }) {
  return (
    <li className={`player ${p.connected ? '' : 'offline'}`}>
      <span className={`dot ${p.connected ? 'on' : ''}`} title={p.connected ? 'Connected' : 'Disconnected'} />
      <span className="pname">{p.name}{p.id === me && <em> (you)</em>}</span>
      {p.isHost && <span className="tag host">Host</span>}
      {p.isBot && <span className="tag cpu">CPU</span>}
      {!p.connected && <span className="tag bad">Disconnected</span>}
      {room.phase === 'Lobby' && p.connected && !p.isHost && (p.ready ? <span className="tag ready">Ready</span> : <span className="tag">Not ready</span>)}
    </li>
  );
}

function Lobby({ room }: { room: RoomState }) {
  const me = useStore(s => s.myId);
  const conn = useStore(s => s.connection);
  const mine = room.players.find(p => p.id === me);
  const isHost = room.hostId === me;
  const teams: TeamId[] = ['A', 'B'];
  const count = (t: TeamId) => room.players.filter(p => p.team === t).length;
  const a = count('A'), b = count('B');
  const allReady = room.players.every(p => p.isHost || p.ready);
  const startProblem = room.practice ? null
    : room.players.length < 2 ? 'Share the room code: you need at least one more player.'
      : a !== b ? `Teams must be even (1 v 1 or 2 v 2). Team A has ${a}, Team B has ${b}.`
        : !allReady ? 'Waiting for every player to press Ready.'
          : room.players.some(p => !p.connected) ? 'A player is disconnected.' : null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(room.code); toast('Room code copied', 'good'); } catch { toast(`Room code: ${room.code}`); }
  };
  return (
    <div className="screen center">
      <div className="card wide">
        <div className="lobby-head">
          <Title small />
          <ConnectionChip status={conn} />
        </div>
        {room.mode === 'Online' && <div className="room-code">
          <span>Room code</span>
          <strong aria-label={`Room code ${room.code.split('').join(' ')}`}>{room.code}</strong>
          <button className="btn small" onClick={() => void copy()}>Copy</button>
        </div>}
        {room.mode === 'Online' && <p className="muted center-text">Friends join from <b>Play → Online multiplayer → Join room</b> on {window.location.host}.</p>}
        <div className="teams">
          {teams.map(t => (
            <section key={t} className={`team team-${t}`}>
              <header>
                <h3>Team {t}</h3>
                <span>{count(t)}/2</span>
              </header>
              <ul>
                {room.players.filter(p => p.team === t).map(p => <PlayerRow key={p.id} p={p} me={me} room={room} />)}
                {count(t) === 0 && <li className="empty">No players yet</li>}
              </ul>
              {mine && mine.team !== t && room.mode === 'Online' && (
                <button className="btn small" disabled={count(t) >= 2} onClick={() => void actions.run(client.setTeam(t))}>
                  {count(t) >= 2 ? 'Team full' : `Join Team ${t}`}
                </button>
              )}
            </section>
          ))}
        </div>
        <div className="row spread">
          <button className="btn ghost" onClick={() => void actions.leave()}>Leave room</button>
          <div className="row">
            {!isHost && mine && (
              <button className={`btn ${mine.ready ? '' : 'primary'}`} onClick={() => void actions.run(client.setReady(!mine.ready))}>
                {mine.ready ? 'Not ready' : 'Ready'}
              </button>
            )}
            {isHost && <button className="btn primary" disabled={!!startProblem} onClick={() => void actions.run(client.startMatch())}>Start match</button>}
          </div>
        </div>
        {startProblem && <p className="hint center-text">{isHost ? startProblem : `Host ${room.players.find(p => p.isHost)?.name ?? ''} starts the match. ${startProblem}`}</p>}
      </div>
    </div>
  );
}

function Toss({ room }: { room: RoomState }) {
  const me = useStore(s => s.myId);
  const toss = room.toss!;
  const left = useCountdown(toss.deadline);
  const chooser = room.players.find(p => p.id === toss.chooserId);
  const mine = room.players.find(p => p.id === me);
  const canChoose = toss.chooserId === me || (!chooser?.connected && mine?.team === toss.winnerTeam);
  const [flipped, setFlipped] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setFlipped(true), 1100); return () => window.clearTimeout(t); }, []);
  return (
    <div className="screen center">
      <div className="card narrow toss">
        <h2>The toss</h2>
        <div className={`coin ${flipped ? 'done' : 'spin'}`} aria-hidden="true">{flipped ? toss.winnerTeam : '?'}</div>
        {!flipped ? <p className="muted">The coin is in the air…</p> : (
          <>
            <p className="big-text">Team {toss.winnerTeam} won the toss</p>
            {canChoose ? (
              <>
                <p>Choose to bat or field first{left !== null ? ` · ${left}s` : ''}</p>
                <div className="row center-row">
                  <button className="btn primary big" onClick={() => void actions.run(client.chooseToss(true))}>Bat first</button>
                  <button className="btn big" onClick={() => void actions.run(client.chooseToss(false))}>Field first</button>
                </div>
              </>
            ) : <p className="muted">{chooser?.isBot ? `The computer (${chooser.name}) is choosing…` : `Waiting for ${chooser?.name ?? 'the captain'} to choose${left !== null ? ` · ${left}s` : ''}…`}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function PauseMenu({ room }: { room: RoomState }) {
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="screen center dim">
      <div className="card narrow">
        <h2>Paused</h2>
        <p className="muted">{room.mode === 'Online' ? 'The online match keeps running for everyone else.' : 'The game keeps running on the server while paused.'} Room {room.code}.</p>
        <nav className="menu-buttons">
          <button className="btn primary" onClick={() => store.set({ paused: false })}>Resume</button>
          <button className="btn" onClick={() => store.set({ overlay: 'controls' })}>Controls</button>
          <button className="btn" onClick={() => store.set({ overlay: 'settings' })}>Settings</button>
          {!confirm
            ? <button className="btn ghost" onClick={() => setConfirm(true)}>Leave match</button>
            : <button className="btn danger" onClick={() => void actions.leave()}>Leave for sure? {room.practice ? '' : 'You will forfeit your turns.'}</button>}
        </nav>
      </div>
    </div>
  );
}

function Result({ room }: { room: RoomState }) {
  const me = useStore(s => s.myId);
  const m = room.match!;
  const isHost = room.hostId === me;
  const name = (id: string) => room.players.find(p => p.id === id)?.name ?? 'Player';
  const vsCpu = room.mode === 'VsComputer';
  const headline = room.practice ? `Practice over: ${m.scores[0]} points`
    : vsCpu ? (m.winner === 'A' ? 'You beat the computer!' : m.winner === 'B' ? 'The computer wins!' : 'Match drawn')
    : m.winner ? `Team ${m.winner} wins!` : 'Match drawn';
  const myTeam = room.players.find(p => p.id === me)?.team;
  const sub = room.practice ? 'Three misses in a row ends a practice session.'
    : m.winner ? (myTeam === m.winner ? 'Your team won. Well batted!' : 'Your team lost this one.') + (m.chaseCompleted ? ' Target chased.' : '')
      : 'Both teams finished level.';
  return (
    <div className="screen center dim">
      <div className="card wide result">
        <p className="eyebrow">Match result</p>
        <h1 className={m.winner ? `win-${m.winner}` : ''}>{headline}</h1>
        <p>{sub}</p>
        {!room.practice && (
          <div className="final">
            {(['A', 'B'] as TeamId[]).map((t, i) => (
              <div key={t} className={`final-team team-${t} ${m.winner === t ? 'winner' : ''}`}>
                <span>{vsCpu ? (t === 'A' ? 'Your team' : 'Computer') : `Team ${t}`}</span>
                <b>{m.scores[i]}</b>
              </div>
            ))}
          </div>
        )}
        <table className="stats">
          <thead><tr><th>Player</th><th>Team</th><th>Points</th><th>Safe hits</th><th>Longest</th><th>How out</th></tr></thead>
          <tbody>
            {Object.entries(m.stats).map(([id, s]) => (
              <tr key={id}>
                <td>{name(id)}{id === me ? ' (you)' : ''}</td>
                <td>{m.lineups.A.includes(id) ? 'A' : 'B'}</td>
                <td>{s.points}</td><td>{s.safeHits}</td><td>{s.longest > 0 ? `${s.longest.toFixed(2)} m` : '—'}</td>
                <td>{({ None: 'Not out', ThreeMisses: '3 misses', Caught: 'Caught', TargetHit: 'Danda hit', Retired: 'Left', AttemptLimit: 'Retired' } as Record<string, string>)[s.out] ?? s.out}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row spread">
          <button className="btn ghost" onClick={() => void actions.leave()}>Main menu</button>
          <div className="row">
            {isHost ? (
              <>
                {room.mode === 'Online' && <button className="btn" onClick={() => void actions.run(client.backToLobby())}>Return to lobby</button>}
                <button className="btn primary" onClick={() => void actions.run(client.playAgain())}>Play again</button>
              </>
            ) : <p className="muted">Waiting for the host to play again or return to the lobby…</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
