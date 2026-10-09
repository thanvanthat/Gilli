// End-to-end smoke test against a RUNNING Gilli server (two real SignalR clients).
// Usage:  node scripts/smoke-test.mjs [http://localhost:5080]
// Exits non-zero if any check fails.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../client/package.json', import.meta.url));
const signalR = require('@microsoft/signalr');

const base = (process.argv[2] ?? 'http://localhost:5080').replace(/\/$/, '');
let failures = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect(name) {
  const states = [], events = [];
  const conn = new signalR.HubConnectionBuilder().withUrl(`${base}/hubs/game`).configureLogging(signalR.LogLevel.Error).build();
  conn.on('State', s => { states.push(s); });
  conn.on('Event', e => { events.push(e); });
  conn.on('Snapshot', () => {});
  await conn.start();
  return { name, conn, states, events, get state() { return states[states.length - 1]; } };
}
async function until(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(25); }
  throw new Error('timed out waiting for ' + what);
}

try {
  const health = await (await fetch(`${base}/health`)).json();
  check(health.status === 'ok', 'GET /health', JSON.stringify(health));

  const a = await connect('Arun'), b = await connect('Bala');
  const created = await a.conn.invoke('CreateRoom', 'Arun', false);
  check(created.ok, 'create room', created.data?.roomCode);
  const code = created.data.roomCode;

  const bad = await b.conn.invoke('JoinRoom', 'QQQQQ', 'Bala');
  check(!bad.ok && bad.code === 'ROOM_NOT_FOUND', 'unknown room code is rejected', bad.error);
  const joined = await b.conn.invoke('JoinRoom', code, 'Bala');
  check(joined.ok, 'second client joins', code);
  await until(() => a.state?.players.length === 2, 3000, 'host sees guest');
  check(true, 'host sees both players', a.state.players.map(p => `${p.name}(${p.team})`).join(', '));

  check((await b.conn.invoke('StartMatch')).code === 'NOT_HOST', 'non-host cannot start');
  await b.conn.invoke('SetReady', true);
  check((await a.conn.invoke('StartMatch')).ok, 'host starts match');
  await until(() => a.state?.phase === 'Toss', 3000, 'toss');
  const toss = a.state.toss;
  const chooser = toss.chooserId === created.data.playerId ? a : b;
  const chooserTeam = a.state.players.find(p => p.id === toss.chooserId).team;
  await chooser.conn.invoke('ChooseToss', chooserTeam === 'A'); // Team A bats
  await until(() => a.state?.phase === 'Playing' && b.state?.phase === 'Playing', 3000, 'playing');
  check(a.state.match.battingTeam === 'A', 'toss choice applied', `Team ${toss.winnerTeam} won, A bats`);

  // a timed strike: flick, then swing 0.29 s later (the server simulates the collision)
  const id = a.state.match.attemptId;
  // time the swing from when the flick is SENT: both messages then cross the network with the same delay,
  // so the server sees them 0.29 s apart however far away it is (awaiting the flick's reply would add a round trip)
  const flick = a.conn.invoke('Flick', id);
  await sleep(290);
  const swingCall = a.conn.invoke('Swing', id);
  check((await flick).ok, 'flick accepted');
  const sw = await swingCall;
  check(sw.ok, 'swing accepted');
  // rejected either as a duplicate or, over a slow network, because the gilli has already left the bat
  const again = await a.conn.invoke('Swing', id);
  check(!again.ok && ['DUPLICATE_ACTION', 'BAD_PHASE', 'STALE_ATTEMPT'].includes(again.code), 'second swing in the same attempt is rejected', again.code);
  await until(() => ['AwaitThrow', 'Result'].includes(b.state?.match.attemptPhase), 12000, 'gilli to stop');
  const m = b.state.match;
  check(m.attemptPhase === 'AwaitThrow' && m.rest?.distance > 2, 'hit simulated: gilli flew and stopped', `landed ${m.landing?.distance.toFixed(2)} m, rested ${m.rest?.distance.toFixed(2)} m`);

  // Bala throws badly on purpose -> safe
  await b.conn.invoke('Throw', id, 0, 0.2, 0.05);
  await until(() => a.state?.match.attemptPhase === 'Result' && b.state?.match.attemptPhase === 'Result', 9000, 'result');
  const ra = a.state.match.lastResult, rb = b.state.match.lastResult;
  const expected = Math.floor(ra.distance / a.state.config.dandaLength + 1e-6) + 1;
  check(ra.outcome === 'Safe', 'missed throw is safe', ra.reason);
  check(ra.points === expected, 'points = floor(distance / danda) + 1', `${ra.distance} m -> ${ra.points} (expected ${expected})`);
  check(JSON.stringify(ra) === JSON.stringify(rb), 'both clients received the identical authoritative result');
  check(a.state.match.scores[0] === ra.points && b.state.match.scores[0] === ra.points, 'scoreboard consistent on both clients', String(a.state.match.scores));
  await sleep(1500);
  check(a.state.match.scores[0] === ra.points, 'no duplicate scoring after the attempt');

  await b.conn.stop();
  await until(() => a.state.players.some(p => !p.connected), 4000, 'disconnect');
  check(true, 'disconnect is broadcast to the room');

  await a.conn.invoke('LeaveRoom');
  await a.conn.stop();
  const metrics = await (await fetch(`${base}/api/metrics`)).json();
  console.log('metrics', JSON.stringify(metrics));
} catch (e) {
  check(false, 'smoke test aborted', e.message);
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed');
process.exit(failures ? 1 : 0);
