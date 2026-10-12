// WebRTC signaling for peer-to-peer online games (no game server: the host's browser runs the C# room).
// Browsers swap one connection offer/answer each through this mailbox, then talk directly.
// Storage: private Vercel Blob store "gilli-signaling" (OIDC auth). Offers/answers are deleted when read.
// Untrusted input: every field is validated; SDP is size-capped. Nothing else is stored.
import { del, get, list, put } from '@vercel/blob';

const ROOM = /^[A-HJ-NP-Z2-9]{5}$/;   // same alphabet as the server's room codes
const PEER = /^[a-z0-9]{12,32}$/;
const MAX_SDP = 20_000;
const HOST_TTL_MS = 3 * 60_000;       // a host refreshes its marker every minute while the room is open
const opts = { access: 'private' };

const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status, code, error) => json(status, { ok: false, code, error });
const path = (room, name) => `rooms/${room}/${name}`;

async function readText(pathname) {
  const r = await get(pathname, { ...opts, useCache: false });
  return r?.statusCode === 200 ? await new Response(r.stream).text() : null;
}

async function hostAlive(room) {
  const { blobs } = await list({ prefix: path(room, 'host') });
  return blobs.some(b => Date.now() - new Date(b.uploadedAt).getTime() < HOST_TTL_MS);
}

export async function POST(request) {
  let m;
  try { m = JSON.parse((await request.text()).slice(0, 32_000)); } catch { return fail(400, 'INVALID_REQUEST', 'Bad JSON'); }
  if (!m || !ROOM.test(m.room ?? '')) return fail(400, 'INVALID_CODE', 'Room codes are 5 letters/digits.');
  const put1 = (name, body) => put(path(m.room, name), body, { ...opts, addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json' });
  switch (m.op) {
    case 'host': // register or refresh a room; refuse a code another live host owns
      if (m.refresh !== true && await hostAlive(m.room)) return fail(409, 'CODE_TAKEN', 'That room code is in use.');
      await put1('host', '{}');
      return json(200, { ok: true });
    case 'offer':
    case 'answer':
      if (!PEER.test(m.peer ?? '') || typeof m.sdp !== 'string' || m.sdp.length > MAX_SDP || !m.sdp.startsWith('v=0'))
        return fail(400, 'INVALID_REQUEST', 'Bad connection offer.');
      if (!await hostAlive(m.room)) return fail(404, 'ROOM_NOT_FOUND', `No room with code ${m.room}.`);
      await put1(`${m.op}-${m.peer}`, JSON.stringify({ peer: m.peer, sdp: m.sdp }));
      return json(200, { ok: true });
    case 'close': { // host leaving: remove everything for the room
      const { blobs } = await list({ prefix: `rooms/${m.room}/` });
      if (blobs.length) await del(blobs.map(b => b.pathname));
      return json(200, { ok: true });
    }
    default:
      return fail(400, 'INVALID_REQUEST', 'Unknown operation.');
  }
}

export async function GET(request) {
  const q = new URL(request.url).searchParams;
  const room = q.get('room') ?? '';
  if (!ROOM.test(room)) return fail(400, 'INVALID_CODE', 'Room codes are 5 letters/digits.');
  switch (q.get('op')) {
    case 'room':
      return json(200, { ok: true, exists: await hostAlive(room) });
    case 'offers': { // host collects new join requests
      const { blobs } = await list({ prefix: path(room, 'offer-') });
      const offers = (await Promise.all(blobs.map(b => readText(b.pathname)))).filter(Boolean).map(t => JSON.parse(t));
      if (blobs.length) await del(blobs.map(b => b.pathname));
      return json(200, { ok: true, offers });
    }
    case 'answer': { // a guest waits for the host's answer
      const peer = q.get('peer') ?? '';
      if (!PEER.test(peer)) return fail(400, 'INVALID_REQUEST', 'Bad peer id.');
      const text = await readText(path(room, `answer-${peer}`));
      if (!text) return json(200, { ok: true, pending: true });
      await del(path(room, `answer-${peer}`));
      return json(200, { ok: true, ...JSON.parse(text) });
    }
    default:
      return fail(400, 'INVALID_REQUEST', 'Unknown operation.');
  }
}
