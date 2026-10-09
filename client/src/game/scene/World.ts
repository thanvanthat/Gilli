import * as THREE from 'three';
import type { FieldLayout, Obstacle } from '../../net/types';
import {
  earthTexture, grassTexture, kolamTexture, mulberry32, paddyTexture, radialFade, roofTileTexture,
  stripeTexture, textCanvas, thatchTexture,
} from './textures';
import { makePerson, type Person, SAREE, SHIRT } from './Characters';

/**
 * Builds the rural Tamil Nadu maidan: red-earth playing field inside a grass village common,
 * coconut groves, neem and banyan trees, tiled and thatched houses with thinnai and kolam,
 * a tea kadai, temple gopuram, paddy fields and distant hills.
 * Solid objects come from the server layout so the scene matches the physics colliders exactly.
 */
export class World {
  readonly root = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  readonly spectators: Person[] = [];
  private readonly mats = new Map<string, THREE.MeshStandardMaterial>();
  private readonly rnd = mulberry32(2024);
  private readonly flags: THREE.Object3D[] = [];
  private cheerTime = 0;
  private readonly targetRing: THREE.Mesh;

  constructor(scene: THREE.Scene, readonly layout: FieldLayout) {
    scene.add(this.root);
    scene.background = new THREE.Color(0xbcd6e6);
    scene.fog = new THREE.Fog(0xcfdde3, 120, 420);

    // ---- sky dome: zenith blue to hazy horizon, with a soft sun glow
    const sky = new THREE.Mesh(new THREE.SphereGeometry(480, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x3f78c0) }, horizon: { value: new THREE.Color(0xd9e6ea) },
        ground: { value: new THREE.Color(0xb9c9b0) }, sunDir: { value: new THREE.Vector3(-0.45, 0.55, -0.7).normalize() },
      },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sunDir; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(horizon, top, pow(smoothstep(0.0, 0.7, h), 0.8)) : mix(horizon, ground, smoothstep(0.0, -0.2, h));
        float s = max(dot(vP, sunDir), 0.0); c += vec3(1.0, 0.85, 0.6) * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
        gl_FragColor = vec4(c, 1.0); }`,
    }));
    sky.renderOrder = -1;
    this.root.add(sky);

    this.root.add(new THREE.HemisphereLight(0xdfeaff, 0x7a5236, 1.15));
    this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6);
    this.sun.position.set(-45, 70, -40);
    this.sun.target.position.set(0, 0, -22);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    Object.assign(this.sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 10, far: 200 });
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.root.add(this.sun, this.sun.target);

    this.targetRing = this.chalkRing(1, 0.05);
  }

  mat(color: number, roughness = 0.92, extra?: Partial<THREE.MeshStandardMaterialParameters>) {
    const key = `${color}_${roughness}_${extra ? JSON.stringify(Object.keys(extra)) : ''}`;
    let m = this.mats.get(key);
    if (!m || extra) {
      m = new THREE.MeshStandardMaterial({ color, roughness, ...extra });
      if (!extra) this.mats.set(key, m);
    }
    return m;
  }

  private box(w: number, h: number, d: number, m: THREE.Material | number, x: number, y: number, z: number, parent: THREE.Object3D) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof m === 'number' ? this.mat(m) : m);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  private cyl(rt: number, rb: number, h: number, m: THREE.Material | number, x: number, y: number, z: number, parent: THREE.Object3D, seg = 10) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), typeof m === 'number' ? this.mat(m) : m);
    mesh.position.set(x, y, z); parent.add(mesh); return mesh;
  }
  private shadows(g: THREE.Object3D, cast: boolean) {
    g.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = cast; o.receiveShadow = true; } });
  }

  /** Build in stages so the loading screen can report progress. */
  *build(): Generator<[number, string]> {
    yield [0.05, 'Laying the red-earth maidan'];
    this.buildGround();
    yield [0.25, 'Marking the pit, crease and boundary'];
    this.buildMarkings();
    yield [0.4, 'Planting coconut, neem and banyan trees'];
    this.buildTrees();
    yield [0.6, 'Building the village'];
    this.buildVillage();
    yield [0.78, 'Paddy fields and hills'];
    this.buildFarAway();
    yield [0.9, 'Gathering the villagers'];
    this.buildSpectators();
    yield [1, 'Ready'];
  }

  private buildGround() {
    const grass = grassTexture(); grass.repeat.set(160, 160);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }));
    g.rotation.x = -Math.PI / 2; g.receiveShadow = true; this.root.add(g);

    const { boundary } = this.layout;
    const earth = earthTexture(); earth.repeat.set(26, 26);
    const maidan = new THREE.Mesh(new THREE.CircleGeometry(boundary.radius + 9, 96), new THREE.MeshStandardMaterial({
      map: earth, alphaMap: radialFade(0.78), transparent: true, roughness: 1, depthWrite: false,
    }));
    maidan.rotation.x = -Math.PI / 2; maidan.position.set(boundary.x, 0.01, boundary.z); maidan.receiveShadow = true;
    this.root.add(maidan);

    // darker, trampled batting area
    const batting = new THREE.Mesh(new THREE.CircleGeometry(4.5, 48), new THREE.MeshStandardMaterial({ map: earth, color: 0xb88a78, roughness: 1, alphaMap: radialFade(0.6), transparent: true, depthWrite: false }));
    batting.rotation.x = -Math.PI / 2; batting.position.set(0, 0.015, 0); batting.receiveShadow = true; this.root.add(batting);

    // village path winding off the common
    const pathMat = new THREE.MeshStandardMaterial({ map: earth, color: 0xd6b090, roughness: 1, alphaMap: radialFade(0.4), transparent: true, depthWrite: false });
    for (let i = 0; i < 26; i++) {
      const t = i / 25;
      const x = 46 + t * 60 + Math.sin(t * 5) * 6, z = 8 - t * 30;
      const p = new THREE.Mesh(new THREE.CircleGeometry(4.5, 20), pathMat);
      p.rotation.x = -Math.PI / 2; p.position.set(x, 0.012, z); this.root.add(p);
    }

    // grass tufts around the edge of the maidan
    const tuftGeo = new THREE.ConeGeometry(0.18, 0.45, 4, 1, true);
    const tufts = new THREE.InstancedMesh(tuftGeo, this.mat(0x5c7d30, 1, { side: THREE.DoubleSide }), 1600);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    for (let i = 0; i < tufts.count; i++) {
      const a = this.rnd() * Math.PI * 2, r = boundary.radius + 3 + this.rnd() * 60;
      const x = boundary.x + Math.sin(a) * r, z = boundary.z + Math.cos(a) * r;
      q.setFromEuler(new THREE.Euler((this.rnd() - 0.5) * 0.4, this.rnd() * 6, (this.rnd() - 0.5) * 0.4));
      const k = 0.6 + this.rnd() * 1.2; s.set(k, k, k);
      m.compose(new THREE.Vector3(x, 0.2 * k, z), q, s); tufts.setMatrixAt(i, m);
    }
    this.root.add(tufts);
  }

  chalkRing(radius: number, width: number, arc = Math.PI * 2, start = 0, opacity = 0.75) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - width, radius + width, Math.max(24, Math.round(radius * 8)), 1, start, arc),
      new THREE.MeshBasicMaterial({ color: 0xf8efdc, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
    this.root.add(ring);
    return ring;
  }

  setTargetRadius(r: number) { this.targetRing.scale.setScalar(r); }

  private buildMarkings() {
    // the kuzhi (pit): a shallow elongated groove
    const pit = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), new THREE.MeshBasicMaterial({ color: 0x2a170c }));
    pit.scale.set(2.2, 1, 1); pit.rotation.x = -Math.PI / 2; pit.position.y = 0.018; this.root.add(pit);
    const lip = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.24, 24), new THREE.MeshStandardMaterial({ color: 0x6b3a22, roughness: 1 }));
    lip.scale.set(2.2, 1, 1); lip.rotation.x = -Math.PI / 2; lip.position.y = 0.017; this.root.add(lip);

    // batting crease line (behind it is foul territory)
    const crease = new THREE.Mesh(new THREE.PlaneGeometry(7, 0.08), new THREE.MeshBasicMaterial({ color: 0xf8efdc, transparent: true, opacity: 0.85, depthWrite: false }));
    crease.rotation.x = -Math.PI / 2; crease.position.set(0, 0.021, 0.5); this.root.add(crease);

    // distance arcs with labels every 10 m
    for (let d = 10; d <= 60; d += 10) {
      this.chalkRing(d, 0.06, 1.6, Math.PI / 2 - 0.8, 0.45);
      const lab = this.groundLabel(`${d} m`);
      lab.position.set(0, 0.025, -d + 1.3); this.root.add(lab);
    }

    // fielding positions
    const spots: [number, number][] = [[-9, -21], [8, -15], [1.5, -33], [-3, -10]];
    for (const [x, z] of spots) { const r = this.chalkRing(0.7, 0.04, Math.PI * 2, 0, 0.4); r.position.set(x, 0.02, z); }

    // boundary: whitewashed stones
    const { boundary } = this.layout;
    const n = Math.round(boundary.radius * 2 * Math.PI / 2.4);
    const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.22, 0), this.mat(0xf1ece0, 0.8), n);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      m.compose(new THREE.Vector3(boundary.x + Math.sin(a) * boundary.radius, 0.1, boundary.z + Math.cos(a) * boundary.radius),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(this.rnd(), this.rnd(), this.rnd())), new THREE.Vector3(1, 0.7, 1));
      stones.setMatrixAt(i, m);
    }
    stones.castShadow = true; stones.receiveShadow = true;
    this.root.add(stones);

    const kolam = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2), new THREE.MeshBasicMaterial({ map: kolamTexture(), transparent: true, depthWrite: false }));
    kolam.rotation.x = -Math.PI / 2; kolam.position.set(-4.5, 0.022, 3.5); this.root.add(kolam);
  }

  private groundLabel(txt: string) {
    const tex = textCanvas([{ text: txt, font: '700 64px "Hind Madurai", system-ui, sans-serif', color: '#f8efdc', y: 52 }], 256, 96);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 0.975), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.7, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  // ------------------------------------------------------------------ trees

  private buildTrees() {
    const palms = this.layout.obstacles.filter(o => o.kind === 'Palm');
    this.buildPalms(palms);
    for (const o of this.layout.obstacles) {
      if (o.kind === 'Neem') this.neem(o);
      if (o.kind === 'Banyan') this.banyan(o);
    }
    // decorative trees beyond the play area (no collision needed: unreachable)
    for (let i = 0; i < 26; i++) {
      const a = this.rnd() * Math.PI * 2, r = 150 + this.rnd() * 120;
      this.neem({ kind: 'Neem', x: Math.sin(a) * r, z: Math.cos(a) * r - 20, radius: 0.4, width: 0, depth: 0, height: 8, rotY: 0, scale: 1 + this.rnd(), isBox: false }, false);
    }
  }

  /** Coconut palms as instanced meshes: one draw call each for trunks, fronds and nuts. */
  private buildPalms(palms: Obstacle[]) {
    const trunkGeo = new THREE.CylinderGeometry(0.15, 0.26, 1, 7); trunkGeo.translate(0, 0.5, 0);
    const leafGeo = new THREE.PlaneGeometry(1.3, 3.6, 2, 8); leafGeo.translate(0, 1.8, 0); leafGeo.rotateX(-Math.PI / 2);
    // leaf outline (narrow at the stem and tip) and an arching droop
    const pos = leafGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i), t = Math.abs(z) / 3.6;
      pos.setY(i, pos.getY(i) + 0.5 * t - 1.5 * t * t);
      pos.setX(i, pos.getX(i) * Math.sin(Math.PI * (0.12 + t * 0.85)));
    }
    leafGeo.computeVertexNormals();
    const nutGeo = new THREE.SphereGeometry(0.17, 8, 6);
    const trunks = new THREE.InstancedMesh(trunkGeo, this.mat(0x7a5534, 1), palms.length);
    const leaves = new THREE.InstancedMesh(leafGeo, this.mat(0x4b8a3a, 0.8, { side: THREE.DoubleSide }), palms.length * 10);
    const nuts = new THREE.InstancedMesh(nutGeo, this.mat(0x6b7a30, 0.8), palms.length * 4);
    const m = new THREE.Matrix4(), local = new THREE.Matrix4(), q = new THREE.Quaternion();
    palms.forEach((p, i) => {
      const lean = (this.rnd() - 0.5) * 0.24;
      const base = new THREE.Matrix4().compose(new THREE.Vector3(p.x, 0, p.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rotY, lean)), new THREE.Vector3(1, 1, 1));
      trunks.setMatrixAt(i, m.copy(base).multiply(local.makeScale(1, p.height, 1)));
      for (let k = 0; k < 10; k++) {
        q.setFromEuler(new THREE.Euler(-0.1 + this.rnd() * 0.45, k / 10 * Math.PI * 2 + this.rnd() * 0.3, 0, 'YXZ'));
        leaves.setMatrixAt(i * 10 + k, m.copy(base).multiply(local.compose(new THREE.Vector3(0, p.height, 0), q, new THREE.Vector3(1, 1, 1))));
      }
      for (let k = 0; k < 4; k++) nuts.setMatrixAt(i * 4 + k, m.copy(base).multiply(local.makeTranslation(Math.cos(k * 1.6) * 0.25, p.height - 0.25, Math.sin(k * 1.6) * 0.25)));
    });
    for (const im of [trunks, leaves, nuts]) { im.castShadow = true; im.receiveShadow = true; this.root.add(im); }
  }

  private neem(o: Obstacle, cast = true) {
    const g = new THREE.Group();
    const s = o.scale;
    const trunk = this.cyl(0.22 * s, 0.38 * s, 3.4 * s, 0x5e4a3a, 0, 1.7 * s, 0, g, 8);
    trunk.rotation.z = 0.05;
    const leafA = this.mat(0x4f7a32, 1), leafB = this.mat(0x5f8a3a, 1);
    const blobs: [number, number, number, number][] = [[0, 5, 0, 2.6], [1.8, 4.4, 0.6, 1.9], [-1.7, 4.5, -0.4, 2], [0.4, 4.6, -1.8, 1.8], [-0.5, 4.3, 1.7, 1.8], [0, 6.2, 0, 1.6]];
    blobs.forEach(([x, y, z, r], i) => {
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(r * s, 1), i % 2 ? leafA : leafB);
      b.position.set(x * s, y * s, z * s); b.scale.y = 0.75; g.add(b);
    });
    g.position.set(o.x, 0, o.z);
    this.shadows(g, cast);
    this.root.add(g);
  }

  private banyan(o: Obstacle) {
    const g = new THREE.Group();
    const s = o.scale;
    this.cyl(3.2, 3.4, 0.7, 0xb9ad98, 0, 0.35, 0, g, 20);            // stone platform (thinnai under the tree)
    this.cyl(1.0, 1.5, 6, 0x6b5440, 0, 3, 0, g, 10);
    const leafA = this.mat(0x2f5a2a), leafB = this.mat(0x3b6b33);
    ([[0, 7.5, 0, 5], [3.5, 6.8, 1, 4], [-3.6, 6.7, -0.5, 4.2], [1, 7, -3.4, 4], [-1, 6.9, 3.3, 4], [4, 6.2, -2.5, 3]] as const).forEach(([a, b, c, r], i) => {
      const sp = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), i % 2 ? leafA : leafB);
      sp.position.set(a, b, c); sp.scale.y = 0.6; g.add(sp);
    });
    const rootMat = this.mat(0x7a6450);
    for (let i = 0; i < 14; i++) {
      const ang = this.rnd() * Math.PI * 2, rr = 2.5 + this.rnd() * 3;
      this.cyl(0.05, 0.08, 6, rootMat, Math.cos(ang) * rr, 3, Math.sin(ang) * rr, g, 5);
    }
    g.scale.setScalar(s);
    g.position.set(o.x, 0, o.z);
    this.shadows(g, true);
    this.root.add(g);
  }

  // ------------------------------------------------------------------ village

  private buildVillage() {
    const roofTiles = roofTileTexture(), thatch = thatchTexture();
    let hutIndex = 0;
    for (const o of this.layout.obstacles) {
      switch (o.kind) {
        case 'Hut': (hutIndex++ % 2 === 0 ? this.tiledHouse(o, roofTiles) : this.hut(o, thatch)); break;
        case 'TeaShop': this.teaShop(o); break;
        case 'Cart': this.bullockCart(o); break;
        case 'WaterTank': this.waterTank(o); break;
        case 'Wall': this.templeWall(o); break;
      }
    }
    this.gopuram(-26, -150, 1.45);
    this.thoranam(-68, 14);
    // haystacks and a well
    for (const [x, z] of [[58, -64], [61, -68], [-52, 12], [-78, -30]] as const) {
      const h = new THREE.Mesh(new THREE.ConeGeometry(2.2, 3.4, 12), new THREE.MeshStandardMaterial({ map: thatch, roughness: 1 }));
      h.position.set(x, 1.7, z); h.castShadow = true; this.root.add(h);
    }
    const well = new THREE.Group();
    this.cyl(1.2, 1.25, 1, 0xb5a58c, 0, 0.5, 0, well, 18);
    this.cyl(1.0, 1.0, 1.02, 0x1d2a2a, 0, 0.5, 0, well, 18);
    [-1, 1].forEach(s => this.cyl(0.07, 0.07, 2.4, 0x6b4226, s * 1.1, 1.6, 0, well, 6));
    this.box(2.4, 0.1, 0.1, 0x6b4226, 0, 2.8, 0, well);
    well.position.set(-50, 0, -30); this.shadows(well, true); this.root.add(well);
  }

  private kolamPlane(size: number) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: kolamTexture(), transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; return m;
  }

  /** Thatched hut with a red-oxide base band, thinnai platform and kolam at the door. */
  private hut(o: Obstacle, thatch: THREE.Texture) {
    const g = new THREE.Group();
    const wall = this.rnd() < 0.5 ? 0xf1ebde : 0xd9b48a;
    this.box(4.2, 2.3, 3.4, wall, 0, 1.15, 0, g);
    this.box(4.24, 0.35, 3.44, 0x8e4a2e, 0, 0.17, 0, g);
    this.box(0.9, 1.6, 0.1, 0x3a2414, 0, 0.8, 1.72, g);
    this.box(0.6, 0.5, 0.1, 0x3a2414, 1.35, 1.35, 1.72, g);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2.5, 4, 1), new THREE.MeshStandardMaterial({ map: thatch, roughness: 1 }));
    roof.rotation.y = Math.PI / 4; roof.scale.set(1.15, 1, 0.95); roof.position.y = 3.5; g.add(roof);
    this.box(4.4, 0.45, 0.9, 0xc9a27a, 0, 0.22, 2.15, g);
    const k = this.kolamPlane(2.4); k.position.set(0, 0.02, 3.9); g.add(k);
    g.position.set(o.x, 0, o.z); g.rotation.y = o.rotY;
    this.shadows(g, true); this.root.add(g);
  }

  /** Village house with a Mangalore-tile pitched roof, pillared verandah (thinnai) and kolam. */
  private tiledHouse(o: Obstacle, tiles: THREE.Texture) {
    const g = new THREE.Group();
    const wall = [0xf3e3c3, 0xe6d3ee, 0xcfe3d6, 0xf2d0b0][Math.floor(this.rnd() * 4)];
    this.box(4.2, 2.5, 3.2, wall, 0, 1.25, -0.3, g);
    this.box(4.24, 0.4, 3.24, 0x8e4a2e, 0, 0.2, -0.3, g);
    this.box(0.9, 1.8, 0.1, 0x5a3517, 0, 0.9, 1.31, g);
    this.box(0.15, 1.9, 0.12, 0xf2c14e, -0.52, 0.95, 1.31, g); this.box(0.15, 1.9, 0.12, 0xf2c14e, 0.52, 0.95, 1.31, g);
    this.box(4.4, 0.5, 1.1, 0xc9a27a, 0, 0.25, 1.85, g); // thinnai
    [-1.9, 1.9].forEach(px => this.cyl(0.09, 0.09, 2.3, 0xf3ece0, px, 1.65, 2.25, g, 8));
    const roofMat = new THREE.MeshStandardMaterial({ map: tiles, roughness: 0.85 });
    const slope = 2.6;
    [-1, 1].forEach(s => {
      const p = new THREE.Mesh(new THREE.BoxGeometry(4.9, 0.12, slope), roofMat);
      p.position.set(0, 3.15, -0.3 + s * 1.05 + (s > 0 ? 0.55 : 0)); p.rotation.x = s * 0.55; g.add(p);
    });
    const gable = new THREE.Shape([new THREE.Vector2(-1.6, 0), new THREE.Vector2(1.6, 0), new THREE.Vector2(0, 0.95)]);
    [-2.1, 2.1].forEach(px => {
      const m = new THREE.Mesh(new THREE.ShapeGeometry(gable), this.mat(wall, 0.95, { side: THREE.DoubleSide }));
      m.rotation.y = Math.PI / 2; m.position.set(px, 2.5, -0.3); g.add(m);
    });
    const k = this.kolamPlane(2.2); k.position.set(0, 0.02, 3.5); g.add(k);
    g.position.set(o.x, 0, o.z); g.rotation.y = o.rotY;
    this.shadows(g, true); this.root.add(g);
  }

  private teaShop(o: Obstacle) {
    const g = new THREE.Group();
    this.box(5, 2.6, 3, 0xe8dcc0, 0, 1.3, -0.4, g);
    const roof = this.box(6.2, 0.12, 4.6, this.mat(0x8a8f94, 0.6), 0, 2.95, 0.5, g); roof.rotation.x = -0.12;
    [-2.9, 2.9].forEach(px => this.cyl(0.07, 0.07, 2.8, 0x6b4226, px, 1.4, 2.5, g, 6));
    this.box(4, 1, 0.8, 0x7a4a2a, 0, 0.5, 1.4, g);
    this.cyl(0.2, 0.25, 0.45, this.mat(0xc0c4c8, 0.3), -1.2, 1.22, 1.4, g, 12);
    this.cyl(0.12, 0.12, 0.25, 0xf3ece0, 0.4, 1.12, 1.4, g, 8); this.cyl(0.12, 0.12, 0.25, 0xf3ece0, 0.8, 1.12, 1.4, g, 8);
    this.box(3.2, 0.12, 0.6, 0x6b4226, 0, 0.5, 3.4, g);
    const signTex = textCanvas([
      { text: 'டீ கடை', font: '700 58px "Hind Madurai", "Latha", "Nirmala UI", sans-serif', color: '#b8322a', y: 52 },
      { text: 'TEA · VADAI · BAJJI', font: '700 24px "Hind Madurai", sans-serif', color: '#2a1a10', y: 102 },
    ], 512, 128, c => { c.fillStyle = '#f2c14e'; c.fillRect(0, 0, 512, 128); c.strokeStyle = '#b8322a'; c.lineWidth = 8; c.strokeRect(6, 6, 500, 116); });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.15), new THREE.MeshBasicMaterial({ map: signTex }));
    sign.position.set(0, 3.65, 2.75); g.add(sign);
    const k = this.kolamPlane(2.2); k.position.set(0, 0.02, 4.6); g.add(k);
    g.position.set(o.x, 0, o.z); g.rotation.y = o.rotY;
    this.shadows(g, true); this.root.add(g);
  }

  private waterTank(o: Obstacle) {
    const g = new THREE.Group();
    [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]].forEach(([a, b]) => this.cyl(0.25, 0.3, 10, 0xcfc8bc, a, 5, b, g, 8));
    this.cyl(3.2, 3.2, 3.4, 0xe4ecee, 0, 11.7, 0, g, 24);
    this.cyl(3.25, 3.25, 0.6, 0x3f86a8, 0, 12.3, 0, g, 24);
    const top = new THREE.Mesh(new THREE.ConeGeometry(3.4, 1.2, 24), this.mat(0xe4ecee)); top.position.y = 14; g.add(top);
    g.position.set(o.x, 0, o.z); this.shadows(g, false); this.root.add(g);
  }

  private bullockCart(o: Obstacle) {
    const g = new THREE.Group();
    const wood = 0x8a5a2b;
    this.box(1.8, 0.2, 2.6, wood, 0, 1.15, 0, g);
    [-0.85, 0.85].forEach(px => this.box(0.08, 0.4, 2.6, wood, px, 1.4, 0, g));
    [-1.0, 1.0].forEach(px => {
      const w = this.cyl(0.9, 0.9, 0.14, 0x5a3a1e, px, 0.9, 0, g, 18); w.rotation.z = Math.PI / 2;
    });
    const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 2.2, 16, 1, true, Math.PI / 2, Math.PI), this.mat(0xa8834a, 1, { side: THREE.DoubleSide }));
    cover.rotation.x = Math.PI / 2; cover.position.set(0, 1.25, -0.2); g.add(cover);
    this.box(2.2, 0.12, 0.14, wood, 0, 1.45, 3.4, g);
    [-0.6, 0.6].forEach((px, i) => {
      const b = new THREE.Group();
      this.box(0.7, 0.75, 1.7, 0xe6e0d2, 0, 1.05, 0, b);
      this.box(0.45, 0.35, 0.4, 0xe6e0d2, 0, 1.55, 0.45, b);
      [[-0.22, 0.6], [0.22, 0.6], [-0.22, -0.6], [0.22, -0.6]].forEach(([a, c]) => this.box(0.15, 0.7, 0.15, 0xd8d0c0, a, 0.35, c, b));
      this.box(0.4, 0.45, 0.55, 0xe6e0d2, 0, 1.3, 1.05, b);
      [-1, 1].forEach(sd => {
        const h = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.5, 8), this.mat(i ? 0x1565c0 : 0xc62828, 0.5));
        h.position.set(sd * 0.15, 1.7, 0.95); h.rotation.z = -sd * 0.45; b.add(h);
      });
      b.position.set(px, 0, 3.6); g.add(b);
    });
    g.position.set(o.x, 0, o.z); g.rotation.y = o.rotY; this.shadows(g, true); this.root.add(g);
  }

  private templeWall(o: Obstacle) {
    const tex = stripeTexture(); tex.repeat.set(o.width / 6, 1);
    const wall = new THREE.Mesh(new THREE.BoxGeometry(o.width, o.height, o.depth), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
    wall.position.set(o.x, o.height / 2, o.z); this.root.add(wall);
    this.box(o.width + 0.4, 0.4, o.depth + 0.4, 0xf1e4c4, o.x, o.height + 0.2, o.z, this.root);
  }

  private gopuram(x: number, z: number, s: number) {
    const g = new THREE.Group();
    const cols = [0xe3a33c, 0xc9553a, 0x3f86a8, 0xe9d6a0, 0x6a9a4a, 0xd9774a, 0xe3a33c];
    this.box(16, 7, 9, 0xd9c49c, 0, 3.5, 0, g);
    this.box(4, 5, 9.3, 0x2e1c10, 0, 2.5, 0, g);
    let y = 7;
    for (let i = 0; i < 7; i++) {
      const w = 14 - i * 1.6, d = 7.5 - i * 0.8, h = 2.5;
      this.box(w + 0.8, 0.35, d + 0.6, 0xf1e4c4, 0, y + 0.17, 0, g);
      this.box(w, h, d, cols[i], 0, y + 0.35 + h / 2, 0, g);
      for (let k = -1; k <= 1; k++) {
        this.box(0.8, 1.3, 0.25, 0x2a1a10, k * w * 0.3, y + 0.35 + h / 2, d / 2 + 0.05, g);
        this.box(0.55, 0.9, 0.3, 0xf3d9a0, k * w * 0.3, y + 0.25 + h / 2, d / 2 + 0.08, g);
      }
      y += h + 0.35;
    }
    const vault = this.cyl(1.25, 1.25, 4.6, 0xe3a33c, 0, y, 0, g, 16); vault.rotation.z = Math.PI / 2;
    const gold = new THREE.MeshStandardMaterial({ color: 0xf2c14e, metalness: 0.6, roughness: 0.35 });
    for (let k = -2; k <= 2; k++) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), gold); b.position.set(k * 0.95, y + 1.5, 0); g.add(b);
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.7, 10), gold); c.position.set(k * 0.95, y + 2.05, 0); g.add(c);
    }
    g.scale.setScalar(s); g.position.set(x, 0, z);
    this.shadows(g, false); this.root.add(g);
  }

  private thoranam(z: number, half: number) {
    [-half, half].forEach(px => this.cyl(0.12, 0.15, 7.5, 0x9c7a3c, px, 3.75, z, this.root, 8));
    const tex = textCanvas([
      { text: 'கில்லி போட்டி', font: '700 72px "Hind Madurai", "Latha", "Nirmala UI", sans-serif', color: '#fff6e0', y: 70 },
      { text: 'VILLAGE GILLI-DANDA TOURNAMENT', font: '600 26px "Hind Madurai", sans-serif', color: '#fff6e0', y: 128 },
    ], 1024, 160, c => { c.fillStyle = '#b8322a'; c.fillRect(0, 0, 1024, 160); c.fillStyle = '#f2c14e'; c.fillRect(0, 0, 1024, 12); c.fillRect(0, 148, 1024, 12); });
    const b = new THREE.Mesh(new THREE.PlaneGeometry(half * 1.3, half * 0.2), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    b.position.set(0, 5.6, z); this.root.add(b);
    const flagCols = [0x3f8a3a, 0xf2c14e, 0xc62828, 0x3f8a3a, 0x1565c0];
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, px = -half + t * half * 2, py = 7.2 - Math.sin(t * Math.PI) * 0.9;
      const tri = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.6, 3), new THREE.MeshBasicMaterial({ color: flagCols[i % 5] }));
      tri.rotation.x = Math.PI; tri.position.set(px, py - 0.3, z); this.root.add(tri);
      this.flags.push(tri);
    }
  }

  private buildFarAway() {
    const paddyTex = paddyTexture(); paddyTex.repeat.set(6, 6);
    const paddyMat = new THREE.MeshStandardMaterial({ map: paddyTex, roughness: 0.8 });
    const bund = this.mat(0x8a5a36);
    for (const [cx, cz, w, d] of [[105, -135, 100, 70], [-120, -60, 60, 90], [-110, 70, 90, 60], [120, 40, 70, 80]] as const) {
      const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), paddyMat);
      f.rotation.x = -Math.PI / 2; f.position.set(cx, 0.03, cz); f.receiveShadow = true; this.root.add(f);
      for (let i = 0; i <= 4; i++) this.box(w, 0.25, 0.6, bund, cx, 0.12, cz - d / 2 + i * d / 4, this.root);
      for (let i = 0; i <= 4; i++) this.box(0.6, 0.25, d, bund, cx - w / 2 + i * w / 4, 0.12, cz, this.root);
    }
    // distant hills (Western Ghats silhouette), softened by fog
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x7c9a83, roughness: 1 });
    const dome = new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2);
    for (let i = 0; i < 24; i++) {
      const a = -2.6 + i / 23 * 2.6 + (this.rnd() - 0.5) * 0.1, r = 360 + this.rnd() * 40;
      const h = new THREE.Mesh(dome, hillMat);
      h.scale.set(70 + this.rnd() * 70, 12 + this.rnd() * 20, 45 + this.rnd() * 35);
      h.rotation.y = this.rnd() * 3;
      h.position.set(Math.sin(a) * r, -2, Math.cos(a) * r - 30);
      this.root.add(h);
    }
  }

  private buildSpectators() {
    const { boundary } = this.layout;
    for (let i = 0; i < 16; i++) {
      for (const side of [-1, 1]) {
        const a = side * (0.95 + i * 0.07) + (this.rnd() - 0.5) * 0.03;
        const r = boundary.radius + 3 + (i % 2) * 1.6;
        const x = boundary.x + Math.sin(a) * r, z = boundary.z + Math.cos(a) * r;
        if (z > 6) continue;
        this.villager(x, z, this.rnd() < 0.45);
      }
    }
    for (let i = 0; i < 4; i++) { const a = i * 1.4; this.villager(-46 + Math.cos(a) * 2.8, -96 + Math.sin(a) * 2.8, false); }
  }

  private villager(x: number, z: number, woman: boolean) {
    const p = makePerson(woman ? SAREE[Math.floor(this.rnd() * SAREE.length)] : SHIRT[Math.floor(this.rnd() * SHIRT.length)], { woman, shadows: false });
    p.group.position.set(x, 0, z);
    p.group.rotation.y = Math.atan2(-x, -20 - z);
    p.phase = this.rnd() * 6;
    this.root.add(p.group);
    this.spectators.push(p);
  }

  cheer(seconds = 2) { this.cheerTime = seconds; }

  update(dt: number, t: number) {
    if (this.cheerTime > 0) this.cheerTime -= dt;
    const cheering = this.cheerTime > 0;
    for (const p of this.spectators) {
      const up = cheering ? -2.4 - Math.sin(t * 12 + p.phase) * 0.4 : -0.05 - Math.max(0, Math.sin(t * 0.7 + p.phase)) * 0.25;
      p.armL.rotation.x = up; p.armR.rotation.x = cheering ? up : 0;
      p.group.position.y = cheering ? Math.abs(Math.sin(t * 10 + p.phase)) * 0.12 : 0;
    }
    for (let i = 0; i < this.flags.length; i++) this.flags[i].rotation.z = Math.sin(t * 2.5 + i * 0.7) * 0.18;
  }

  /** Same push-out rules as the server's FieldLayout.ConstrainPlayer, for responsive local movement. */
  constrain(x: number, z: number, radius: number): [number, number] {
    const { boundary, walkRadius } = this.layout;
    let dx = x - boundary.x, dz = z - boundary.z;
    const len = Math.hypot(dx, dz);
    if (len > walkRadius) { x = boundary.x + dx / len * walkRadius; z = boundary.z + dz / len * walkRadius; }
    for (const o of this.layout.obstacles) {
      if (o.isBox) {
        const c = Math.cos(o.rotY), s = Math.sin(o.rotY);
        let lx = (x - o.x) * c - (z - o.z) * s, lz = (x - o.x) * s + (z - o.z) * c;
        const hx = o.width / 2 + radius, hz = o.depth / 2 + radius;
        if (Math.abs(lx) < hx && Math.abs(lz) < hz) {
          if (hx - Math.abs(lx) < hz - Math.abs(lz)) lx = Math.sign(lx || 1) * hx; else lz = Math.sign(lz || 1) * hz;
          x = o.x + lx * c + lz * s; z = o.z - lx * s + lz * c;
        }
      } else {
        const r = (o.kind === 'Banyan' ? 3.3 * o.scale : o.radius) + radius;
        dx = x - o.x; dz = z - o.z;
        const l = Math.hypot(dx, dz);
        if (l < r) { if (l < 1e-4) { x = o.x + r; } else { x = o.x + dx / l * r; z = o.z + dz / l * r; } }
      }
    }
    return [x, z];
  }
}
