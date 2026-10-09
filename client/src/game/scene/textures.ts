import * as THREE from 'three';

/** Seeded PRNG so the decorative scene is identical for every player. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function speckle(c: CanvasRenderingContext2D, w: number, h: number, base: string, cols: string[], n: number, rmin: number, rmax: number, alpha: number, rnd: () => number) {
  c.fillStyle = base; c.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    c.globalAlpha = alpha * (0.5 + rnd() * 0.5);
    c.fillStyle = cols[i % cols.length];
    const x = rnd() * w, y = rnd() * h, r = rmin + rnd() * (rmax - rmin);
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    // wrap so the tile repeats seamlessly
    if (x < r) { c.beginPath(); c.arc(x + w, y, r, 0, Math.PI * 2); c.fill(); }
    if (y < r) { c.beginPath(); c.arc(x, y + h, r, 0, Math.PI * 2); c.fill(); }
  }
  c.globalAlpha = 1;
}

/** Packed red earth of a village maidan with pebbles and footprint scuffs. */
export function earthTexture() {
  const rnd = mulberry32(7);
  const t = canvasTexture(512, 512, (c, w, h) => {
    speckle(c, w, h, '#9a4d2c', ['#7f3c22', '#b0603a', '#8d4628', '#a8714a', '#6e3a24'], 5200, 1, 6, 0.35, rnd);
    c.globalAlpha = 0.5;
    for (let i = 0; i < 260; i++) { c.fillStyle = rnd() < 0.5 ? '#d8b48a' : '#5a2f1d'; c.fillRect(rnd() * w, rnd() * h, 2, 2); }
    c.globalAlpha = 1;
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function grassTexture() {
  const rnd = mulberry32(11);
  const t = canvasTexture(512, 512, (c, w, h) => {
    speckle(c, w, h, '#6f8d3c', ['#5b7a2f', '#86a24a', '#7a8f3a', '#9aa857', '#4f6b2a'], 6000, 1, 5, 0.4, rnd);
    c.globalAlpha = 0.35;
    for (let i = 0; i < 1400; i++) {
      c.strokeStyle = rnd() < 0.5 ? '#a9b765' : '#4d6a29';
      const x = rnd() * w, y = rnd() * h;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 4, y - 3 - rnd() * 5); c.stroke();
    }
    c.globalAlpha = 1;
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Radial alpha so the earth maidan fades into the surrounding grass. */
export function radialFade(inner: number) {
  return canvasTexture(256, 256, (c, w, h) => {
    const g = c.createRadialGradient(w / 2, h / 2, w / 2 * inner, w / 2, h / 2, w / 2);
    g.addColorStop(0, '#fff'); g.addColorStop(1, '#000');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }, false);
}

export function kolamTexture() {
  return canvasTexture(256, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h);
    c.strokeStyle = '#fffaf0'; c.fillStyle = '#fffaf0'; c.lineWidth = 5; c.lineCap = 'round';
    const n = 5, step = w / (n + 1);
    for (let i = 1; i <= n; i++) for (let j = 1; j <= n; j++) { c.beginPath(); c.arc(i * step, j * step, 4.5, 0, Math.PI * 2); c.fill(); }
    for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) {
      if ((i + j) % 2) continue;
      c.beginPath(); c.arc((i + 0.5) * step, (j + 0.5) * step, step * 0.72, 0, Math.PI * 2); c.stroke();
    }
    c.beginPath(); c.arc(w / 2, h / 2, w * 0.47, 0, Math.PI * 2); c.stroke();
    for (let a = 0; a < 16; a++) {
      const px = w / 2 + Math.cos(a / 16 * Math.PI * 2) * w * 0.47, py = h / 2 + Math.sin(a / 16 * Math.PI * 2) * w * 0.47;
      c.beginPath(); c.arc(px, py, 9, 0, Math.PI * 2); c.stroke();
    }
    c.fillStyle = '#e0457b';
    for (let a = 0; a < 8; a++) { c.beginPath(); c.arc(w / 2 + Math.cos(a * 0.785) * w * 0.32, h / 2 + Math.sin(a * 0.785) * w * 0.32, 7, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#f2c14e'; c.beginPath(); c.arc(w / 2, h / 2, 12, 0, Math.PI * 2); c.fill();
  });
}

export function paddyTexture() {
  const rnd = mulberry32(5);
  const t = canvasTexture(256, 256, (c, w, h) => {
    c.fillStyle = '#5f9a34'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 6) { c.fillStyle = y % 12 ? '#77b443' : '#4f8a2c'; c.fillRect(0, y, w, 3); }
    c.fillStyle = 'rgba(120,170,190,0.35)';
    for (let i = 0; i < 30; i++) c.fillRect(rnd() * w, rnd() * h, 20, 2);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function stripeTexture() {
  const t = canvasTexture(256, 64, (c, _w, h) => {
    for (let i = 0; i < 8; i++) { c.fillStyle = i % 2 ? '#f3ece0' : '#b8322a'; c.fillRect(i * 32, 0, 32, h); }
  });
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function roofTileTexture() {
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#a6452a'; c.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 16) {
      c.fillStyle = '#7d2f1c'; c.fillRect(0, y + 13, w, 3);
      for (let x = (y / 16) % 2 ? 8 : 0; x < w; x += 16) { c.fillStyle = '#c0583a'; c.fillRect(x + 2, y + 2, 10, 9); }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function thatchTexture() {
  const rnd = mulberry32(3);
  const t = canvasTexture(128, 128, (c, w, h) => {
    c.fillStyle = '#9c7a3c'; c.fillRect(0, 0, w, h);
    c.lineWidth = 1.5;
    for (let i = 0; i < 500; i++) {
      c.strokeStyle = rnd() < 0.5 ? '#b8954f' : '#7a5c2a';
      const x = rnd() * w, y = rnd() * h;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (rnd() - 0.5) * 3, y + 8 + rnd() * 10); c.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

export function textCanvas(lines: { text: string; font: string; color: string; y: number }[], w: number, h: number, bg?: (c: CanvasRenderingContext2D) => void) {
  return canvasTexture(w, h, c => {
    bg?.(c);
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const l of lines) { c.font = l.font; c.fillStyle = l.color; c.fillText(l.text, w / 2, l.y); }
  });
}
