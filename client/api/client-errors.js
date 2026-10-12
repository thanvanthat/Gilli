// Bug reports from players' browsers (same contract as the C# server's POST /api/client-errors).
// Logged as "ClientError" in Vercel's function logs. Untrusted input: size-capped, truncated, line breaks stripped, never stored.
// ponytail: no per-IP rate limit here (stateless function); Vercel's platform limits apply. Add a KV-backed limiter if spammed.
const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n).replace(/\s+/g, ' ') : '');

export async function POST(request) {
  try {
    const r = JSON.parse((await request.text()).slice(0, 4096));
    if (r && typeof r.message === 'string' && r.message.trim())
      console.warn(`ClientError ${clip(r.message, 300)} | page ${clip(r.url, 200)} | browser ${clip(request.headers.get('user-agent'), 160)} | stack ${clip(r.stack, 1500)}`);
  } catch { /* not a report */ }
  return new Response(null, { status: 204 });
}
