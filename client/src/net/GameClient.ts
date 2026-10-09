import * as signalR from '@microsoft/signalr';
import type { ConnectionStatus, GameEvent, JoinResult, OpResult, RoomState, Snapshot } from './types';

/** Where the C# server lives. Empty = same origin (Vite dev proxy, or the server hosting the built site). */
export const SERVER_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? '';
export const HUB_URL = `${SERVER_URL}/hubs/game`;

const SESSION_KEY = 'gilli.session';

export interface Session { roomCode: string; playerId: string; token: string; name: string }

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(v: T) { for (const fn of [...this.listeners]) { try { fn(v); } catch (e) { console.error('[gilli] listener failed', e); } } }
}

/**
 * The only bridge between the browser and the authoritative C# server.
 * Sends intents (flick, swing, catch, throw, movement), receives state, events and snapshots,
 * keeps the room clock in sync and recovers the player's seat after a dropped connection.
 */
export class GameClient {
  readonly onState = new Emitter<RoomState>();
  readonly onEvent = new Emitter<GameEvent>();
  readonly onSnapshot = new Emitter<Snapshot>();
  readonly onStatus = new Emitter<ConnectionStatus>();
  readonly onSessionLost = new Emitter<string>();

  status: ConnectionStatus = 'idle';
  session: Session | null = null;
  lastState: RoomState | null = null;
  /** Estimated room clock = performance.now()/1000 + offset. */
  private clockOffset = 0;
  private clockSynced = false;
  rtt = 0.05;
  private conn: signalR.HubConnection | null = null;
  private syncTimer: number | undefined;
  private starting: Promise<void> | null = null;

  constructor() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) this.session = JSON.parse(raw) as Session;
    } catch { this.session = null; }
  }

  private setStatus(s: ConnectionStatus) { this.status = s; this.onStatus.emit(s); }

  /** Seconds on the room clock right now (estimated). */
  serverNow(): number { return performance.now() / 1000 + this.clockOffset; }

  async connect(): Promise<void> {
    if (this.conn && this.conn.state === signalR.HubConnectionState.Connected) return;
    if (this.starting) return this.starting;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(HUB_URL)
      .withAutomaticReconnect([0, 1000, 2000, 4000, 8000, 10000, 15000, 20000])
      .configureLogging(signalR.LogLevel.Warning)
      .build();
    conn.serverTimeoutInMilliseconds = 30000;
    conn.keepAliveIntervalInMilliseconds = 10000;
    conn.on('State', (s: RoomState) => this.handleState(s));
    conn.on('Event', (e: GameEvent) => this.onEvent.emit(e));
    conn.on('Snapshot', (s: Snapshot) => this.handleSnapshot(s));
    conn.onreconnecting(() => this.setStatus('reconnecting'));
    conn.onreconnected(async () => {
      this.setStatus('connected');
      await this.resumeSeat();
    });
    conn.onclose(() => { this.setStatus('disconnected'); window.clearInterval(this.syncTimer); });
    this.conn = conn;
    this.setStatus('connecting');
    this.starting = conn.start().then(() => {
      this.setStatus('connected');
      window.clearInterval(this.syncTimer);
      this.syncTimer = window.setInterval(() => void this.syncClock(), 4000);
    }).catch((e: unknown) => {
      this.setStatus('disconnected');
      this.conn = null;
      throw e;
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  private handleState(s: RoomState) {
    if (this.lastState && this.lastState.code === s.code && s.version <= this.lastState.version) return; // out of order
    if (!this.lastState || this.lastState.code !== s.code) { this.clockSynced = false; this.clockOffset = s.serverTime - performance.now() / 1000; }
    this.lastState = s;
    this.onState.emit(s);
  }

  private handleSnapshot(s: Snapshot) {
    // snapshots cannot come from the future: nudge the clock forward if they do
    const now = this.serverNow();
    if (!this.clockSynced || s.t > now + 0.005) this.clockOffset += (s.t + this.rtt / 2) - now;
    this.clockSynced = true;
    this.onSnapshot.emit(s);
  }

  private async syncClock() {
    if (!this.conn || this.conn.state !== signalR.HubConnectionState.Connected || !this.session) return;
    try {
      const t0 = performance.now() / 1000;
      const server = await this.conn.invoke<number>('Ping');
      const t1 = performance.now() / 1000;
      if (server < 0) return;
      const rtt = t1 - t0;
      this.rtt = this.rtt * 0.7 + rtt * 0.3;
      const target = server + rtt / 2 - t1;
      // blend gently unless far off
      this.clockOffset = Math.abs(target - this.clockOffset) > 0.25 ? target : this.clockOffset * 0.8 + target * 0.2;
      this.clockSynced = true;
    } catch { /* connection issues surface via status */ }
  }

  private async call<T = unknown>(method: string, ...args: unknown[]): Promise<OpResult<T>> {
    try {
      await this.connect();
      return await this.conn!.invoke<OpResult<T>>(method, ...args);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, code: 'NETWORK', error: `Cannot reach the Gilli server (${msg}).` };
    }
  }

  private saveSession(join: JoinResult, name: string) {
    this.session = { roomCode: join.roomCode, playerId: join.playerId, token: join.token, name };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session)); } catch { /* private mode */ }
    this.lastState = null;
    this.handleState(join.state);
    void this.syncClock();
  }

  clearSession() {
    this.session = null;
    this.lastState = null;
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  async createRoom(name: string, practice: boolean): Promise<OpResult<JoinResult>> {
    const r = await this.call<JoinResult>('CreateRoom', name, practice);
    if (r.ok && r.data) this.saveSession(r.data, name);
    return r;
  }

  /** Single player: you (and CPU teammates) against a CPU side, simulated on the server. */
  async createVsComputer(name: string, difficulty: string, teamSize: number): Promise<OpResult<JoinResult>> {
    const r = await this.call<JoinResult>('CreateVsComputer', name, difficulty, teamSize);
    if (r.ok && r.data) this.saveSession(r.data, name);
    return r;
  }

  async joinRoom(code: string, name: string): Promise<OpResult<JoinResult>> {
    const r = await this.call<JoinResult>('JoinRoom', code, name);
    if (r.ok && r.data) this.saveSession(r.data, name);
    return r;
  }

  /** Re-attach to our seat (after a reconnect or a page reload in the same tab). */
  async resumeSeat(): Promise<boolean> {
    const s = this.session;
    if (!s) return false;
    const r = await this.call<JoinResult>('Rejoin', s.roomCode, s.playerId, s.token);
    if (r.ok && r.data) { this.saveSession(r.data, s.name); return true; }
    if (r.code !== 'NETWORK') { this.clearSession(); this.onSessionLost.emit(r.error ?? 'Your seat in the room was lost.'); }
    return false;
  }

  async leaveRoom() {
    await this.call('LeaveRoom');
    this.clearSession();
  }

  setTeam(team: 'A' | 'B') { return this.call('SetTeam', team); }
  setReady(ready: boolean) { return this.call('SetReady', ready); }
  startMatch() { return this.call('StartMatch'); }
  chooseToss(bat: boolean) { return this.call('ChooseToss', bat); }
  playAgain() { return this.call('PlayAgain'); }
  backToLobby() { return this.call('BackToLobby'); }
  aim(aim: number) { return this.call('Aim', aim); }
  flick(attemptId: number) { return this.call('Flick', attemptId); }
  swing(attemptId: number) { return this.call('Swing', attemptId); }
  catchGilli(attemptId: number) { return this.call('Catch', attemptId); }
  throwGilli(attemptId: number, yaw: number, pitch: number, power: number) { return this.call('Throw', attemptId, yaw, pitch, power); }

  /** Fire-and-forget movement input (validated and clamped by the server). */
  move(x: number, z: number, yaw: number) {
    if (this.conn?.state === signalR.HubConnectionState.Connected) this.conn.send('Move', x, z, yaw).catch(() => { /* status handles it */ });
  }

  get playerId() { return this.session?.playerId ?? null; }
}

export const client = new GameClient();

export async function fetchJson<T>(path: string, timeoutMs = 6000): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SERVER_URL}${path}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}
