import type { EngineExports } from './localEngine';
import type { GameEvent, JoinResult, OpResult, RoomState, Snapshot } from './types';

/**
 * Peer-to-peer online play without a game server (used on Vercel).
 * The host's browser runs the authoritative C# room (WebAssembly); guests connect to it over WebRTC data
 * channels. /api/signal (a Vercel function + private Blob store) only relays one offer/answer per guest.
 *
 * Wire messages (JSON):
 *   guest -> host: {t:'join', name} | {t:'call', id, method, args} | {t:'move', args}
 *   host -> guest: {t:'joined', result} | {t:'reply', id, result} | {t:'state', s} | {t:'event', e} | {t:'snap', s}
 */

// Public STUN servers find each browser's internet address. Some strict networks (symmetric NAT, some mobile
// carriers) also need a TURN relay, which costs money; without one those players cannot connect.
const ICE: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun.cloudflare.com:3478' }];
const SIGNAL = '/api/signal';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const randomFrom = (alphabet: string, n: number) => Array.from(crypto.getRandomValues(new Uint32Array(n)), v => alphabet[v % alphabet.length]).join('');
export const randomRoomCode = () => randomFrom(CODE_ALPHABET, 5);
const randomPeerId = () => randomFrom('abcdefghijklmnopqrstuvwxyz0123456789', 20);

async function signalPost(body: object): Promise<{ ok: boolean; code?: string; error?: string }> {
  const r = await fetch(SIGNAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}
async function signalGet<T>(params: Record<string, string>): Promise<T & { ok: boolean; code?: string; error?: string }> {
  const r = await fetch(`${SIGNAL}?${new URLSearchParams(params)}`, { cache: 'no-store' });
  return r.json();
}

/** Non-trickle ICE: wait until all candidates are in the SDP, so one offer/answer exchange is enough. */
function iceGathered(pc: RTCPeerConnection, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve(); } };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, ms);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ host

interface Guest { pc: RTCPeerConnection; dc?: RTCDataChannel; playerId?: string; windowStart: number; count: number }

export class PeerHost {
  private readonly guests = new Map<string, Guest>();
  private pollTimer: number | undefined;
  private heartbeatTimer: number | undefined;
  private tickCount = 0;
  private stopped = false;

  constructor(private readonly engine: EngineExports, readonly code: string) {}

  /** Claim a free room code on the signaling service (retries on collision). */
  static async claimCode(): Promise<string> {
    for (let i = 0; i < 5; i++) {
      const code = randomRoomCode();
      const r = await signalPost({ op: 'host', room: code });
      if (r.ok) return code;
      if (r.code !== 'CODE_TAKEN') throw new Error(r.error ?? 'Could not open a room.');
    }
    throw new Error('Could not find a free room code. Try again.');
  }

  start() {
    const poll = async () => {
      if (this.stopped) return;
      try {
        const r = await signalGet<{ offers: { peer: string; sdp: string }[] }>({ op: 'offers', room: this.code });
        for (const o of r.offers ?? []) void this.accept(o.peer, o.sdp);
      } catch { /* transient network error: next poll retries */ }
      this.pollTimer = window.setTimeout(poll, 1500);
    };
    void poll();
    this.heartbeatTimer = window.setInterval(() => void signalPost({ op: 'host', room: this.code, refresh: true }).catch(() => {}), 60_000);
  }

  private async accept(peer: string, sdp: string) {
    if (this.guests.has(peer) || this.guests.size >= 3) return; // a room holds the host + 3 guests
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const g: Guest = { pc, windowStart: performance.now(), count: 0 };
    this.guests.set(peer, g);
    pc.ondatachannel = e => this.attach(peer, g, e.channel);
    pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) this.drop(peer); };
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      await iceGathered(pc);
      await signalPost({ op: 'answer', room: this.code, peer, sdp: pc.localDescription!.sdp });
    } catch { this.drop(peer); }
  }

  private attach(peer: string, g: Guest, dc: RTCDataChannel) {
    g.dc = dc;
    dc.onclose = () => this.drop(peer);
    dc.onmessage = e => {
      // flood cap: the host is also a player; a misbehaving guest must not freeze its browser
      const now = performance.now();
      if (now - g.windowStart > 1000) { g.windowStart = now; g.count = 0; }
      if (++g.count > 120 || typeof e.data !== 'string' || e.data.length > 16_384) { this.drop(peer); return; }
      let m: { t?: string; id?: number; name?: string; method?: string; args?: unknown[] };
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'join' && !g.playerId) {
        const result = JSON.parse(this.engine.Join(String(m.name ?? ''), `peer:${peer}`)) as OpResult<JoinResult>;
        if (result.ok && result.data) g.playerId = result.data.playerId;
        this.send(dc, { t: 'joined', result });
      } else if (m.t === 'call' && g.playerId && typeof m.method === 'string' && Array.isArray(m.args)) {
        if (m.method === 'Move') return; // moves use the 'move' message
        const result = JSON.parse(this.engine.CallAs(g.playerId, m.method, JSON.stringify(m.args)));
        this.send(dc, { t: 'reply', id: m.id, result });
      } else if (m.t === 'move' && g.playerId && Array.isArray(m.args)) {
        this.engine.CallAs(g.playerId, 'Move', JSON.stringify(m.args));
      }
    };
  }

  private send(dc: RTCDataChannel | undefined, msg: object) {
    if (dc?.readyState === 'open') { try { dc.send(JSON.stringify(msg)); } catch { /* channel closing */ } }
  }

  /** Called after every engine tick: share what the C# room produced with every connected guest. */
  broadcast(out: { state: RoomState | null; events: GameEvent[]; snapshot: Snapshot | null }) {
    const sendSnapshot = ++this.tickCount % 2 === 0; // 30 Hz is plenty for interpolation
    for (const g of this.guests.values()) {
      if (!g.playerId) continue;
      if (out.state) this.send(g.dc, { t: 'state', s: out.state });
      for (const e of out.events) this.send(g.dc, { t: 'event', e });
      if (sendSnapshot && out.snapshot) this.send(g.dc, { t: 'snap', s: out.snapshot });
    }
  }

  private drop(peer: string) {
    const g = this.guests.get(peer);
    if (!g) return;
    this.guests.delete(peer);
    if (g.playerId) this.engine.Disconnect(g.playerId);
    try { g.dc?.close(); g.pc.close(); } catch { /* already closed */ }
  }

  stop() {
    this.stopped = true;
    window.clearTimeout(this.pollTimer);
    window.clearInterval(this.heartbeatTimer);
    for (const peer of [...this.guests.keys()]) this.drop(peer);
    void signalPost({ op: 'close', room: this.code }).catch(() => {});
  }
}

// ------------------------------------------------------------------ guest

export class PeerGuest {
  onState: (s: RoomState) => void = () => {};
  onEvent: (e: GameEvent) => void = () => {};
  onSnapshot: (s: Snapshot) => void = () => {};
  onClose: () => void = () => {};
  rtt = 0.1;
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (r: OpResult) => void; at: number }>();
  private closedByUs = false;

  async connect(code: string, name: string): Promise<OpResult<JoinResult>> {
    const room = await signalGet<{ exists: boolean }>({ op: 'room', room: code });
    if (!room.ok) return { ok: false, code: room.code, error: room.error };
    if (!room.exists) return { ok: false, code: 'ROOM_NOT_FOUND', error: `No room with code ${code}.` };

    const peer = randomPeerId();
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE });
    const dc = this.dc = pc.createDataChannel('gilli', { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await iceGathered(pc);
    const sent = await signalPost({ op: 'offer', room: code, peer, sdp: pc.localDescription!.sdp });
    if (!sent.ok) { this.close(); return { ok: false, code: sent.code, error: sent.error }; }

    let answer: string | null = null;
    for (let i = 0; i < 25 && !answer; i++) {
      await sleep(1000);
      const r = await signalGet<{ pending?: boolean; sdp?: string }>({ op: 'answer', room: code, peer });
      if (r.sdp) answer = r.sdp;
    }
    if (!answer) { this.close(); return { ok: false, code: 'HOST_UNREACHABLE', error: 'The host did not answer. Is their game still open?' }; }
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });

    const opened = await Promise.race([
      new Promise<boolean>(resolve => { dc.onopen = () => resolve(true); }),
      sleep(15_000).then(() => false),
    ]);
    if (!opened) { this.close(); return { ok: false, code: 'P2P_FAILED', error: 'Could not connect directly to the host. One of your networks may block peer-to-peer connections (try another network or a mobile hotspot).' }; }

    dc.onclose = () => { if (!this.closedByUs) this.onClose(); };
    let joinResolve: (r: OpResult<JoinResult>) => void = () => {};
    const joined = new Promise<OpResult<JoinResult>>(resolve => { joinResolve = resolve; });
    dc.onmessage = e => {
      let m: { t: string; id?: number; result?: OpResult; s?: RoomState & Snapshot; e?: GameEvent };
      try { m = JSON.parse(e.data); } catch { return; }
      switch (m.t) {
        case 'joined': joinResolve(m.result as OpResult<JoinResult>); break;
        case 'reply': {
          const p = this.pending.get(m.id!);
          if (p) { this.pending.delete(m.id!); this.rtt = this.rtt * 0.8 + ((performance.now() - p.at) / 1000) * 0.2; p.resolve(m.result!); }
          break;
        }
        case 'state': this.onState(m.s!); break;
        case 'event': this.onEvent(m.e!); break;
        case 'snap': this.onSnapshot(m.s!); break;
      }
    };
    dc.send(JSON.stringify({ t: 'join', name }));
    return Promise.race([joined, sleep(10_000).then(() => ({ ok: false, code: 'HOST_UNREACHABLE', error: 'The host did not let you in.' }))]);
  }

  call<T = unknown>(method: string, args: unknown[]): Promise<OpResult<T>> {
    if (this.dc?.readyState !== 'open') return Promise.resolve({ ok: false, code: 'NETWORK', error: 'Not connected to the host.' });
    const id = ++this.nextId;
    this.dc.send(JSON.stringify({ t: 'call', id, method, args }));
    return Promise.race([
      new Promise<OpResult<T>>(resolve => this.pending.set(id, { resolve: resolve as (r: OpResult) => void, at: performance.now() })),
      sleep(10_000).then(() => { this.pending.delete(id); return { ok: false, code: 'NETWORK', error: 'The host did not respond.' } as OpResult<T>; }),
    ]);
  }

  move(args: unknown[]) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ t: 'move', args }));
  }

  close() {
    this.closedByUs = true;
    try { this.dc?.close(); this.pc?.close(); } catch { /* already closed */ }
  }
}
