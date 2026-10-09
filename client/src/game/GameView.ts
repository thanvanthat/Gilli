import * as THREE from 'three';
import type { ClientConfig, FieldLayout, GameEvent, MatchDto, RoomState, Snapshot } from '../net/types';
import type { GameClient } from '../net/GameClient';
import { World } from './scene/World';
import { Avatar } from './scene/Characters';
import { SnapshotBuffer, lerp, lerpAngle } from './Interpolator';
import { SwingRig, aimForward, ballisticPath, stepBallistic, throwVelocity, yawForward } from './rig';
import { SFX } from './audio';
import { textCanvas } from './scene/textures';
import type { Settings } from '../ui/settings';

export type Role = 'batter' | 'fielder' | 'thrower' | 'waiting' | 'spectator';

/** Values the React HUD shows; pushed ~12 times per second. */
export interface HudFeed {
  role: Role;
  prompt: string;
  subPrompt: string;
  gilliHeight: number | null;
  swingHeight: number;
  canCatch: boolean;
  throwPower: number | null;
  throwPitch: number;
  aim: number;
  fps: number;
  drawCalls: number;
  pointerLocked: boolean;
}

const INTERP_DELAY = 0.1;

/** Yield to the browser: next frame, or a short timer when the tab is hidden (rAF is paused there). */
const yieldFrame = () => new Promise<void>(resolve => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  requestAnimationFrame(finish);
  setTimeout(finish, 60);
});
const WALK = 4.2, SPRINT = 7.0;
const UP = new THREE.Vector3(0, 1, 0);

type CamMode = 'menu' | 'batter' | 'follow' | 'player' | 'thrower' | 'watch';

export class GameView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.05, 1200);
  world!: World;
  onHud: (f: HudFeed) => void = () => {};
  onRequestPause: () => void = () => {};
  onError: (msg: string) => void = () => {};

  private state: RoomState | null = null;
  private cfg: ClientConfig | null = null;
  private myId: string | null = null;
  private readonly buffer = new SnapshotBuffer();
  private readonly avatars = new Map<string, Avatar>();
  private active = false;
  private paused = false;
  private disposed = false;
  private raf = 0;
  private lastFrame = performance.now();
  private elapsed = 0;

  // objects
  private gilli!: THREE.Group;
  private danda!: THREE.Mesh;
  private targetDanda!: THREE.Mesh;
  private targetRing!: THREE.Mesh;
  private gilliMarker!: THREE.Sprite;
  private blob!: THREE.Mesh;
  private trail!: THREE.Line;
  private readonly trailPts = new Float32Array(48 * 3);
  private landingMark!: THREE.Group;
  private restMark!: THREE.Group;
  private rope!: THREE.Mesh;
  private ropeLabel: THREE.Sprite | null = null;
  private ropeLabelKey = '';
  private reachRing!: THREE.Mesh;
  private throwPreview!: THREE.Line;
  private readonly puffs: { mesh: THREE.Mesh; age: number }[] = [];

  // display state
  private readonly gPos = new THREE.Vector3(0, 0.022, 0);
  private readonly gQuat = new THREE.Quaternion();
  private readonly gOffset = new THREE.Vector3();
  private lastSeq = -1;
  private readonly dPos = new THREE.Vector3();
  private readonly dQuat = new THREE.Quaternion();
  private remoteSwing: { t0: number; aim: number } | null = null;
  private localSwing: { t0: number; aim: number } | null = null;

  // local control
  private readonly keys = new Set<string>();
  private readonly localPos = new THREE.Vector3();
  private localYaw = Math.PI;
  private localInit = false;
  private camYaw = Math.PI;
  private camPitch = 0.32;
  private camMode: CamMode = 'menu';
  private readonly camPos = new THREE.Vector3(30, 18, 30);
  private readonly camLook = new THREE.Vector3(0, 0, -20);
  private aim = 0;
  private aimSentAt = 0;
  private aimSent = 0;
  private moveSentAt = 0;
  private actionDown = false;
  private flickSentFor = -1;
  private swingSentFor = -1;
  private catchSentAt = -10;
  private throwYaw = 0;
  private throwPitch = 0.55;
  private throwCharge: number | null = null;
  private throwSentFor = -1;
  private attemptSeen = -1;
  private pointerLocked = false;
  private ignorePointerUnlock = false;
  private hudAt = 0;
  private fpsFrames = 0;
  private fpsAt = 0;
  private fps = 0;
  private settings: Settings;

  constructor(private readonly container: HTMLElement, private readonly net: GameClient, readonly layout: FieldLayout, settings: Settings) {
    this.settings = settings;
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { antialias: settings.quality !== 'low', powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL 2 is not available in this browser.');
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: settings.quality !== 'low' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = settings.quality !== 'low';
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.applyPixelRatio();
    canvas.className = 'game-canvas';
    canvas.tabIndex = -1;
    container.appendChild(canvas);
    canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.onError('The graphics context was lost. Reload the page to continue.'); });
  }

  /** Build the scene in steps (for the loading bar). */
  async build(progress: (p: number, label: string) => void) {
    this.world = new World(this.scene, this.layout);
    for (const [p, label] of this.world.build()) {
      progress(p * 0.9, label);
      await yieldFrame();
    }
    this.buildGameObjects();
    this.applySettings(this.settings);
    progress(0.95, 'Compiling shaders');
    await yieldFrame();
    this.renderer.compile(this.scene, this.camera);
    this.resize();
    progress(1, 'Ready');
    this.bindInput();
    new ResizeObserver(() => this.resize()).observe(this.container);
    this.loop();
  }

  private buildGameObjects() {
    const wood = new THREE.MeshStandardMaterial({ color: 0xd9a45b, roughness: 0.55, emissive: 0x3a2208, emissiveIntensity: 0.25 });
    this.gilli = new THREE.Group();
    // capsule axis along local Y, matching the BEPU capsule; ends taper like a real gilli
    const r = 0.022, L = 0.136;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, L * 0.7, 12), wood); this.gilli.add(body);
    [-1, 1].forEach(s => {
      const tip = new THREE.Mesh(new THREE.ConeGeometry(r, L * 0.15 + r, 12), wood);
      tip.position.y = s * (L * 0.35 + (L * 0.15 + r) / 2); if (s < 0) tip.rotation.x = Math.PI; this.gilli.add(tip);
    });
    this.gilli.traverse(o => { (o as THREE.Mesh).castShadow = true; });
    this.scene.add(this.gilli);

    const dandaMat = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.65 });
    this.danda = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.03, 0.74, 10), dandaMat);
    this.danda.castShadow = true; this.scene.add(this.danda);
    this.targetDanda = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.74, 10), dandaMat);
    this.targetDanda.rotation.z = Math.PI / 2; this.targetDanda.position.y = 0.025; this.targetDanda.castShadow = true;
    this.targetDanda.visible = false; this.scene.add(this.targetDanda);
    this.targetRing = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 48), new THREE.MeshBasicMaterial({ color: 0xf2c14e, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
    this.targetRing.rotation.x = -Math.PI / 2; this.targetRing.position.y = 0.03; this.targetRing.visible = false; this.scene.add(this.targetRing);

    const markerTex = textCanvas([{ text: '▼', font: '700 90px sans-serif', color: '#f2c14e', y: 64 }], 128, 128);
    this.gilliMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTex, depthTest: false, transparent: true }));
    this.gilliMarker.renderOrder = 30; this.scene.add(this.gilliMarker);

    this.blob = new THREE.Mesh(new THREE.CircleGeometry(0.25, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2; this.scene.add(this.blob);

    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(this.trailPts, 3));
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xfff6e0, transparent: true, opacity: 0.75 }));
    this.trail.frustumCulled = false; this.trail.visible = false; this.scene.add(this.trail);

    const cross = (color: number) => {
      const g = new THREE.Group();
      const m = new THREE.MeshBasicMaterial({ color, depthWrite: false, transparent: true, opacity: 0.9 });
      [Math.PI / 4, -Math.PI / 4].forEach(a => { const b = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.12), m); b.rotation.set(-Math.PI / 2, 0, a); b.position.y = 0.03; g.add(b); });
      g.visible = false; this.scene.add(g); return g;
    };
    this.landingMark = cross(0xf2c14e);
    this.restMark = cross(0xffffff);
    this.rope = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 1), new THREE.MeshBasicMaterial({ color: 0xf8efdc }));
    this.rope.visible = false; this.scene.add(this.rope);

    this.reachRing = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 40), new THREE.MeshBasicMaterial({ color: 0x9ee37d, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    this.reachRing.rotation.x = -Math.PI / 2; this.reachRing.visible = false; this.scene.add(this.reachRing);

    const pg = new THREE.BufferGeometry();
    this.throwPreview = new THREE.Line(pg, new THREE.LineDashedMaterial({ color: 0xf2c14e, dashSize: 0.4, gapSize: 0.25, transparent: true, opacity: 0.9 }));
    this.throwPreview.frustumCulled = false; this.throwPreview.visible = false; this.scene.add(this.throwPreview);
  }

  // ------------------------------------------------------------------ settings & lifecycle

  applySettings(s: Settings) {
    this.settings = s;
    this.applyPixelRatio();
    const shadows = s.quality !== 'low';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      this.scene.traverse(o => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
    }
    if (this.world) {
      const size = s.quality === 'high' ? 4096 : 2048;
      if (this.world.sun.shadow.mapSize.x !== size) {
        this.world.sun.shadow.mapSize.set(size, size);
        this.world.sun.shadow.map?.dispose();
        this.world.sun.shadow.map = null;
      }
    }
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
  }

  private applyPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(this.settings.quality === 'low' ? Math.min(dpr, 1) : this.settings.quality === 'medium' ? Math.min(dpr, 1.5) : Math.min(dpr, 2));
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setActive(active: boolean) {
    this.active = active;
    if (!active) { this.releasePointer(); this.keys.clear(); this.throwCharge = null; }
  }

  setPaused(p: boolean) {
    this.paused = p;
    if (p) { this.releasePointer(); this.keys.clear(); this.throwCharge = null; this.actionDown = false; }
  }

  private releasePointer() {
    if (document.pointerLockElement) { this.ignorePointerUnlock = true; document.exitPointerLock(); }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.unbind?.();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ------------------------------------------------------------------ network input

  setState(state: RoomState | null, myId: string | null) {
    const prevCode = this.state?.code;
    this.state = state;
    this.myId = myId;
    this.cfg = state?.config ?? this.cfg;
    if (!state) { this.syncAvatars([]); this.buffer.clear(); return; }
    if (prevCode !== state.code) { this.buffer.clear(); this.localInit = false; }
    if (this.cfg) this.targetRing.scale.setScalar(this.cfg.targetRadius);
    const players = state.phase === 'Playing' || state.phase === 'Finished' ? state.players.filter(p => !p.left) : [];
    this.syncAvatars(players);
    const m = state.match;
    if (m && m.attemptId !== this.attemptSeen) {
      this.attemptSeen = m.attemptId;
      this.aim = m.aim;
      this.localSwing = null; this.remoteSwing = null;
      this.throwCharge = null;
      this.trail.visible = false;
    }
    if (m && m.attemptPhase === 'AwaitThrow' && m.throwerId === myId && this.throwSentFor !== m.attemptId && m.rest) {
      this.throwYaw = Math.atan2(-m.rest.x, -m.rest.z);
    }
  }

  private syncAvatars(players: { id: string; name: string; team: 'A' | 'B' }[]) {
    const ids = new Set(players.map(p => p.id));
    for (const [id, av] of this.avatars) if (!ids.has(id)) { this.scene.remove(av.person.group); this.avatars.delete(id); }
    for (const p of players) {
      let av = this.avatars.get(p.id);
      if (!av) {
        av = new Avatar(p.id, p.name, p.team, p.id === this.myId);
        this.avatars.set(p.id, av);
        this.scene.add(av.person.group);
      }
      av.setTeam(p.team);
    }
  }

  onSnapshot(s: Snapshot) {
    this.buffer.push(s);
  }

  onEvent(e: GameEvent) {
    const d = e.data ?? {};
    switch (e.type) {
      case 'flick': SFX.flick(); break;
      case 'swing':
        if (this.role() !== 'batter') { this.remoteSwing = { t0: Number(d.t), aim: Number(d.aim) }; SFX.swish(); }
        break;
      case 'hit': {
        SFX.hit(Math.min(1, Number(d.speed) / 20));
        this.resetTrail(); this.trail.visible = true;
        // fielders: turn the camera to face the gilli once, to help track it
        if (this.role() === 'fielder') this.camYaw = Math.atan2(this.localPos.x - this.gPos.x, this.localPos.z - this.gPos.z);
        break;
      }
      case 'landed': SFX.thud(1); this.puff(Number(d.x), Number(d.z)); break;
      case 'caught': SFX.catch(); this.avatars.get(String(d.playerId))?.play('catch', 1.5); break;
      case 'throw': this.avatars.get(String(d.playerId))?.play('throw', 0.5); SFX.swish(); this.resetTrail(); this.trail.visible = true; break;
      case 'targetHit': SFX.danda(); break;
      case 'result': {
        const r = d.result as { outcome?: string; batterId?: string } | undefined;
        if (r?.outcome === 'Safe') { SFX.safe(); SFX.crowd(); this.world.cheer(2); this.avatars.get(String(r.batterId))?.play('celebrate', 1.6); }
        else if (r?.outcome === 'Out') { SFX.out(); this.world.cheer(1.2); }
        else SFX.miss();
        break;
      }
      case 'matchEnd': SFX.win(); this.world.cheer(3); break;
    }
  }

  private match(): MatchDto | null { return this.state?.phase === 'Playing' || this.state?.phase === 'Finished' ? this.state.match : null; }

  role(): Role {
    const m = this.match();
    if (!m || this.state?.phase !== 'Playing' || !this.myId) return 'spectator';
    if (m.batterId === this.myId) return 'batter';
    if (m.throwerId === this.myId && m.attemptPhase === 'AwaitThrow') return 'thrower';
    const me = this.state.players.find(p => p.id === this.myId);
    if (me && me.team === m.fieldingTeam) return 'fielder';
    return 'waiting';
  }

  // ------------------------------------------------------------------ input

  private unbind?: () => void;

  private bindInput() {
    const canvas = this.renderer.domElement;
    const typing = () => { const el = document.activeElement; return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'); };
    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.active || typing()) return;
      if (e.code === 'Escape' || e.code === 'KeyP') { if (!this.paused) { e.preventDefault(); this.onRequestPause(); } return; }
      if (this.paused) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat && (e.code === 'Space' || e.code === 'KeyF' || e.code === 'KeyC')) this.actionPress();
      this.keys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      if (e.code === 'Space' || e.code === 'KeyF' || e.code === 'KeyC') this.actionRelease();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (!this.active || this.paused) return;
      if (e.button !== 0) return;
      if (!document.pointerLockElement && this.settings.mouseLook) {
        try { void canvas.requestPointerLock()?.catch?.(() => { /* denied: keyboard still works */ }); } catch { /* unsupported */ }
        return; // the click that captures the mouse is not an action
      }
      this.actionPress();
    };
    const onMouseUp = (e: MouseEvent) => { if (e.button === 0) this.actionRelease(); };
    const onMouseMove = (e: MouseEvent) => {
      if (!this.active || this.paused || document.pointerLockElement !== canvas) return;
      const s = this.settings.sensitivity * 0.0022;
      const dy = (this.settings.invertY ? -1 : 1) * e.movementY;
      const role = this.role();
      if (role === 'batter' && this.match()?.attemptPhase === 'Ready') this.setAim(this.aim + e.movementX * s * 0.6);
      else if (role === 'thrower') { this.throwYaw -= e.movementX * s * 0.6; this.throwPitch = THREE.MathUtils.clamp(this.throwPitch - dy * s * 0.5, 0.1, 1.15); }
      else { this.camYaw -= e.movementX * s; this.camPitch = THREE.MathUtils.clamp(this.camPitch + dy * s, -0.15, 1.2); }
    };
    const onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === canvas;
      if (!this.pointerLocked && this.active && !this.paused && !this.ignorePointerUnlock) this.onRequestPause();
      this.ignorePointerUnlock = false;
    };
    const onBlur = () => { this.keys.clear(); this.actionRelease(); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('blur', onBlur);
    this.unbind = () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onLockChange);
      window.removeEventListener('blur', onBlur);
    };
  }

  /** Space / click / tap: flick, swing, catch or start charging a throw, depending on role. */
  actionPress() {
    const m = this.match();
    if (!m || this.paused || !this.active || this.state?.phase !== 'Playing') return;
    this.actionDown = true;
    switch (this.role()) {
      case 'batter':
        if (m.attemptPhase === 'Ready' && this.flickSentFor !== m.attemptId) {
          this.flickSentFor = m.attemptId;
          void this.net.flick(m.attemptId).then(r => { if (!r.ok) this.onError(r.error ?? 'Flick rejected'); });
        } else if (m.attemptPhase === 'Popped' && this.swingSentFor !== m.attemptId) {
          this.swingSentFor = m.attemptId;
          this.localSwing = { t0: performance.now() / 1000, aim: this.aim };
          SFX.swish();
          void this.net.swing(m.attemptId).then(r => { if (!r.ok) this.onError(r.error ?? 'Swing rejected'); });
        }
        break;
      case 'fielder': {
        const now = performance.now() / 1000;
        if (now - this.catchSentAt < 0.35) return;
        this.catchSentAt = now;
        this.avatars.get(this.myId!)?.play('catch', 0.5);
        if (m.attemptPhase === 'InFlight' || m.attemptPhase === 'Popped') void this.net.catchGilli(m.attemptId);
        break;
      }
      case 'thrower':
        if (m.attemptPhase === 'AwaitThrow' && this.throwSentFor !== m.attemptId) this.throwCharge = 0;
        break;
    }
  }

  actionRelease() {
    if (!this.actionDown) return;
    this.actionDown = false;
    const m = this.match();
    if (this.throwCharge !== null && m && this.role() === 'thrower' && this.throwSentFor !== m.attemptId) {
      const power = this.chargeToPower(this.throwCharge);
      this.throwCharge = null;
      this.throwSentFor = m.attemptId;
      this.avatars.get(this.myId!)?.play('throw', 0.5);
      void this.net.throwGilli(m.attemptId, this.throwYaw, this.throwPitch, power).then(r => { if (!r.ok) { this.throwSentFor = -1; this.onError(r.error ?? 'Throw rejected'); } });
    }
    this.throwCharge = null;
  }

  private chargeToPower(t: number) { const p = (t % 2.0) / 1.0; return p <= 1 ? p : 2 - p; }

  private setAim(a: number) {
    if (!this.cfg) return;
    this.aim = THREE.MathUtils.clamp(a, -this.cfg.maxAimAngle, this.cfg.maxAimAngle);
  }

  // ------------------------------------------------------------------ frame

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const nowMs = performance.now();
    const dt = Math.min((nowMs - this.lastFrame) / 1000, 0.1);
    this.lastFrame = nowMs;
    this.elapsed += dt;
    try {
      this.frame(dt);
      this.renderer.render(this.scene, this.camera);
    } catch (e) {
      console.error('[gilli] frame failed', e);
    }
    this.fpsFrames++;
    if (this.elapsed - this.fpsAt >= 0.5) { this.fps = Math.round(this.fpsFrames / (this.elapsed - this.fpsAt)); this.fpsFrames = 0; this.fpsAt = this.elapsed; }
  };

  private frame(dt: number) {
    const m = this.match();
    const cfg = this.cfg;
    const role = this.role();
    const sNow = this.net.serverNow();
    this.world.update(dt, this.elapsed);

    if (!m || !cfg) {
      this.updateMenuCamera(dt);
      for (const v of [this.gilli, this.danda, this.blob, this.gilliMarker, this.trail, this.landingMark, this.restMark, this.rope, this.reachRing, this.throwPreview, this.targetDanda, this.targetRing]) v.visible = false;
      if (this.ropeLabel) this.ropeLabel.visible = false;
      this.emitHud(role, m, null);
      return;
    }
    this.gilli.visible = true; this.danda.visible = true; this.blob.visible = true;

    this.updateLocalControl(dt, role, m, cfg);
    this.updateGilli(dt, role, m, cfg, sNow);
    this.updateDanda(role, m, cfg, sNow);
    this.updatePlayers(dt, m, sNow);
    this.updateMarkers(m, cfg, role);
    this.updatePuffs(dt);
    this.updateCamera(dt, role, m);
    this.emitHud(role, m, cfg);
  }

  private updateLocalControl(dt: number, role: Role, m: MatchDto, cfg: ClientConfig) {
    const me = this.myId;
    if (!me || this.paused) return;
    const latest = this.buffer.latest;
    const server = latest?.p.find(p => p.id === me);
    if (server && !this.localInit) { this.localPos.set(server.x, 0, server.z); this.localYaw = server.yaw; this.localInit = true; }

    if (role === 'batter') {
      if (m.attemptPhase === 'Ready') {
        let a = this.aim;
        if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) a -= 0.9 * dt;
        if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) a += 0.9 * dt;
        this.setAim(a);
        const now = performance.now() / 1000;
        if (Math.abs(this.aim - this.aimSent) > 0.002 && now - this.aimSentAt > 0.1) { this.aimSent = this.aim; this.aimSentAt = now; void this.net.aim(this.aim); }
      }
      const rig = new SwingRig(cfg, m.attemptPhase === 'Ready' ? this.aim : m.aim);
      this.localPos.copy(rig.batterFeet); this.localYaw = rig.batterYaw;
      return;
    }
    if (role === 'thrower') {
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) this.throwYaw += 0.8 * dt;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) this.throwYaw -= 0.8 * dt;
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.throwPitch = Math.min(1.15, this.throwPitch + 0.6 * dt);
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.throwPitch = Math.max(0.1, this.throwPitch - 0.6 * dt);
      if (this.throwCharge !== null) this.throwCharge += dt;
      if (server) this.localPos.set(server.x, 0, server.z);
      this.localYaw = this.throwYaw;
      return;
    }

    // free movement (fielders and waiting batsmen), camera-relative
    if (this.keys.has('KeyQ')) this.camYaw += 1.8 * dt;
    if (this.keys.has('KeyE')) this.camYaw -= 1.8 * dt;
    let fx = 0, fz = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) fz += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) fz -= 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) fx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) fx += 1;
    if (fx || fz) {
      const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
      const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
      const dir = fwd.multiplyScalar(fz).addScaledVector(right, fx).normalize();
      const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? SPRINT : WALK;
      const nx = this.localPos.x + dir.x * speed * dt, nz = this.localPos.z + dir.z * speed * dt;
      const [cx, cz] = this.world.constrain(nx, nz, 0.4);
      this.localPos.set(cx, 0, cz);
      this.localYaw = lerpAngle(this.localYaw, Math.atan2(dir.x, dir.z), Math.min(1, dt * 12));
    }
    // reconcile: if the server disagrees a lot (teleport, rejected step), take the server's position
    if (server && Math.hypot(server.x - this.localPos.x, server.z - this.localPos.z) > 2.5) this.localPos.set(server.x, 0, server.z);
    const now = performance.now() / 1000;
    if (now - this.moveSentAt > 1 / 15) { this.moveSentAt = now; this.net.move(this.localPos.x, this.localPos.z, this.localYaw); }
  }

  private updateGilli(dt: number, role: Role, m: MatchDto, cfg: ClientConfig, sNow: number) {
    const latest = this.buffer.latest;
    if (!latest) return;
    const target = new THREE.Vector3(), tq = new THREE.Quaternion();
    const airborne = latest.air && !latest.held && (latest.ap === 'Popped' || latest.ap === 'InFlight' || latest.ap === 'Throwing');
    if (airborne) {
      // ballistic prediction from the newest authoritative state; the batter sees it half a round trip ahead
      const lead = role === 'batter' && latest.ap === 'Popped' ? this.net.rtt / 2 : 0;
      let rem = THREE.MathUtils.clamp(sNow + lead - latest.t, 0, 0.35);
      target.set(latest.g[0], latest.g[1], latest.g[2]);
      tq.set(latest.g[3], latest.g[4], latest.g[5], latest.g[6]);
      const v = new THREE.Vector3(latest.gv[0], latest.gv[1], latest.gv[2]);
      const w = new THREE.Vector3(latest.gv[3], latest.gv[4], latest.gv[5]);
      const total = rem;
      while (rem > 1e-4) { const h = Math.min(rem, 1 / 120); stepBallistic(cfg, target, v, h); rem -= h; }
      if (target.y < cfg.gilliRadius) target.y = cfg.gilliRadius;
      const wl = w.length();
      if (wl > 1e-3) tq.premultiply(new THREE.Quaternion().setFromAxisAngle(w.divideScalar(wl), wl * total));
    } else {
      const s = this.buffer.sample(sNow - INTERP_DELAY);
      if (!s) return;
      const { a, b, alpha } = s;
      target.set(lerp(a.g[0], b.g[0], alpha), lerp(a.g[1], b.g[1], alpha), lerp(a.g[2], b.g[2], alpha));
      tq.set(a.g[3], a.g[4], a.g[5], a.g[6]).slerp(new THREE.Quaternion(b.g[3], b.g[4], b.g[5], b.g[6]), alpha);
    }
    // smooth over corrections when a new snapshot changes the prediction
    if (latest.seq !== this.lastSeq) {
      const shown = this.gPos.clone();
      this.lastSeq = latest.seq;
      const err = shown.sub(target);
      this.gOffset.copy(err.length() < 1.5 && this.gilli.visible ? err : new THREE.Vector3());
    }
    this.gOffset.multiplyScalar(Math.exp(-dt * 14));
    this.gPos.copy(target).add(this.gOffset);
    this.gQuat.slerp(tq, Math.min(1, dt * 30));
    this.gilli.position.copy(this.gPos);
    this.gilli.quaternion.copy(this.gQuat);

    // helpers: ground shadow, overhead marker (scaled with distance), trail
    const h = Math.max(0, this.gPos.y);
    this.blob.position.set(this.gPos.x, 0.025, this.gPos.z);
    const s = THREE.MathUtils.clamp(1 - h / 10, 0.35, 1);
    this.blob.scale.setScalar(s); (this.blob.material as THREE.MeshBasicMaterial).opacity = 0.35 * s;
    const camDist = this.camera.position.distanceTo(this.gPos);
    this.gilliMarker.visible = camDist > 7 && m.attemptPhase !== 'Ready';
    this.gilliMarker.position.copy(this.gPos).add(new THREE.Vector3(0, 0.25 + camDist * 0.02, 0));
    this.gilliMarker.scale.setScalar(Math.max(0.25, camDist * 0.025));
    if (this.trail.visible) {
      this.trailPts.copyWithin(3, 0, this.trailPts.length - 3);
      this.trailPts[0] = this.gPos.x; this.trailPts[1] = this.gPos.y; this.trailPts[2] = this.gPos.z;
      (this.trail.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      if (m.attemptPhase === 'Ready' || m.attemptPhase === 'AwaitThrow') this.trail.visible = false;
    }
  }

  private resetTrail() {
    for (let i = 0; i < this.trailPts.length; i += 3) { this.trailPts[i] = this.gPos.x; this.trailPts[i + 1] = this.gPos.y; this.trailPts[i + 2] = this.gPos.z; }
  }

  private updateDanda(role: Role, m: MatchDto, cfg: ClientConfig, sNow: number) {
    const target = m.targetPresent;
    this.targetDanda.visible = target;
    this.targetRing.visible = target || m.attemptPhase === 'AwaitThrow';
    this.danda.visible = !target;
    if (target) return;

    const swing = role === 'batter' ? this.localSwing : this.remoteSwing;
    const swingT = swing ? (role === 'batter' ? performance.now() / 1000 - swing.t0 : sNow - swing.t0) : -1;
    if (swing && swingT >= 0 && swingT < new SwingRig(cfg, swing.aim).duration + 0.25) {
      const rig = new SwingRig(cfg, swing.aim);
      rig.pose(rig.angleAt(swingT), this.dPos, this.dQuat);
    } else if (role === 'batter' && m.attemptPhase === 'Ready') {
      const rig = new SwingRig(cfg, this.aim);
      rig.pose(cfg.swingStartAngle, this.dPos, this.dQuat);
    } else {
      const s = this.buffer.sample(sNow - INTERP_DELAY);
      if (s) {
        const { a, b, alpha } = s;
        this.dPos.set(lerp(a.d[0], b.d[0], alpha), lerp(a.d[1], b.d[1], alpha), lerp(a.d[2], b.d[2], alpha));
        this.dQuat.set(a.d[3], a.d[4], a.d[5], a.d[6]).slerp(new THREE.Quaternion(b.d[3], b.d[4], b.d[5], b.d[6]), alpha);
      }
    }
    this.danda.position.copy(this.dPos);
    this.danda.quaternion.copy(this.dQuat);
  }

  private updatePlayers(dt: number, m: MatchDto, sNow: number) {
    const s = this.buffer.sample(sNow - INTERP_DELAY);
    for (const [id, av] of this.avatars) {
      const pos = new THREE.Vector3();
      let yaw = 0;
      if (id === this.myId && this.localInit) { pos.copy(this.localPos); yaw = this.localYaw; }
      else if (s) {
        const pa = s.a.p.find(p => p.id === id), pb = s.b.p.find(p => p.id === id) ?? pa;
        if (!pa || !pb) continue;
        pos.set(lerp(pa.x, pb.x, s.alpha), 0, lerp(pa.z, pb.z, s.alpha));
        yaw = lerpAngle(pa.yaw, pb.yaw, s.alpha);
      } else continue;
      // batting stance: hold the danda grip; thrower: wind-up pose
      if (id === m.batterId && !m.targetPresent) {
        const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(this.dQuat);
        av.grip = this.dPos.clone().addScaledVector(dir, -0.33);
        if (av.mode !== 'celebrate') av.mode = 'bat';
      } else if (av.mode === 'bat') { av.mode = 'idle'; av.grip = null; }
      if (id === m.throwerId && m.attemptPhase === 'AwaitThrow' && av.mode !== 'throw') av.mode = 'throwAim';
      else if (av.mode === 'throwAim') av.mode = 'idle';
      av.update(dt, pos, yaw);
      av.tag.visible = id !== this.myId; // never draw your own name over your view
    }
  }

  private updateMarkers(m: MatchDto, cfg: ClientConfig, role: Role) {
    const showMeasure = !!m.rest && (m.attemptPhase === 'AwaitThrow' || m.attemptPhase === 'Throwing' || m.attemptPhase === 'Result');
    this.landingMark.visible = !!m.landing && m.attemptPhase !== 'Ready';
    if (m.landing) this.landingMark.position.set(m.landing.x, 0, m.landing.z);
    this.restMark.visible = showMeasure;
    this.rope.visible = showMeasure;
    if (showMeasure && m.rest) {
      this.restMark.position.set(m.rest.x, 0, m.rest.z);
      const len = Math.hypot(m.rest.x, m.rest.z);
      this.rope.scale.z = len; this.rope.position.set(m.rest.x / 2, 0.03, m.rest.z / 2); this.rope.rotation.y = Math.atan2(m.rest.x, m.rest.z);
      const dandas = Math.floor(Math.round(m.rest.distance * 100) / 100 / cfg.dandaLength + 1e-6);
      const key = `${m.attemptId}:${m.rest.distance.toFixed(2)}`;
      if (key !== this.ropeLabelKey) {
        this.ropeLabelKey = key;
        if (this.ropeLabel) { this.scene.remove(this.ropeLabel); this.ropeLabel.material.map?.dispose(); this.ropeLabel.material.dispose(); }
        const tex = textCanvas([{ text: `${m.rest.distance.toFixed(2)} m · ${dandas} dandas`, font: '700 40px "Hind Madurai", system-ui, sans-serif', color: '#f8efdc', y: 48 }], 512, 96,
          c => { c.fillStyle = 'rgba(42,26,16,0.85)'; c.beginPath(); c.roundRect(16, 12, 480, 72, 16); c.fill(); });
        this.ropeLabel = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
        this.ropeLabel.renderOrder = 25; this.ropeLabel.scale.set(4, 0.75, 1);
        this.scene.add(this.ropeLabel);
      }
      this.ropeLabel!.visible = role !== 'thrower'; // the thrower stands on the rest point: keep their view clear
      this.ropeLabel!.position.set(m.rest.x * 0.5, 1.6, m.rest.z * 0.5);
    } else if (this.ropeLabel) this.ropeLabel.visible = false;

    // catch reach for the local fielder while the gilli is in the air
    const me = this.avatars.get(this.myId ?? '');
    this.reachRing.visible = role === 'fielder' && m.attemptPhase === 'InFlight' && !m.landing && !!me;
    if (this.reachRing.visible) { this.reachRing.position.set(this.localPos.x, 0.035, this.localPos.z); this.reachRing.scale.setScalar(cfg.catchRadius); }

    // thrower's trajectory preview (same integrator as the server)
    this.throwPreview.visible = role === 'thrower' && !!m.rest;
    if (this.throwPreview.visible && m.rest) {
      const power = this.throwCharge !== null ? this.chargeToPower(this.throwCharge) : 0.5;
      const start = new THREE.Vector3(m.rest.x, cfg.throwReleaseHeight, m.rest.z);
      const pts = ballisticPath(cfg, start, throwVelocity(cfg, this.throwYaw, this.throwPitch, power), 5, 1 / 30);
      this.throwPreview.geometry.setFromPoints(pts);
      this.throwPreview.computeLineDistances();
      (this.throwPreview.material as THREE.LineDashedMaterial).opacity = this.throwCharge !== null ? 0.95 : 0.45;
    }
  }

  private puff(x: number, z: number) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    for (let i = 0; i < 6; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 6, 5), new THREE.MeshBasicMaterial({ color: 0xb87a55, transparent: true, opacity: 0.6, depthWrite: false }));
      mesh.position.set(x + (Math.random() - 0.5) * 0.3, 0.1, z + (Math.random() - 0.5) * 0.3);
      mesh.userData.v = new THREE.Vector3((Math.random() - 0.5) * 1.2, 0.6 + Math.random() * 0.5, (Math.random() - 0.5) * 1.2);
      this.scene.add(mesh);
      this.puffs.push({ mesh, age: 0 });
    }
  }

  private updatePuffs(dt: number) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      p.mesh.position.addScaledVector(p.mesh.userData.v as THREE.Vector3, dt);
      p.mesh.scale.setScalar(1 + p.age * 4);
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.6 - p.age);
      if (p.age > 0.7) { this.scene.remove(p.mesh); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); this.puffs.splice(i, 1); }
    }
  }

  // ------------------------------------------------------------------ camera

  private updateMenuCamera(dt: number) {
    const t = this.elapsed * 0.05;
    const desP = new THREE.Vector3(Math.sin(t) * 42, 15 + Math.sin(t * 0.7) * 3, -24 + Math.cos(t) * 42);
    const k = 1 - Math.exp(-dt * 1.5);
    this.camPos.lerp(desP, k); this.camLook.lerp(new THREE.Vector3(0, 1, -20), k);
    this.camera.position.copy(this.camPos); this.camera.lookAt(this.camLook);
  }

  private updateCamera(dt: number, role: Role, m: MatchDto) {
    const flying = m.attemptPhase === 'InFlight' || m.attemptPhase === 'Throwing' || (m.attemptPhase === 'Result' && this.camMode === 'follow');
    let mode: CamMode;
    if (role === 'batter') mode = flying ? 'follow' : 'batter';
    else if (role === 'thrower') mode = 'thrower';
    else if (role === 'fielder') mode = 'player';
    else if (this.state?.phase === 'Finished') mode = 'menu';
    else mode = flying ? 'follow' : 'watch';
    this.camMode = mode;

    const desP = new THREE.Vector3(), desL = new THREE.Vector3();
    let rate = 5;
    switch (mode) {
      case 'menu': this.updateMenuCamera(dt); return;
      case 'batter':
      case 'watch': {
        const F = aimForward(role === 'batter' ? this.aim : m.aim);
        const R = new THREE.Vector3(-F.z, 0, F.x);
        desP.copy(F).multiplyScalar(-4.6).addScaledVector(R, 1.5).add(new THREE.Vector3(0, 2.3, 0));
        desL.copy(F).multiplyScalar(7).add(new THREE.Vector3(0, 0.35, 0));
        rate = 6;
        break;
      }
      case 'follow': {
        const flat = new THREE.Vector3(this.gPos.x, 0, this.gPos.z);
        const dir = flat.lengthSq() > 4 ? flat.clone().normalize() : aimForward(m.aim);
        desP.copy(this.gPos).addScaledVector(dir, -8).add(new THREE.Vector3(0, 3.5, 0));
        desP.y = Math.max(desP.y, 2.2);
        desL.copy(this.gPos);
        rate = 4;
        break;
      }
      case 'player': {
        const target = this.localPos.clone().add(new THREE.Vector3(0, 1.5, 0));
        const dist = 5.5;
        desP.set(Math.sin(this.camYaw) * Math.cos(this.camPitch) * dist, Math.sin(this.camPitch) * dist, Math.cos(this.camYaw) * Math.cos(this.camPitch) * dist).add(target);
        desP.y = Math.max(desP.y, 0.6);
        desL.copy(target);
        rate = 12;
        break;
      }
      case 'thrower': {
        const fwd = yawForward(this.throwYaw);
        const target = this.localPos.clone().add(new THREE.Vector3(0, 1.6, 0));
        desP.copy(target).addScaledVector(fwd, -4.2).add(new THREE.Vector3(0, 1.1, 0));
        desL.copy(target).addScaledVector(fwd, 12);
        rate = 8;
        break;
      }
    }
    const k = 1 - Math.exp(-dt * rate);
    this.camPos.lerp(desP, k); this.camLook.lerp(desL, k);
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    void UP;
  }

  private emitHud(role: Role, m: MatchDto | null, cfg: ClientConfig | null) {
    if (this.elapsed - this.hudAt < 0.08) return;
    this.hudAt = this.elapsed;
    let prompt = '', sub = '';
    let canCatch = false;
    const ph = m?.attemptPhase;
    if (m && cfg && this.state?.phase === 'Playing') {
      switch (role) {
        case 'batter':
          if (ph === 'Ready') { prompt = 'SPACE / CLICK — flick the gilli'; sub = 'A / D or mouse to aim · then strike it in the air'; }
          else if (ph === 'Popped') { prompt = this.swingSentFor === m.attemptId ? 'Swinging…' : 'SPACE / CLICK — STRIKE!'; sub = 'Hit it near the top of its rise'; }
          else if (ph === 'InFlight') prompt = 'Run it out! Watch the fielders';
          else if (ph === 'AwaitThrow' || ph === 'Throwing') prompt = 'The fielder is throwing at your danda';
          break;
        case 'fielder': {
          const g = this.gPos;
          const d = Math.hypot(g.x - this.localPos.x, g.z - this.localPos.z);
          canCatch = ph === 'InFlight' && !m.landing && d <= cfg.catchRadius && g.y >= 0.15 && g.y <= cfg.catchMaxHeight;
          if (ph === 'InFlight' && !m.landing) { prompt = canCatch ? 'SPACE — CATCH IT!' : 'Run under the gilli · SPACE to catch'; sub = `${d.toFixed(1)} m away`; }
          else if (ph === 'Ready' || ph === 'Popped') { prompt = 'Fielding — WASD to move, Shift to sprint'; sub = 'Catch it before it lands to get the batter out'; }
          else if (ph === 'AwaitThrow') prompt = 'A teammate is throwing at the danda';
          break;
        }
        case 'thrower':
          prompt = this.throwCharge !== null ? 'Release to throw!' : 'HOLD SPACE / CLICK to charge · release to throw';
          sub = 'A / D aim · W / S height · hit the danda across the pit';
          break;
        case 'waiting': prompt = 'Waiting to bat — watch your teammate'; break;
      }
    }
    const throwPower = role === 'thrower' && this.throwCharge !== null ? this.chargeToPower(this.throwCharge) : null;
    this.onHud({
      role, prompt, subPrompt: sub,
      gilliHeight: m && (ph === 'Popped' || ph === 'Ready') ? this.gPos.y : null,
      swingHeight: cfg?.pivotHeight ?? 0.95, canCatch, throwPower, throwPitch: this.throwPitch, aim: this.aim,
      fps: this.fps, drawCalls: this.renderer.info.render.calls, pointerLocked: this.pointerLocked,
    });
  }
}
