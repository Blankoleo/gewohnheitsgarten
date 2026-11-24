/* Gewohnheits-Garten 1.0
   Gewohnheiten als Pflanzen: jeden Tag gießen, zusehen wie alles wächst.
   Keine Frameworks, kein Build. Alles in localStorage.

   Debug (versteckt):
     ?tag=+3      simuliert 3 Tage später (auch ?tag=-1)
     ?zeit=21.5   feste Uhrzeit (Tag/Nacht testen)
     ?debug       nur das Debug-Feld einblenden
   Mit einem dieser Parameter erscheint oben links ein kleines Feld mit +1/-1 Tag und Uhrzeit.
*/
'use strict';
(function () {

const VERSION = '1.0';
const STORE_KEY = 'gewohnheitsgarten.v1';
const SW = 40, SH = 50;      // Spritegröße einer Pflanze (Pixel)
const SLOT = 40;             // Breite eines Beetplatzes (Pixel)
const RH = 68;               // Abstand der Beetreihen (Pixel)

/* ------------------------------------------------------------------ Hilfen */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const css = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'value') n.value = attrs[k];
    else n.setAttribute(k, attrs[k]);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
}
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ Debug / Zeit */
const params = new URLSearchParams(location.search);
const DEBUG = params.has('tag') || params.has('zeit') || params.has('debug');
let dayOffset = parseInt((params.get('tag') || '0').trim(), 10) || 0; // "+3" kommt als " 3" an
let hourOverride = null;
if (params.has('zeit')) {
  const z = parseFloat(String(params.get('zeit')).replace(',', '.'));
  if (isFinite(z)) hourOverride = ((z % 24) + 24) % 24;
}
function dayNumber(d) { return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); }
function today() { return dayNumber(new Date()) + dayOffset; }
function currentHour() {
  if (hourOverride != null) return hourOverride;
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

/* ------------------------------------------------------------------ Daten
   Aufbau (für eine spätere "Nachbarschaft" vorbereitet):
   garden  = öffentlich teilbar: nur Pflanzenart, Wachstum, Gießtage – keine Namen
   privat  = bleibt auf dem Gerät: die Namen der Gewohnheiten (nach Pflanzen-ID)        */
let state = null; // wird in init() geladen

function freshState() {
  return { schema: 1, garden: { id: uid(), plants: [] }, privat: { names: {} } };
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.schema === 1 && s.garden && Array.isArray(s.garden.plants)) {
      s.privat = s.privat || { names: {} };
      s.privat.names = s.privat.names || {};
      s.garden.plants = s.garden.plants.filter((p) => p && SPECIES[p.species]);
      return s;
    }
  } catch (e) { /* kaputte Daten: neu anfangen */ }
  return freshState();
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { toast('Speichern hat leider nicht geklappt.'); }
}
const nameOf = (p) => state.privat.names[p.id] || 'Pflanze';

/** Öffentlicher Schnappschuss ohne private Namen – Grundlage für eine spätere Nachbarschaft. */
function gardenSnapshot() {
  const t = today();
  return {
    id: state.garden.id,
    day: t,
    plants: state.garden.plants.map((p) => ({
      id: p.id, species: p.species, stage: stageOf(p.growth),
      condition: condition(p, t), wateredToday: wateredToday(p, t)
    }))
  };
}

/* ------------------------------------------------------------------ Pflanzenarten */
const SPECIES = {
  farn:        { name: 'Farn',        stages: ['Samen', 'Keim', 'Busch', 'Wedel', 'Voll'],        seed: [168, 136, 100], accent: [124, 184, 140] },
  sonnenblume: { name: 'Sonnenblume', stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Volle Blüte'], seed: [96, 84, 76],    accent: [246, 196, 88] },
  kaktus:      { name: 'Kaktus',      stages: ['Samen', 'Keim', 'Säule', 'Blüte', 'Voll'],        seed: [70, 58, 54],    accent: [236, 140, 170] },
  kirschbaum:  { name: 'Kirschbaum',  stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Baum'],        seed: [160, 86, 74],   accent: [246, 176, 196] },
  monstera:    { name: 'Monstera',    stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Voll'],        seed: [176, 144, 104], accent: [96, 160, 120] }
};
const SPECIES_ORDER = ['farn', 'sonnenblume', 'kaktus', 'kirschbaum', 'monstera'];
const STAGE_MIN = [0, 2, 5, 10, 18]; // Gießtage bis zur Stufe

function stageOf(g) { let s = 0; for (let i = 0; i < STAGE_MIN.length; i++) if (g >= STAGE_MIN[i]) s = i; return s; }
function refDay(p) { return p.lastWatered != null ? p.lastWatered : p.plantedDay - 1; }
function wateredToday(p, t = today()) { return p.lastWatered != null && p.lastWatered >= t; }
function missedDays(p, t = today()) { return Math.max(0, t - refDay(p) - 1); }
/** 0 = gesund, 1 = Blätter hängen (1–2 Tage verpasst), 2 = welk (3+ Tage) */
function condition(p, t = today()) {
  if (wateredToday(p, t)) return 0;
  const m = missedDays(p, t);
  return m >= 3 ? 2 : (m >= 1 ? 1 : 0);
}
/** Gießen: einmal pro Tag. Nach langem Welken geht etwas Wachstum verloren, nie alles. */
function water(p) {
  const t = today();
  if (wateredToday(p, t)) return null;
  const m = missedDays(p, t);
  const before = stageOf(p.growth);
  let loss = 0;
  if (m >= 3) {
    loss = Math.min(Math.floor(p.growth * 0.35), m - 2);
    p.growth -= loss;
  }
  p.growth += 1;
  p.lastWatered = t;
  saveState();
  return { revived: m >= 3, drooped: m >= 1 && m < 3, loss, grew: stageOf(p.growth) > before, stage: stageOf(p.growth) };
}

/* ------------------------------------------------------------------ Pixel-Sprite-Baukasten */
function Buf() {
  this.w = SW; this.h = SH;
  this.c = new Array(SW * SH).fill(null);
  this.p = new Int16Array(SW * SH).fill(-1);
  this.cur = 0;
}
Buf.prototype.part = function () { return ++this.cur; };
Buf.prototype.put = function (x, y, col) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= this.w || y >= this.h || !col) return;
  const i = y * this.w + x;
  this.c[i] = col; this.p[i] = this.cur;
};

function disc(b, cx, cy, rx, ry, col) {
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const dx = (x - cx) / (rx + 0.5), dy = (y - cy) / (ry + 0.5);
      if (dx * dx + dy * dy <= 1) b.put(x, y, col);
    }
  }
}
function dot(b, x, y, th, col) {
  if (th <= 1.25) { b.put(x, y, col); return; }
  if (th <= 2.25) {
    const fx = Math.floor(x), fy = Math.floor(y);
    b.put(fx, fy, col); b.put(fx + 1, fy, col); b.put(fx, fy + 1, col); b.put(fx + 1, fy + 1, col);
    return;
  }
  disc(b, x, y, th / 2 - 0.5, th / 2 - 0.5, col);
}
function seg(b, x0, y0, x1, y1, th, col) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= n; i++) { const t = i / n; dot(b, lerp(x0, x1, t), lerp(y0, y1, t), th, col); }
}
function qp(a, t) {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * a[2] + t * t * a[4], u * u * a[1] + 2 * u * t * a[3] + t * t * a[5]];
}
function curve(b, a, th0, th1, col) {
  const n = 56;
  for (let i = 0; i <= n; i++) { const t = i / n; const q = qp(a, t); dot(b, q[0], q[1], lerp(th0, th1, t), col); }
}
/** Blatt: Basis bei (x0,y0), Richtung ang. Zweifarbig (Mittelrippe), optional rund + Schlitze. */
function leaf(b, x0, y0, ang, len, wid, col, dark, opt) {
  opt = opt || {};
  const ca = Math.cos(ang), sa = Math.sin(ang);
  const r = Math.ceil(len + wid + 1);
  const pw = opt.round ? 0.45 : 0.8;
  const slits = opt.slits || 0;
  for (let y = Math.floor(y0 - r); y <= y0 + r; y++) {
    for (let x = Math.floor(x0 - r); x <= x0 + r; x++) {
      const dx = x - x0, dy = y - y0;
      const u = dx * ca + dy * sa;
      const v = -dx * sa + dy * ca;
      if (u < 0 || u > len) continue;
      const f = u / len;
      const w = opt.heart
        ? wid * Math.pow(Math.sin(Math.PI * Math.pow(clamp(f * 0.92 + 0.08, 0, 1), 0.7)), 0.55)
        : wid * Math.pow(Math.sin(Math.PI * clamp(f * 0.9 + 0.1, 0, 1)), pw);
      if (Math.abs(v) > w + 0.25) continue;
      if (opt.heart && f < 0.16 && Math.abs(v) < wid * 0.28 * (1 - f / 0.16) && u > 0.6) continue;
      if (slits) {
        const av = Math.abs(v) / Math.max(w, 0.1);
        if (av > 0.32) {
          let hole = false;
          for (let s = 1; s <= slits; s++) {
            const us = s / (slits + 1) + 0.04;
            if (Math.abs(f - us - av * 0.18) < 0.05) { hole = true; break; }
          }
          if (hole) continue;
        }
      }
      b.put(x, y, (dark && v > 0.4) ? dark : col);
    }
  }
}
/** Kleines Glanzlicht-Bällchen (für Kronen und Kugeln) */
function puff(b, x, y, r, back, midc, light) {
  b.part();
  disc(b, x, y, r, r * 0.85, back);
  disc(b, x - r * 0.22, y - r * 0.25, r * 0.72, r * 0.58, midc);
  disc(b, x - r * 0.45, y - r * 0.45, Math.max(0.6, r * 0.3), Math.max(0.5, r * 0.25), light);
}

function wiltC(c, w, kind) {
  if (w <= 0) return c;
  const g = (c[0] + c[1] + c[2]) / 3;
  const target = kind === 'flower' ? [158, 120, 104] : kind === 'wood' ? [112, 92, 84] : [160, 132, 88];
  return mix(c, mix([g, g, g], target, 0.72), w);
}

const CX = 20, BY = SH - 1;

function drawSeed(b, sp) {
  const S = SPECIES[sp];
  b.part(); disc(b, CX, BY, 6.5, 2.2, [104, 74, 60]);
  disc(b, CX - 1, BY - 1, 4.5, 1.1, [126, 92, 72]);
  b.part(); disc(b, CX, BY - 2, 1.6, 1, S.seed);
  b.put(CX - 1, BY - 3, mix(S.seed, [255, 255, 255], 0.35));
  // kleines Pflanzschild
  b.part(); seg(b, CX + 8, BY, CX + 8, BY - 9, 1, [170, 132, 98]);
  b.part();
  for (let y = BY - 13; y <= BY - 9; y++) for (let x = CX + 5; x <= CX + 11; x++) b.put(x, y, [232, 214, 184]);
  b.put(CX + 7, BY - 11, S.accent); b.put(CX + 8, BY - 11, S.accent); b.put(CX + 9, BY - 11, S.accent);
}

const DRAW = {
  farn(b, st, d, w) {
    const G = wiltC([108, 174, 126], w), D = wiltC([66, 128, 106], w), Li = wiltC([158, 210, 156], w);
    if (st === 1) {
      b.part(); curve(b, [CX - 1, BY, CX - 4, BY - 6, CX - 1, BY - 10 + d * 4], 1.5, 1.1, G);
      disc(b, CX - 1 + d, BY - 11 + d * 4.5, 1.4, 1.4, Li); b.put(CX - 1 + d, BY - 11 + d * 4.5, D);
      b.part(); curve(b, [CX + 2, BY, CX + 4, BY - 4, CX + 3, BY - 7 + d * 3], 1.3, 1, D);
      disc(b, CX + 3, BY - 8 + d * 3, 1.1, 1.1, G);
      return;
    }
    const cfg = st === 2 ? { n: 4, len: 14, spread: 0.75 } : st === 3 ? { n: 6, len: 20, spread: 0.9 } : { n: 8, len: 27, spread: 1.0 };
    const angs = [];
    for (let i = 0; i < cfg.n; i++) angs.push(-Math.PI / 2 + (i / (cfg.n - 1) - 0.5) * 2 * cfg.spread);
    angs.sort((a1, a2) => Math.abs(a2 + Math.PI / 2) - Math.abs(a1 + Math.PI / 2));
    angs.forEach((a, i) => {
      const k = Math.abs(a + Math.PI / 2) / cfg.spread;
      const len = cfg.len * (1 - 0.3 * k);
      const shade = i / angs.length;
      frond(b, CX + (a + Math.PI / 2) * 1.6, BY, a, len, d, mix(D, G, 0.35 + shade * 0.65), D, mix(G, Li, shade));
    });
    if (st >= 3 && d < 0.4) {
      b.part(); curve(b, [CX + 1, BY, CX + 2, BY - 9, CX, BY - 13], 1.3, 1, Li);
      disc(b, CX - 0.5, BY - 14, 1.3, 1.3, Li); b.put(CX, BY - 14, G);
    }
  },

  sonnenblume(b, st, d, w) {
    const G = wiltC([112, 172, 106], w), D = wiltC([74, 128, 88], w);
    const Y = wiltC([250, 204, 96], w, 'flower'), Y2 = wiltC([236, 158, 74], w, 'flower');
    const C = wiltC([120, 78, 58], w, 'flower'), C2 = wiltC([84, 54, 48], w, 'flower');
    const H = [0, 10, 18, 27, 34][st];
    const tipX = CX + d * 7, tipY = BY - H + d * H * 0.16;
    const stem = [CX, BY, CX - d * 1.5, BY - H * 0.6, tipX, tipY];
    b.part(); curve(b, stem, st >= 3 ? 2.2 : 1.5, st >= 3 ? 1.6 : 1, D);
    const nl = [0, 2, 4, 6, 7][st];
    for (let i = 0; i < nl; i++) {
      const t = st === 1 ? 1 : 0.18 + 0.62 * (i / Math.max(1, nl - 1));
      const q = qp(stem, t);
      const side = i % 2 ? 1 : -1;
      const base = side > 0 ? -0.35 : -Math.PI + 0.35;
      const ang = base + d * side * 1.25;
      const len = st === 1 ? 4 : (st === 2 ? 6 : 8) * (1.1 - t * 0.45);
      b.part(); leaf(b, q[0], q[1], ang, len, len * 0.36, G, D);
    }
    if (st === 2) { b.part(); disc(b, tipX, tipY - 1, 1.6, 1.8, wiltC([132, 184, 112], w)); }
    const head = (hx, hy, R, pl) => {
      b.part();
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2 + 0.13;
        leaf(b, hx + Math.cos(a) * (R - 0.5), hy + Math.sin(a) * (R - 0.5), a, pl, pl * 0.33, k % 2 ? Y : Y2, null);
      }
      b.part(); disc(b, hx, hy, R, R * 0.92, C);
      disc(b, hx - R * 0.3, hy - R * 0.3, R * 0.45, R * 0.4, mix(C, Y2, 0.35));
      b.put(hx + 1, hy + 1, C2); b.put(hx - 1, hy + 1, C2); b.put(hx + 1, hy - 1, C2);
    };
    if (st === 4) {
      const q = qp(stem, 0.5);
      const sx = q[0] - 8, sy = q[1] - 4 + d * 4;
      b.part(); seg(b, q[0], q[1], sx, sy, 1, D);
      head(sx, sy, 2, 3.2);
    }
    if (st >= 3) {
      const R = st === 3 ? 3 : 4, pl = st === 3 ? 4 : 5.5;
      head(tipX + d * 2, tipY - 2 + d * 4, R, pl);
    }
  },

  kaktus(b, st, d, w) {
    const G = wiltC([110, 170, 130], w), D = wiltC([72, 126, 104], w), Li = wiltC([156, 204, 164], w);
    const S = [244, 236, 210];
    const P = wiltC([244, 150, 178], w, 'flower'), P2 = wiltC([252, 204, 216], w, 'flower'), Pc = wiltC([250, 214, 120], w, 'flower');
    const lean = d * 0.13;
    const shrink = 1 - w * 0.22;
    if (st === 1) {
      b.part(); disc(b, CX, BY - 3, 3.4 * shrink, 3.3, G);
      disc(b, CX - 1, BY - 4, 1.2, 1.2, Li);
      b.put(CX - 3, BY - 5, S); b.put(CX + 3, BY - 4, S); b.put(CX, BY - 7, S);
      return;
    }
    const column = (x0, y0, h, r) => {
      b.part();
      for (let y = 0; y <= h; y++) {
        const yy = y0 - y, xx = x0 + y * lean;
        const rr = y > h - r ? Math.sqrt(Math.max(0, r * r - (y - (h - r)) ** 2)) : r;
        for (let x = Math.floor(xx - rr - 1); x <= Math.ceil(xx + rr + 1); x++) {
          if (Math.abs(x - xx) <= rr + 0.15) {
            const k = (((Math.round(x - xx) % 3) + 3) % 3);
            b.put(x, yy, k === 0 ? D : (x < xx - rr * 0.3 && k === 1 ? Li : G));
          }
        }
      }
      for (let y = 2; y < h - 1; y += 3) {
        const xx = x0 + y * lean;
        b.put(xx - r - 1, y0 - y, S); b.put(xx + r + 1, y0 - y - 1, S);
      }
    };
    const flower = (x, y, s) => {
      b.part();
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; leaf(b, x, y, a, 2.2 * s, 1.1 * s, k % 2 ? P : P2, null); }
      b.put(x, y, Pc);
    };
    const H = [0, 0, 14, 22, 31][st], R = [0, 0, 4.2, 4.8, 5.2][st] * shrink;
    const arm = (side, yAt, h, r) => {
      const ax = CX + yAt * lean + side * (R + r + 1.5);
      b.part(); seg(b, CX + yAt * lean + side * (R - 1), BY - yAt + 1, ax, BY - yAt + 1, r * 2, G);
      column(ax, BY - yAt, h, r);
      return [ax + h * lean, BY - yAt - h - 1];
    };
    let tips = [];
    if (st === 3) tips.push(arm(-1, 9, 7, 2.2 * shrink));
    if (st === 4) { tips.push(arm(-1, 11, 9, 2.4 * shrink)); tips.push(arm(1, 17, 7, 2.2 * shrink)); }
    column(CX, BY, H, R);
    if (st >= 3 && w < 0.5) {
      flower(CX + H * lean, BY - H - 1, st === 4 ? 1.3 : 1.1);
      if (st === 4) tips.forEach((t) => flower(t[0], t[1], 0.9));
    }
  },

  kirschbaum(b, st, d, w) {
    const T = wiltC([136, 96, 78], w, 'wood'), Td = wiltC([98, 68, 62], w, 'wood');
    const G = wiltC([128, 176, 114], w), Gd = wiltC([86, 136, 98], w), Gl = wiltC([168, 206, 140], w);
    const P = wiltC([248, 184, 204], w, 'flower'), Pd = wiltC([222, 136, 168], w, 'flower'), Pl = wiltC([255, 226, 234], w, 'flower');
    const dr = (a) => a + d * 1.1 * Math.sign(Math.cos(a) || 1);
    const sag = d * 2.5;
    if (st === 1) {
      b.part(); seg(b, CX, BY, CX, BY - 8, 1, wiltC([128, 150, 100], w));
      b.part(); leaf(b, CX, BY - 8, dr(-Math.PI + 0.55), 4.5, 1.9, G, Gd);
      b.part(); leaf(b, CX, BY - 8, dr(-0.55), 4.5, 1.9, G, Gd);
      return;
    }
    if (st === 2) {
      b.part(); seg(b, CX, BY, CX, BY - 14, 2, T); seg(b, CX, BY - 9, CX - 5, BY - 14, 1, T); seg(b, CX + 1, BY - 11, CX + 6, BY - 16, 1, T);
      puff(b, CX - 6, BY - 15 + sag, 3.6, Gd, G, Gl);
      puff(b, CX + 6, BY - 17 + sag, 3.8, Gd, G, Gl);
      puff(b, CX, BY - 20 + sag, 4.2, Gd, G, Gl);
      return;
    }
    const big = st === 4;
    const trunkTop = big ? BY - 25 : BY - 19;
    b.part();
    seg(b, CX, BY, CX, trunkTop, big ? 3 : 2, T);
    if (big) { b.put(CX - 2, BY, Td); b.put(CX + 2, BY, T); b.put(CX + 3, BY, Td); }
    seg(b, CX, BY - (big ? 13 : 10), CX - (big ? 11 : 8), trunkTop - 2, big ? 2 : 1, T);
    seg(b, CX + 1, BY - (big ? 16 : 12), CX + (big ? 11 : 8), trunkTop - 4, big ? 2 : 1, T);
    const rnd = mulberry32(31 + st);
    const cy = big ? BY - 33 : BY - 25;
    const puffs = big
      ? [[-12, 2, 5], [12, 1, 5], [-7, -6, 6.5], [7, -7, 6.5], [0, -11, 6], [-4, 2, 6.5], [5, 2, 6.5], [-14, -4, 4], [14, -5, 4]]
      : [[-8, 1, 4.2], [8, 0, 4.2], [-3, -5, 5], [4, -5, 5], [0, 1, 5]];
    puffs.sort((p1, p2) => p1[1] - p2[1]);
    for (const [dx, dy, r] of puffs) {
      const leafy = !big && rnd() < 0.5;
      if (leafy || w > 0.6) puff(b, CX + dx, cy + dy + sag, r * (1 - w * 0.15), Gd, G, Gl);
      else puff(b, CX + dx, cy + dy + sag, r * (1 - w * 0.15), Pd, P, Pl);
    }
    // einzelne Blüten-Tupfer
    if (w < 0.6) {
      b.part();
      for (let i = 0; i < (big ? 26 : 12); i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (big ? 15 : 10);
        b.put(CX + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.75 + sag - 1, rnd() < 0.5 ? Pl : P);
      }
    }
  },

  monstera(b, st, d, w) {
    const G = wiltC([82, 158, 120], w), D = wiltC([54, 116, 96], w), S = wiltC([104, 150, 98], w);
    const dr = (a) => a + d * 1.0 * Math.sign(Math.cos(a) || 1);
    const L = {
      1: [[2, -7, -0.9, 5, 0]],
      2: [[-6, -10, -2.6, 7, 0], [6, -12, -0.5, 7, 0], [0, -15, -1.65, 6.5, 0]],
      3: [[-7, -12, -2.8, 10, 1], [7, -14, -0.35, 10, 2], [-3, -22, -2.15, 9, 1], [4, -24, -0.95, 9.5, 2]],
      4: [[-8, -10, 3.0, 12, 3], [8, -12, 0.15, 12, 3], [-5, -24, -2.5, 12, 3], [6, -27, -0.7, 12, 3], [0, -31, -1.6, 10, 2]]
    }[st];
    L.forEach(([ax, ay, ang, size, slits], i) => {
      const x = CX + ax, y = BY + ay + d * size * 0.45;
      b.part();
      curve(b, [CX + ax * 0.1, BY, CX + ax * 0.35, y + (BY - y) * 0.3, x, y], st >= 3 ? 1.5 : 1, 1, S);
      const shade = 0.75 + 0.25 * (i / L.length);
      leaf(b, x, y, dr(ang), size, size * 0.6, mix(D, G, shade), D, { heart: true, slits });
      if (size >= 7) seg(b, x + Math.cos(dr(ang)) * 1.5, y + Math.sin(dr(ang)) * 1.5, x + Math.cos(dr(ang)) * size * 0.75, y + Math.sin(dr(ang)) * size * 0.75, 1, mix(G, [200, 230, 190], 0.3));
    });
    if (st >= 3 && w < 0.5) { // Blütenkolben (Spatha)
      b.part();
      leaf(b, CX + 2, BY - 8, -1.25, 6, 2, [240, 228, 198], [214, 200, 168], { round: true });
      seg(b, CX + 2.5, BY - 9, CX + 3.5, BY - 12, 1, [232, 206, 140]);
    }
  }
};

function frond(b, x0, y0, ang, len, droop, col, dark, light) {
  // Wedel: steigt auf, biegt sich nach außen; beim Hängen kippt die Spitze nach unten
  const sgn = Math.sign(Math.cos(ang)) || (ang > -Math.PI / 2 ? 1 : -1);
  const out = ang + sgn * (0.75 + droop * 1.3);
  const cx = x0 + Math.cos(ang) * len * 0.62, cy = y0 + Math.sin(ang) * len * 0.62 + droop * len * 0.25;
  const x1 = cx + Math.cos(out) * len * 0.5, y1 = cy + Math.sin(out) * len * 0.5 + droop * len * 0.2;
  const a = [x0, y0, cx, cy, x1, y1];
  b.part();
  const n = Math.max(4, Math.floor(len / 1.7));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = qp(a, t), q = qp(a, Math.min(1, t + 0.03));
    const dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const l = Math.pow(1 - t, 0.6) * len * 0.2 + 0.8;
    for (const s of [-1, 1]) {
      const la = dir + s * (0.95 - droop * 0.25) + droop * 0.7 * (Math.sign(Math.cos(dir)) || 1);
      seg(b, p[0], p[1], p[0] + Math.cos(la) * l, p[1] + Math.sin(la) * l, 1, s > 0 ? col : light);
    }
  }
  curve(b, a, 1.2, 1, dark);
}

function buildBuf(sp, st, cond) {
  const b = new Buf();
  const d = [0, 0.5, 0.95][cond], w = [0, 0.2, 0.85][cond];
  if (st === 0) drawSeed(b, sp);
  else DRAW[sp](b, st, d, w);
  return b;
}

/** Pixelpuffer -> Canvas, mit weicher Licht/Schatten-Kante, Kontaktschatten und getöntem Umriss. */
function bake(b, amb, flip) {
  const w = b.w, h = b.h;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const img = c.createImageData(w, h);
  const D = img.data;
  const am = [amb[0] / 255, amb[1] / 255, amb[2] / 255];
  let topRow = h - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = (y * w + (flip ? w - 1 - x : x)) * 4;
      const col = b.c[i], p = b.p[i];
      const up = y > 0 ? b.p[i - w] : -1, lf = x > 0 ? b.p[i - 1] : -1;
      const dn = y < h - 1 ? b.p[i + w] : -1, rt = x < w - 1 ? b.p[i + 1] : -1;
      if (col) {
        if (y < topRow) topRow = y;
        const ls = up === -1 || (flip ? rt === -1 : lf === -1);
        const ds = dn === -1 || (flip ? lf === -1 : rt === -1);
        let k = 1;
        if (ls && !ds) k = 1.13; else if (ds && !ls) k = 0.86;
        if (up > p || lf > p || dn > p || rt > p) k *= 0.8; // liegt hinter etwas
        D[o] = clamp(col[0] * k * am[0], 0, 255);
        D[o + 1] = clamp(col[1] * k * am[1], 0, 255);
        D[o + 2] = clamp(col[2] * k * am[2], 0, 255);
        D[o + 3] = 255;
      } else {
        const nb = up >= 0 ? b.c[i - w] : dn >= 0 ? b.c[i + w] : lf >= 0 ? b.c[i - 1] : rt >= 0 ? b.c[i + 1] : null;
        if (nb) {
          D[o] = (nb[0] * 0.3 + 40 * 0.7) * am[0];
          D[o + 1] = (nb[1] * 0.3 + 26 * 0.7) * am[1];
          D[o + 2] = (nb[2] * 0.3 + 58 * 0.7) * am[2];
          D[o + 3] = 165;
        }
      }
    }
  }
  c.putImageData(img, 0, 0);
  cv.topRow = topRow;
  return cv;
}

const spriteCache = new Map();
let ambKey = '';
function getSprite(sp, st, cond, flip) {
  const k = sp + st + cond + (flip ? 'f' : '');
  let s = spriteCache.get(k);
  if (!s) { s = bake(buildBuf(sp, st, cond), pal.amb, flip); spriteCache.set(k, s); }
  return s;
}
function previewCanvas(sp, st, cond) {
  const cv = bake(buildBuf(sp, st, cond), [255, 255, 255], false);
  cv.className = 'pixel';
  return cv;
}

/* ------------------------------------------------------------------ Pixel-Schrift (5x5, Umlaute 7 hoch) */
const FONT = (() => {
  const g = {
    A: '01110 10001 11111 10001 10001', B: '11110 10001 11110 10001 11110', C: '01111 10000 10000 10000 01111',
    D: '11110 10001 10001 10001 11110', E: '11111 10000 11110 10000 11111', F: '11111 10000 11110 10000 10000',
    G: '01111 10000 10011 10001 01111', H: '10001 10001 11111 10001 10001', I: '11111 00100 00100 00100 11111',
    J: '00111 00001 00001 10001 01110', K: '10001 10010 11100 10010 10001', L: '10000 10000 10000 10000 11111',
    M: '10001 11011 10101 10001 10001', N: '10001 11001 10101 10011 10001', O: '01110 10001 10001 10001 01110',
    P: '11110 10001 11110 10000 10000', Q: '01110 10001 10101 10010 01101', R: '11110 10001 11110 10010 10001',
    S: '01111 10000 01110 00001 11110', T: '11111 00100 00100 00100 00100', U: '10001 10001 10001 10001 01110',
    V: '10001 10001 10001 01010 00100', W: '10001 10001 10101 11011 10001', X: '10001 01010 00100 01010 10001',
    Y: '10001 01010 00100 00100 00100', Z: '11111 00010 00100 01000 11111',
    0: '01110 10011 10101 11001 01110', 1: '00100 01100 00100 00100 01110', 2: '11110 00001 01110 10000 11111',
    3: '11110 00001 00110 00001 11110', 4: '10010 10010 11111 00010 00010', 5: '11111 10000 11110 00001 11110',
    6: '01110 10000 11110 10001 01110', 7: '11111 00001 00010 00100 00100', 8: '01110 10001 01110 10001 01110',
    9: '01110 10001 01111 00001 01110',
    '.': '00000 00000 00000 00000 00100', '-': '00000 00000 01110 00000 00000', '!': '00100 00100 00100 00000 00100',
    '?': '01110 00001 00110 00000 00100', ':': '00000 00100 00000 00100 00000', '+': '00000 00100 01110 00100 00000',
    ',': '00000 00000 00000 00100 01000'
  };
  const out = {};
  for (const k in g) out[k] = ['00000', '00000'].concat(g[k].split(' '));
  out['Ä'] = ['01010', '00000'].concat(g.A.split(' '));
  out['Ö'] = ['01010', '00000'].concat(g.O.split(' '));
  out['Ü'] = ['01010', '00000'].concat(g.U.split(' '));
  return out;
})();
function pixelText(str, scale, dark) {
  str = String(str).toUpperCase().replace(/ß/g, 'SS');
  const glyphs = [];
  let w = 0;
  for (const ch of str) { const gw = ch === ' ' ? 3 : 5; glyphs.push([FONT[ch], gw]); w += gw + 1; }
  w = Math.max(1, w - 1);
  const cv = document.createElement('canvas');
  cv.width = w + 1; cv.height = 8;
  const c = cv.getContext('2d');
  const shades = dark ? ['#3a2440', '#3a2440', '#3a2440', '#3a2440', '#3a2440', '#4a2c48', '#4a2c48'] : ['#fff4e2', '#fff0dc', '#ffe6cf', '#fcdac0', '#f8c8ac', '#f4b79a', '#f0a88c'];
  for (const pass of [0, 1]) {
    let x = 0;
    for (const [rows, gw] of glyphs) {
      if (rows) rows.forEach((r, y) => {
        for (let i = 0; i < 5; i++) if (r[i] === '1') {
          if (pass === 0) { if (dark) continue; c.fillStyle = 'rgba(42,26,64,.85)'; c.fillRect(x + i + 1, y + 1, 1, 1); }
          else { c.fillStyle = shades[y]; c.fillRect(x + i, y, 1, 1); }
        }
      });
      x += gw + 1;
    }
  }
  cv.className = 'pixeltext';
  cv.style.width = cv.width * scale + 'px';
  cv.style.height = cv.height * scale + 'px';
  cv.setAttribute('aria-hidden', 'true');
  return cv;
}

/* ------------------------------------------------------------------ Tageszeit-Paletten */
const PALS_RAW = {
  nacht:      { top: '#0f1430', mid: '#1e2148', bot: '#3a2f5e', far: '#2b2952', near: '#1d1f3e', cloud: '#2f2c58', sun: '#ffd9a0', amb: [112, 120, 184], night: 1, lamps: 1, dust: 0 },
  daemmerung: { top: '#2b3466', mid: '#8a6a9c', bot: '#f0a688', far: '#6f5b8f', near: '#4a456e', cloud: '#c79db6', sun: '#ffc39a', amb: [206, 176, 196], night: 0.35, lamps: 0.6, dust: 0.5 },
  morgen:     { top: '#86acd6', mid: '#d6c2d8', bot: '#f8cdb2', far: '#a496c4', near: '#7787b0', cloud: '#fde6da', sun: '#ffe0b0', amb: [255, 238, 230], night: 0, lamps: 0, dust: 1 },
  tag:        { top: '#6ea8d2', mid: '#a7d0dc', bot: '#e2eedf', far: '#93bdb4', near: '#679f93', cloud: '#f6f2ea', sun: '#fff4d8', amb: [255, 252, 246], night: 0, lamps: 0, dust: 0.55 },
  abend:      { top: '#4a3e7a', mid: '#c76f8e', bot: '#f7a86a', far: '#8c5f90', near: '#5d4472', cloud: '#f4b49a', sun: '#ffb27a', amb: [255, 198, 170], night: 0.08, lamps: 0.75, dust: 1 },
  spaet:      { top: '#1d1e48', mid: '#4f3c72', bot: '#a0607e', far: '#4a3a6c', near: '#2e2a52', cloud: '#584876', sun: '#ff9a70', amb: [172, 152, 198], night: 0.75, lamps: 1, dust: 0.1 }
};
const PALS = {};
for (const k in PALS_RAW) {
  PALS[k] = {};
  for (const f in PALS_RAW[k]) { const v = PALS_RAW[k][f]; PALS[k][f] = typeof v === 'string' ? hex(v) : v; }
}
const TIMELINE = [[0, 'nacht'], [4.8, 'nacht'], [6, 'daemmerung'], [7.3, 'morgen'], [9.5, 'morgen'], [11, 'tag'], [16, 'tag'],
  [18, 'abend'], [19.6, 'abend'], [20.6, 'spaet'], [21.6, 'nacht'], [24, 'nacht']];
function paletteAt(h) {
  let i = 0;
  while (i < TIMELINE.length - 2 && h >= TIMELINE[i + 1][0]) i++;
  const [h0, a] = TIMELINE[i], [h1, bb] = TIMELINE[i + 1];
  let t = clamp(h1 > h0 ? (h - h0) / (h1 - h0) : 0, 0, 1);
  t = t * t * (3 - 2 * t);
  const A = PALS[a], B = PALS[bb], r = {};
  for (const k in A) r[k] = Array.isArray(A[k]) ? mix(A[k], B[k], t) : lerp(A[k], B[k], t);
  return r;
}
function phaseOf(h) {
  if (h >= 5 && h < 11) return 'morgen';
  if (h >= 11 && h < 17) return 'tag';
  if (h >= 17 && h < 21.5) return 'abend';
  return 'nacht';
}

/* ------------------------------------------------------------------ Szene */
const canvas = $('garten'), ctx = canvas.getContext('2d');
const szene = $('szene');
const skyCv = document.createElement('canvas'), skyCtx = skyCv.getContext('2d');
const landCv = document.createElement('canvas'), landCtx = landCv.getContext('2d');

let PX = 3, W = 125, H = 270, VH = 270, horizonY = 90, firstBase = 126, cols = 3;
let slots = [], beds = [];
let pal = paletteAt(currentHour());

const GRASS_TOP = [134, 170, 128], GRASS_BOT = [82, 122, 112];
const SOIL = [100, 70, 60], SOIL_TOP = [128, 92, 74], SOIL_WET = [70, 48, 46];
const WOOD = [176, 124, 92], WOOD_L = [208, 158, 116], WOOD_D = [118, 80, 66];
const FENCE = [222, 202, 188], FENCE_D = [176, 150, 150];
const BULBS = [[255, 206, 140], [255, 170, 150], [255, 228, 180], [246, 170, 200]];
const A = (c) => [c[0] * pal.amb[0] / 255, c[1] * pal.amb[1] / 255, c[2] * pal.amb[2] / 255];
const lightSag = () => Math.min(15, W * 0.07);
const lightY = (x) => { const u = (2 * x / W) - 1; return 3 + lightSag() * (1 - u * u); };

function layout() {
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = innerHeight;
  PX = clamp(Math.floor(vw / 125), 2, 4);
  W = Math.max(60, Math.ceil(vw / PX));
  VH = Math.max(120, Math.ceil(vh / PX));
  horizonY = Math.max(60, Math.round(VH * 0.36));
  firstBase = horizonY + 38;
  cols = clamp(Math.floor((W - 8) / 36), 1, 6);
  const slotW = Math.min(SLOT, Math.floor((W - 8) / cols));
  const plants = state.garden.plants, n = plants.length;
  const rows = Math.max(1, Math.ceil(n / cols));
  slots = []; beds = [];
  for (let r = 0; r < rows; r++) {
    const items = n ? Math.min(cols, n - r * cols) : Math.min(cols, 3);
    const x0 = Math.round((W - items * slotW) / 2);
    const base = firstBase + r * RH;
    beds.push({ x0: x0 - 4, x1: x0 + items * slotW + 4, base });
    if (!n) continue;
    for (let i = 0; i < items; i++) {
      const p = plants[r * cols + i];
      const hs = hashStr(p.id);
      slots.push({ p, cx: x0 + i * slotW + slotW / 2, base, flip: (hs & 1) === 1, phase: (hs % 628) / 100 });
    }
  }
  H = Math.max(VH, firstBase + (rows - 1) * RH + 18 + Math.ceil(100 / PX));
  for (const cv of [canvas, skyCv, landCv]) { cv.width = W; cv.height = H; }
  canvas.style.width = W * PX + 'px';
  canvas.style.height = H * PX + 'px';
  szene.style.height = H * PX + 'px';
  ctx.imageSmoothingEnabled = true;
  $('kopf').style.top = `max(calc(var(--sat) + 10px), ${Math.round((3 + lightSag() + 7) * PX)}px)`;
  const leer = $('leer');
  leer.style.top = (firstBase + 12) * PX + 'px';
  initParticles();
}

function renderLayers() {
  pal = paletteAt(currentHour());
  const k = pal.amb.map((v) => Math.round(v / 6)).join(',');
  if (k !== ambKey) { ambKey = k; spriteCache.clear(); }
  renderSky();
  renderLand();
}

function pdisc(c, x, y, r, fill) {
  c.fillStyle = fill;
  for (let dy = -r; dy <= r; dy++) {
    const hw = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy + r * 0.6)));
    c.fillRect(Math.round(x) - hw, Math.round(y) + dy, hw * 2 + 1, 1);
  }
}

function renderSky() {
  const c = skyCtx, hz = horizonY;
  for (let y = 0; y < H; y++) {
    const t = Math.min(1, y / hz);
    const col = t < 0.55 ? mix(pal.top, pal.mid, t / 0.55) : mix(pal.mid, pal.bot, (t - 0.55) / 0.45);
    c.fillStyle = css(col);
    c.fillRect(0, y, W, 1);
  }
  const h = currentHour();
  if (h > 5.4 && h < 20.6) { // Sonne
    const t = (h - 5.4) / 15.2;
    const x = W * (0.1 + 0.8 * t), y = hz + 2 - Math.sin(Math.PI * t) * hz * 0.66;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.55;
    c.drawImage(glow(pal.sun), x - 34, y - 34, 68, 68);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    pdisc(c, x, y, 6, css(pal.sun));
    pdisc(c, x - 1.5, y - 1.5, 3, css(mix(pal.sun, [255, 255, 255], 0.45)));
  }
  if (h > 19.4 || h < 6.6) { // Mond
    const t = ((h - 19.4 + 24) % 24) / 11.2;
    const x = W * (0.12 + 0.76 * t), y = hz + 2 - Math.sin(Math.PI * t) * hz * 0.6;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.35;
    c.drawImage(glow([200, 200, 255]), x - 24, y - 24, 48, 48);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    pdisc(c, x, y, 5, '#f3ead6');
    c.fillStyle = '#d8ccb6';
    c.fillRect(Math.round(x) - 2, Math.round(y) - 1, 2, 2);
    c.fillRect(Math.round(x) + 1, Math.round(y) + 2, 1, 1);
    c.fillRect(Math.round(x) + 2, Math.round(y) - 3, 1, 1);
  }
}

function renderLand() {
  const c = landCtx, hz = horizonY;
  c.clearRect(0, 0, W, H);
  // ferne Hügel
  c.fillStyle = css(pal.far);
  for (let x = 0; x < W; x++) {
    const y = Math.round(hz - 13 - 5 * Math.sin(x * 0.035 + 1.3) - 3 * Math.sin(x * 0.09 + 0.5));
    c.fillRect(x, y, 1, hz - y + 1);
  }
  c.fillStyle = css(mix(pal.far, pal.bot, 0.35));
  for (let x = 0; x < W; x++) {
    const y = Math.round(hz - 13 - 5 * Math.sin(x * 0.035 + 1.3) - 3 * Math.sin(x * 0.09 + 0.5));
    c.fillRect(x, y, 1, 1);
  }
  // nahe Hügel mit Baumtupfern
  const nearY = [];
  c.fillStyle = css(pal.near);
  for (let x = 0; x < W; x++) {
    const y = Math.round(hz - 5 - 3 * Math.sin(x * 0.06 + 2.1) - 2 * Math.sin(x * 0.15));
    nearY[x] = y;
    c.fillRect(x, y, 1, hz - y + 2);
  }
  const rnd = mulberry32(9);
  for (let x = 3; x < W; x += 7 + rnd() * 13) {
    const r = 1.5 + rnd() * 1.6;
    const y = nearY[x | 0];
    pdisc(c, x, y - r + 0.5, Math.round(r), css(mix(pal.near, [0, 0, 0], 0.1)));
    c.fillStyle = css(mix(pal.near, pal.bot, 0.18));
    c.fillRect(Math.round(x) - 1, Math.round(y - r * 2 + 1), 1, 1);
  }
  // Wiese
  for (let y = hz; y < H; y++) {
    const t = Math.min(1, (y - hz) / Math.max(40, VH - hz));
    c.fillStyle = css(A(mix(GRASS_TOP, GRASS_BOT, t)));
    c.fillRect(0, y, W, 1);
  }
  const r2 = mulberry32(5);
  const nTuft = Math.floor(W * (H - hz) / 45);
  for (let i = 0; i < nTuft; i++) {
    const x = Math.floor(r2() * W), y = hz + 2 + Math.floor(r2() * (H - hz));
    const t = Math.min(1, (y - hz) / Math.max(40, VH - hz));
    const base = mix(GRASS_TOP, GRASS_BOT, t);
    c.fillStyle = css(A(r2() < 0.5 ? mix(base, [210, 230, 170], 0.25) : mix(base, [40, 70, 70], 0.25)));
    c.fillRect(x, y, 1, r2() < 0.4 ? 2 : 1);
  }
  const FLOWERS = [[250, 214, 226], [252, 236, 200], [200, 186, 240], [250, 190, 160]];
  for (let i = 0; i < W / 4; i++) {
    const x = Math.floor(r2() * W), y = hz + 3 + Math.floor(r2() * (H - hz));
    c.fillStyle = css(A(FLOWERS[i % 4]));
    c.fillRect(x, y, 1, 1);
  }
  // Zaun
  c.fillStyle = css(A(FENCE_D));
  c.fillRect(0, hz - 5, W, 1); c.fillRect(0, hz - 2, W, 1);
  for (let x = 1; x < W; x += 6) {
    c.fillStyle = css(A(FENCE));
    c.fillRect(x, hz - 7, 2, 9);
    c.fillStyle = css(A(FENCE_D));
    c.fillRect(x + 1, hz - 6, 1, 8);
    c.fillStyle = css(A(mix(FENCE, [255, 255, 255], 0.3)));
    c.fillRect(x, hz - 7, 1, 1);
  }
  c.fillStyle = 'rgba(30,20,40,.12)';
  c.fillRect(0, hz + 2, W, 2);
  // Beete
  for (const bed of beds) drawBed(c, bed);
  // nasse Erde unter heute gegossenen Pflanzen
  const t = today();
  for (const s of slots) {
    if (wateredToday(s.p, t) && !pendingVis.has(s.p.id)) {
      c.fillStyle = css(A(SOIL_WET));
      c.beginPath(); c.ellipse(s.cx, s.base - 0.5, 9, 2.2, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = css(A(mix(SOIL_WET, [170, 200, 220], 0.35)));
      c.fillRect(Math.round(s.cx) - 5, s.base - 2, 2, 1);
      c.fillRect(Math.round(s.cx) + 4, s.base, 1, 1);
    }
  }
  // Lichterkette
  c.fillStyle = css(A([66, 52, 76]));
  for (let x = -1; x <= W; x++) c.fillRect(x, Math.round(lightY(x)), 1, 1);
  bulbList().forEach(([x, y], i) => {
    c.fillStyle = css(A([60, 48, 66]));
    c.fillRect(x, y - 1, 1, 1);
    c.fillStyle = css(A(mix(BULBS[i % 4], [120, 100, 110], 0.35)));
    c.fillRect(x - 1, y, 3, 2);
    c.fillRect(x, y + 2, 1, 1);
  });
}
function bulbList() {
  const out = [];
  for (let x = 6; x < W - 2; x += 11) out.push([x, Math.round(lightY(x)) + 1]);
  return out;
}

function drawBed(c, bed) {
  const { x0, x1, base } = bed, w = x1 - x0;
  c.fillStyle = 'rgba(24,14,34,.22)';
  c.fillRect(x0 + 1, base + 8, w + 1, 2);
  c.fillStyle = css(A(SOIL));
  c.fillRect(x0 + 1, base - 3, w - 2, 6);
  c.fillStyle = css(A(SOIL_TOP));
  c.fillRect(x0 + 2, base - 3, w - 4, 1);
  const r = mulberry32(base * 7 + x0);
  for (let i = 0; i < w * 1.2; i++) {
    c.fillStyle = css(A(r() < 0.5 ? mix(SOIL, [0, 0, 0], 0.25) : mix(SOIL, SOIL_TOP, 0.8)));
    c.fillRect(x0 + 2 + Math.floor(r() * (w - 4)), base - 2 + Math.floor(r() * 4), 1, 1);
  }
  c.fillStyle = css(A(WOOD));
  c.fillRect(x0, base + 2, w, 6);
  c.fillStyle = css(A(WOOD_L));
  c.fillRect(x0, base + 2, w, 1);
  c.fillStyle = css(A(WOOD_D));
  c.fillRect(x0, base + 7, w, 1);
  c.fillRect(x0, base + 5, w, 1);
  c.fillStyle = css(A(mix(WOOD, WOOD_L, 0.5)));
  for (let x = x0 + 3; x < x1 - 3; x += 5) c.fillRect(x + ((x * 7) % 3), base + 3 + ((x * 3) % 2) * 3, 2, 1);
  c.fillStyle = css(A(WOOD_D));
  for (let x = x0 + 14; x < x1 - 4; x += 15) c.fillRect(x, base + 2, 1, 6);
  for (const px of [x0 - 1, x1 - 2]) {
    c.fillStyle = css(A(WOOD_D)); c.fillRect(px, base - 4, 3, 12);
    c.fillStyle = css(A(WOOD_L)); c.fillRect(px, base - 4, 1, 11);
    c.fillStyle = css(A(mix(WOOD_L, [255, 255, 255], 0.3))); c.fillRect(px, base - 4, 3, 1);
  }
}

/* Glow-Sprites (radiale Verläufe, einmal erzeugt) */
const glowCache = new Map();
function glow(col) {
  const k = col.map((v) => v | 0).join(',');
  let g = glowCache.get(k);
  if (!g) {
    g = document.createElement('canvas'); g.width = g.height = 32;
    const c = g.getContext('2d');
    const gr = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    gr.addColorStop(0, css(col, 1)); gr.addColorStop(0.3, css(col, 0.4)); gr.addColorStop(1, css(col, 0));
    c.fillStyle = gr; c.fillRect(0, 0, 32, 32);
    if (glowCache.size > 24) glowCache.clear();
    glowCache.set(k, g);
  }
  return g;
}

/* Gießkanne (Pixel) */
const canSprite = (() => {
  const c = document.createElement('canvas'); c.width = 18; c.height = 12;
  const x = c.getContext('2d');
  const R = (col, a, b, w, h) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
  R('#3e6b74', 5, 2, 9, 9); R('#7cc4bd', 6, 3, 7, 7); R('#a9e2d8', 7, 4, 2, 4); R('#5d9fa0', 6, 8, 7, 2);
  R('#3e6b74', 7, 0, 5, 1); R('#3e6b74', 6, 1, 1, 1); R('#3e6b74', 12, 1, 1, 1);
  R('#3e6b74', 14, 4, 1, 1); R('#3e6b74', 15, 5, 1, 3); R('#3e6b74', 14, 8, 1, 1);
  R('#5d9fa0', 4, 6, 1, 2); R('#5d9fa0', 3, 5, 1, 2); R('#5d9fa0', 2, 4, 1, 2); R('#5d9fa0', 1, 3, 1, 2);
  R('#a9e2d8', 0, 2, 2, 2);
  return c;
})();

/* ------------------------------------------------------------------ Partikel */
let stars = [], clouds = [], flies = [], dust = [], drops = [], sparks = [], petals = [], cans = [];
const pendingVis = new Map(); // id -> {stage, cond} während der Gieß-Animation
const wiggle = new Map();     // id -> Zeitpunkt des Gießens
function initParticles() {
  const r = mulberry32(123);
  stars = Array.from({ length: Math.round(W * 0.35) }, () => ({ x: r(), y: r(), s: 0.6 + r() * 2.2, p: r() * 6.28, big: r() < 0.12 }));
  clouds = Array.from({ length: 4 }, (_, i) => ({ x: r() * W, y: 0.22 + r() * 0.4, s: 0.7 + r() * 0.7, v: 0.6 + r() * 0.9 + i * 0.1 }));
  flies = Array.from({ length: 14 }, () => ({ x: r(), y: r(), a: 0.15 + r() * 0.3, b: 0.2 + r() * 0.3, c: 0.6 + r() * 1.2, p: r() * 6.28 }));
  dust = Array.from({ length: 22 }, () => ({ x: r() * W, y: r() * H, v: 0.8 + r() * 1.6, p: r() * 6.28, a: 0.3 + r() * 0.6 }));
}

/* ------------------------------------------------------------------ Hauptschleife */
let raf = 0, last = 0, T = 0, dt = 0;
function frame(now) {
  raf = requestAnimationFrame(frame);
  if (now - last < 32) return; // ~30 fps reicht und schont den Akku
  dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  T = now / 1000;
  draw();
}
function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

function draw() {
  if (!W || !H || !skyCv.width) return;
  const c = ctx;
  const viewTop = Math.floor(window.scrollY / PX) - 4, viewBot = viewTop + VH + 8;
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.drawImage(skyCv, 0, 0);

  // Sterne
  if (pal.night > 0.05) {
    for (const s of stars) {
      const a = pal.night * (0.45 + 0.55 * Math.sin(T * s.s + s.p)) ;
      if (a <= 0.03) continue;
      const x = Math.floor(s.x * W), y = Math.floor(s.y * (horizonY - 26));
      c.fillStyle = `rgba(255,244,222,${a.toFixed(2)})`;
      c.fillRect(x, y, 1, 1);
      if (s.big && a > 0.6) {
        c.fillStyle = `rgba(255,244,222,${(a * 0.35).toFixed(2)})`;
        c.fillRect(x - 1, y, 1, 1); c.fillRect(x + 1, y, 1, 1); c.fillRect(x, y - 1, 1, 1); c.fillRect(x, y + 1, 1, 1);
      }
    }
  }
  // Wolken
  for (const cl of clouds) {
    cl.x += cl.v * dt;
    if (cl.x - 30 * cl.s > W) cl.x = -30 * cl.s;
    const y = cl.y * horizonY;
    const t = Math.min(1, y / horizonY);
    const skyCol = t < 0.55 ? mix(pal.top, pal.mid, t / 0.55) : mix(pal.mid, pal.bot, (t - 0.55) / 0.45);
    c.fillStyle = css(mix(skyCol, mix(pal.cloud, [40, 20, 60], 0.12), 0.85));
    cloudShape(c, cl.x + 1, y + 1.5, cl.s);
    c.fillStyle = css(mix(skyCol, pal.cloud, 0.92));
    cloudShape(c, cl.x, y, cl.s);
  }

  c.drawImage(landCv, 0, 0);

  // Pflanzen
  for (const s of slots) {
    if (s.base < viewTop || s.base - SH > viewBot) continue;
    drawPlant(c, s);
  }

  // Wasser, Funken, Blütenblätter, Gießkannen
  updateFx(c);

  // Licht: Lampen, Glühwürmchen, Staub
  c.globalCompositeOperation = 'lighter';
  if (pal.lamps > 0.05) {
    bulbList().forEach(([x, y], i) => {
      const a = pal.lamps * (0.8 + 0.2 * Math.sin(T * 1.3 + i * 1.7));
      c.globalAlpha = a * 0.55;
      c.drawImage(glow(BULBS[i % 4]), x - 9, y - 8, 19, 19);
      c.globalAlpha = a * 0.9;
      c.fillStyle = css(BULBS[i % 4]);
      c.fillRect(x - 1, y, 3, 2);
    });
  }
  if (pal.night > 0.25) {
    for (const f of flies) {
      const x = f.x * W + Math.sin(T * f.a + f.p) * 14 + Math.sin(T * f.a * 2.3) * 4;
      const y = horizonY - 8 + f.y * (H - horizonY) + Math.sin(T * f.b + f.p * 2) * 8;
      if (y < viewTop || y > viewBot) continue;
      const bl = Math.max(0, Math.sin(T * f.c + f.p));
      const a = (pal.night - 0.2) * bl * bl;
      if (a < 0.02) continue;
      c.globalAlpha = a * 0.75;
      c.drawImage(glow([200, 240, 140]), x - 6, y - 6, 12, 12);
      c.globalAlpha = a;
      c.fillStyle = '#f4ffc4';
      c.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }
  if (pal.dust > 0.05) {
    for (const d of dust) {
      d.y -= d.v * dt; d.x += Math.sin(T * 0.4 + d.p) * 0.05;
      if (d.y < 0) { d.y = H; d.x = Math.random() * W; }
      if (d.y < viewTop || d.y > viewBot) continue;
      c.globalAlpha = pal.dust * d.a * (0.35 + 0.3 * Math.sin(T * 0.9 + d.p));
      c.fillStyle = '#fff0d6';
      c.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
    }
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
}

function cloudShape(c, x, y, s) {
  const e = (ex, ey, rx, ry) => { c.beginPath(); c.ellipse(x + ex * s, y + ey * s, rx * s, ry * s, 0, 0, Math.PI * 2); c.fill(); };
  e(0, 0, 12, 3); e(-5, -1.5, 5.5, 3.5); e(3, -3, 6.5, 4.5); e(9, -1, 4, 2.6);
}

function visualOf(p) {
  const v = pendingVis.get(p.id);
  if (v) return v;
  return { stage: stageOf(p.growth), cond: condition(p, today()) };
}

function drawPlant(c, s) {
  const p = s.p, vis = visualOf(p);
  const spr = getSprite(p.species, vis.stage, vis.cond, s.flip);
  const top = s.base - SH + 1, left = Math.round(s.cx - SW / 2);
  // weicher Schatten
  c.fillStyle = 'rgba(30,16,40,.28)';
  c.beginPath(); c.ellipse(s.cx, s.base + 0.5, 5 + vis.stage * 1.6, 1.4, 0, 0, Math.PI * 2); c.fill();
  let amp = [1.1, 0.6, 0.2][vis.cond];
  const wt = wiggle.get(p.id);
  if (wt != null) {
    const e = T - wt;
    if (e > 3) wiggle.delete(p.id);
    else amp += 2.4 * Math.exp(-e * 1.5) * Math.sin(e * 9);
  }
  const sw = Math.sin(T * 0.8 + s.phase) + 0.35 * Math.sin(T * 1.9 + s.phase * 1.7);
  const tr = spr.topRow, span = Math.max(1, SH - 1 - tr);
  for (let y = tr; y < SH; y++) {
    const f = (SH - 1 - y) / span;
    const off = Math.round(amp * sw * f * f);
    c.drawImage(spr, 0, y, SW, 1, left + off, top + y, SW, 1);
  }
  // Kirschblüten fallen
  if (p.species === 'kirschbaum' && vis.stage >= 3 && vis.cond === 0 && Math.random() < dt * 0.5 && petals.length < 40) {
    petals.push({ x: s.cx + (Math.random() - 0.5) * 26, y: s.base - 30 - Math.random() * 8, ground: s.base + 1, p: Math.random() * 6, life: 0 });
  }
}

function updateFx(c) {
  // Gießkannen
  for (let i = cans.length - 1; i >= 0; i--) {
    const k = cans[i], e = T - k.t0, s = k.s;
    if (e > 1.2 && !k.done) { k.done = true; onWatered(k); }
    if (e > 1.75) { cans.splice(i, 1); continue; }
    const tilt = e < 0.3 ? -0.75 * (e / 0.3) : e < 1.15 ? -0.75 + 0.06 * Math.sin(e * 12) : -0.75 * Math.max(0, 1 - (e - 1.15) / 0.4);
    const alpha = e < 0.18 ? e / 0.18 : e > 1.45 ? Math.max(0, 1 - (e - 1.45) / 0.3) : 1;
    const px = s.cx + 10, py = Math.max(8, s.base - SH + k.top - 7);
    c.save();
    c.globalAlpha = alpha;
    c.translate(Math.round(px), Math.round(py - (e < 0.3 ? (1 - e / 0.3) * 3 : 0)));
    c.rotate(tilt);
    c.imageSmoothingEnabled = false;
    c.drawImage(canSprite, -9, -6);
    c.restore();
    if (e > 0.3 && e < 1.1) {
      const ca = Math.cos(tilt), sa = Math.sin(tilt);
      const tx = px + (-8.5 * ca - -3.5 * sa), ty = py + (-8.5 * sa + -3.5 * ca);
      for (let j = 0; j < 2; j++) {
        drops.push({ x: tx + Math.random() * 1.5, y: ty, vx: -3 - Math.random() * 6, vy: 6 + Math.random() * 8, ground: s.base - 1 + Math.random() * 2 });
      }
    }
  }
  // Tropfen
  c.fillStyle = 'rgba(170,226,240,.9)';
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.vy += 150 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
    if (d.y >= d.ground) {
      drops.splice(i, 1);
      if (Math.random() < 0.5) sparks.push({ x: d.x, y: d.ground, vx: (Math.random() - 0.5) * 14, vy: -10 - Math.random() * 10, life: 0, max: 0.35, col: '170,226,240', g: 90 });
      continue;
    }
    c.fillRect(Math.round(d.x), Math.round(d.y), 1, 2);
  }
  // Funken / Spritzer
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life += dt;
    if (s.life > s.max) { sparks.splice(i, 1); continue; }
    s.vy += (s.g || 0) * dt; s.x += s.vx * dt; s.y += s.vy * dt;
    const a = 1 - s.life / s.max;
    c.fillStyle = `rgba(${s.col},${a.toFixed(2)})`;
    const x = Math.round(s.x), y = Math.round(s.y);
    c.fillRect(x, y, 1, 1);
    if (s.star && a > 0.4) { c.fillRect(x - 1, y, 1, 1); c.fillRect(x + 1, y, 1, 1); c.fillRect(x, y - 1, 1, 1); c.fillRect(x, y + 1, 1, 1); }
  }
  // Blütenblätter
  const pc = css(A([250, 196, 214]));
  c.fillStyle = pc;
  for (let i = petals.length - 1; i >= 0; i--) {
    const q = petals[i];
    q.life += dt;
    if (q.y < q.ground) { q.y += 5 * dt; q.x += Math.sin(T * 1.5 + q.p) * 4 * dt; }
    if (q.life > 9) { petals.splice(i, 1); continue; }
    c.globalAlpha = Math.min(1, (9 - q.life) / 2);
    c.fillRect(Math.round(q.x), Math.round(q.y), 1, 1);
  }
  c.globalAlpha = 1;
}

function onWatered(k) {
  const s = k.s, p = s.p;
  pendingVis.delete(p.id);
  wiggle.set(p.id, T);
  const n = k.res && k.res.grew ? 18 : 10;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({ x: s.cx + Math.cos(a) * 6, y: s.base - 12 - Math.random() * 14, vx: Math.cos(a) * 8, vy: -8 - Math.random() * 10, life: 0, max: 0.9 + Math.random() * 0.5, col: '255,240,200', star: Math.random() < 0.4, g: 0 });
  }
  renderLand();
  updateUI();
  if (k.msg) toast(k.msg);
}

/* ------------------------------------------------------------------ Gießen */
const LOB = ['Schön gegossen.', 'Ein guter Schluck.', 'Das tat gut.', 'Tropfen für Tropfen.', 'Sie streckt sich ein bisschen.', 'Ganz in Ruhe. Gut gemacht.'];
function giessen(p) {
  const t = today();
  if (wateredToday(p, t)) { toast(`${nameOf(p)} ist heute schon gegossen.`); return; }
  const s = slots.find((x) => x.p.id === p.id);
  const old = { stage: stageOf(p.growth), cond: condition(p, t) };
  const res = water(p);
  if (!res) return;
  const name = nameOf(p);
  let msg;
  if (res.grew) msg = `${name} ist gewachsen: ${SPECIES[p.species].stages[res.stage]}.`;
  else if (res.revived) msg = `${name} richtet sich wieder auf.`;
  else if (res.drooped) msg = `${name} hebt die Blätter wieder.`;
  else msg = LOB[Math.floor(Math.random() * LOB.length)];
  plip();
  if (s && raf) {
    pendingVis.set(p.id, old);
    const spr = getSprite(p.species, old.stage, old.cond, s.flip);
    cans.push({ s, t0: T, top: spr.topRow, res, msg, done: false });
    updateUI(true);
  } else {
    renderLand(); updateUI(); toast(msg);
  }
}

let actx = null;
function plip() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = actx || new AC();
    if (actx.state === 'suspended') actx.resume();
    const now = actx.currentTime + 0.32;
    [0, 0.17, 0.36].forEach((dl, i) => {
      const o = actx.createOscillator(), g = actx.createGain();
      const f = [880, 1046, 784][i];
      o.type = 'sine';
      o.frequency.setValueAtTime(f * 0.7, now + dl);
      o.frequency.exponentialRampToValueAtTime(f * 1.25, now + dl + 0.07);
      g.gain.setValueAtTime(0.0001, now + dl);
      g.gain.exponentialRampToValueAtTime(0.045, now + dl + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + dl + 0.2);
      o.connect(g); g.connect(actx.destination);
      o.start(now + dl); o.stop(now + dl + 0.22);
    });
  } catch (e) { /* Ton ist nur Beiwerk */ }
}

/* ------------------------------------------------------------------ Oberfläche */
const schilder = $('schilder'), toastEl = $('toast'), blatt = $('blatt'), schleier = $('schleier');

function updateUI(skipLabelsState) {
  // Gruß
  const h = currentHour(), ph = phaseOf(h), t = today();
  const hallo = { morgen: 'Guten Morgen.', tag: 'Schönen Tag.', abend: 'Guten Abend.', nacht: 'Gute Nacht.' }[ph];
  const plants = state.garden.plants;
  let text;
  if (!plants.length) text = 'Dein Garten wartet auf die erste Pflanze.';
  else {
    const durst = plants.filter((p) => !wateredToday(p, t));
    const welk = plants.filter((p) => condition(p, t) === 2);
    if (!durst.length) text = ph === 'nacht' ? 'Alles gegossen. Der Garten schläft zufrieden.' : 'Alles gegossen. Der Garten ist zufrieden.';
    else if (welk.length) text = 'Ein paar Pflanzen lassen den Kopf hängen. Ein Schluck Wasser hilft.';
    else if (durst.length === 1) text = `${nameOf(durst[0])} hat noch Durst.`;
    else text = 'Ein paar Pflanzen haben noch Durst.';
  }
  $('gruss').textContent = `${hallo} ${text}`;
  $('leer').hidden = plants.length > 0;
  renderLabels();
  renderDebug();
}

function renderLabels() {
  const t = today();
  schilder.replaceChildren(...slots.map((s) => {
    const p = s.p;
    const cls = ['schild'];
    if (wateredToday(p, t)) cls.push('gegossen');
    if (condition(p, t) === 2) cls.push('welk');
    const b = el('button', { class: cls.join(' '), type: 'button', 'aria-label': `${nameOf(p)} – Details` }, el('span', null, nameOf(p)));
    b.style.left = s.cx * PX + 'px';
    b.style.top = (s.base + 10) * PX + 'px';
    b.addEventListener('click', () => openPlant(p));
    return b;
  }));
}

let toastTimer = 0;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('zeigen');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('zeigen'), 2800);
}

let sheetToken = 0;
function openSheet(build) {
  const tok = ++sheetToken;
  blatt.replaceChildren();
  build(blatt);
  blatt.inert = false;
  blatt.hidden = false; schleier.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (tok !== sheetToken) return;
    blatt.classList.add('offen'); schleier.classList.add('offen');
  }));
}
function closeSheet() {
  const tok = ++sheetToken;
  blatt.inert = true; // beim Zuklappen nicht mehr antippbar (sonst Doppel-Pflanzen)
  blatt.classList.remove('offen'); schleier.classList.remove('offen');
  setTimeout(() => {
    if (tok !== sheetToken) return;
    blatt.hidden = true; schleier.hidden = true; blatt.replaceChildren();
  }, 340);
}
schleier.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !blatt.hidden) closeSheet(); });

function openNew() {
  let chosen = SPECIES_ORDER[state.garden.plants.length % SPECIES_ORDER.length];
  openSheet((b) => {
    b.setAttribute('aria-label', 'Neue Pflanze setzen');
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Neue Pflanze', 3)));
    const inp = el('input', { class: 'feld', type: 'text', maxlength: '40', placeholder: 'Gewohnheit, z. B. Lesen', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Name der Gewohnheit' });
    const grid = el('div', { class: 'arten', role: 'group', 'aria-label': 'Pflanzenart' });
    for (const sp of SPECIES_ORDER) {
      const btn = el('button', { class: 'art', type: 'button', 'aria-pressed': String(sp === chosen), 'data-sp': sp },
        previewCanvas(sp, 4, 0), el('span', null, SPECIES[sp].name));
      btn.addEventListener('click', () => {
        chosen = sp;
        grid.querySelectorAll('.art').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.sp === sp)));
      });
      grid.append(btn);
    }
    const ok = el('button', { class: 'knopf haupt', type: 'button' }, 'Einpflanzen');
    const ab = el('button', { class: 'knopf leise', type: 'button' }, 'Abbrechen');
    let gepflanzt = false;
    ok.addEventListener('click', () => {
      if (gepflanzt) return; // Doppeltipp: nur einmal einpflanzen
      const name = inp.value.trim();
      if (!name) {
        inp.classList.remove('wackel'); void inp.offsetWidth; inp.classList.add('wackel');
        inp.focus();
        return;
      }
      gepflanzt = true;
      addPlant(name, chosen);
      closeSheet();
    });
    ab.addEventListener('click', closeSheet);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    b.append(inp, grid, el('div', { class: 'reihe' }, ab, ok));
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => inp.focus(), 60);
  });
}

function moodText(p, st, cond, wt) {
  const night = phaseOf(currentHour()) === 'nacht';
  if (wt) return night ? 'Heute schon gegossen. Sie schläft zufrieden.' : 'Heute schon gegossen. Sie sonnt sich.';
  if (st === 0 && p.lastWatered == null) return 'Ein Samen in der Erde. Gieß ihn, dann keimt er bald.';
  if (cond === 2) return 'Ist welk, aber nicht verloren. Einmal gießen holt sie zurück.';
  if (cond === 1) return 'Lässt die Blätter hängen. Ein Schluck Wasser hilft.';
  return 'Hat ein bisschen Durst.';
}

function openPlant(p) {
  openSheet((b) => {
    b.setAttribute('aria-label', nameOf(p));
    const t = today(), st = stageOf(p.growth), cond = condition(p, t), wt = wateredToday(p, t);
    const prev = previewCanvas(p.species, st, cond);
    prev.className = 'vorschau';
    const nameEl = el('h2', { class: 'pflanzen-name' }, nameOf(p));
    const info = el('div', null, nameEl,
      el('p', { class: 'meta' }, `${SPECIES[p.species].name} · ${SPECIES[p.species].stages[st]}`),
      el('p', { class: 'stimmung' }, moodText(p, st, cond, wt)));
    const g = el('button', { class: 'knopf haupt', type: 'button' }, wt ? 'Heute gegossen' : 'Gießen');
    g.disabled = wt;
    g.addEventListener('click', () => { closeSheet(); setTimeout(() => giessen(p), 220); });
    const area = el('div', { class: 'reihe' });
    const showButtons = () => {
      const ren = el('button', { class: 'knopf', type: 'button' }, 'Umbenennen');
      const del = el('button', { class: 'knopf', type: 'button' }, 'Entfernen');
      ren.addEventListener('click', showRename);
      del.addEventListener('click', showDelete);
      area.replaceChildren(ren, del);
    };
    const showRename = () => {
      const inp = el('input', { class: 'feld', type: 'text', maxlength: '40', value: nameOf(p), autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Neuer Name' });
      const save = el('button', { class: 'knopf haupt', type: 'button' }, 'Speichern');
      const cancel = el('button', { class: 'knopf leise', type: 'button' }, 'Abbrechen');
      save.addEventListener('click', () => {
        const v = inp.value.trim();
        if (!v) { inp.focus(); return; }
        state.privat.names[p.id] = v;
        saveState();
        nameEl.textContent = v;
        updateUI();
        showButtons();
        toast('Umbenannt.');
      });
      cancel.addEventListener('click', showButtons);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
      area.replaceChildren(el('div', { class: 'spalte' }, inp, el('div', { class: 'reihe' }, cancel, save)));
      inp.focus(); inp.select();
    };
    const showDelete = () => {
      const yes = el('button', { class: 'knopf gefahr', type: 'button' }, 'Ja, entfernen');
      const no = el('button', { class: 'knopf leise', type: 'button' }, 'Behalten');
      yes.addEventListener('click', () => { const n = nameOf(p); removePlant(p); closeSheet(); toast(`${n} ist aus dem Garten genommen.`); });
      no.addEventListener('click', showButtons);
      area.replaceChildren(el('p', { class: 'frage' }, `${nameOf(p)} wirklich aus dem Garten nehmen?`), no, yes);
    };
    showButtons();
    b.append(el('div', { class: 'pflanze-kopf' }, prev, info), el('div', { class: 'reihe' }, g), area);
  });
}

function addPlant(name, sp) {
  const p = { id: uid(), species: sp, plantedDay: today(), lastWatered: null, growth: 0 };
  state.garden.plants.push(p);
  state.privat.names[p.id] = name;
  saveState();
  refresh();
  toast(`${name} ist eingepflanzt. Gieß sie gleich zum ersten Mal.`);
  const s = slots.find((x) => x.p.id === p.id);
  if (s) {
    const y = (s.base - SH) * PX;
    if (y + 200 > window.scrollY + innerHeight) window.scrollTo({ top: Math.max(0, y - 120), behavior: 'smooth' });
  }
}
function removePlant(p) {
  state.garden.plants = state.garden.plants.filter((x) => x.id !== p.id);
  delete state.privat.names[p.id];
  pendingVis.delete(p.id);
  saveState();
  refresh();
}

function refresh() {
  layout();
  renderLayers();
  updateUI();
  draw(); // sofort ein Bild, nicht erst beim nächsten Frame
}

/* Tippen auf die Szene */
function plantAt(e) {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) / PX, y = (e.clientY - r.top) / PX;
  let best = null, bd = 1e9;
  for (const s of slots) {
    const spr = getSprite(s.p.species, visualOf(s.p).stage, visualOf(s.p).cond, s.flip);
    const topY = s.base - SH + 1 + spr.topRow - 3;
    if (x < s.cx - 17 || x > s.cx + 17 || y < Math.min(topY, s.base - 14) || y > s.base + 8) continue;
    const d = Math.abs(x - s.cx);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
canvas.addEventListener('click', (e) => {
  const s = plantAt(e);
  if (!s) return;
  if (cans.some((k) => k.s.p.id === s.p.id)) return;
  if (wateredToday(s.p)) openPlant(s.p);
  else giessen(s.p);
});
canvas.addEventListener('mousemove', (e) => { canvas.classList.toggle('zeiger', !!plantAt(e)); });

/* ------------------------------------------------------------------ Debug-Feld */
function renderDebug() {
  const box = $('debug');
  if (!DEBUG) return;
  box.hidden = false;
  const mk = (txt, fn) => { const b = el('button', { type: 'button' }, txt); b.addEventListener('click', fn); return b; };
  box.replaceChildren(
    el('span', null, `Tag ${dayOffset >= 0 ? '+' : ''}${dayOffset}`),
    mk('−1', () => setDebug(dayOffset - 1, hourOverride)),
    mk('+1', () => setDebug(dayOffset + 1, hourOverride)),
    el('span', null, ` Zeit ${hourOverride == null ? 'echt' : hourOverride.toFixed(1).replace('.', ',')}`),
    mk('−3h', () => setDebug(dayOffset, ((hourOverride == null ? currentHour() : hourOverride) - 3 + 24) % 24)),
    mk('+3h', () => setDebug(dayOffset, ((hourOverride == null ? currentHour() : hourOverride) + 3) % 24)),
    mk('echt', () => setDebug(0, null))
  );
}
function setDebug(off, hour) {
  dayOffset = off; hourOverride = hour;
  const u = new URL(location.href);
  u.searchParams.set('debug', '1');
  if (off) u.searchParams.set('tag', (off > 0 ? '+' : '') + off); else u.searchParams.delete('tag');
  if (hour != null) u.searchParams.set('zeit', String(Math.round(hour * 10) / 10)); else u.searchParams.delete('zeit');
  history.replaceState(null, '', u.toString());
  pendingVis.clear();
  renderLayers();
  updateUI();
}

/* ------------------------------------------------------------------ Start */
function makeGrain() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const img = x.createImageData(128, 128);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = (Math.random() * 255) | 0;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  $('korn').style.backgroundImage = `url(${c.toDataURL()})`;
}

function init() {
  state = loadState();
  $('titel').append(pixelText('Gewohnheits-Garten', innerWidth < 400 ? 2 : 3));
  $('neu').append(pixelText('+', 5, true));
  $('neu').addEventListener('click', openNew);
  $('leer-neu').addEventListener('click', openNew);
  $('version').textContent = VERSION;
  makeGrain();
  refresh();
  start();

  let lastDay = today(), lastMin = -1;
  setInterval(() => {
    if (document.hidden) return;
    const m = Math.floor(currentHour() * 60);
    if (today() !== lastDay) { lastDay = today(); renderLayers(); updateUI(); }
    else if (m !== lastMin) { lastMin = m; if (!cans.length) { renderLayers(); updateUI(); } }
  }, 30000);

  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const t = $('titel'); t.replaceChildren(pixelText('Gewohnheits-Garten', innerWidth < 400 ? 2 : 3));
      refresh();
    }, 150);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else { renderLayers(); updateUI(); start(); }
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }
}

window.garten = { snapshot: gardenSnapshot, version: VERSION, sprite: previewCanvas };
init();
})();
