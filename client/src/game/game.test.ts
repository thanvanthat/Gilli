import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SnapshotBuffer, lerpAngle, reconcileMove } from './Interpolator';
import { SwingRig, ballisticPath } from './rig';
import type { ClientConfig, Snapshot } from '../net/types';

const cfg: ClientConfig = {
  dandaLength: 0.75, catchRadius: 1.6, catchMaxHeight: 2.7, targetRadius: 1, maxMisses: 3, maxAttempts: 8,
  gilliRadius: 0.022, gilliLength: 0.136, dandaRadius: 0.025, dandaInner: 0.06, dandaOuter: 0.8,
  pivotHeight: 0.95, pivotSideOffset: 0.5, swingTilt: 0.4363, swingAngularSpeed: 32, swingStartAngle: -2.2689, swingEndAngle: 1.9199,
  maxAimAngle: 0.75, gravity: 9.81, airDrag: 0.012, throwMinSpeed: 6, throwMaxSpeed: 30, throwMinPitch: 0.05, throwMaxPitch: 1.2,
  throwReleaseHeight: 1.5, maxRunSpeed: 7.5, fixedStep: 1 / 120,
};

const snap = (seq: number, t: number, x: number): Snapshot => ({ seq, t, ap: 'InFlight', g: [x, 1, 0, 0, 0, 0, 1], gv: [0, 0, 0, 0, 0, 0], air: true, held: false, d: [0, 0, 0, 0, 0, 0, 1], p: [] });

describe('SnapshotBuffer', () => {
  it('interpolates between bracketing snapshots', () => {
    const b = new SnapshotBuffer();
    b.push(snap(1, 1.0, 0));
    b.push(snap(2, 1.1, 10));
    const s = b.sample(1.05)!;
    expect(s.a.seq).toBe(1);
    expect(s.b.seq).toBe(2);
    expect(s.alpha).toBeCloseTo(0.5);
  });
  it('drops duplicate and out-of-order snapshots', () => {
    const b = new SnapshotBuffer();
    b.push(snap(2, 1.1, 0));
    b.push(snap(1, 1.0, 0));
    b.push(snap(2, 1.1, 0));
    expect(b.size).toBe(1);
  });
  it('clamps to the newest snapshot when sampling past the end', () => {
    const b = new SnapshotBuffer();
    b.push(snap(1, 1, 0)); b.push(snap(2, 2, 5));
    expect(b.sample(9)!.a.seq).toBe(2);
  });
});

describe('rig mirror', () => {
  it('points the danda at the pit with forward-upward motion at phi = 0', () => {
    const rig = new SwingRig(cfg, 0);
    const d = rig.directionAt(0);
    expect(d.x).toBeCloseTo(1); // towards the pit
    const pos = new THREE.Vector3(), q = new THREE.Quaternion();
    rig.pose(0, pos, q);
    expect(pos.y).toBeCloseTo(0.95);
    expect(rig.tangent.z).toBeLessThan(0); // down the field
    expect(rig.tangent.y).toBeGreaterThan(0); // and upward
    expect(rig.duration).toBeCloseTo((1.9199 + 2.2689) / 32);
  });
});

describe('ballistic preview', () => {
  it('lands short of the drag-free range', () => {
    const v = new THREE.Vector3(0, Math.sin(Math.PI / 4), -Math.cos(Math.PI / 4)).multiplyScalar(20);
    const pts = ballisticPath(cfg, new THREE.Vector3(0, 0.03, 0), v);
    const range = -pts[pts.length - 1].z;
    expect(range).toBeLessThan(400 / 9.81);
    expect(range).toBeGreaterThan(25);
  });
});

it('lerpAngle takes the short way round', () => {
  expect(lerpAngle(3.1, -3.1, 0.5)).toBeCloseTo(Math.PI, 1);
});

describe('sprint reconciliation (regression: sprinting players were snapped back on slow connections)', () => {
  // client sprints at 7 m/s, sends a move every 1/15 s; the server applies each move 200 ms later and
  // its snapshot (10 Hz) reaches the client another 200 ms later: a 400 ms round trip (India to a US server with jitter)
  function simulate(serverClamp = Infinity) {
    const sent = new Map<number, { x: number; z: number }>();
    const applied: { t: number; seq: number; x: number }[] = [];
    let local = 0, serverX = 0, seq = 0, lastAck = 0, oldSnaps = 0, corrections = 0;
    for (let t = 0; t < 3; t += 1 / 60) {
      local += 7 / 60;
      if (Math.round(t * 60) % 4 === 0) { sent.set(++seq, { x: local, z: 0 }); applied.push({ t: t + 0.2, seq, x: local }); }
      while (applied.length && applied[0].t <= t) { const m = applied.shift()!; serverX = Math.min(m.x, serverClamp); lastAck = m.seq; }
      if (Math.round(t * 60) % 6 === 0 && t > 0.3) {
        const snapX = serverX; // arrives 200 ms later: compare against the local position then
        if (Math.abs(snapX - (local + 7 * 0.2)) > 2.5) oldSnaps++; // the old rule: distance from "now"
        const fix = reconcileMove(sent, lastAck, snapX, 0);
        if (fix) { corrections++; local += fix.dx; sent.clear(); }
      }
    }
    return { oldSnaps, corrections, local };
  }

  it('old rule rubber-bands a sprint at 400 ms latency; the sequenced rule does not', () => {
    const r = simulate();
    expect(r.oldSnaps).toBeGreaterThan(0);
    expect(r.corrections).toBe(0);
    expect(r.local).toBeGreaterThan(20);
  });

  it('a real server correction (rejected movement) is still applied', () => {
    const r = simulate(5); // the server refuses to let the player past x = 5
    expect(r.corrections).toBeGreaterThan(0);
    expect(r.local).toBeLessThan(5 + 7 * 0.5); // held at the wall, at most one round trip of running ahead (not 21 m)
  });
});
