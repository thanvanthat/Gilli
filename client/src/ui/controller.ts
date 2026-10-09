import { client, fetchJson, SERVER_URL } from '../net/GameClient';
import type { FieldLayout, GameEvent, ResultDto, RoomState } from '../net/types';
import { GameView } from '../game/GameView';
import { setVolume, SFX, unlockAudio } from '../game/audio';
import { showBanner, store, toast, type Screen } from './store';
import type { Settings } from './settings';

/** The single GameView instance (Three.js lives outside React). */
export let view: GameView | null = null;

function webglSupported(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch { return false; }
}

const nameOf = (s: RoomState | null, id: string | null | undefined) => s?.players.find(p => p.id === id)?.name ?? 'Someone';

let booted = false;
export async function boot(container: HTMLElement) {
  if (booted) return; // React StrictMode runs effects twice in development: build the scene once
  booted = true;
  if (!webglSupported()) {
    store.set({ screen: 'error', fatal: 'Your browser cannot run Gilli: WebGL 2 is not available. Use a current Chrome, Edge, Firefox or Safari with hardware acceleration enabled.' });
    return;
  }
  setVolume(store.get().settings.volume);
  store.set({ loading: { progress: 0.02, label: 'Contacting the Gilli server' } });
  let layout: FieldLayout;
  try {
    layout = await fetchJson<FieldLayout>('/api/layout');
  } catch (e) {
    store.set({
      screen: 'error',
      fatal: `Cannot reach the Gilli game server${SERVER_URL ? ` at ${SERVER_URL}` : ''}. Start the C# backend (see README: "dotnet run --project server/Gilli.Server") and press Retry. (${e instanceof Error ? e.message : e})`,
    });
    return;
  }
  store.set({ layout });
  try {
    view?.dispose();
    view = new GameView(container, client, layout, store.get().settings);
    view.onHud = hud => store.set({ hud });
    view.onRequestPause = () => store.set({ paused: true });
    view.onError = msg => toast(msg, 'bad');
    await view.build((progress, label) => store.set({ loading: { progress, label } }));
  } catch (e) {
    console.error('[gilli] scene build failed', e);
    store.set({ screen: 'error', fatal: `The 3D scene could not be created: ${e instanceof Error ? e.message : e}` });
    return;
  }
  wireClient();
  store.set({ screen: 'menu' });

  // a reload in the same tab resumes the seat
  if (client.session) {
    store.set({ busy: true });
    const ok = await client.resumeSeat().catch(() => false);
    store.set({ busy: false });
    if (ok) { store.set({ screen: 'room', myId: client.playerId }); toast('Reconnected to your room', 'good'); }
  }
}

let wired = false;
function wireClient() {
  if (wired) return; // never register listeners twice
  wired = true;
  client.onStatus.on(status => {
    store.set({ connection: status });
    if (status === 'reconnecting') toast('Connection lost: reconnecting…', 'bad');
  });
  client.onState.on(s => {
    const prev = store.get().room;
    store.set({ room: s, myId: client.playerId });
    view?.setState(s, client.playerId);
    if (prev?.phase !== s.phase) {
      if (s.phase === 'Playing') store.set({ paused: false });
      if (s.phase === 'Toss') SFX.coin();
    }
    syncActive();
  });
  client.onSnapshot.on(s => view?.onSnapshot(s));
  client.onEvent.on(e => handleEvent(e));
  client.onSessionLost.on(msg => {
    toast(msg, 'bad', 5000);
    store.set({ room: null, screen: 'menu' });
    view?.setState(null, null);
    syncActive();
  });
  store.subscribe(syncActive);
}

function syncActive() {
  const s = store.get();
  const active = s.screen === 'room' && s.room?.phase === 'Playing' && s.overlay === 'none';
  view?.setActive(active);
  view?.setPaused(s.paused || s.overlay !== 'none');
}

function handleEvent(e: GameEvent) {
  view?.onEvent(e);
  const room = store.get().room;
  const feed = [...store.get().feed.slice(-5), e];
  store.set({ feed });
  const d = e.data ?? {};
  switch (e.type) {
    case 'join': case 'leave': case 'disconnect': case 'reconnect': case 'host': case 'forfeit':
      toast(e.text, e.type === 'join' || e.type === 'reconnect' ? 'good' : 'info');
      break;
    case 'innings':
      if (room?.practice) showBanner('Practice', 'Flick, then strike the gilli in the air', 'info', 2400);
      else if (room?.mode === 'VsComputer') showBanner(d.battingTeam === 'A' ? 'Your team bats' : 'The computer bats', d.battingTeam === 'A' ? 'Flick, then strike the gilli in the air' : 'Field: catch it or hit the danda with your throw', 'info', 2600);
      else showBanner(`Team ${String(d.battingTeam)} to bat`, `Innings ${String(d.innings)}`, 'info', 2400);
      break;
    case 'result': {
      const r = d.result as ResultDto;
      const batter = nameOf(room, r.batterId);
      if (r.outcome === 'Safe') showBanner(`SAFE! +${r.points}`, `${batter}: ${r.distance.toFixed(2)} m = ${r.distancePoints} danda${r.distancePoints === 1 ? '' : 's'} + ${r.bonus} bonus`, 'good', 3000);
      else if (r.outcome === 'Miss') showBanner(`MISS ${r.missesAfter}/${room?.config.maxMisses ?? 3}`, `${batter}: ${r.reason}`, 'info', 2400);
      else if (r.outKind === 'Retired' || r.outKind === 'AttemptLimit') showBanner('RETIRED', `${batter}: ${r.reason}`, 'info', 3000);
      else showBanner('OUT!', `${batter}: ${r.reason}`, 'bad', 3000);
      break;
    }
    case 'throwTurn':
      if (d.playerId === client.playerId) showBanner('Your throw!', 'Hit the danda across the pit to get the batter out', 'info', 2400);
      break;
  }
}

// ------------------------------------------------------------------ actions used by screens

export function go(screen: Screen) { SFX.click(); unlockAudio(); store.set({ screen, error: null }); }

async function enterRoom(p: Promise<{ ok: boolean; error?: string | null; code?: string | null }>) {
  store.set({ busy: true, error: null });
  unlockAudio();
  const r = await p;
  store.set({ busy: false });
  if (!r.ok) { store.set({ error: r.error ?? 'Something went wrong.' }); return false; }
  store.set({ screen: 'room', myId: client.playerId, paused: false, overlay: 'none', feed: [] });
  return true;
}

export const actions = {
  createRoom: (name: string, practice: boolean) => enterRoom(client.createRoom(name, practice)),
  joinRoom: (code: string, name: string) => enterRoom(client.joinRoom(code, name)),
  async startVsComputer(name: string, difficulty: string, teamSize: number) {
    if (!(await enterRoom(client.createVsComputer(name, difficulty, teamSize)))) return;
    const r = await client.startMatch();
    if (!r.ok) toast(r.error ?? 'Could not start the match', 'bad');
  },
  async startPractice(name: string) {
    if (!(await enterRoom(client.createRoom(name, true)))) return;
    const r = await client.startMatch();
    if (!r.ok) toast(r.error ?? 'Could not start practice', 'bad');
  },
  async leave() {
    store.set({ busy: true });
    await client.leaveRoom();
    view?.setState(null, null);
    store.set({ busy: false, room: null, screen: 'menu', paused: false, overlay: 'none' });
  },
  async run(p: Promise<{ ok: boolean; error?: string | null }>) {
    SFX.click();
    const r = await p;
    if (!r.ok) toast(r.error ?? 'Request rejected', 'bad');
    return r.ok;
  },
  async retryConnection() {
    try {
      await client.connect();
      const ok = await client.resumeSeat();
      if (ok) toast('Reconnected', 'good');
    } catch { toast('Still cannot reach the server', 'bad'); }
  },
  applySettings(s: Settings) {
    store.set({ settings: s });
    setVolume(s.volume);
    view?.applySettings(s);
  },
};
