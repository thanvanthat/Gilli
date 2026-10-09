import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { SnapshotBuffer, lerpAngle } from './Interpolator';
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
