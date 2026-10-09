import * as THREE from 'three';
import type { ClientConfig } from '../net/types';

/**
 * Browser mirror of server/Gilli.Core/Physics/SwingRig.cs. Used only to draw the danda
 * smoothly during the 0.13 s swing and to preview aim; the server's simulation decides contact.
 */
export class SwingRig {
  readonly pivot: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly tangent: THREE.Vector3;
  constructor(readonly cfg: ClientConfig, readonly aim: number) {
    this.forward = aimForward(aim);
    this.right = new THREE.Vector3(Math.cos(aim), 0, Math.sin(aim));
    this.tangent = this.forward.clone().multiplyScalar(Math.cos(cfg.swingTilt)).add(new THREE.Vector3(0, Math.sin(cfg.swingTilt), 0));
    this.pivot = this.right.clone().multiplyScalar(-cfg.pivotSideOffset).add(new THREE.Vector3(0, cfg.pivotHeight, 0));
  }
  get duration() { return (this.cfg.swingEndAngle - this.cfg.swingStartAngle) / this.cfg.swingAngularSpeed; }
  angleAt(t: number) { return THREE.MathUtils.clamp(this.cfg.swingStartAngle + this.cfg.swingAngularSpeed * t, this.cfg.swingStartAngle, this.cfg.swingEndAngle); }
  directionAt(phi: number) { return this.right.clone().multiplyScalar(Math.cos(phi)).addScaledVector(this.tangent, Math.sin(phi)); }
  pose(phi: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion) {
    const d = this.directionAt(phi);
    outPos.copy(this.pivot).addScaledVector(d, (this.cfg.dandaInner + this.cfg.dandaOuter) / 2);
    outQuat.setFromUnitVectors(UP, d);
  }
  get batterFeet() { return new THREE.Vector3(this.pivot.x, 0, this.pivot.z).addScaledVector(this.right, -0.35); }
  get batterYaw() { return Math.atan2(this.right.x, this.right.z); }
}

const UP = new THREE.Vector3(0, 1, 0);

/** aim 0 = straight down the field (-Z); positive aims towards +X. */
export function aimForward(aim: number) { return new THREE.Vector3(Math.sin(aim), 0, -Math.cos(aim)); }

/** Player yaw convention shared with the server: forward = (sin yaw, 0, cos yaw). */
export function yawForward(yaw: number) { return new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)); }

export function throwVelocity(cfg: ClientConfig, yaw: number, pitch: number, power: number) {
  const p = THREE.MathUtils.clamp(pitch, cfg.throwMinPitch, cfg.throwMaxPitch);
  const speed = cfg.throwMinSpeed + (cfg.throwMaxSpeed - cfg.throwMinSpeed) * THREE.MathUtils.clamp(power, 0, 1);
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(p), Math.sin(p), Math.cos(yaw) * Math.cos(p)).multiplyScalar(speed);
}

/**
 * Same integrator the server's pose callbacks use (gravity + quadratic drag), for previews and
 * short extrapolation of an airborne gilli between snapshots. Returns points until ground contact.
 */
export function ballisticPath(cfg: ClientConfig, start: THREE.Vector3, velocity: THREE.Vector3, maxTime = 6, step = 1 / 60): THREE.Vector3[] {
  const p = start.clone(), v = velocity.clone();
  const pts = [p.clone()];
  for (let t = 0; t < maxTime; t += step) {
    stepBallistic(cfg, p, v, step);
    pts.push(p.clone());
    if (p.y <= cfg.gilliRadius) break;
  }
  return pts;
}

export function stepBallistic(cfg: ClientConfig, p: THREE.Vector3, v: THREE.Vector3, dt: number) {
  const speed = v.length();
  const drag = 1 - Math.min(speed * cfg.airDrag * dt, 0.5);
  v.y -= cfg.gravity * dt;
  v.multiplyScalar(drag);
  p.addScaledVector(v, dt);
}
