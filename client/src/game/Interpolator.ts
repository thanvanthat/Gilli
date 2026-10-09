import type { Snapshot } from '../net/types';

/** A buffer of authoritative snapshots, sampled behind the server clock for smooth motion. */
export class SnapshotBuffer {
  private buf: Snapshot[] = [];
  constructor(private readonly capacity = 90) {}

  push(s: Snapshot) {
    const last = this.buf[this.buf.length - 1];
    if (last && s.seq <= last.seq) return; // duplicate or out-of-order delivery
    if (last && s.t < last.t) this.buf.length = 0; // room clock restarted (new room)
    this.buf.push(s);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
  }

  clear() { this.buf.length = 0; }
  get latest(): Snapshot | undefined { return this.buf[this.buf.length - 1]; }
  get size() { return this.buf.length; }

  /**
   * The two snapshots around time t and the blend factor between them.
   * Before the first snapshot: the first; after the last: the last (caller may extrapolate).
   */
  sample(t: number): { a: Snapshot; b: Snapshot; alpha: number } | null {
    const n = this.buf.length;
    if (n === 0) return null;
    if (t <= this.buf[0].t) return { a: this.buf[0], b: this.buf[0], alpha: 0 };
    for (let i = n - 1; i >= 1; i--) {
      const a = this.buf[i - 1], b = this.buf[i];
      if (t >= a.t && t <= b.t) {
        const span = b.t - a.t;
        return { a, b, alpha: span > 1e-6 ? (t - a.t) / span : 1 };
      }
    }
    return { a: this.buf[n - 1], b: this.buf[n - 1], alpha: 0 };
  }
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Shortest-path angle interpolation. */
export function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
