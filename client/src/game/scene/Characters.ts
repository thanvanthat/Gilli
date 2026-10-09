import * as THREE from 'three';

export const SAREE = [0xd6336c, 0x2a9d8f, 0xe9c46a, 0x8e44ad, 0xe76f51, 0x2e7d32];
export const SHIRT = [0xf3ece0, 0x4a7fb5, 0xb8a27a, 0x6d8f5a, 0xd8d3c6];
export const TEAM_COLORS = { A: 0xc2412d, B: 0x2f4a8a } as const;

export interface Person {
  group: THREE.Group;
  body: THREE.Group;      // everything above the feet (bobs while running)
  legL: THREE.Group; legR: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
  torso: THREE.Mesh; head: THREE.Mesh;
  cloth: THREE.MeshStandardMaterial;
  phase: number;
}

const skinMat = new THREE.MeshStandardMaterial({ color: 0x9a5f3c, roughness: 0.8 });
const hairMat = new THREE.MeshStandardMaterial({ color: 0x1d130d, roughness: 0.9 });
const veshtiMat = new THREE.MeshStandardMaterial({ color: 0xefe6d0, roughness: 0.9 });
const legGeo = new THREE.CylinderGeometry(0.075, 0.065, 0.85, 8); legGeo.translate(0, -0.425, 0);
const armGeo = new THREE.CylinderGeometry(0.055, 0.048, 0.62, 8); armGeo.translate(0, -0.31, 0);
const handGeo = new THREE.SphereGeometry(0.06, 8, 6); handGeo.translate(0, -0.64, 0);

/** Procedural low-poly villager / player. Limbs are pivot groups so they can be animated. */
export function makePerson(clothHex: number, opts: { woman?: boolean; shadows?: boolean } = {}): Person {
  const group = new THREE.Group();
  const body = new THREE.Group(); group.add(body);
  const cloth = new THREE.MeshStandardMaterial({ color: clothHex, roughness: 0.9 });
  const mkLeg = (s: number) => { const g = new THREE.Group(); g.position.set(0.1 * s, 0.86, 0); g.add(new THREE.Mesh(legGeo, skinMat)); body.add(g); return g; };
  const legL = mkLeg(-1), legR = mkLeg(1);
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.27, 0.45, 10), opts.woman ? cloth : veshtiMat);
  lower.position.y = 0.68; body.add(lower);
  if (opts.woman) { lower.scale.set(1.15, 1.9, 1.15); lower.position.y = 0.45; }
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.6, 10), cloth); torso.position.y = 1.18; body.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 14, 10), skinMat); head.position.y = 1.63; body.add(head);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.157, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), hairMat); hair.position.y = 1.65; body.add(hair);
  if (opts.woman) {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), hairMat); bun.position.set(0, 1.62, -0.15); body.add(bun);
    const pallu = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.7, 0.42), cloth); pallu.position.set(0.12, 1.2, 0); pallu.rotation.z = 0.5; body.add(pallu);
  }
  const mkArm = (s: number) => {
    const g = new THREE.Group(); g.position.set(0.27 * s, 1.44, 0);
    g.add(new THREE.Mesh(armGeo, skinMat)); g.add(new THREE.Mesh(handGeo, skinMat)); body.add(g); return g;
  };
  const armL = mkArm(-1), armR = mkArm(1);
  const cast = opts.shadows ?? true;
  group.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = cast; o.receiveShadow = false; } });
  return { group, body, legL, legR, armL, armR, torso, head, cloth, phase: Math.random() * 6 };
}

const DOWN = new THREE.Vector3(0, -1, 0);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();

/** Rotate an arm group so it points at a world-space target (used to hold the danda). */
export function pointArmAt(person: Person, arm: THREE.Group, worldTarget: THREE.Vector3, slerp = 1) {
  person.group.updateMatrixWorld(true);
  const shoulder = arm.getWorldPosition(new THREE.Vector3());
  tmpV.copy(worldTarget).sub(shoulder).normalize();
  // to the parent's (body) local frame
  tmpM.extractRotation(arm.parent!.matrixWorld).invert();
  tmpV.applyMatrix4(tmpM).normalize();
  tmpQ.setFromUnitVectors(DOWN, tmpV);
  arm.quaternion.slerp(tmpQ, slerp);
}

export type AnimMode = 'idle' | 'move' | 'bat' | 'throwAim' | 'throw' | 'catch' | 'celebrate';

/** A networked player: person model + name tag + procedural animation state machine. */
export class Avatar {
  readonly person: Person;
  readonly tag: THREE.Sprite;
  private run = 0;
  private actionTime = 0;
  mode: AnimMode = 'idle';
  speed = 0;
  /** world-space grip of the danda while batting */
  grip: THREE.Vector3 | null = null;
  private readonly lastPos = new THREE.Vector3();
  private hasLast = false;

  constructor(readonly id: string, name: string, team: 'A' | 'B', isLocal: boolean) {
    this.person = makePerson(TEAM_COLORS[team]);
    this.tag = makeNameTag(name, team, isLocal);
    this.tag.position.y = 2.15;
    this.person.group.add(this.tag);
  }

  setTeam(team: 'A' | 'B') { this.person.cloth.color.setHex(TEAM_COLORS[team]); }
  setName(name: string, team: 'A' | 'B', isLocal: boolean) {
    const old = this.tag.material.map; this.tag.material.map = makeNameTag(name, team, isLocal).material.map; old?.dispose(); this.tag.material.needsUpdate = true;
  }

  play(mode: AnimMode, duration = 0.6) { this.mode = mode; this.actionTime = duration; }

  /** Place the avatar and animate from its actual motion (works for both local and remote players). */
  update(dt: number, pos: THREE.Vector3, yaw: number) {
    const g = this.person.group;
    if (this.hasLast && dt > 0) {
      const v = tmpV.copy(pos).sub(this.lastPos).setY(0).length() / dt;
      this.speed += (Math.min(v, 12) - this.speed) * Math.min(1, dt * 10);
    }
    this.lastPos.copy(pos); this.hasLast = true;
    g.position.copy(pos);
    g.rotation.y = yaw;

    const p = this.person;
    if (this.actionTime > 0) { this.actionTime -= dt; if (this.actionTime <= 0 && (this.mode === 'throw' || this.mode === 'catch' || this.mode === 'celebrate')) this.mode = 'idle'; }

    // legs: idle / walk / run blend from speed
    const moving = this.speed > 0.4;
    const stride = Math.min(1, this.speed / 7);
    if (moving) {
      this.run += dt * (6 + this.speed * 1.4);
      const swing = Math.sin(this.run) * (0.35 + 0.55 * stride);
      p.legL.rotation.x = swing; p.legR.rotation.x = -swing;
      p.body.position.y = Math.abs(Math.sin(this.run)) * 0.05 * (0.5 + stride);
      p.body.rotation.x = 0.12 * stride;
    } else {
      p.legL.rotation.x *= 0.8; p.legR.rotation.x *= 0.8;
      p.body.position.y = Math.sin(performance.now() / 700 + p.phase) * 0.006; // breathing
      p.body.rotation.x *= 0.85;
    }

    // arms by mode
    switch (this.mode) {
      case 'bat':
        if (this.grip) { pointArmAt(p, p.armL, this.grip); pointArmAt(p, p.armR, this.grip); }
        p.legL.rotation.z = 0.12; p.legR.rotation.z = -0.12;
        break;
      case 'throwAim':
        p.armR.rotation.set(2.6, 0, 0.2); p.armL.rotation.set(-0.9, 0, -0.3);
        break;
      case 'throw': {
        const k = 1 - Math.max(0, this.actionTime) / 0.5;
        p.armR.rotation.set(2.6 - k * 4.2, 0, 0.1); p.armL.rotation.set(-0.4, 0, -0.2);
        break;
      }
      case 'catch':
        p.armL.rotation.set(-2.7, 0, -0.25); p.armR.rotation.set(-2.7, 0, 0.25);
        break;
      case 'celebrate': {
        const w = Math.sin(performance.now() / 90) * 0.4;
        p.armL.rotation.set(-2.8 + w, 0, -0.3); p.armR.rotation.set(-2.8 - w, 0, 0.3);
        break;
      }
      default: {
        const swing = moving ? -Math.sin(this.run) * (0.3 + 0.6 * stride) : 0;
        p.armL.rotation.set(-swing, 0, -0.06); p.armR.rotation.set(swing, 0, 0.06);
        p.legL.rotation.z = 0; p.legR.rotation.z = 0;
      }
    }
  }
}

function makeNameTag(name: string, team: 'A' | 'B', isLocal: boolean) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = team === 'A' ? 'rgba(194,65,45,0.92)' : 'rgba(47,74,138,0.92)';
  x.beginPath(); x.roundRect(8, 8, 240, 48, 14); x.fill();
  if (isLocal) { x.strokeStyle = '#f2c14e'; x.lineWidth = 5; x.stroke(); }
  x.fillStyle = '#fff8ea'; x.font = '700 30px "Hind Madurai", system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(isLocal ? `${name} (you)` : name, 128, 33, 228);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  s.scale.set(1.3, 0.325, 1); s.renderOrder = 20;
  return s;
}
