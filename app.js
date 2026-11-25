/* Gewohnheits-Garten 1.5 „Widget“
   Gewohnheiten als Pflanzen: im eigenen Rhythmus gießen, zusehen wie alles wächst –
   und wie der Garten mit der Zeit völlig übertrieben prächtig wird.
   Keine Frameworks, kein Build. Alles in localStorage.

   Debug (versteckt):
     ?tag=+3      simuliert 3 Tage später (auch ?tag=-1)
     ?zeit=21.5   feste Uhrzeit (Tag/Nacht testen)
     ?level=12    Garten-Stufe nur zur Ansicht erzwingen (wird nicht gespeichert)
     ?debug       nur das Debug-Feld einblenden
     ?mock=a      Nachbarschaft ohne Supabase: Fake-Backend in localStorage. Jeder Profilname
                  (a, b, …) ist ein eigenes „Gerät“ mit eigenem Garten – zwei Tabs mit
                  ?mock=a und ?mock=b sehen sich gegenseitig. garten._fakeNachbar() legt
                  erfundene Nachbargärten an (mit ein paar Fotos). garten._fakeFoto() macht ein
                  Testfoto ohne Kamera (auch Knopf „📸“ im Debug-Feld).
   Mit einem dieser Parameter erscheint oben links ein Feld mit Tag, Uhrzeit, Stufe,
   „+1 Wo gießen“ (simuliert eine Woche Pflege für alle Pflanzen) und „Ereignis“.
*/
'use strict';
(function () {

const VERSION = '1.5';
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
const DEBUG = params.has('tag') || params.has('zeit') || params.has('debug') || params.has('level');
let dayOffset = parseInt((params.get('tag') || '0').trim(), 10) || 0; // "+3" kommt als " 3" an
let hourOverride = null;
let levelOverride = null;
if (params.has('level')) {
  const l = parseInt(params.get('level'), 10);
  if (isFinite(l)) levelOverride = clamp(l, 0, 16);
}
// Mock-Modus: eigenes „Gerät“ je Profil, damit zwei Tabs desselben Origins zwei Gärten haben
const MOCK = params.has('mock');
const MOCK_PROFILE = MOCK ? (String(params.get('mock') || '1').replace(/[^a-z0-9]/gi, '').slice(0, 12) || '1') : '';
const STORE = MOCK ? `${STORE_KEY}.mock.${MOCK_PROFILE}` : STORE_KEY;
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
   garden  = öffentlich teilbar: Pflanzenart, Rhythmus, Wachstum, Gießtage, Pause,
             Garten-Pflege (xp), Stufe und freigeschaltete Deko – keine Namen
   privat  = bleibt auf dem Gerät: die Namen der Gewohnheiten (nach Pflanzen-ID)

   Schema 2 (1.1): Pflanze = { id, species, plantedDay, lastWatered, growth,
     goal (1|2|3|5|7 pro Woche), days: [Gießtage, letzte ~9 Wochen], paused (Tag|null), resumeDay }   */
let state = null; // wird in init() geladen
/* Was gerade gezeichnet wird: null = eigener Garten, sonst ein Nachbargarten
   { id, name, level, plants (aus dem Schnappschuss nachgebaut), at, day }. Dieselbe Zeichen-Engine. */
let view = null;
const vPlants = () => view ? view.plants : state.garden.plants;

function freshState() {
  return { schema: 2, garden: { id: uid(), plants: [], xp: 0, level: 0, deko: [] }, privat: { names: {} } };
}
function migratePlant(p) {
  if (!isFinite(p.goal) || !GOALS.includes(p.goal)) p.goal = 7;           // 1.0: alles täglich
  if (!Array.isArray(p.days)) p.days = p.lastWatered != null ? [p.lastWatered] : [];
  if (p.paused === undefined) p.paused = null;
  if (p.resumeDay === undefined) p.resumeDay = null;
  if (!isFinite(p.growth)) p.growth = 0;
  return p;
}
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE));
    if (s && (s.schema === 1 || s.schema === 2) && s.garden && Array.isArray(s.garden.plants)) {
      s.privat = s.privat || { names: {} };
      s.privat.names = s.privat.names || {};
      s.garden.plants = s.garden.plants.filter((p) => p && SPECIES[p.species]).map(migratePlant);
      if (s.schema === 1 || !isFinite(s.garden.xp)) {
        // bisherige Pflege als Startguthaben für die Garten-Stufe
        const n = s.garden.plants.length;
        s.garden.xp = s.garden.plants.reduce((a, p) => a + p.growth, 0) / Math.sqrt(Math.max(1, n));
      }
      s.schema = 2;
      return s;
    }
  } catch (e) { /* kaputte Daten: neu anfangen */ }
  return freshState();
}
function saveState() {
  const L = levelOfXp(state.garden.xp);
  state.garden.level = L;
  state.garden.deko = DEKO.filter((d) => d.lv <= L).map((d) => d.id);
  try { localStorage.setItem(STORE, JSON.stringify(state)); }
  catch (e) { toast('Speichern hat leider nicht geklappt.'); }
  scheduleSync();
}
const nameOf = (p) => state.privat.names[p.id] || 'Pflanze';

/** Öffentlicher Schnappschuss ohne private Namen – Grundlage für eine spätere Nachbarschaft. */
function gardenSnapshot() {
  const t = today();
  const own = state.garden.plants;
  const L = levelOfXp(state.garden.xp), vit = vitality(t, own);
  const fotos = fotoSnapshotMap(t); // 1.3: nur Tag + Mini-Bild, Vollbild erst beim Antippen
  return {
    v: 2,
    id: state.garden.id,
    day: t,
    level: L,
    xp: Math.round(state.garden.xp * 10) / 10,
    vitality: Math.round(vit * 100) / 100,
    deko: DEKO.filter((d) => d.lv <= L).map((d) => d.id),
    visible: DEKO.filter((d) => d.lv <= effLevel(L, vit)).map((d) => d.id),
    plants: state.garden.plants.map((p) => ({
      id: p.id, species: p.species, goal: p.goal, stage: stageOf(p.growth),
      growth: Math.round(p.growth * 10) / 10,
      condition: condition(p, t), wateredToday: wateredToday(p, t),
      week: weekCount(p, t), paused: p.paused != null,
      // Rohdaten, damit Nachbarn den Zustand auch Tage später richtig sehen (keine Namen!)
      last: p.lastWatered, planted: p.plantedDay, resume: p.resumeDay,
      days: p.days.filter((d) => d > t - 14 && d <= t),
      ...(fotos.has(p.id) ? { foto: fotos.get(p.id) } : {})
    }))
  };
}

/* ------------------------------------------------------------------ Pflanzenarten */
const SPECIES = {
  farn:        { name: 'Farn',        goal: 7, durst: 'durstig',  stages: ['Samen', 'Keim', 'Busch', 'Wedel', 'Voll'],        seed: [168, 136, 100], accent: [124, 184, 140] },
  sonnenblume: { name: 'Sonnenblume', goal: 3, durst: 'mäßig durstig', stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Volle Blüte'], seed: [96, 84, 76],    accent: [246, 196, 88] },
  kaktus:      { name: 'Kaktus',      goal: 1, durst: 'genügsam', stages: ['Samen', 'Keim', 'Säule', 'Blüte', 'Voll'],        seed: [70, 58, 54],    accent: [236, 140, 170] },
  kirschbaum:  { name: 'Kirschbaum',  goal: 3, durst: 'mäßig durstig', stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Baum'],        seed: [160, 86, 74],   accent: [246, 176, 196] },
  monstera:    { name: 'Monstera',    goal: 7, durst: 'durstig',  stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Voll'],        seed: [176, 144, 104], accent: [96, 160, 120] },
  mohn:        { name: 'Mohn',        goal: 3, durst: 'mäßig durstig', stages: ['Samen', 'Keim', 'Rosette', 'Blüte', 'Volle Blüte'], seed: [64, 60, 72],  accent: [228, 64, 60] },
  kornblume:   { name: 'Kornblume',   goal: 5, durst: 'durstig',  stages: ['Samen', 'Keim', 'Busch', 'Blüte', 'Volle Blüte'], seed: [176, 160, 128], accent: [92, 132, 236] },
  lavendel:    { name: 'Lavendel',    goal: 1, durst: 'genügsam', stages: ['Samen', 'Keim', 'Busch', 'Ähren', 'Volle Blüte'], seed: [110, 84, 70],  accent: [156, 120, 214] }
};
const SPECIES_ORDER = ['farn', 'sonnenblume', 'kaktus', 'kirschbaum', 'monstera', 'mohn', 'kornblume', 'lavendel'];
const EXTRA_STAGES = ['Prächtig', 'Riesig', 'Legendär'];
// Wachstumspunkte bis zur Stufe. 1 Punkt ≈ 1 Tag täglicher Pflege, also ~7 pro Woche bei jedem Rhythmus.
// Prächtig nach ~5, Riesig nach ~9, Legendär nach ~16 Wochen Dranbleiben.
const STAGE_MIN = [0, 2, 5, 10, 18, 35, 63, 112];
const STAGE_MAX = STAGE_MIN.length - 1;
const GOALS = [7, 5, 3, 2, 1];
const GOAL_LABEL = { 7: 'täglich', 5: '5× pro Woche', 3: '3× pro Woche', 2: '2× pro Woche', 1: '1× pro Woche' };
const GOAL_SHORT = { 7: 'täglich', 5: '5×', 3: '3×', 2: '2×', 1: '1×' };
const GOAL_DAYS = { 7: [0, 1, 2, 3, 4, 5, 6], 5: [0, 1, 2, 3, 4], 3: [0, 2, 4], 2: [0, 3], 1: [0] }; // Mo=0 (Debug-Simulation)
const stageName = (sp, st) => st <= 4 ? SPECIES[sp].stages[st] : EXTRA_STAGES[st - 5];

function stageOf(g) { let s = 0; for (let i = 0; i < STAGE_MIN.length; i++) if (g >= STAGE_MIN[i] - 1e-6) s = i; return s; }

/* Wochen laufen Mo–So. Tag 0 (1.1.1970) war ein Donnerstag. */
const weekday = (t) => ((t + 3) % 7 + 7) % 7;
const weekStart = (t) => t - weekday(t);
function weekCount(p, t = today()) { const w0 = weekStart(t); return p.days.filter((d) => d >= w0 && d <= t).length; }
function refDay(p) {
  let r = p.lastWatered != null ? p.lastWatered : p.plantedDay - 1;
  if (p.resumeDay != null) r = Math.max(r, p.resumeDay - 1); // nach einer Pause zählt die Pause nicht
  return r;
}
function wateredToday(p, t = today()) { return p.lastWatered != null && p.lastWatered >= t; }
/* Faire Welk-Regel: Intervall = 7/Ziel Tage. Bis "grace" Tage seit dem letzten Gießen bleibt alles frisch
   (täglich: 1, 5×: 3, 3×: 4, 2×: 5, 1×: 8). Danach hängt sie, nach weiteren "wiltSpan" Tagen welkt sie
   (täglich: ab 4 Tagen, 3×: ab 7, 1×: ab 15). Wochenziel schon erfüllt -> immer frisch. Pause -> nie welk. */
const grace = (g) => g >= 7 ? 1 : Math.ceil(7 / g) + 1;
const wiltSpan = (g) => g >= 7 ? 3 : Math.max(3, Math.ceil(7 / g));
function overdue(p, t = today()) { return (t - refDay(p)) - grace(p.goal); }
/** 0 = frisch, 1 = Blätter hängen, 2 = welk */
function condition(p, t = today()) {
  if (p.paused != null) return 0;
  if (wateredToday(p, t)) return 0;
  if (p.goal < 7 && weekCount(p, t) >= p.goal) return 0;
  const o = overdue(p, t);
  if (o <= 0) return 0;
  return o >= wiltSpan(p.goal) ? 2 : 1;
}
/** Braucht heute Wasser? (für den Gruß) */
function thirsty(p, t = today()) {
  if (p.paused != null || wateredToday(p, t)) return false;
  return p.goal >= 7 || weekCount(p, t) < p.goal;
}
/** Gießen: einmal pro Tag. Wachstum pro Gießen = 7/Ziel, über dem Wochenziel nur ein kleiner Bonus.
    Nach langem Welken geht etwas Wachstum verloren, nie mehr als 35 %. */
function water(p, t = today()) {
  if (wateredToday(p, t)) return null;
  const c0 = condition(p, t);
  const o = overdue(p, t), ws = wiltSpan(p.goal);
  const before = stageOf(p.growth);
  const lvBefore = levelOfXp(state.garden.xp);
  let loss = 0;
  if (c0 === 2 && o >= ws) {
    loss = Math.min(Math.floor(p.growth * 0.35), o - ws + 1);
    p.growth -= loss;
  }
  const wc = weekCount(p, t);
  const bonus = wc >= p.goal;
  const gain = bonus ? 0.5 : 7 / p.goal;
  p.growth += gain;
  p.lastWatered = t;
  p.days.push(t);
  p.days = p.days.filter((d) => d > t - 63);
  state.garden.xp += gain / Math.sqrt(Math.max(1, state.garden.plants.length));
  const lvAfter = levelOfXp(state.garden.xp);
  return {
    revived: c0 === 2, drooped: c0 === 1, loss, bonus,
    grew: stageOf(p.growth) > before, stage: stageOf(p.growth),
    levelUp: lvAfter > lvBefore ? lvAfter : 0,
    weekDone: !bonus && wc + 1 === p.goal && p.goal < 7
  };
}

/* ------------------------------------------------------------------ Garten-Stufe und Deko
   Jedes Gießen gibt Pflege (7/Ziel, geteilt durch √Pflanzenzahl). So wird auch ein kleiner Garten
   übertrieben, ein großer nur etwas schneller. Stufe L braucht 1,6·L^1,8 Pflege
   (1 Pflanze täglich: Stufe 5 nach ~4 Wochen, Stufe 10 nach ~14, Stufe 16 nach ~34 Wochen). */
const LEVEL_MAX = 16;
const DEKO = [
  { lv: 1, id: 'wiese', name: 'Dichtere Wiese' },
  { lv: 2, id: 'laternen', name: 'Papierlaternen' },
  { lv: 3, id: 'schmetterlinge', name: 'Schmetterlinge' },
  { lv: 4, id: 'ranken', name: 'Ranken am Zaun' },
  { lv: 5, id: 'steinweg', name: 'Steinweg mit Laternen' },
  { lv: 6, id: 'teich', name: 'Teich mit Fischen' },
  { lv: 7, id: 'vogelhaus', name: 'Vogelhaus und Vögel' },
  { lv: 8, id: 'bienen', name: 'Bienen' },
  { lv: 9, id: 'katze', name: 'Eine Katze' },
  { lv: 10, id: 'windspiel', name: 'Windspiel' },
  { lv: 11, id: 'brunnen', name: 'Brunnen' },
  { lv: 12, id: 'gewaechshaus', name: 'Gewächshaus' },
  { lv: 13, id: 'igel', name: 'Ein Igel' },
  { lv: 14, id: 'gluehwuermchen', name: 'Glühwürmchen-Schwarm' },
  { lv: 15, id: 'regenbogen', name: 'Regenbogen' },
  { lv: 16, id: 'gold', name: 'Sternschnuppen und Goldglanz' }
];
const xpFor = (L) => 1.6 * Math.pow(L, 1.8);
function levelOfXp(xp) { let L = 0; while (L < LEVEL_MAX && xp >= xpFor(L + 1)) L++; return L; }
function gardenLevel() {
  if (view) return view.level;
  return levelOverride != null ? levelOverride : levelOfXp(state.garden.xp);
}
/** 1 = alles frisch, 0 = alles welk. Pausierte zählen nicht. */
function vitality(t = today(), plants = vPlants()) {
  const ps = plants.filter((p) => p.paused == null);
  if (!ps.length) return 1;
  let bad = 0;
  for (const p of ps) { const c = condition(p, t); bad += c === 2 ? 1 : c === 1 ? 0.35 : 0; }
  return 1 - bad / ps.length;
}
/** Welkt viel, ziehen sich Deko und Tiere vorübergehend zurück (nichts geht verloren). */
function effLevel(L, vit) { return vit >= 0.75 ? L : Math.floor(L * vit / 0.75); }

/* ------------------------------------------------------------------ Pixel-Sprite-Baukasten
   Gezeichnet wird immer in einem gedachten 40x50-Raum (CX/BY = Fußpunkt). Für die Stufen über
   „Voll“ wird dieser Raum mit tK vergrößert in einen größeren Puffer gerastert – scharfe Pixel. */
let tK = 1, tOX = 20, tOY = SH - 1;
const tx = (x) => tOX + (x - 20) * tK, ty = (y) => tOY + (y - (SH - 1)) * tK;
function Buf(w, h) {
  this.w = w || SW; this.h = h || SH;
  this.c = new Array(this.w * this.h).fill(null);
  this.p = new Int16Array(this.w * this.h).fill(-1);
  this.cur = 0;
}
Buf.prototype.part = function () { return ++this.cur; };
Buf.prototype.raw = function (x, y, col) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= this.w || y >= this.h || !col) return;
  const i = y * this.w + x;
  this.c[i] = col; this.p[i] = this.cur;
};
Buf.prototype.put = function (x, y, col) { this.raw(tx(x), ty(y), col); };

function discRaw(b, cx, cy, rx, ry, col) {
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const dx = (x - cx) / (rx + 0.5), dy = (y - cy) / (ry + 0.5);
      if (dx * dx + dy * dy <= 1) b.raw(x, y, col);
    }
  }
}
function disc(b, cx, cy, rx, ry, col) { discRaw(b, tx(cx), ty(cy), rx * tK, ry * tK, col); }
function dot(b, x, y, th, col) {
  const X = tx(x), Y = ty(y), t = th * tK;
  if (t <= 1.25) { b.raw(X, Y, col); return; }
  if (t <= 2.25) {
    const fx = Math.floor(X + 1e-6), fy = Math.floor(Y + 1e-6);
    b.raw(fx, fy, col); b.raw(fx + 1, fy, col); b.raw(fx, fy + 1, col); b.raw(fx + 1, fy + 1, col);
    return;
  }
  discRaw(b, X, Y, t / 2 - 0.5, t / 2 - 0.5, col);
}
function seg(b, x0, y0, x1, y1, th, col) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2 * tK));
  for (let i = 0; i <= n; i++) { const t = i / n; dot(b, lerp(x0, x1, t), lerp(y0, y1, t), th, col); }
}
function qp(a, t) {
  const u = 1 - t;
  return [u * u * a[0] + 2 * u * t * a[2] + t * t * a[4], u * u * a[1] + 2 * u * t * a[3] + t * t * a[5]];
}
function curve(b, a, th0, th1, col) {
  const n = Math.ceil(56 * tK);
  for (let i = 0; i <= n; i++) { const t = i / n; const q = qp(a, t); dot(b, q[0], q[1], lerp(th0, th1, t), col); }
}
/** Blatt: Basis bei (x0,y0), Richtung ang. Zweifarbig (Mittelrippe), optional rund + Schlitze. */
function leaf(b, x0, y0, ang, len, wid, col, dark, opt) {
  opt = opt || {};
  x0 = tx(x0); y0 = ty(y0); len *= tK; wid *= tK;
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
      b.raw(x, y, (dark && v > 0.4 * tK) ? dark : col);
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
  farn(b, st, d, w, ex) {
    const G = wiltC([108, 174, 126], w), D = wiltC([66, 128, 106], w), Li = wiltC([158, 210, 156], w);
    if (st === 1) {
      b.part(); curve(b, [CX - 1, BY, CX - 4, BY - 6, CX - 1, BY - 10 + d * 4], 1.5, 1.1, G);
      disc(b, CX - 1 + d, BY - 11 + d * 4.5, 1.4, 1.4, Li); b.put(CX - 1 + d, BY - 11 + d * 4.5, D);
      b.part(); curve(b, [CX + 2, BY, CX + 4, BY - 4, CX + 3, BY - 7 + d * 3], 1.3, 1, D);
      disc(b, CX + 3, BY - 8 + d * 3, 1.1, 1.1, G);
      return;
    }
    const cfg = st === 2 ? { n: 4, len: 14, spread: 0.75 } : st === 3 ? { n: 6, len: 20, spread: 0.9 } : { n: 8 - (ex ? 1 : 0), len: 27 + ex * 4, spread: 1.0 + ex * 0.16 };
    const angs = [];
    for (let i = 0; i < cfg.n; i++) angs.push(-Math.PI / 2 + (i / (cfg.n - 1) - 0.5) * 2 * cfg.spread);
    angs.sort((a1, a2) => Math.abs(a2 + Math.PI / 2) - Math.abs(a1 + Math.PI / 2));
    angs.forEach((a, i) => {
      const k = Math.abs(a + Math.PI / 2) / cfg.spread;
      // ab Prächtig: äußere Wedel länger und bogig überhängend, Längen unregelmäßig
      // (der längste Wedel i=2 hängt auf Prächtig/Riesig sonst über den Sprite-Rand → harte Kante)
      const len = cfg.len * (ex ? (0.82 + 0.25 * k) * (0.9 + 0.2 * ((i * 7) % 5) / 4) * (i === 2 ? [1, 0.93, 0.85, 1][ex] : 1) : (1 - 0.3 * k));
      const shade = i / angs.length;
      const arch = ex ? Math.min(0.95, d + k * (0.3 + ex * 0.13)) : d;
      frond(b, CX + (a + Math.PI / 2) * 1.6, BY, a, len, arch, mix(D, G, 0.35 + shade * 0.65), D, mix(G, Li, shade), ex ? 1.45 : 1);
    });
    if (st >= 3 && d < 0.4) {
      b.part(); curve(b, [CX + 1, BY, CX + 2, BY - 9, CX, BY - 13], 1.3, 1, Li);
      disc(b, CX - 0.5, BY - 14, 1.3, 1.3, Li); b.put(CX, BY - 14, G);
    }
    if (ex >= 2) { // eingerollte junge Wedel (Fiddleheads)
      for (const sd of [-1, 1]) {
        b.part(); curve(b, [CX + sd * 3, BY, CX + sd * 7, BY - 9, CX + sd * 5, BY - 17 + d * 7], 1.2, 1, Li);
        disc(b, CX + sd * 5.5, BY - 18 + d * 7, 1.6, 1.6, G); b.put(CX + sd * 5.5, BY - 18 + d * 7, Li); b.put(CX + sd * 6, BY - 17 + d * 7, D);
      }
    }
    if (ex >= 1 && w < 0.6) sprinkle(b, 6 + ex * 6, [[246, 240, 214], [214, 236, 170]], 11 + ex, false);
    if (ex >= 3 && w < 0.6) sprinkle(b, 14, [[255, 226, 140], [250, 246, 190]], 77, true);
  },

  sonnenblume(b, st, d, w, ex) {
    const G = wiltC([112, 172, 106], w), D = wiltC([74, 128, 88], w);
    const Y = wiltC([250, 204, 96], w, 'flower'), Y2 = wiltC([236, 158, 74], w, 'flower');
    const C = wiltC([120, 78, 58], w, 'flower'), C2 = wiltC([84, 54, 48], w, 'flower');
    const H = [0, 10, 18, 27, 34][st] + ex * 3;
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
    if (ex >= 1) { // weitere Köpfe an Seitentrieben
      const extra = [[0.62, 9, -6, 2.4, 3.6], [0.3, -10, -3, 2.2, 3.2], [0.78, -9, -8, 2, 3]].slice(0, ex);
      for (const [tt, ox, oy, R2, pl2] of extra) {
        const q = qp(stem, tt);
        const sx = q[0] + ox, sy = q[1] + oy + d * 4;
        b.part(); seg(b, q[0], q[1], sx, sy + 1, 1, D);
        b.part(); leaf(b, (q[0] + sx) / 2, (q[1] + sy) / 2, ox > 0 ? -0.2 : -Math.PI + 0.2, 4, 1.5, G, D);
        head(sx, sy, R2, pl2);
      }
    }
    if (st >= 3) {
      const R = st === 3 ? 3 : 4 + (ex >= 3 ? 1 : 0), pl = st === 3 ? 4 : 5.5 + (ex >= 2 ? 1 : 0);
      head(tipX + d * 2, tipY - 2 + d * 4, R, pl);
      if (ex >= 3 && w < 0.6) { // goldener Ring im Kopf
        b.part();
        for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; b.put(tipX + d * 2 + Math.cos(a) * 3.3, tipY - 2 + d * 4 + Math.sin(a) * 3, [255, 224, 130]); }
      }
    }
  },

  kaktus(b, st, d, w, ex) {
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
      const stp = 1 / Math.max(1, tK * 1.2); // bei großen Stufen feiner abtasten, sonst Lücken
      for (let y = 0; y <= h; y += stp) {
        const yy = y0 - y, xx = x0 + y * lean;
        const rr = y > h - r ? Math.sqrt(Math.max(0, r * r - (y - (h - r)) ** 2)) : r;
        for (let x = Math.floor(xx - rr - 1); x <= Math.ceil(xx + rr + 1); x += stp) {
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
    const H = [0, 0, 14, 22, 31][st] + ex * 2, R = ([0, 0, 4.2, 4.8, 5.2][st] + ex * 0.3) * shrink;
    const arm = (side, yAt, h, r) => {
      const ax = CX + yAt * lean + side * (R + r + 1.5);
      b.part(); seg(b, CX + yAt * lean + side * (R - 1), BY - yAt + 1, ax, BY - yAt + 1, r * 2, G);
      column(ax, BY - yAt, h, r);
      return [ax + h * lean, BY - yAt - h - 1];
    };
    let tips = [];
    if (st === 3) tips.push(arm(-1, 9, 7, 2.2 * shrink));
    if (st === 4) { tips.push(arm(-1, 11, 9, 2.4 * shrink)); tips.push(arm(1, 17, 7, 2.2 * shrink)); }
    if (ex >= 2) tips.push(arm(1, 7, 5, 2 * shrink));
    if (ex >= 3) tips.push(arm(-1, 22, 6, 1.9 * shrink));
    column(CX, BY, H, R);
    if (st >= 3 && w < 0.5) {
      flower(CX + H * lean, BY - H - 1, st === 4 ? 1.3 + ex * 0.15 : 1.1);
      if (st === 4) tips.forEach((t) => flower(t[0], t[1], 0.9));
      if (ex >= 1) { // Blüten an den Seiten
        const side = [[-1, 8], [1, 14], [-1, 20], [1, 25], [-1, 26]].slice(0, 1 + ex);
        for (const [sd, yy] of side) flower(CX + yy * lean + sd * (R + 0.5), BY - yy, 0.75);
      }
      if (ex >= 2) { // rote Kaktusfeigen
        b.part();
        tips.slice(0, 2 + ex).forEach((t, i) => { disc(b, t[0] + (i % 2 ? 2 : -2), t[1] + 3, 1, 1.3, [214, 84, 104]); b.put(t[0] + (i % 2 ? 2 : -2), t[1] + 2, [246, 150, 160]); });
      }
      if (ex >= 3) { // Blütenkrone
        for (let k = 0; k < 5; k++) { const a = -Math.PI / 2 + (k - 2) * 0.55; flower(CX + H * lean + Math.cos(a) * 4, BY - H + 1 + Math.sin(a) * 2.5, 0.8); }
      }
    }
  },

  kirschbaum(b, st, d, w, ex) {
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
        .concat(ex >= 2 ? [[-17, 3, 3.6], [17, 2, 3.6], [-10, 7, 4], [10, 7, 4]] : [])
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
      for (let i = 0; i < (big ? 26 + ex * 14 : 12); i++) {
        const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * (big ? 15 + ex : 10);
        b.put(CX + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.75 + sag - 1, rnd() < 0.5 ? Pl : P);
      }
    }
    if (ex >= 1 && w < 0.6) { // Kirschen
      const K = wiltC([206, 58, 84], w, 'flower'), Kl = [250, 150, 160];
      for (let i = 0; i < 3 + ex * 3; i++) {
        const a = rnd() * Math.PI * 2, rr = 4 + Math.sqrt(rnd()) * (12 + ex);
        const x = CX + Math.cos(a) * rr, y = cy + 3 + Math.sin(a) * rr * 0.6 + sag;
        b.part(); b.put(x, y - 2, Td); b.put(x - 1, y - 1, Td); b.put(x + 1, y - 1, Td);
        disc(b, x - 1, y, 0.6, 0.6, K); disc(b, x + 1.3, y + 0.3, 0.6, 0.6, K); b.put(x - 1, y - 0.4, Kl);
      }
    }
    if (ex >= 3 && w < 0.6) sprinkle(b, 16, [[255, 232, 160], [255, 246, 220]], 131, false);
  },

  monstera(b, st, d, w, ex) {
    const G = wiltC([82, 158, 120], w), D = wiltC([54, 116, 96], w), S = wiltC([104, 150, 98], w);
    const dr = (a) => a + d * 1.0 * Math.sign(Math.cos(a) || 1);
    const L = {
      1: [[2, -7, -0.9, 5, 0]],
      2: [[-6, -10, -2.6, 7, 0], [6, -12, -0.5, 7, 0], [0, -15, -1.65, 6.5, 0]],
      3: [[-7, -12, -2.8, 10, 1], [7, -14, -0.35, 10, 2], [-3, -22, -2.15, 9, 1], [4, -24, -0.95, 9.5, 2]],
      4: [[-8, -10, 3.0, 12, 3], [8, -12, 0.15, 12, 3], [-5, -24, -2.5, 12, 3], [6, -27, -0.7, 12, 3], [0, -31, -1.6, 10, 2]]
    }[st].slice();
    if (ex >= 1) L.unshift([-13, -6, 3.25, 10, 2], [13, -7, -0.05, 10, 2]);
    if (ex >= 2) L.unshift([-11, -18, -2.85, 11, 3], [12, -20, -0.3, 11, 3]);
    if (ex >= 3) L.push([-2, -36, -1.85, 9, 2]);
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
    if (ex >= 2 && w < 0.5) { // Fruchtkolben
      b.part();
      leaf(b, CX - 3, BY - 6, -1.9, 9, 2.6, [244, 234, 204], [218, 204, 170], { round: true });
      seg(b, CX - 3.5, BY - 8, CX - 5, BY - 14, 2, [236, 214, 140]);
      b.put(CX - 4, BY - 12, [252, 236, 180]);
    }
    if (ex >= 3) { // Luftwurzeln und goldene Panaschierung
      if (w < 0.6) sprinkle(b, 18, [[236, 230, 170], [255, 226, 140]], 57, false);
    }
  },

  mohn(b, st, d, w, ex) {
    const G = wiltC([120, 170, 112], w), D = wiltC([82, 128, 94], w), Gl = wiltC([160, 200, 140], w);
    const R1 = wiltC([230, 66, 60], w, 'flower'), R2 = wiltC([184, 38, 54], w, 'flower'), R3 = wiltC([252, 134, 112], w, 'flower');
    const K = wiltC([48, 36, 50], w, 'flower'), Kc = wiltC([150, 176, 120], w);
    // Rosette aus gelappten (gefiederten) Blättern am Boden
    const rosette = (n, len) => {
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const a = -Math.PI + 0.3 + t * (Math.PI - 0.6);
        const sg = Math.cos(a) >= 0 ? 1 : -1;
        const l = len * (0.75 + 0.25 * Math.sin(t * Math.PI));
        b.part(); leaf(b, CX + sg, BY, a + d * 0.8 * sg, l, l * 0.3, i % 2 ? G : Gl, D, { slits: l >= 7 ? 2 : l >= 5 ? 1 : 0 });
      }
    };
    if (st === 1) { rosette(3, 4.5); return; }
    // Stiele: [Versatz x, Höhe, Blütenradius (0 = nickende Knospe)]
    let F = [[[2, 13, 0]], [[3, 22, 3], [-4, 15, 0]], [[2, 30, 3.6], [-7, 24, 3.2], [8, 19, 3], [-3, 16, 0]]][st - 2].slice();
    if (ex >= 1) F.push([-12, 28, 3.2], [12, 25, 3], [5, 14, 0]);
    if (ex >= 2) F.push([-4, 37, 3.4], [15, 33, 3], [-14, 15, 0]);
    if (ex >= 3) F.push([-17, 21, 2.8], [6, 42, 3.8], [17, 18, 0]);
    const heads = [];
    F.forEach(([ox, h, R], i) => {
      const sg = ox >= 0 ? 1 : -1;
      const tx0 = CX + ox + d * 6 * sg, ty0 = BY - h + d * h * 0.22;
      const s = [CX + ox * 0.25, BY, CX + ox * 0.6 - d * sg, BY - h * 0.55, tx0, ty0];
      b.part(); curve(b, s, st >= 4 ? 1.3 : 1, 1, D);
      if (i % 2 === 0 && h > 18) { const q = qp(s, 0.3); b.part(); leaf(b, q[0], q[1], sg > 0 ? -0.5 : -Math.PI + 0.5, 4.5, 1.4, G, D, { slits: 1 }); }
      heads.push([tx0, ty0, R * (1 + ex * 0.07) * (1 - w * 0.15)]);
    });
    rosette([0, 0, 5, 6, 7][st] + ex, [0, 0, 6, 7, 8][st] + ex);
    for (const [x, y, R] of heads) {
      if (!R) { // nickende Knospe am gebogenen Stielende
        b.part(); disc(b, x + 1, y + 1.5, 1.1, 1.5, G); b.put(x + 1, y + 3, R2); b.put(x, y + 1, Gl);
        continue;
      }
      if (w > 0.6) { // verblüht: nur die Samenkapsel bleibt
        b.part(); disc(b, x, y, R * 0.35, R * 0.45, Kc); seg(b, x - R * 0.35, y - R * 0.45, x + R * 0.35, y - R * 0.45, 1, K);
        continue;
      }
      b.part(); // hintere Blütenblätter (dunkler), vordere (hell), schwarzes Herz
      disc(b, x - R * 0.48, y - R * 0.22, R * 0.6, R * 0.55, R2);
      disc(b, x + R * 0.48, y - R * 0.22, R * 0.6, R * 0.55, R2);
      b.part();
      disc(b, x - R * 0.42, y + R * 0.18, R * 0.58, R * 0.52, R1);
      disc(b, x + R * 0.42, y + R * 0.18, R * 0.58, R * 0.52, R1);
      disc(b, x, y + R * 0.34, R * 0.5, R * 0.42, R1);
      disc(b, x - R * 0.55, y + R * 0.02, R * 0.24, R * 0.2, R3);
      b.part(); disc(b, x, y - R * 0.12, Math.max(0.6, R * 0.24), Math.max(0.5, R * 0.18), K);
      if (ex >= 3 && w < 0.6) b.put(x, y - R * 0.14, [255, 224, 130]);
    }
    if (ex >= 1 && w < 0.6) sprinkle(b, 4 + ex * 4, [[252, 150, 130], [246, 240, 214]], 23 + ex, false);
    if (ex >= 3 && w < 0.6) sprinkle(b, 14, [[255, 226, 140], [250, 246, 190]], 91, true);
  },

  kornblume(b, st, d, w, ex) {
    const G = wiltC([126, 166, 132], w), D = wiltC([84, 122, 104], w), Gl = wiltC([170, 198, 162], w); // graugrün
    const B1 = wiltC([96, 136, 238], w, 'flower'), B2 = wiltC([62, 94, 206], w, 'flower'), B3 = wiltC([156, 190, 252], w, 'flower');
    const V = wiltC([106, 66, 148], w, 'flower');
    const narrow = (x, y, a, len) => { b.part(); leaf(b, x, y, a, len, Math.max(0.8, len * 0.15), G, D); };
    if (st === 1) {
      narrow(CX, BY, -Math.PI / 2 - 0.45 - d, 5); narrow(CX, BY, -Math.PI / 2 + 0.4 + d, 5.5);
      return;
    }
    const head = (x, y, R) => {
      if (w > 0.6) { b.part(); disc(b, x, y + 0.5, 1.1, 1.4, Gl); b.put(x, y - 1, V); return; } // verblüht
      b.part();
      const n = R >= 2.6 ? 9 : 8;
      for (let k = 0; k < n; k++) { // trichterförmige, ausgefranste Randblüten
        const a = k / n * Math.PI * 2 - Math.PI / 2 + 0.2;
        leaf(b, x, y, a - 0.1, R + 0.7, R * 0.36, k % 2 ? B1 : B2, null);
        leaf(b, x, y, a + 0.12, R + 0.4, R * 0.3, k % 2 ? B2 : B1, null);
      }
      b.part(); disc(b, x, y, R * 0.42, R * 0.38, B3); disc(b, x, y, Math.max(0.5, R * 0.22), Math.max(0.5, R * 0.2), V);
      if (ex >= 3) b.put(x, y, [255, 224, 130]);
    };
    const bud = (x, y) => { b.part(); disc(b, x, y, 1.1, 1.5, Gl); b.put(x, y + 1, D); b.put(x, y - 1.5, B2); };
    // Stiele: [x, Höhe, Kopfradius (0 = Knospe), Seitenast [t, dx, dy, Radius] oder null]
    let S = [
      [[1, 15, 0, null]],
      [[1, 24, 2.4, null], [-4, 17, 0, null]],
      [[1, 31, 2.8, [0.55, -8, -5, 2.2]], [6, 24, 2.5, [0.5, 6, -4, 0]], [-6, 20, 2.3, null]]
    ][st - 2].slice();
    if (ex >= 1) S.push([-12, 27, 2.5, [0.5, -6, -4, 0]], [11, 17, 2.2, null]);
    if (ex >= 2) S.push([13, 31, 2.6, [0.55, 7, -5, 2.2]], [-2, 38, 2.7, [0.6, -6, -3, 0]]);
    if (ex >= 3) S.push([-16, 19, 2.3, null], [4, 44, 3, [0.6, -7, -4, 2.4]], [17, 22, 2.3, null]);
    const heads = [];
    S.forEach(([ox, h, R, br], i) => {
      const sg = ox >= 0 ? 1 : -1;
      const tx0 = CX + ox + d * 6 * sg, ty0 = BY - h + d * h * 0.22;
      const s = [CX + ox * 0.2, BY, CX + ox * 0.65 - d * sg, BY - h * 0.5, tx0, ty0];
      b.part(); curve(b, s, 1, 1, D);
      const q = qp(s, 0.32);
      narrow(q[0], q[1], (sg > 0 ? -0.75 : -Math.PI + 0.75) + d * sg, 5);
      if (h > 22) { const q2 = qp(s, 0.62); narrow(q2[0], q2[1], (sg > 0 ? -Math.PI + 0.9 : -0.9) - d * sg, 4); }
      if (br) {
        const [t, dx, dy, R2] = br, p = qp(s, t);
        const bx = p[0] + dx + d * 3 * Math.sign(dx), by = p[1] + dy + d * 4;
        b.part(); seg(b, p[0], p[1], bx, by, 1, D);
        heads.push([bx, by, R2]);
      }
      heads.push([tx0, ty0, R]);
    });
    // grundständige schmale Blätter
    const nb = [0, 0, 4, 5, 6][st] + ex;
    for (let i = 0; i < nb; i++) { const t = i / (nb - 1); narrow(CX + (t - 0.5) * 3, BY, -Math.PI + 0.45 + t * (Math.PI - 0.9) + d * 0.7 * Math.sign(t - 0.5), 7 + ex); }
    for (const [x, y, R] of heads) R ? head(x, y, R * (1 + ex * 0.06) * (1 - w * 0.15)) : bud(x, y);
    if (ex >= 1 && w < 0.6) sprinkle(b, 4 + ex * 4, [[156, 190, 252], [246, 240, 214]], 37 + ex, false);
    if (ex >= 3 && w < 0.6) sprinkle(b, 14, [[255, 226, 140], [250, 246, 190]], 113, true);
  },

  lavendel(b, st, d, w, ex) {
    const G = wiltC([134, 166, 140], w), D = wiltC([92, 124, 112], w), Gl = wiltC([178, 200, 172], w); // silbriges Graugrün
    const L1 = wiltC([160, 122, 216], w, 'flower'), L2 = wiltC([118, 84, 184], w, 'flower'), L3 = wiltC([200, 174, 238], w, 'flower');
    const T = wiltC([126, 102, 84], w, 'wood');
    const rnd = mulberry32(53 + st * 7 + ex);
    const tuft = (n, len, spread) => { // Busch aus schmalen, aufrechten Blättchen
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0.5 : i / (n - 1);
        const a = -Math.PI / 2 + (t - 0.5) * 2 * spread;
        const sg = Math.sign(t - 0.5);
        const l = len * (0.7 + 0.3 * Math.cos((t - 0.5) * Math.PI)) * (0.85 + rnd() * 0.3);
        b.part(); leaf(b, CX + (t - 0.5) * 4, BY, a + d * 0.9 * sg, l, Math.max(0.8, l * 0.13), mix(G, Gl, rnd()), D);
      }
    };
    if (st === 1) { tuft(3, 5, 0.6); return; }
    // Blütenstiele mit Ähren aus Quirlen
    const n = [0, 0, 3, 5, 8][st] + ex * 3;
    const H = [0, 0, 15, 22, 28][st] + ex * 3, spread = 0.55 + ex * 0.07;
    const spikeLen = [0, 0, 3, 6, 8][st] + ex;
    const order = [];
    for (let i = 0; i < n; i++) order.push(i);
    order.sort((a1, a2) => Math.abs(a2 - (n - 1) / 2) - Math.abs(a1 - (n - 1) / 2)); // außen zuerst, Mitte vorn
    for (const i of order) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const sg = Math.sign(t - 0.5) || 1;
      const a = -Math.PI / 2 + (t - 0.5) * 2 * spread;
      const h = H * (1 - 0.22 * Math.abs(t - 0.5) * 2) * (0.88 + rnd() * 0.24);
      const x0 = CX + (t - 0.5) * 7, y0 = BY - 2;
      const ex1 = x0 + Math.cos(a) * h + d * h * 0.2 * sg, ey1 = y0 + Math.sin(a) * h + d * h * 0.32;
      const s = [x0, y0, x0 + Math.cos(a) * h * 0.55, y0 + Math.sin(a) * h * 0.55, ex1, ey1];
      b.part(); curve(b, s, 1, 1, D);
      b.part();
      const m = Math.max(2, Math.round(spikeLen / 1.3));
      for (let k = 0; k < m; k++) {
        if (k >= m * 0.6 && k % 3 === 2) continue; // unten lockere Quirle mit Lücken
        const q = qp(s, 1 - (k / m) * (spikeLen / h));
        const col = st === 2 ? (k % 2 ? G : Gl) : k === 0 ? L3 : k % 2 ? L2 : L1;
        disc(b, q[0], q[1], k === 0 ? 0.4 : 0.6, 0.7, col);
      }
    }
    if (st >= 3) { b.part(); seg(b, CX - 1, BY, CX - 1, BY - 3, 2, T); }
    tuft([0, 0, 8, 12, 15][st] + ex * 3, [0, 0, 8, 10.5, 12.5][st] + ex * 1.5, 1.05 + ex * 0.08);
    if (ex >= 1 && w < 0.6) sprinkle(b, 5 + ex * 5, [[200, 174, 238], [246, 240, 214]], 61 + ex, false);
    if (ex >= 3 && w < 0.6) sprinkle(b, 14, [[255, 226, 140], [250, 246, 190]], 149, true);
  }
};

/** Streut kleine Farbtupfer auf vorhandenes Laub (für Blüten, Früchte, Goldglanz). */
function sprinkle(b, n, cols, seed, plus) {
  const r = mulberry32(seed);
  let k = 0, tries = 0;
  while (k < n && tries < n * 60) {
    tries++;
    const x = Math.floor(r() * b.w), y = Math.floor(r() * b.h * 0.82);
    if (!b.c[y * b.w + x]) continue;
    b.part();
    const col = cols[k % cols.length];
    b.raw(x, y, col);
    if (plus) { const c2 = mix(col, [255, 255, 255], 0.3); b.raw(x + 1, y, c2); b.raw(x - 1, y, c2); b.raw(x, y - 1, c2); b.raw(x, y + 1, c2); }
    k++;
  }
}

function frond(b, x0, y0, ang, len, droop, col, dark, light, airy) {
  airy = airy || 1; // >1: weiter auseinander stehende, kürzere Fiedern (luftiger)
  // Wedel: steigt auf, biegt sich nach außen; beim Hängen kippt die Spitze nach unten
  const sgn = Math.sign(Math.cos(ang)) || (ang > -Math.PI / 2 ? 1 : -1);
  const out = ang + sgn * (0.75 + droop * 1.3);
  const cx = x0 + Math.cos(ang) * len * 0.62, cy = y0 + Math.sin(ang) * len * 0.62 + droop * len * 0.25;
  const x1 = cx + Math.cos(out) * len * 0.5, y1 = cy + Math.sin(out) * len * 0.5 + droop * len * 0.2;
  const a = [x0, y0, cx, cy, x1, y1];
  b.part();
  const n = Math.max(4, Math.floor(len / (1.7 * airy)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = qp(a, t), q = qp(a, Math.min(1, t + 0.03));
    const dir = Math.atan2(q[1] - p[1], q[0] - p[0]);
    const l = (Math.pow(1 - t, 0.6) * len * 0.2 + 0.8) / Math.sqrt(airy);
    for (const s of [-1, 1]) {
      const la = dir + s * (0.95 - droop * 0.25) + droop * 0.7 * (Math.sign(Math.cos(dir)) || 1);
      seg(b, p[0], p[1], p[0] + Math.cos(la) * l, p[1] + Math.sin(la) * l, 1, s > 0 ? col : light);
    }
  }
  curve(b, a, 1.2, 1, dark);
}

const STAGE_K = [1, 1, 1, 1, 1, 1.22, 1.44, 1.68]; // Vergrößerung der Extra-Stufen
const SPAD_X = 14, SPAD_Y = 12;                     // Sprite-Rand im gedachten Raum
function buildBuf(sp, st, cond) {
  const K = STAGE_K[st];
  // Rand um den gedachten 40x50-Raum: Wedel, Extra-Blätter und Kronen dürfen darüber hinausragen,
  // sonst entstehen harte, gerade Schnittkanten. Leere Ränder kosten beim Zeichnen nichts (topRow).
  const b = st === 0 ? new Buf() : new Buf(Math.round((SW + 2 * SPAD_X) * K / 2) * 2, Math.round((SH + SPAD_Y) * K) + 2);
  tK = K; tOX = b.w / 2; tOY = b.h - 1;
  const d = [0, 0.5, 0.95][cond], w = [0, 0.2, 0.85][cond];
  if (st === 0) drawSeed(b, sp);
  else DRAW[sp](b, Math.min(4, st), d, w, Math.max(0, st - 4));
  tK = 1; tOX = 20; tOY = SH - 1;
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
let lowerTop = 0, lowerH = 0;               // unterer Garten (Weg, Teich, Brunnen) – wächst mit der Stufe
let GS = { level: 0, eff: 0, vit: 1 };       // Garten-Zustand für das Zeichnen
let pal = paletteAt(currentHour());
/** Tatsächliche Höhe des Pflanzenbilds (ohne leeren Rand oben). */
function contentH(p) { const spr = getSprite(p.species, stageOf(p.growth), 0, false); return spr.height - spr.topRow; }

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
  // Riesige Pflanzen brauchen breitere Plätze: dann weniger Spalten, der Garten wächst nach unten.
  let maxK = 1;
  for (const p of vPlants()) maxK = Math.max(maxK, STAGE_K[stageOf(p.growth)]);
  const need = Math.max(36, SW * maxK * 0.8);
  cols = clamp(Math.floor((W - 8) / need), 1, 6);
  const slotW = Math.min(Math.round(SLOT * Math.max(1, maxK * 0.85)), Math.floor((W - 8) / cols));
  const plants = vPlants(), n = plants.length;
  const rows = Math.max(1, Math.ceil(n / cols));
  slots = []; beds = [];
  let base = firstBase;
  for (let r = 0; r < rows; r++) {
    const items = n ? Math.min(cols, n - r * cols) : Math.min(cols, 3);
    const x0 = Math.round((W - items * slotW) / 2);
    if (r > 0) { // große Pflanzen brauchen mehr Platz nach oben
      let mh = SH;
      for (let i = 0; i < items; i++) mh = Math.max(mh, contentH(plants[r * cols + i]) + 4);
      base += RH + Math.max(0, mh - SH - 4);
    }
    beds.push({ x0: x0 - 4, x1: x0 + items * slotW + 4, base });
    if (!n) continue;
    for (let i = 0; i < items; i++) {
      const p = plants[r * cols + i];
      const hs = hashStr(p.id);
      slots.push({ p, cx: x0 + i * slotW + slotW / 2, base, flip: (hs & 1) === 1, phase: (hs % 628) / 100 });
    }
  }
  const L = gardenLevel();
  lowerTop = base + 26;
  lowerH = L >= 6 ? 86 : L >= 5 ? 34 : 0;
  H = Math.max(VH, lowerTop + lowerH + Math.ceil(90 / PX));
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
  const c = landCtx, hz = horizonY, t = today();
  GS.level = gardenLevel(); GS.vit = vitality(t); GS.eff = effLevel(GS.level, GS.vit);
  const E = GS.eff;
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
  if (E >= 12) drawGreenhouse(c);
  // Wiese
  for (let y = hz; y < H; y++) {
    const tt = Math.min(1, (y - hz) / Math.max(40, VH - hz));
    c.fillStyle = css(A(mix(GRASS_TOP, GRASS_BOT, tt)));
    c.fillRect(0, y, W, 1);
  }
  const r2 = mulberry32(5);
  const nTuft = Math.floor(W * (H - hz) / 45 * (1 + Math.min(E, 10) * 0.14));
  for (let i = 0; i < nTuft; i++) {
    const x = Math.floor(r2() * W), y = hz + 2 + Math.floor(r2() * (H - hz));
    const tt = Math.min(1, (y - hz) / Math.max(40, VH - hz));
    const base = mix(GRASS_TOP, GRASS_BOT, tt);
    const light = r2() < 0.5;
    c.fillStyle = css(A(light ? mix(base, [210, 230, 170], 0.25) : mix(base, [40, 70, 70], 0.25)));
    const tall = E >= 1 && r2() < 0.18 + E * 0.015;
    c.fillRect(x, y, 1, tall ? 3 : r2() < 0.4 ? 2 : 1);
    if (tall) { c.fillRect(x - 1, y + 1, 1, 2); c.fillRect(x + 1, y, 1, 3); }
  }
  const FLOWERS = [[250, 214, 226], [252, 236, 200], [200, 186, 240], [250, 190, 160], [255, 246, 236]];
  const nFl = Math.floor(W / 4 * (1 + E * 0.35) * (H - hz) / Math.max(1, VH - hz));
  for (let i = 0; i < nFl; i++) {
    const x = Math.floor(r2() * W), y = hz + 3 + Math.floor(r2() * (H - hz));
    const col = A(FLOWERS[i % 5]);
    c.fillStyle = css(col);
    c.fillRect(x, y, 1, 1);
    if (E >= 3 && i % 3 === 0) { // kleine Blüten statt Pünktchen
      c.fillRect(x - 1, y, 1, 1); c.fillRect(x + 1, y, 1, 1); c.fillRect(x, y - 1, 1, 1);
      c.fillStyle = css(A([250, 222, 120])); c.fillRect(x, y, 1, 1);
      c.fillStyle = css(A([96, 140, 100])); c.fillRect(x, y + 1, 1, 1);
    }
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
  if (E >= 4) drawVines(c, E);
  if (E >= 7) drawBirdhouse(c);
  // unterer Garten
  if (E >= 5) drawPath(c);
  if (E >= 6) drawPond(c);
  if (E >= 11) drawFountainBase(c);
  // Beete
  for (const bed of beds) drawBed(c, bed);
  for (const s of slots) {
    const p = s.p;
    // nasse Erde unter heute gegossenen Pflanzen
    if (wateredToday(p, t) && !pendingVis.has(p.id)) {
      c.fillStyle = css(A(SOIL_WET));
      c.beginPath(); c.ellipse(s.cx, s.base - 0.5, 9, 2.2, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = css(A(mix(SOIL_WET, [170, 200, 220], 0.35)));
      c.fillRect(Math.round(s.cx) - 5, s.base - 2, 2, 1);
      c.fillRect(Math.round(s.cx) + 4, s.base, 1, 1);
    }
    if (p.paused != null) drawBlanket(c, s);
    drawWeekDrops(c, s, t);
    drawCompanions(c, s, t);
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
  if (E >= 2) lanternList().forEach(([x, y, col]) => {
    c.fillStyle = css(A([60, 48, 66]));
    c.fillRect(x, y - 2, 1, 2);
    c.fillRect(x - 1, y, 3, 1); c.fillRect(x - 1, y + 5, 3, 1);
    c.fillStyle = css(A(mix(col, [140, 100, 110], 0.3)));
    c.fillRect(x - 2, y + 1, 5, 4);
    c.fillStyle = css(A(mix(col, [90, 60, 80], 0.45)));
    c.fillRect(x - 2, y + 2, 5, 1); c.fillRect(x - 2, y + 4, 5, 1);
    c.fillStyle = css(A([200, 80, 80])); c.fillRect(x, y + 6, 1, 1);
  });
}

/* ---------- Deko-Bausteine (alles Pixel, alles im Code) ---------- */
const F = (c, col, x, y, w = 1, h = 1) => { c.fillStyle = css(A(col)); c.fillRect(Math.round(x), Math.round(y), w, h); };
function pell(c, x, y, rx, ry, col) { // Pixel-Ellipse
  c.fillStyle = css(A(col));
  for (let dy = -Math.ceil(ry); dy <= Math.ceil(ry); dy++) {
    const k = 1 - (dy * dy) / ((ry + 0.4) * (ry + 0.4));
    if (k <= 0) continue;
    const hw = Math.floor(rx * Math.sqrt(k) + 0.3);
    c.fillRect(Math.round(x) - hw, Math.round(y) + dy, hw * 2 + 1, 1);
  }
}
const LANTERN_COLS = [[255, 170, 130], [255, 214, 140], [246, 160, 190]];
function lanternList() {
  const out = [];
  const wc = windchimeX();
  for (let x = 23, i = 0; x < W - 6; x += 22, i++) {
    if (GS.eff >= 10 && Math.abs(x - wc) < 8) continue;
    out.push([x, Math.round(lightY(x)) + 2, LANTERN_COLS[i % 3]]);
  }
  return out;
}
const windchimeX = () => Math.round(W * 0.84);
const pathY = (x) => lowerTop + 7 + Math.round(Math.sin(x * 0.07 + 0.6) * 2.5);
const pondGeo = () => ({ x: Math.round(W * 0.32), y: lowerTop + 52, rx: Math.min(30, Math.round(W * 0.24)), ry: 13 });
const fountGeo = () => ({ x: Math.round(W * 0.79), y: lowerTop + 60 });
function stoneLanterns() { return [[6, pathY(6)], [W - 7, pathY(W - 7)]]; }

function drawPath(c) {
  const STONE = [184, 172, 166];
  for (let x = 3; x < W; x += 8) {
    const y = pathY(x) + ((x / 8) % 2 ? 1 : -1);
    pell(c, x + 1, y + 1, 3, 1.4, [70, 60, 70]);
    pell(c, x, y, 3, 1.4, STONE);
    F(c, mix(STONE, [255, 255, 255], 0.35), x - 2, y - 1, 2, 1);
  }
  // Blumen säumen den Weg
  const r = mulberry32(77);
  for (let x = 2; x < W; x += 3 + r() * 4) {
    const y = pathY(x) + (r() < 0.5 ? -4 : 4);
    if (r() < 0.55) mini(c, r() < 0.8 ? 0 : 3, Math.round(x), Math.round(y), FLOWER_COLS[(r() * 5) | 0]);
  }
  for (const [x, y] of stoneLanterns()) {
    const S = [150, 144, 150], Sd = [110, 104, 116];
    F(c, Sd, x - 2, y + 1, 5, 2); F(c, S, x - 1, y - 3, 3, 4);
    F(c, Sd, x - 2, y - 7, 5, 4); F(c, [250, 214, 150], x - 1, y - 6, 3, 2);
    F(c, S, x - 3, y - 8, 7, 1); F(c, S, x - 2, y - 9, 5, 1); F(c, S, x, y - 10, 1, 1);
  }
}
function drawPond(c) {
  const P = pondGeo();
  pell(c, P.x + 1, P.y + 2, P.rx + 3, P.ry + 2, [60, 50, 66]);
  pell(c, P.x, P.y, P.rx + 3, P.ry + 2, [160, 150, 156]);
  pell(c, P.x, P.y, P.rx, P.ry, [56, 96, 124]);
  pell(c, P.x, P.y - 2, P.rx - 3, P.ry - 4, [76, 128, 150]);
  pell(c, P.x - 4, P.y - 5, P.rx - 12, 2, [120, 172, 186]);
  const r = mulberry32(4);
  for (let i = 0; i < 16; i++) { // Randsteine
    const a = i / 16 * Math.PI * 2;
    F(c, i % 2 ? [190, 180, 182] : [132, 124, 134], P.x + Math.cos(a) * (P.rx + 2), P.y + Math.sin(a) * (P.ry + 1.5), 2, 1);
  }
  const pads = [[-0.5, 0.2], [0.35, -0.3], [0.55, 0.35], [-0.2, -0.45]];
  pads.forEach(([u, v], i) => {
    const x = P.x + u * P.rx, y = P.y + v * P.ry;
    pell(c, x, y, 3, 1.4, [96, 154, 104]);
    F(c, [56, 96, 124], x + 1, y - 1, 2, 1);
    F(c, [140, 196, 130], x - 2, y - 1, 2, 1);
    if (i % 2 === 0) { F(c, [250, 196, 214], x - 1, y - 2, 3, 1); F(c, [255, 236, 240], x, y - 3, 1, 1); F(c, [250, 222, 120], x, y - 2, 1, 1); }
  });
  // Blumenbüsche rund um den Teich (mehr mit höherer Stufe)
  const nB = Math.min(12, 4 + (GS.eff - 6));
  for (let i = 0; i < nB; i++) {
    const a = Math.PI * (0.85 + (i / nB) * 1.3) + r() * 0.2;
    const x = P.x + Math.cos(a) * (P.rx + 6), y = P.y + Math.sin(a) * (P.ry + 4);
    bush(c, x, y, FLOWER_COLS[i % FLOWER_COLS.length], r);
  }
  // Schilf
  for (const [x, h] of [[P.x + P.rx - 1, 9], [P.x + P.rx + 2, 7], [P.x - P.rx + 1, 8]]) {
    F(c, [110, 150, 96], x, P.y - h, 1, h);
    F(c, [140, 100, 70], x, P.y - h - 2, 1, 3);
  }
  void r;
}
function bush(c, x, y, col, r) {
  pell(c, x + 1, y + 1, 3.5, 2, [56, 78, 70]);
  pell(c, x, y, 3.5, 2.2, [92, 140, 100]);
  F(c, [130, 180, 116], x - 2, y - 2, 2, 1);
  for (let k = 0; k < 4; k++) F(c, col, x - 3 + r() * 6, y - 2 + r() * 3);
}
function drawFountainBase(c) {
  const f = fountGeo(), S = [196, 186, 190], Sd = [130, 122, 136];
  pell(c, f.x + 1, f.y + 3, 12, 3, [60, 50, 66]);
  pell(c, f.x, f.y + 1, 12, 3.4, Sd);
  pell(c, f.x, f.y, 11, 2.6, S);
  pell(c, f.x, f.y, 9, 1.6, [86, 140, 168]);
  F(c, [150, 200, 216], f.x - 6, f.y - 1, 4, 1);
  F(c, Sd, f.x - 1, f.y - 9, 3, 9); F(c, S, f.x - 1, f.y - 9, 1, 9);
  pell(c, f.x, f.y - 10, 5, 1.3, S);
  F(c, [86, 140, 168], f.x - 3, f.y - 11, 7, 1);
  F(c, S, f.x, f.y - 13, 1, 2);
}
function drawGreenhouse(c) {
  const x0 = W - 34, w = 26, y1 = horizonY - 3, y0 = y1 - 13, peak = y0 - 7;
  const FR = [236, 230, 222], GL = [170, 206, 214];
  c.fillStyle = css(A(GL), 0.75);
  c.fillRect(x0, y0, w, y1 - y0);
  for (let i = 0; i <= 7; i++) { // Dach
    const yy = y0 - i;
    const hw = Math.round((w / 2) * (1 - i / 7.5));
    c.fillStyle = css(A(GL), 0.75); c.fillRect(x0 + w / 2 - hw, yy, hw * 2, 1);
    F(c, FR, x0 + w / 2 - hw - 1, yy); F(c, FR, x0 + w / 2 + hw, yy);
  }
  F(c, FR, x0 - 1, y0, 1, y1 - y0 + 1); F(c, FR, x0 + w, y0, 1, y1 - y0 + 1);
  F(c, FR, x0, y0, w, 1); F(c, FR, x0, y1, w, 1);
  for (let x = x0 + 6; x < x0 + w; x += 6) F(c, FR, x, y0 - (x === x0 + 12 ? 6 : 3), 1, y1 - y0 + (x === x0 + 12 ? 6 : 3));
  F(c, FR, x0, y0 + 6, w, 1);
  const r = mulberry32(12);
  for (let i = 0; i < 16; i++) F(c, r() < 0.3 ? [240, 160, 170] : [96, 156, 106], x0 + 1 + r() * (w - 2), y1 - 1 - r() * 5);
  F(c, [255, 255, 255], x0 + 2, y0 + 2, 2, 1); F(c, [255, 255, 255], x0 + 3, y0 + 3, 1, 1);
}
function drawVines(c, E) {
  const hz = horizonY, r = mulberry32(21), dens = E >= 10 ? 0.85 : E >= 7 ? 0.6 : 0.4;
  const G = [92, 146, 98], G2 = [126, 178, 110], FL = [[246, 186, 206], [250, 230, 170], [210, 190, 250]];
  for (let x = 0; x < W; x++) {
    const n = (Math.sin(x * 0.13) + Math.sin(x * 0.051 + 2)) * 0.25 + 0.5;
    if (n > dens) continue;
    const y = hz - 5 + Math.round(Math.sin(x * 0.45) * 1.6);
    F(c, x % 3 ? G : G2, x, y);
    if (r() < 0.35) F(c, G2, x, y - 1);
    if (r() < 0.12) { F(c, G, x, y + 1, 1, 2 + (r() * 3 | 0)); }
    if (r() < 0.07 + E * 0.006) F(c, FL[(r() * 3) | 0], x, y - 1);
  }
}
function drawBirdhouse(c) {
  const x = 6, hz = horizonY, W0 = [196, 124, 96], Rf = [150, 84, 92], P = [118, 80, 66];
  F(c, P, x, hz - 12, 1, 26); F(c, [150, 108, 86], x - 1, hz - 12, 1, 26);
  F(c, W0, x - 4, hz - 19, 8, 7); F(c, mix(W0, [255, 255, 255], 0.2), x - 4, hz - 19, 1, 7);
  F(c, [60, 40, 50], x - 1, hz - 17, 2, 2); F(c, P, x - 2, hz - 14, 4, 1);
  for (let i = 0; i < 4; i++) F(c, Rf, x - 5 + i, hz - 20 - i, 10 - i * 2, 1);
}
function drawBlanket(c, s) {
  const x = Math.round(s.cx) - 11, y = s.base - 4;
  F(c, [150, 132, 192], x, y, 22, 4);
  F(c, [186, 168, 220], x, y, 22, 1);
  for (let i = 2; i < 22; i += 5) F(c, [240, 214, 180], x + i, y + 1, 2, 3);
  F(c, [110, 94, 150], x, y + 4, 22, 1);
}
function drawWeekDrops(c, s, t) {
  const p = s.p;
  if (p.paused != null) return;
  const y = s.base + 3, cx = Math.round(s.cx);
  if (p.goal >= 7) { // täglich: nur ein kleiner Glanz, wenn heute gegossen
    if (wateredToday(p, t)) { F(c, [150, 214, 226], cx - 1, y + 1, 3, 1); F(c, [150, 214, 226], cx, y, 1, 3); F(c, [230, 250, 250], cx, y + 1, 1, 1); }
    return;
  }
  const n = weekCount(p, t), g = p.goal, tot = Math.max(g, n);
  const x0 = cx - Math.round((tot * 4 - 1) / 2);
  for (let i = 0; i < tot; i++) {
    const x = x0 + i * 4;
    if (i < n) {
      const col = i >= g ? [252, 222, 130] : [126, 196, 226];
      F(c, col, x + 1, y, 1, 1); F(c, col, x, y + 1, 3, 2);
      F(c, mix(col, [255, 255, 255], 0.55), x, y + 1, 1, 1);
    } else {
      F(c, [86, 56, 50], x + 1, y, 1, 1); F(c, [86, 56, 50], x, y + 1, 1, 2); F(c, [86, 56, 50], x + 2, y + 1, 1, 2); F(c, [86, 56, 50], x + 1, y + 3, 1, 1);
    }
  }
}
/** Ableger, Blumen und Pilze sprießen um gut gepflegte Pflanzen. */
function drawCompanions(c, s, t) {
  const p = s.p, st = stageOf(p.growth);
  if (st < 4 || p.paused != null || condition(p, t) !== 0) return;
  const n = [3, 5, 8, 11][st - 4];
  const r = mulberry32(hashStr(p.id) ^ 0x5bd1);
  const acc = SPECIES[p.species].accent;
  for (let i = 0; i < n; i++) {
    let x, y;
    const sd = i % 2 ? 1 : -1;
    if (i < 4) { x = s.cx + sd * (12 + r() * 6); y = s.base - 1; }                 // auf der Beeterde
    else { x = s.cx + sd * (3 + r() * 16); y = s.base + 19 + r() * 7; }            // davor in der Wiese
    const kind = (i + (hashStr(p.id) & 3)) % 4;
    mini(c, kind, Math.round(x), Math.round(y), kind === 2 ? acc : FLOWER_COLS[i % FLOWER_COLS.length], p.species);
  }
}
const FLOWER_COLS = [[250, 200, 214], [252, 232, 170], [206, 190, 246], [255, 244, 236], [250, 180, 150]];
function mini(c, kind, x, y, col, sp) {
  const G = [98, 156, 104], G2 = [134, 190, 120];
  if (kind === 0) { // Blümchen
    F(c, G, x, y - 2, 1, 3); F(c, G2, x + 1, y - 1);
    F(c, col, x - 1, y - 3, 3, 1); F(c, col, x, y - 4, 1, 1); F(c, col, x, y - 2);
    F(c, [250, 220, 120], x, y - 3);
  } else if (kind === 1) { // Pilz
    F(c, [236, 226, 210], x, y - 2, 1, 2);
    F(c, [206, 92, 92], x - 1, y - 3, 3, 1); F(c, [206, 92, 92], x, y - 4);
    F(c, [255, 240, 230], x - 1, y - 3);
  } else if (kind === 2) { // Ableger: Mini-Version der Art
    F(c, G, x, y - 3, 1, 3);
    F(c, sp === 'kaktus' ? [110, 170, 130] : G2, x - 2, y - 4, 2, 1); F(c, G2, x + 1, y - 5, 2, 1);
    F(c, col, x, y - 5);
  } else { // Klee mit Blüte
    F(c, G2, x - 1, y - 1, 3, 1); F(c, G, x, y - 2);
    F(c, col, x + 1, y - 3); F(c, col, x + 2, y - 4);
  }
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

/* ------------------------------------------------------------------ Partikel und Tiere
   Alles mit festen Höchstzahlen, damit es auch bei Stufe 16 und 15 Pflanzen flüssig bleibt. */
const MAX_SPARKS = 140, MAX_PETALS = 70, MAX_SPRAY = 18;
let stars = [], clouds = [], flies = [], dust = [], drops = [], sparks = [], petals = [], cans = [], spray = [];
let butterflies = [], bees = [], birds = [], fish = [];
let shooting = null, swarmUntil = 0, rainbowUntil = 0, rainbowCv = null;
const pendingVis = new Map(); // id -> {stage, cond} während der Gieß-Animation
const wiggle = new Map();     // id -> Zeitpunkt des Gießens
function initParticles() {
  const r = mulberry32(123);
  stars = Array.from({ length: Math.round(W * 0.35) }, () => ({ x: r(), y: r(), s: 0.6 + r() * 2.2, p: r() * 6.28, big: r() < 0.12 }));
  clouds = Array.from({ length: 4 }, (_, i) => ({ x: r() * W, y: 0.22 + r() * 0.4, s: 0.7 + r() * 0.7, v: 0.6 + r() * 0.9 + i * 0.1 }));
  flies = Array.from({ length: 40 }, () => ({ x: r(), y: r(), a: 0.15 + r() * 0.3, b: 0.2 + r() * 0.3, c: 0.6 + r() * 1.2, p: r() * 6.28 }));
  dust = Array.from({ length: 22 }, () => ({ x: r() * W, y: r() * H, v: 0.8 + r() * 1.6, p: r() * 6.28, a: 0.3 + r() * 0.6 }));
  const BCOL = [[250, 206, 120], [206, 186, 250], [252, 246, 236], [150, 204, 240], [250, 170, 190]];
  butterflies = Array.from({ length: 5 }, (_, i) => ({ p: r() * 6.28, v: 0.6 + r() * 0.5, col: BCOL[i], k: i }));
  bees = Array.from({ length: 6 }, (_, i) => ({ p: r() * 6.28, v: 0.8 + r() * 0.6, k: i * 2 + 1 }));
  birds = Array.from({ length: 3 }, (_, i) => ({ p: r() * 8, u: 0.18 + i * 0.3 + r() * 0.08, col: i === 1 ? [110, 150, 204] : [150, 104, 88], br: i === 1 ? [244, 222, 120] : [234, 146, 96] }));
  fish = Array.from({ length: 3 }, (_, i) => ({ p: i * 2.1, v: 0.25 + r() * 0.2, col: i === 2 ? [250, 244, 236] : [244, 140, 76] }));
  rainbowCv = makeRainbow();
}
function makeRainbow() {
  const cv = document.createElement('canvas');
  const R = Math.round(W * 0.62), bw = 2;
  const cols = [[244, 150, 160], [248, 192, 140], [248, 230, 150], [168, 214, 156], [146, 194, 232], [180, 160, 226]];
  cv.width = W; cv.height = horizonY;
  const c = cv.getContext('2d');
  const cx = W * 0.5, cy = horizonY + 6;
  for (let y = 0; y < horizonY; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - cx, (y - cy) * 1.15);
    const k = Math.floor((R - d) / bw);
    if (k >= 0 && k < cols.length) { c.fillStyle = css(cols[k]); c.fillRect(x, y, 1, 1); }
  }
  return cv;
}
function burst(x, y, n, col, spread) {
  for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
    const a = Math.random() * Math.PI * 2, v = 4 + Math.random() * spread;
    sparks.push({ x: x + Math.cos(a) * 4, y: y + Math.sin(a) * 4, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 6, life: 0, max: 0.9 + Math.random() * 0.8, col, star: Math.random() < 0.45, g: 0 });
  }
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

let eventToastShown = {};
function rareEvents() {
  const E = GS.eff;
  if (pal.night > 0.6 && !shooting && E >= 8) {
    const rate = E >= 16 ? 1 / 18 : 1 / 150;
    if (Math.random() < rate * dt) startShootingStar();
  }
  if (pal.night > 0.6 && E >= 6 && T > swarmUntil && Math.random() < dt / 420) { swarmUntil = T + 30; eventToast('swarm', 'Ein Glühwürmchen-Schwarm tanzt durch den Garten.'); }
  if (pal.night < 0.1 && E >= 8 && E < 15 && GS.vit > 0.9 && T > rainbowUntil && Math.random() < dt / 500) { rainbowUntil = T + 45; eventToast('rain', view ? 'Ein Regenbogen über diesem Garten.' : 'Ein Regenbogen über deinem Garten.'); }
}
function startShootingStar() {
  shooting = { x: W * (0.35 + Math.random() * 0.6), y: 4 + Math.random() * horizonY * 0.3, t0: T, vx: -(55 + Math.random() * 25), vy: 22 + Math.random() * 10 };
  eventToast('star', 'Eine Sternschnuppe. Wünsch dir was.');
}
function eventToast(k, msg) {
  if (eventToastShown[k] || !blatt.hidden) return;
  eventToastShown[k] = true;
  toastLater(msg);
}

function draw() {
  if (!W || !H || !skyCv.width) return;
  const c = ctx;
  const viewTop = Math.floor(window.scrollY / PX) - 4, viewBot = viewTop + VH + 8;
  const E = GS.eff, vit = GS.vit, day = 1 - pal.night;
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.drawImage(skyCv, 0, 0);
  rareEvents();

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
  // Sternschnuppe
  if (shooting) {
    const e = T - shooting.t0;
    if (e > 1.4 || pal.night < 0.3) shooting = null;
    else {
      const a = e < 0.2 ? e / 0.2 : Math.max(0, 1 - (e - 0.2) / 1.2);
      for (let i = 0; i < 12; i++) {
        const x = shooting.x + shooting.vx * (e - i * 0.018), y = shooting.y + shooting.vy * (e - i * 0.018);
        c.fillStyle = `rgba(255,246,220,${(a * (1 - i / 12)).toFixed(2)})`;
        c.fillRect(Math.round(x), Math.round(y), 1, 1);
      }
    }
  }
  // Regenbogen (dauerhaft ab Stufe 15, sonst als seltenes Ereignis)
  let rb = 0;
  if (E >= 15) rb = 0.22;
  if (T < rainbowUntil) rb = Math.max(rb, 0.24 * Math.min(1, (rainbowUntil - T) / 6, (T - (rainbowUntil - 45)) / 6));
  rb *= clamp(day * 1.2 - 0.1, 0, 1);
  if (rb > 0.01 && rainbowCv) { c.globalAlpha = rb; c.drawImage(rainbowCv, 0, 0); c.globalAlpha = 1; }
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

  // Bewohner am Boden (hinter den Pflanzen)
  if (E >= 7 && pal.night < 0.6) drawBirds(c, vit);
  if (lowerH && lowerTop < viewBot && lowerTop + lowerH > viewTop) {
    if (E >= 6) drawFish(c);
    if (E >= 11) drawFountain(c);
    if (E >= 9) drawCat(c);
    if (E >= 13) drawHedgehog(c);
  }

  // Pflanzen
  for (const s of slots) {
    if (s.base < viewTop || s.base - 100 > viewBot) continue;
    drawPlant(c, s);
  }

  // Wasser, Funken, Blütenblätter, Gießkannen
  updateFx(c);

  // Fliegende Bewohner
  if (E >= 3 && pal.night < 0.5 && slots.length) drawButterflies(c, E, vit, viewTop, viewBot);
  if (E >= 8 && pal.night < 0.5 && slots.length) drawBees(c, E, vit, viewTop, viewBot);
  if (E >= 10) drawWindchime(c);

  // Licht: Lampen, Laternen, Glühwürmchen, Staub
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
    if (E >= 2) lanternList().forEach(([x, y, col], i) => {
      const a = pal.lamps * (0.85 + 0.15 * Math.sin(T * 0.9 + i * 2.3));
      c.globalAlpha = a * 0.5;
      c.drawImage(glow(col), x - 12, y - 9, 25, 25);
      c.globalAlpha = a * 0.7;
      c.fillStyle = css(col); c.fillRect(x - 2, y + 1, 5, 4);
    });
    if (E >= 5) stoneLanterns().forEach(([x, y]) => {
      if (y < viewTop || y > viewBot) return;
      c.globalAlpha = pal.lamps * 0.55;
      c.drawImage(glow([255, 200, 130]), x - 11, y - 16, 22, 22);
      c.globalAlpha = pal.lamps * 0.8;
      c.fillStyle = '#ffd890'; c.fillRect(x - 1, y - 6, 3, 2);
    });
    if (E >= 12) {
      c.globalAlpha = pal.lamps * 0.4;
      c.drawImage(glow([255, 204, 140]), W - 40, horizonY - 34, 38, 38);
    }
  }
  if (pal.night > 0.25) {
    const nF = Math.min(flies.length, Math.round((E >= 14 ? 28 : 14) * (0.4 + 0.6 * vit)) + (T < swarmUntil ? 26 : 0));
    const gold = E >= 16;
    for (let i = 0; i < nF; i++) {
      const f = flies[i];
      const x = f.x * W + Math.sin(T * f.a + f.p) * 14 + Math.sin(T * f.a * 2.3) * 4;
      const y = horizonY - 8 + f.y * (H - horizonY) + Math.sin(T * f.b + f.p * 2) * 8;
      if (y < viewTop || y > viewBot) continue;
      const bl = Math.max(0, Math.sin(T * f.c + f.p));
      const a = (pal.night - 0.2) * bl * bl;
      if (a < 0.02) continue;
      c.globalAlpha = a * 0.75;
      c.drawImage(glow(gold && i % 3 === 0 ? [255, 214, 120] : [200, 240, 140]), x - 6, y - 6, 12, 12);
      c.globalAlpha = a;
      c.fillStyle = '#f4ffc4';
      c.fillRect(Math.round(x), Math.round(y), 1, 1);
    }
  }
  const dustA = Math.max(pal.dust, E >= 16 ? 0.7 : 0);
  if (dustA > 0.05) {
    c.fillStyle = E >= 16 ? '#ffe2a0' : '#fff0d6';
    for (const d of dust) {
      d.y -= d.v * dt; d.x += Math.sin(T * 0.4 + d.p) * 0.05;
      if (d.y < 0) { d.y = H; d.x = Math.random() * W; }
      if (d.y < viewTop || d.y > viewBot) continue;
      c.globalAlpha = dustA * d.a * (0.35 + 0.3 * Math.sin(T * 0.9 + d.p));
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

/* ---------- Tiere ---------- */
const R1 = (c, col, x, y, w = 1, h = 1) => { c.fillStyle = css(A(col)); c.fillRect(Math.round(x), Math.round(y), w, h); };
function drawBirds(c, vit) {
  const n = Math.round(3 * vit), hz = horizonY;
  for (let i = 0; i < n; i++) {
    const b = birds[i];
    const ph = (T * 0.45 + b.p) % 5;
    let x = Math.round(W * b.u + Math.floor((T * 0.45 + b.p) / 5) % 3 * 3), y = hz - 9;
    if (i === 0) { x = 6; y = hz - 23; } // sitzt auf dem Vogelhaus
    if (ph < 0.35) y -= Math.round(Math.sin(ph / 0.35 * Math.PI) * 2);
    const dir = Math.sin(T * 0.13 + b.p * 3) > 0 ? 1 : -1;
    const peck = ph > 2 && ph < 2.4;
    R1(c, b.col, x - 1, y, 3, 2);
    R1(c, b.br, x + (dir > 0 ? 0 : -1), y + 1, 2, 1);
    R1(c, mix(b.col, [40, 30, 40], 0.3), x - 1 - dir, y - (dir > 0 ? 0 : 0), 1, 1);
    const hx = x + dir * 2, hy = y - 1 + (peck ? 2 : 0);
    R1(c, b.col, hx, hy, 1, 1); R1(c, b.col, hx - dir, hy, 1, 1);
    R1(c, [250, 176, 90], hx + dir, hy + (peck ? 1 : 0), 1, 1);
    R1(c, [30, 24, 30], hx, hy, 1, 1);
    R1(c, [80, 60, 60], x, y + 2, 1, 1);
  }
}
function drawFish(c) {
  const P = pondGeo();
  for (const f of fish) {
    const a = T * f.v + f.p;
    const x = P.x + Math.cos(a) * P.rx * 0.55, y = P.y + Math.sin(a * 1.3) * P.ry * 0.4 + 1;
    const dir = -Math.sin(a) > 0 ? 1 : -1;
    c.globalAlpha = 0.85;
    R1(c, f.col, x - 1, y, 3, 1);
    R1(c, mix(f.col, [255, 255, 255], 0.4), x - 1 - dir * 1, y - (Math.sin(T * 6 + f.p) > 0 ? 1 : 0), 1, 1);
    c.globalAlpha = 1;
  }
  // Glitzern auf dem Wasser
  c.fillStyle = `rgba(230,246,250,${(0.35 + 0.25 * Math.sin(T * 2)).toFixed(2)})`;
  for (let i = 0; i < 4; i++) {
    const k = Math.floor(T * 0.8 + i * 1.7) % 7;
    c.fillRect(Math.round(P.x - P.rx * 0.6 + k * P.rx * 0.18), P.y - 4 + (i % 3) * 3, 2, 1);
  }
}
function drawFountain(c) {
  const f = fountGeo();
  if (spray.length < MAX_SPRAY && Math.random() < 0.7) {
    const a = (Math.random() - 0.5) * 1.4;
    spray.push({ x: f.x, y: f.y - 13, vx: Math.sin(a) * 9, vy: -12 - Math.random() * 6 });
  }
  c.fillStyle = css(A([186, 228, 240]), 0.85);
  for (let i = spray.length - 1; i >= 0; i--) {
    const d = spray[i];
    d.vy += 40 * dt; d.x += d.vx * dt; d.y += d.vy * dt;
    if (d.y > f.y) { spray.splice(i, 1); continue; }
    c.fillRect(Math.round(d.x), Math.round(d.y), 1, 1);
  }
  c.fillRect(f.x, f.y - 14 - (Math.sin(T * 5) > 0 ? 1 : 0), 1, 2);
}
function drawCat(c) {
  const x = Math.round(W * 0.64), y = lowerTop + 21;
  const O = [232, 158, 100], Od = [196, 116, 76], Ol = [248, 204, 160];
  const br = Math.sin(T * 1.6) > 0.3 ? 1 : 0;
  pell(c, x + 1, y + 2, 6, 1.5, [60, 46, 60]); // Schatten
  pell(c, x, y, 5, 2 + br * 0.3, O);
  R1(c, Od, x - 2, y - 2 + (br ? 0 : 1), 1, 2); R1(c, Od, x + 1, y - 2 + (br ? 0 : 1), 1, 2); R1(c, Od, x + 3, y - 1, 1, 2);
  R1(c, O, x - 6, y - 1, 3, 3); R1(c, Ol, x - 6, y + 1, 3, 1);
  R1(c, O, x - 6, y - 2, 1, 1); R1(c, O, x - 4, y - 2, 1, 1);
  R1(c, [70, 50, 60], x - 6, y, 1, 1); R1(c, [70, 50, 60], x - 4, y, 1, 1);
  const tw = Math.sin(T * 0.9) > 0.6 ? 1 : 0; // Schwanz zuckt
  R1(c, Od, x + 5, y + 1, 1, 1); R1(c, Od, x + 4, y + 2, 2, 1); R1(c, Od, x + 6, y + 1 - tw, 1, 1);
  if (pal.night > 0.4) zzz(c, x - 5, y - 4, 0.8);
}
function drawHedgehog(c) {
  const span = Math.max(20, W - 24), pos = (T * 2.6) % (2 * span);
  const dir = pos < span ? 1 : -1;
  const x = Math.round(12 + (pos < span ? pos : 2 * span - pos)), y = lowerTop + 29;
  const step = Math.floor(T * 4) % 2;
  R1(c, [60, 46, 60], x - 3, y + 2, 7, 1);
  pell(c, x, y, 3.4, 1.8, [128, 98, 80]);
  for (let i = -3; i <= 2; i += 2) R1(c, [88, 66, 58], x + i, y - 2, 1, 1);
  R1(c, [88, 66, 58], x - 2, y - 1, 1, 1); R1(c, [88, 66, 58], x + 1, y - 1, 1, 1);
  R1(c, [216, 188, 158], x + dir * 3, y, 2 * (dir > 0 ? 1 : 1), 1);
  R1(c, [216, 188, 158], x + dir * 3, y + 1, 1, 1);
  R1(c, [36, 28, 30], x + dir * 4 + (dir > 0 ? 1 : 0), y, 1, 1);
  R1(c, [70, 52, 48], x - 2 + step, y + 2, 1, 1); R1(c, [70, 52, 48], x + 1 - step, y + 2, 1, 1);
}
function drawButterflies(c, E, vit, vt, vb) {
  const n = Math.round(Math.min(5, 2 + (E - 3) * 0.35) * vit);
  const a = clamp(1 - pal.night * 2, 0, 1);
  c.globalAlpha = a;
  for (let i = 0; i < n; i++) {
    const b = butterflies[i], s = slots[(b.k * 3) % slots.length];
    const top = s.base - 34;
    const x = s.cx + Math.sin(T * 0.37 * b.v + b.p) * 20 + Math.sin(T * 1.3 + b.p) * 4;
    const y = top + Math.sin(T * 0.5 * b.v + b.p * 2) * 12;
    if (y < vt || y > vb) continue;
    const open = Math.sin(T * 13 + b.p) > 0;
    const X = Math.round(x), Y = Math.round(y);
    c.fillStyle = css(A(b.col));
    if (open) { c.fillRect(X - 2, Y - 1, 2, 2); c.fillRect(X + 1, Y - 1, 2, 2); c.fillRect(X - 2, Y + 1, 1, 1); c.fillRect(X + 2, Y + 1, 1, 1); }
    else { c.fillRect(X - 1, Y - 2, 1, 2); c.fillRect(X + 1, Y - 2, 1, 2); }
    c.fillStyle = css(A([60, 44, 60])); c.fillRect(X, Y - 1, 1, 3);
  }
  c.globalAlpha = 1;
}
function drawBees(c, E, vit, vt, vb) {
  const n = Math.round(Math.min(6, 2 + (E - 8) * 0.6) * vit);
  const flowering = slots.filter((s) => stageOf(s.p.growth) >= 3 && s.p.paused == null);
  const pool = flowering.length ? flowering : slots;
  c.globalAlpha = clamp(1 - pal.night * 2, 0, 1);
  for (let i = 0; i < n; i++) {
    const b = bees[i], s = pool[(b.k) % pool.length];
    const x = s.cx + Math.cos(T * 1.9 * b.v + b.p) * 11 + Math.sin(T * 5 + b.p) * 1.5;
    const y = s.base - 28 + Math.sin(T * 2.7 * b.v + b.p) * 7;
    if (y < vt || y > vb) continue;
    const X = Math.round(x), Y = Math.round(y);
    c.fillStyle = css(A([250, 206, 90])); c.fillRect(X, Y, 2, 1);
    c.fillStyle = css(A([60, 44, 50])); c.fillRect(X + (Math.cos(T * 1.9 * b.v + b.p) > 0 ? 0 : 1), Y, 1, 1);
    if (Math.sin(T * 30 + i) > 0) { c.fillStyle = 'rgba(240,248,255,.8)'; c.fillRect(X, Y - 1, 1, 1); }
  }
  c.globalAlpha = 1;
}
function drawWindchime(c) {
  const x = windchimeX(), y = Math.round(lightY(x)) + 1;
  const S = [214, 218, 232], Sd = [150, 150, 176];
  R1(c, [80, 64, 80], x, y, 1, 4);
  R1(c, [176, 124, 92], x - 3, y + 4, 7, 1);
  const lens = [5, 7, 6, 4];
  [-3, -1, 1, 3].forEach((dx, i) => {
    const sw = Math.round(Math.sin(T * 1.7 + i * 1.3) * 0.9);
    R1(c, Sd, x + dx, y + 5, 1, 1);
    R1(c, S, x + dx + sw, y + 6, 1, lens[i]);
  });
  if (Math.sin(T * 0.7) > 0.97) { c.fillStyle = 'rgba(255,255,240,.9)'; c.fillRect(x + 1, y + 7, 1, 1); }
  R1(c, [246, 186, 206], x + Math.round(Math.sin(T * 1.2)), y + 12, 1, 2);
}
function zzz(c, x, y, a) {
  for (let k = 0; k < 2; k++) {
    const ph = ((T * 0.45 + k * 0.5) % 1);
    const zx = Math.round(x + ph * 5 + k), zy = Math.round(y - ph * 9);
    c.fillStyle = `rgba(236,230,255,${(a * (1 - ph)).toFixed(2)})`;
    c.fillRect(zx, zy, 3, 1); c.fillRect(zx + 1, zy + 1, 1, 1); c.fillRect(zx, zy + 2, 3, 1);
  }
}

function visualOf(p) {
  const v = pendingVis.get(p.id);
  if (v) return v;
  return { stage: stageOf(p.growth), cond: condition(p, today()) };
}

function drawPlant(c, s) {
  const p = s.p, vis = visualOf(p), st = vis.stage;
  const spr = getSprite(p.species, st, vis.cond, s.flip);
  const sw = spr.width, sh = spr.height;
  const top = s.base - sh + 1, left = Math.round(s.cx - sw / 2);
  const paused = p.paused != null;
  const healthy = vis.cond === 0 && !paused;
  // goldener Schimmer hinter Riesig/Legendär
  if (st >= 6 && healthy) {
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = (st - 5) * 0.11 * (0.7 + 0.6 * pal.night) * (0.85 + 0.15 * Math.sin(T * 1.2 + s.phase));
    const gs = sw * 1.5, gy = s.base - (sh - spr.topRow) * 0.55;
    c.drawImage(glow([255, 206, 130]), s.cx - gs / 2, gy - gs / 2, gs, gs);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }
  // weicher Schatten
  c.fillStyle = 'rgba(30,16,40,.28)';
  c.beginPath(); c.ellipse(s.cx, s.base + 0.5, 5 + Math.min(st, 5) * 1.6, 1.4, 0, 0, Math.PI * 2); c.fill();
  let amp = paused ? 0.25 : [1.1, 0.6, 0.2][vis.cond];
  const wt = wiggle.get(p.id);
  if (wt != null) {
    const e = T - wt;
    if (e > 3) wiggle.delete(p.id);
    else amp += 2.4 * Math.exp(-e * 1.5) * Math.sin(e * 9);
  }
  const swy = Math.sin(T * 0.8 + s.phase) + 0.35 * Math.sin(T * 1.9 + s.phase * 1.7);
  const tr = spr.topRow, span = Math.max(1, sh - 1 - tr);
  const step = sh > 60 ? 2 : 1; // große Sprites in Doppelzeilen: halb so viele Aufrufe
  for (let y = tr; y < sh; y += step) {
    const f = (sh - 1 - y) / span;
    const off = Math.round(amp * swy * f * f);
    const hh = Math.min(step, sh - y);
    c.drawImage(spr, 0, y, sw, hh, left + off, top + y, sw, hh);
  }
  if (paused) zzz(c, s.cx + 4, top + tr - 2, 0.9);
  if (!healthy) return;
  const r = Math.random();
  // Funkeln bei Prächtig und mehr
  if (st >= 5 && sparks.length < MAX_SPARKS && r < dt * (st - 4) * 0.8) {
    sparks.push({ x: s.cx + (Math.random() - 0.5) * sw * 0.75, y: top + tr + Math.random() * (sh - tr) * 0.7, vx: 0, vy: -3, life: 0, max: 1.3, col: '255,228,150', star: Math.random() < 0.5, g: 0 });
  }
  // Bonus-Glitzern: mehr als das Wochenziel gegossen
  if (p.goal < 7 && sparks.length < MAX_SPARKS && Math.random() < dt * 0.9 && weekCount(p) > p.goal) {
    sparks.push({ x: s.cx + (Math.random() - 0.5) * sw * 0.6, y: top + tr + Math.random() * (sh - tr) * 0.8, vx: 0, vy: -2, life: 0, max: 1.1, col: '206,240,255', star: true, g: 0 });
  }
  // Kirschblüten fallen – ab Legendär ein richtiger Blütenregen
  if (p.species === 'kirschbaum' && st >= 3 && petals.length < MAX_PETALS && Math.random() < dt * [0, 0, 0, 0.5, 0.5, 1.1, 1.8, 3.6][st]) {
    petals.push({ x: s.cx + (Math.random() - 0.5) * sw * 0.7, y: top + tr + 4 + Math.random() * 8, ground: s.base + 1 + Math.random() * 3, p: Math.random() * 6, life: 0 });
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
    const px = s.cx + 10, py = Math.max(8, s.base - k.sh + k.top - 7);
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
      if (Math.random() < 0.5 && sparks.length < MAX_SPARKS) sparks.push({ x: d.x, y: d.ground, vx: (Math.random() - 0.5) * 14, vy: -10 - Math.random() * 10, life: 0, max: 0.35, col: '170,226,240', g: 90 });
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
  const s = k.s, p = s.p, res = k.res || {};
  pendingVis.delete(p.id);
  wiggle.set(p.id, T);
  const n = res.grew ? 18 : res.bonus ? 16 : 10;
  for (let i = 0; i < n && sparks.length < MAX_SPARKS; i++) {
    const a = Math.random() * Math.PI * 2;
    sparks.push({ x: s.cx + Math.cos(a) * 6, y: s.base - 12 - Math.random() * 14, vx: Math.cos(a) * 8, vy: -8 - Math.random() * 10, life: 0, max: 0.9 + Math.random() * 0.5, col: res.bonus ? '206,240,255' : '255,240,200', star: Math.random() < 0.4, g: 0 });
  }
  if (res.levelUp || (res.grew && res.stage >= 5)) refresh(); // Platz und Deko neu verteilen
  else { renderLand(); updateUI(); }
  if (k.msg) toast(k.msg);
  if (res.levelUp) celebrate(res.levelUp);
  if (!view) showNachweis(p);
}
function celebrate(L) {
  const d = DEKO.find((x) => x.lv === L);
  const vt = Math.floor(window.scrollY / PX);
  for (let i = 0; i < 4; i++) burst(W * (0.2 + 0.2 * i), vt + VH * (0.3 + 0.1 * (i % 2)), 12, '255,226,150', 14);
  toastLater(`Garten-Stufe ${L}${d ? ': ' + d.name + '!' : '!'}`);
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
  if (res.grew) msg = res.stage >= 5 ? `${name} wird ${stageName(p.species, res.stage)}!` : `${name} ist gewachsen: ${stageName(p.species, res.stage)}.`;
  else if (res.revived) msg = `${name} richtet sich wieder auf.`;
  else if (res.drooped) msg = `${name} hebt die Blätter wieder.`;
  else if (res.bonus) msg = `Extra-Schluck für ${name}. Es glitzert.`;
  else if (res.weekDone) msg = `Wochenziel für ${name} geschafft.`;
  else msg = LOB[Math.floor(Math.random() * LOB.length)];
  plip();
  if (s && raf) {
    pendingVis.set(p.id, old);
    const spr = getSprite(p.species, old.stage, old.cond, s.flip);
    cans.push({ s, t0: T, top: spr.topRow, sh: spr.height, res, msg, done: false });
    updateUI(true);
  } else {
    if (res.levelUp || res.grew) refresh(); else { renderLand(); updateUI(); }
    toast(msg);
    if (res.levelUp) celebrate(res.levelUp);
    showNachweis(p);
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
  const plants = vPlants();
  if (view) { updateNeighborUI(); renderLabels(); renderDebug(); return; }
  let text;
  if (!plants.length) text = 'Dein Garten wartet auf die erste Pflanze.';
  else {
    const durst = plants.filter((p) => thirsty(p, t));
    const welk = plants.filter((p) => condition(p, t) === 2);
    if (!durst.length) text = ph === 'nacht' ? 'Alles versorgt. Der Garten schläft zufrieden.' : 'Alles versorgt. Der Garten ist zufrieden.';
    else if (welk.length) text = 'Ein paar Pflanzen lassen den Kopf hängen. Ein Schluck Wasser hilft.';
    else if (durst.length === 1) text = `${nameOf(durst[0])} hat noch Durst.`;
    else text = 'Ein paar Pflanzen haben noch Durst.';
  }
  $('gruss').textContent = `${hallo} ${text}`;
  $('leer').hidden = plants.length > 0;
  renderBadge();
  renderLabels();
  renderDebug();
}

function renderLabels() {
  const t = today();
  schilder.replaceChildren(...slots.map((s) => {
    const p = s.p;
    const cls = ['schild'];
    if (wateredToday(p, t)) cls.push('gegossen');
    else if (p.goal < 7 && weekCount(p, t) >= p.goal) cls.push('satt');
    if (condition(p, t) === 2) cls.push('welk');
    if (p.paused != null) cls.push('pause');
    if (view) cls.push('fremd');
    const label = view ? SPECIES[p.species].name : nameOf(p);
    const b = el('button', { class: cls.join(' '), type: 'button', 'aria-label': view ? plantInfo(p) : `${label} – Details` }, el('span', null, label));
    b.style.left = s.cx * PX + 'px';
    b.style.top = (s.base + 10) * PX + 'px';
    b.addEventListener('click', () => view ? toast(plantInfo(p)) : openPlant(p));
    return b;
  }), ...slots.map((s) => { const f = fotoOf(s.p); return f ? fotoPin(s, f) : null; }).filter(Boolean));
  if (!view && fotosLoaded && [...fotoIdx.values()].some((m) => !fotoFresh(m.day, t))) purgeFotos();
}

let toastTimer = 0, toastQ = [];
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('zeigen');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('zeigen');
    if (toastQ.length) toastTimer = setTimeout(() => showToast(toastQ.shift()), 420);
  }, 2800);
}
function toast(msg) { toastQ = []; showToast(msg); }
/** Hängt eine Meldung hinten an, statt die laufende zu überschreiben. */
function toastLater(msg) {
  if (toastEl.classList.contains('zeigen') || toastQ.length) toastQ.push(msg); else showToast(msg);
}

/* Garten-Stufe oben im Kopf */
function renderBadge() {
  const L = gardenLevel(), vit = vitality(), eff = effLevel(L, vit);
  const b = $('stufe');
  const cur = xpFor(L), nxt = xpFor(Math.min(LEVEL_MAX, L + 1));
  const prog = L >= LEVEL_MAX ? 1 : clamp((state.garden.xp - cur) / (nxt - cur), 0, 1);
  b.hidden = !state.garden.plants.length && L === 0;
  b.replaceChildren(
    el('span', { class: 'stufe-zahl' }, `Stufe ${L}`),
    el('span', { class: 'stufe-balken' }, el('span', { style: `width:${Math.round(levelOverride != null ? 100 : prog * 100)}%` })),
    eff < L ? el('span', { class: 'stufe-weg' }, 'ein paar sind ausgeflogen') : ''
  );
  b.setAttribute('aria-label', `Garten-Stufe ${L} von ${LEVEL_MAX}. Details`);
}
function openLevel() {
  openSheet((b) => {
    const L = gardenLevel(), vit = vitality(), eff = effLevel(L, vit);
    b.setAttribute('aria-label', 'Dein Garten');
    const next = DEKO.find((d) => d.lv > L);
    const list = el('ul', { class: 'deko-liste' });
    for (const d of DEKO) {
      const cls = d.lv <= eff ? 'da' : d.lv <= L ? 'weg' : 'zu';
      list.append(el('li', { class: cls }, el('span', { class: 'deko-lv' }, String(d.lv)),
        el('span', null, d.lv <= L ? d.name : '???'),
        cls === 'weg' ? el('span', { class: 'deko-hinweis' }, 'ausgeflogen') : null));
    }
    const intro = L >= LEVEL_MAX ? 'Dein Garten ist legendär. Mehr geht nicht – nur noch genießen.'
      : `Jedes Gießen bringt deinen Garten weiter. Als Nächstes: ${next.name}.`;
    const welk = eff < L ? 'Gerade lassen viele Pflanzen den Kopf hängen, deshalb sind ein paar Bewohner ausgeflogen. Sie kommen zurück, sobald der Garten wieder frisch ist.' : null;
    const zu = el('button', { class: 'knopf leise', type: 'button' }, 'Schließen');
    zu.addEventListener('click', closeSheet);
    b.append(el('div', { class: 'blatt-kopf' }, pixelText(`Stufe ${L}`, 3)),
      el('p', { class: 'stimmung' }, intro), welk ? el('p', { class: 'stimmung leise' }, welk) : '', list, el('div', { class: 'reihe' }, zu));
  });
}

let sheetToken = 0;
function openSheet(build) {
  const tok = ++sheetToken;
  overviewOpen = false; nbConfirming = false;
  hideNachweis();
  blatt.classList.remove('nachbarschaft', 'foto-blatt');
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
  overviewOpen = false;
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
    let goal = SPECIES[chosen].goal, goalTouched = false;
    const rh = rhythmPicker(() => goal, (g) => { goal = g; goalTouched = true; }, () => chosen);
    grid.addEventListener('click', () => { if (!goalTouched) { goal = SPECIES[chosen].goal; } rh.update(); });
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
      addPlant(name, chosen, goal);
      closeSheet();
    });
    ab.addEventListener('click', closeSheet);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    b.append(inp, grid, rh.node, el('div', { class: 'reihe' }, ab, ok));
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => inp.focus(), 60);
  });
}

/** Auswahl täglich / 5× / 3× / 2× / 1× mit verspieltem Hinweis zur Pflanzenart. */
function rhythmPicker(get, set, species) {
  const hint = el('p', { class: 'rhythmus-hinweis' });
  const row = el('div', { class: 'rhythmen', role: 'group', 'aria-label': 'Wie oft gießen?' });
  const btns = GOALS.map((g) => {
    const bt = el('button', { class: 'chip', type: 'button', 'data-g': String(g) }, GOAL_SHORT[g]);
    bt.addEventListener('click', () => { set(g); update(); });
    row.append(bt);
    return bt;
  });
  function update() {
    const g = get(), sp = SPECIES[species()];
    btns.forEach((bt) => bt.setAttribute('aria-pressed', String(+bt.dataset.g === g)));
    const sug = sp.goal === g ? 'passt' : `Vorschlag: ${GOAL_SHORT[sp.goal]}`;
    hint.textContent = `Gießen ${GOAL_LABEL[g]} · ${sp.name} ist ${sp.durst} (${sug})`;
  }
  update();
  return { node: el('div', { class: 'rhythmus' }, hint, row), update };
}

function weekText(p, t) {
  if (p.paused != null) return 'Macht gerade Pause. Welkt nicht.';
  if (p.goal >= 7) return wateredToday(p, t) ? 'Täglich · heute erledigt' : 'Täglich · heute noch offen';
  const n = weekCount(p, t);
  const drops = '💧'.repeat(Math.min(n, p.goal)) + '○'.repeat(Math.max(0, p.goal - n)) + (n > p.goal ? ' ✨' : '');
  return `Diese Woche ${drops}  ${n} von ${p.goal}`;
}

function moodText(p, st, cond, wt) {
  const night = phaseOf(currentHour()) === 'nacht';
  if (p.paused != null) return night ? 'Schläft unter ihrer Decke. Gute Erholung.' : 'Ruht sich aus. Nichts verpasst, nichts welkt.';
  if (wt) return night ? 'Heute schon gegossen. Sie schläft zufrieden.' : 'Heute schon gegossen. Sie sonnt sich.';
  if (p.goal < 7 && cond === 0 && weekCount(p) >= p.goal) return 'Wochenziel geschafft. Ein Extra-Schluck bringt sie zum Glitzern.';
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
      el('p', { class: 'meta' }, `${SPECIES[p.species].name} · ${stageName(p.species, st)}`),
      el('p', { class: 'woche' }, weekText(p, t)),
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
    const rh = rhythmPicker(() => p.goal, (gg) => {
      if (gg === p.goal) return;
      p.goal = gg; saveState(); renderLand(); updateUI();
      b.querySelector('.woche').textContent = weekText(p, today());
      toast(`${nameOf(p)}: jetzt ${GOAL_LABEL[gg]}.`);
    }, () => p.species);
    const pz = el('button', { class: 'knopf pause-knopf', type: 'button' }, p.paused != null ? 'Pause beenden' : 'Pause (Urlaub, krank …)');
    pz.addEventListener('click', () => {
      if (pz.dataset.done) return; // Doppeltipp-Schutz
      pz.dataset.done = '1';
      togglePause(p);
      closeSheet();
    });
    // 1.3: Foto von heute (freiwillig)
    const fo = fotoOf(p);
    const cam = el('button', { class: 'knopf foto-knopf', type: 'button' }, fo && fo.d === t ? '📸 Neues Foto von heute' : '📸 Foto von heute');
    cam.addEventListener('click', () => fotoStart(p, false));
    const gal = el('button', { class: 'knopf leise klein', type: 'button' }, 'aus der Galerie');
    gal.addEventListener('click', () => fotoStart(p, true));
    const fotoRow = el('div', { class: 'reihe foto-reihe' });
    if (fo) {
      const ansehen = el('button', { class: 'foto-mini', type: 'button', 'aria-label': `Foto ansehen (${dayAgo(fo.d)})` },
        fo.t ? el('img', { src: fo.t, alt: '', width: '40', height: '40' }) : '📸', el('span', null, dayAgo(fo.d)));
      ansehen.addEventListener('click', () => openFoto(p));
      fotoRow.append(ansehen);
    }
    fotoRow.append(cam, gal);
    b.append(el('div', { class: 'pflanze-kopf' }, prev, info), el('div', { class: 'reihe' }, g), rh.node, el('div', { class: 'reihe' }, pz), fotoRow, area);
  });
}

function togglePause(p) {
  const t = today();
  if (p.paused != null) {
    p.paused = null; p.resumeDay = t;
    toast(`${nameOf(p)} ist wieder wach.`);
  } else {
    p.paused = t;
    toast(`${nameOf(p)} macht Pause und welkt nicht.`);
  }
  saveState();
  renderLand(); updateUI();
}
function addPlant(name, sp, goal) {
  const p = migratePlant({ id: uid(), species: sp, plantedDay: today(), lastWatered: null, growth: 0, goal: goal || SPECIES[sp].goal });
  state.garden.plants.push(p);
  state.privat.names[p.id] = name;
  saveState();
  refresh();
  toast(`${name} ist eingepflanzt. Gieß sie gleich zum ersten Mal.`);
  const s = slots.find((x) => x.p.id === p.id);
  if (s) {
    const y = (s.base - contentH(p)) * PX;
    if (y + 200 > window.scrollY + innerHeight) window.scrollTo({ top: Math.max(0, y - 120), behavior: 'smooth' });
  }
}
function removePlant(p) {
  state.garden.plants = state.garden.plants.filter((x) => x.id !== p.id);
  delete state.privat.names[p.id];
  if (fotoIdx.has(p.id)) deleteFoto(p);
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
    const topY = s.base - spr.height + 1 + spr.topRow - 3, hw = Math.max(17, spr.width * 0.3);
    if (x < s.cx - hw || x > s.cx + hw || y < Math.min(topY, s.base - 14) || y > s.base + 8) continue;
    const d = Math.abs(x - s.cx);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}
canvas.addEventListener('click', (e) => {
  const s = plantAt(e);
  if (!s) return;
  if (view) { toast(plantInfo(s.p)); return; } // Nachbargarten: nur ansehen, nie gießen
  if (cans.some((k) => k.s.p.id === s.p.id)) return;
  if (wateredToday(s.p) || s.p.paused != null) openPlant(s.p);
  else giessen(s.p);
});
canvas.addEventListener('mousemove', (e) => { canvas.classList.toggle('zeiger', !!plantAt(e)); });

/* ------------------------------------------------------------------ Debug-Feld */
function renderDebug() {
  const box = $('debug');
  if (!DEBUG) return;
  box.hidden = false;
  const mk = (txt, fn) => { const b = el('button', { type: 'button' }, txt); b.addEventListener('click', fn); return b; };
  const L = gardenLevel();
  box.replaceChildren(
    el('span', null, `Tag ${dayOffset >= 0 ? '+' : ''}${dayOffset}`),
    mk('−1', () => setDebug(dayOffset - 1, hourOverride)),
    mk('+1', () => setDebug(dayOffset + 1, hourOverride)),
    mk('+7', () => setDebug(dayOffset + 7, hourOverride)),
    el('span', null, ` Zeit ${hourOverride == null ? 'echt' : hourOverride.toFixed(1).replace('.', ',')}`),
    mk('−3h', () => setDebug(dayOffset, ((hourOverride == null ? currentHour() : hourOverride) - 3 + 24) % 24)),
    mk('+3h', () => setDebug(dayOffset, ((hourOverride == null ? currentHour() : hourOverride) + 3) % 24)),
    mk('echt', () => { levelOverride = null; setDebug(0, null); }),
    el('span', null, ` Stufe ${L}${levelOverride != null ? '*' : ''}`),
    mk('−', () => setLevelOverride(Math.max(0, L - 1))),
    mk('+', () => setLevelOverride(Math.min(LEVEL_MAX, L + 1))),
    mk('+1 Wo gießen', () => simulateWeeks(1)),
    mk('+4 Wo', () => simulateWeeks(4)),
    mk('Ereignis', debugEvent),
    view ? '' : mk('📸', () => fakeFoto())
  );
}
function setLevelOverride(L) {
  levelOverride = L;
  const u = new URL(location.href);
  u.searchParams.set('level', String(L));
  history.replaceState(null, '', u.toString());
  refresh();
}
/** Simuliert Pflege: jede Pflanze wird an ihren Wochentagen gegossen (täglich, Mo–Fr, Mo/Mi/Fr, Mo/Do, Mo). */
function simulateWeeks(n) {
  const L0 = levelOfXp(state.garden.xp);
  for (let i = 0; i < 7 * n; i++) {
    dayOffset++;
    const t = today(), wd = weekday(t);
    for (const p of state.garden.plants) {
      if (p.paused != null) continue;
      if (GOAL_DAYS[p.goal].includes(wd)) water(p, t);
    }
  }
  saveState();
  setDebug(dayOffset, hourOverride);
  const L1 = levelOfXp(state.garden.xp);
  toast(`${n} Woche${n > 1 ? 'n' : ''} gepflegt. Garten-Stufe ${L1}${L1 > L0 ? ' (+' + (L1 - L0) + ')' : ''}.`);
  if (L1 > L0 && levelOverride == null) celebrate(L1);
}
function debugEvent() {
  eventToastShown = {};
  if (pal.night > 0.5) { startShootingStar(); swarmUntil = T + 30; }
  else { rainbowUntil = T + 45; eventToast('rain', view ? 'Ein Regenbogen über diesem Garten.' : 'Ein Regenbogen über deinem Garten.'); }
}
function setDebug(off, hour) {
  dayOffset = off; hourOverride = hour;
  const u = new URL(location.href);
  u.searchParams.set('debug', '1');
  if (off) u.searchParams.set('tag', (off > 0 ? '+' : '') + off); else u.searchParams.delete('tag');
  if (hour != null) u.searchParams.set('zeit', String(Math.round(hour * 10) / 10)); else u.searchParams.delete('zeit');
  if (levelOverride == null) u.searchParams.delete('level');
  history.replaceState(null, '', u.toString());
  pendingVis.clear();
  refresh();
}

/* ------------------------------------------------------------------ Nachbarschaft (1.2)
   Nur ansehen, nie mitgießen. Hochgeladen wird ausschließlich gardenSnapshot() (keine Namen der
   Gewohnheiten) plus ein frei gewählter Gartenname. Backend: Supabase über die REST-API (PostgREST),
   ganz ohne Bibliothek. Schreiben nur über die RPC-Funktion upsert_garden mit geheimem Token,
   Lesen über get_gardens(ids). Live: Polling alle 25 s, solange ein Nachbargarten oder die
   Übersicht sichtbar ist – nie bei verborgener Seite.
   Ohne config.js-Werte (und ohne ?mock) ist all das unsichtbar und die App bleibt wie 1.1. */
const CFG = window.GARTEN_CONFIG || {};
const SB_URL = String(CFG.supabaseUrl || '').trim().replace(/\/+$/, '');
const SB_KEY = String(CFG.supabaseAnonKey || '').trim();
const NB_ON = MOCK || !!(SB_URL && SB_KEY);
const NB_MAX = 20, POLL_MS = 25000, SYNC_GAP = 10000, SNAP_MAX = 20000, NAME_MAX = 40;
const MOCK_DB = 'gewohnheitsgarten.mock-db';
const CACHE_KEY = STORE + '.nachbarn';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid4() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
const cleanName = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);

/** Private Nachbarschaftsdaten – liegen in state.privat, verlassen nie das Gerät (außer Token-Prüfung). */
function nbData() {
  const pv = state.privat;
  if (!pv.nb || typeof pv.nb !== 'object') pv.nb = {};
  const nb = pv.nb;
  if (!Array.isArray(nb.list)) nb.list = [];
  nb.list = nb.list.filter((x) => x && UUID_RE.test(x.id)).slice(0, NB_MAX);
  return nb;
}
/** Garten-ID (UUID) und Schreib-Token einmalig erzeugen. */
function ensureIdentity() {
  const nb = nbData();
  let changed = false;
  if (!UUID_RE.test(state.garden.id || '')) { state.garden.id = uuid4(); changed = true; }
  if (!nb.token || nb.token.length < 32) { nb.token = randomToken(); changed = true; }
  if (changed) saveState();
}
const sharing = () => NB_ON && !!nbData().name; // geteilt wird erst, wenn ein Gartenname gewählt ist

/* ---------- Backend: Supabase (fetch) oder Mock (localStorage) ---------- */
async function sbRpc(fn, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  const headers = { apikey: SB_KEY, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (/^eyJ/.test(SB_KEY)) headers.Authorization = 'Bearer ' + SB_KEY; // alter anon-JWT; neue sb_publishable-Schlüssel nur als apikey
  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  } finally { clearTimeout(timer); }
}
function mockRead() { try { return JSON.parse(localStorage.getItem(MOCK_DB)) || {}; } catch (e) { return {}; } }
const mockWait = () => new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
const backend = {
  async upsert(id, token, name, snap) {
    if (MOCK) {
      await mockWait();
      if (navigator.onLine === false) throw new Error('offline');
      const db = mockRead(), h = 'h' + hashStr(token) + '.' + hashStr(token + 'x');
      const row = db[id];
      if (row && row.token_hash !== h) { const e = new Error('forbidden'); e.status = 403; throw e; }
      db[id] = { token_hash: h, name: cleanName(name), snapshot: snap, updated_at: new Date().toISOString() };
      localStorage.setItem(MOCK_DB, JSON.stringify(db));
      return db[id].updated_at;
    }
    return sbRpc('upsert_garden', { p_id: id, p_token: token, p_name: cleanName(name), p_snapshot: snap });
  },
  async get(ids) {
    if (!ids.length) return [];
    if (MOCK) {
      await mockWait();
      if (navigator.onLine === false) throw new Error('offline');
      const db = mockRead();
      return ids.filter((id) => db[id]).map((id) => ({ id, name: db[id].name, snapshot: db[id].snapshot, updated_at: db[id].updated_at }));
    }
    const rows = await sbRpc('get_gardens', { p_ids: ids });
    return Array.isArray(rows) ? rows : [];
  },
  // Fotos (1.3) – ohne Storage-Bucket, base64 in der Tabelle photos
  async putFoto(gid, token, pid, day, mime, data) {
    if (MOCK) {
      await mockWait();
      if (navigator.onLine === false) throw new Error('offline');
      mockCheckToken(gid, token);
      if (!FOTO_MIMES.includes(mime) || data.length > 90000) { const e = new Error('ungueltig'); e.status = 400; throw e; }
      const db = mockFotos(), t = today();
      for (const g of Object.keys(db)) { // wie der Server: Abgelaufenes bei jedem Aufruf löschen
        for (const k of Object.keys(db[g])) if (!fotoFresh(db[g][k].day, t)) delete db[g][k];
        if (!Object.keys(db[g]).length) delete db[g];
      }
      const g = db[gid] = db[gid] || {};
      g[pid] = { day, mime, data, at: Date.now() };
      const keys = Object.keys(g).sort((a, b) => g[b].at - g[a].at);
      keys.slice(30).forEach((k) => delete g[k]);
      mockFotosSave(db);
      return true;
    }
    return sbRpc('upsert_photo', { p_garden: gid, p_token: token, p_plant: pid, p_taken_on: isoDay(day), p_mime: mime, p_data: data });
  },
  async delFoto(gid, token, pid) {
    if (MOCK) {
      await mockWait();
      if (navigator.onLine === false) throw new Error('offline');
      mockCheckToken(gid, token);
      const db = mockFotos();
      if (db[gid]) { delete db[gid][pid]; mockFotosSave(db); }
      return true;
    }
    return sbRpc('delete_photo', { p_garden: gid, p_token: token, p_plant: pid });
  },
  /** -> { mime, data, day } oder null (nicht da oder älter als 7 Tage) */
  async getFoto(gid, pid) {
    if (MOCK) {
      await mockWait();
      if (navigator.onLine === false) throw new Error('offline');
      const r = (mockFotos()[gid] || {})[pid];
      return r && fotoFresh(r.day) ? { mime: r.mime, data: r.data, day: r.day } : null;
    }
    const rows = await sbRpc('get_photo', { p_garden: gid, p_plant: pid });
    const r = Array.isArray(rows) ? rows[0] : rows;
    return r && r.data ? { mime: r.mime, data: r.data, day: dayOfIso(r.taken_on) } : null;
  }
};

/* ---------- Hochladen: gedrosselt, nur bei Änderung, offline später ---------- */
let syncTimer = 0, syncBusy = false, syncAgain = false, lastSyncAt = 0, syncHintShown = false;
/** Größe so, wie Postgres sie prüft: jsonb::text setzt nach jedem „:“ und „,“ ein Leerzeichen. */
const snapSize = (json) => json.length + (json.match(/[:,]/g) || []).length;
function snapshotForUpload() {
  const snap = gardenSnapshot();
  let json = JSON.stringify(snap);
  if (snapSize(json) > SNAP_MAX) { // zuerst Mini-Bilder weglassen (älteste zuerst) – der Foto-Hinweis bleibt
    const withT = snap.plants.filter((p) => p.foto && p.foto.t).sort((a, b) => a.foto.d - b.foto.d);
    while (snapSize(json) > SNAP_MAX && withT.length) { delete withT.shift().foto.t; json = JSON.stringify(snap); }
  }
  if (snapSize(json) > SNAP_MAX) { // sehr großer Garten: Wochenrohdaten kürzen, dann Pflanzen begrenzen
    const w0 = weekStart(today());
    snap.plants.forEach((p) => { p.days = p.days.filter((d) => d >= w0); if (!p.foto) delete p.id; });
    json = JSON.stringify(snap);
    while (snapSize(json) > SNAP_MAX && snap.plants.length) { snap.plants.pop(); json = JSON.stringify(snap); }
  }
  return snap;
}
function scheduleSync(soon) {
  if (!sharing()) return;
  clearTimeout(syncTimer);
  const wait = soon ? 0 : Math.max(800, lastSyncAt + SYNC_GAP - Date.now());
  syncTimer = setTimeout(syncNow, wait);
}
async function syncNow(force) {
  if (!sharing()) return false;
  if (!fotosLoaded) { scheduleSync(); return false; } // erst die Fotos kennen, dann teilen
  if (syncBusy) { syncAgain = true; return false; }
  const nb = nbData();
  const snap = snapshotForUpload();
  const body = JSON.stringify([nb.name, snap]);
  const sig = hashStr(body) + ':' + body.length;
  if (!force && sig === nb.sent) return true; // nichts geändert
  if (navigator.onLine === false) { nb.dirty = true; return false; }
  if (!force && Date.now() - lastSyncAt < SYNC_GAP) { scheduleSync(); return false; }
  syncBusy = true; lastSyncAt = Date.now();
  try {
    await backend.upsert(state.garden.id, nb.token, nb.name, snap);
    nb.sent = sig; nb.dirty = false;
    try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* egal */ }
    syncFotos(); // wartende Fotos (z. B. von offline) nachholen
    return true;
  } catch (e) {
    nb.dirty = true;
    if (!syncHintShown && navigator.onLine !== false && e.status) { syncHintShown = true; toastLater('Dein Garten konnte gerade nicht geteilt werden. Später klappt es wieder.'); }
    return false;
  } finally {
    syncBusy = false;
    if (syncAgain) { syncAgain = false; scheduleSync(); }
  }
}

/* ---------- Nachbarn laden (Polling) ---------- */
let nbCache = {};      // id -> { name, snap, at, loaded }
let pollTimer = 0, lastPollAt = 0, overviewOpen = false, nbConfirming = false;
function loadCache() {
  try { const c = JSON.parse(localStorage.getItem(CACHE_KEY)); nbCache = c && typeof c === 'object' ? c : {}; } catch (e) { nbCache = {}; }
  const ids = new Set(nbData().list.map((x) => x.id));
  for (const k of Object.keys(nbCache)) if (!ids.has(k)) delete nbCache[k];
}
function saveCache() { try { localStorage.setItem(CACHE_KEY, JSON.stringify(nbCache)); } catch (e) { /* Platz: nicht schlimm */ } }
const pollWanted = () => NB_ON && !document.hidden && nbData().list.length > 0 && (!!view || overviewOpen);
function schedulePoll(delay = POLL_MS) {
  clearTimeout(pollTimer);
  if (pollWanted()) pollTimer = setTimeout(() => pollNow(), delay);
}
async function pollNow(always) {
  clearTimeout(pollTimer);
  if (!NB_ON || (!always && !pollWanted())) return;
  const nb = nbData(), ids = nb.list.map((x) => x.id);
  if (!ids.length) return;
  lastPollAt = Date.now();
  try {
    const rows = await backend.get(ids);
    let changedView = false, changedAny = false;
    for (const r of rows) {
      if (!r || !UUID_RE.test(r.id) || !ids.includes(r.id)) continue;
      const snap = sanitizeSnap(r.snapshot);
      const old = nbCache[r.id];
      const name = cleanName(r.name) || 'Nachbargarten';
      if (!old || old.at !== r.updated_at || old.name !== name) {
        nbCache[r.id] = { name, snap, at: r.updated_at, loaded: Date.now() };
        changedAny = true;
        if (view && view.id === r.id) changedView = true;
      }
      const ent = nb.list.find((x) => x.id === r.id);
      if (ent && ent.name !== name) ent.name = name;
    }
    saveCache();
    if (changedView) { view = buildView(view.id); refresh(); markFotosSeen(); }
    else if (view) updateNeighborUI(); // „zuletzt aktiv“ weiterzählen
    renderNav();
    if (changedAny && overviewOpen && !nbConfirming) openNeighborhood(); // Übersicht auffrischen
  } catch (e) { /* offline oder Server weg: beim nächsten Mal */ }
  schedulePoll();
}

/** Daten aus dem Netz sind fremd: nur bekannte Felder, Zahlen geprüft, Größe begrenzt. */
function sanitizeSnap(s) {
  if (!s || typeof s !== 'object') return { level: 0, day: today(), plants: [] };
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
  const day = Math.round(num(s.day, today()));
  const plants = (Array.isArray(s.plants) ? s.plants : []).slice(0, 60).filter((p) => p && SPECIES_ORDER.includes(p.species)).map((p, i) => ({
    id: String(p.id == null ? i : p.id).slice(0, 40), species: p.species,
    goal: GOALS.includes(p.goal) ? p.goal : 7,
    growth: clamp(num(p.growth, 0), 0, 400),
    last: p.last == null ? (p.wateredToday ? day : null) : Math.round(num(p.last, day)),
    planted: Math.round(num(p.planted, day - 7)),
    resume: p.resume == null ? null : Math.round(num(p.resume, day)),
    days: (Array.isArray(p.days) ? p.days : []).slice(-14).filter((d) => typeof d === 'number' && isFinite(d)).map(Math.round),
    paused: !!p.paused,
    foto: sanitizeFoto(p.foto)
  }));
  return { level: clamp(Math.round(num(s.level, 0)), 0, LEVEL_MAX), day, plants };
}
/** Nachbar-Pflanzen so nachbauen, dass condition()/weekCount() mit dem heutigen Tag des Betrachters rechnen. */
function buildView(id) {
  const c = nbCache[id], ent = nbData().list.find((x) => x.id === id);
  const snap = c ? c.snap : { level: 0, day: today(), plants: [] };
  const plants = snap.plants.map((p) => ({
    id: p.id, species: p.species, goal: p.goal, growth: p.growth,
    lastWatered: p.last, plantedDay: p.planted, resumeDay: p.resume, days: p.days.slice(),
    paused: p.paused ? snap.day : null, nb: true, foto: p.foto || null
  }));
  return { id, name: (c && c.name) || (ent && ent.name) || 'Nachbargarten', level: snap.level, plants, at: c ? c.at : null, loaded: !!c };
}
function gardenStatus(plants, t = today()) {
  if (!plants.length) return { key: 'leer', emoji: '🌱', text: 'noch leer' };
  if (plants.every((p) => p.paused != null)) return { key: 'pause', emoji: '💤', text: 'Pause' };
  const vit = vitality(t, plants);
  if (vit < 0.75 || plants.some((p) => condition(p, t) === 2)) return { key: 'durst', emoji: '🥀', text: 'durstig' };
  return { key: 'bluet', emoji: '🌸', text: 'blüht' };
}
function agoText(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!isFinite(ms)) return '';
  const m = Math.floor(ms / 60000);
  if (m < 2) return 'gerade eben aktiv';
  if (m < 60) return `zuletzt aktiv vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `zuletzt aktiv vor ${h} Std.`;
  const d = Math.floor(h / 24);
  return `zuletzt aktiv vor ${d} ${d === 1 ? 'Tag' : 'Tagen'}`;
}
function plantInfo(p) { return `${SPECIES[p.species].name} · ${stageName(p.species, stageOf(p.growth))}${p.paused != null ? ' · Pause' : ''}`; }

/* ---------- Gartenzaun-Ansicht: eigener Garten + Nachbarn ---------- */
let viewIdx = 0;
const gardenIds = () => [null].concat(nbData().list.map((x) => x.id));
function showGarden(idx, dir) {
  const ids = gardenIds();
  idx = clamp(idx, 0, ids.length - 1);
  // laufende Gieß-Animation im eigenen Garten sofort abschließen
  for (const k of cans) if (!k.done) { k.done = true; pendingVis.delete(k.s.p.id); if (k.msg) toast(k.msg); if (k.res && k.res.levelUp) celebrate(k.res.levelUp); }
  cans.length = 0; drops.length = 0; sparks.length = 0; petals.length = 0; spray.length = 0;
  pendingVis.clear(); wiggle.clear();
  hideNachweis();
  viewIdx = idx;
  view = ids[idx] ? buildView(ids[idx]) : null;
  document.body.classList.toggle('nachbar-ansicht', !!view);
  $('titel').replaceChildren(titleNode());
  $('titel').setAttribute('aria-label', view ? view.name : 'Gewohnheits-Garten');
  refresh();
  renderNav();
  if (dir) { canvas.classList.remove('rein-l', 'rein-r'); void canvas.offsetWidth; canvas.classList.add(dir > 0 ? 'rein-r' : 'rein-l'); }
  markFotosSeen();
  if (view && Date.now() - lastPollAt > 15000) pollNow(); else schedulePoll();
}
function titleNode() {
  const sc = innerWidth < 400 ? 2 : 3;
  if (!view) return pixelText('Gewohnheits-Garten', sc);
  const name = view.name;
  const pt = pixelText(name, sc);
  if (pt.width * sc > innerWidth - 40 || /[^A-Za-zÄÖÜäöüß0-9 .\-!?:+,]/.test(name)) {
    const pt2 = pixelText(name, 2);
    if (pt2.width * 2 <= innerWidth - 40 && !/[^A-Za-zÄÖÜäöüß0-9 .\-!?:+,]/.test(name)) return pt2;
    return el('span', { class: 'titel-text' }, name);
  }
  return pt;
}
function updateNeighborUI() {
  if (!view) return;
  const t = today(), plants = view.plants;
  $('titel').setAttribute('aria-label', view.name);
  $('stufe').hidden = true;
  $('leer').hidden = true;
  const parts = [];
  if (!view.loaded) parts.push('wird geladen …');
  else {
    const st = gardenStatus(plants, t);
    parts.push(`Stufe ${view.level}`);
    parts.push(`${st.text} ${st.emoji}`);
    if (plants.some((p) => wateredToday(p, t))) parts.push('heute gegossen 💧');
    if (view.at) parts.push(agoText(view.at));
  }
  $('gruss').textContent = parts.join(' · ');
}

/* Leiste mit Punkten oben + Pfeile am Zaun */
const punkte = el('nav', { id: 'punkte', 'aria-label': 'Gärten', hidden: '' });
const pfeilL = el('button', { id: 'pfeil-l', class: 'zaun-pfeil', type: 'button', 'aria-label': 'Vorheriger Garten', hidden: '' }, '‹');
const pfeilR = el('button', { id: 'pfeil-r', class: 'zaun-pfeil', type: 'button', 'aria-label': 'Nächster Garten', hidden: '' }, '›');
function renderNav() {
  const ids = gardenIds(), many = NB_ON && ids.length > 1;
  punkte.hidden = !many; pfeilL.hidden = !many || viewIdx === 0; pfeilR.hidden = !many || viewIdx >= ids.length - 1;
  if (!many) { punkte.replaceChildren(); return; }
  if (viewIdx >= ids.length) viewIdx = ids.length - 1;
  punkte.replaceChildren(...ids.map((id, i) => {
    const c = id && nbCache[id];
    let cls = 'punkt' + (i === 0 ? ' heim' : '') + (i === viewIdx ? ' aktiv' : '');
    if (c) cls += ' ' + gardenStatus(buildView(id).plants).key;
    const nm = i === 0 ? 'Dein Garten' : (c ? c.name : (nbData().list[i - 1] || {}).name || 'Nachbargarten');
    const b = el('button', { class: cls, type: 'button', 'aria-label': nm, 'aria-current': String(i === viewIdx) });
    b.addEventListener('click', () => { if (i !== viewIdx) showGarden(i, i > viewIdx ? 1 : -1); });
    return b;
  }));
  const y = Math.round((horizonY - 4) * PX);
  pfeilL.style.top = pfeilR.style.top = y + 'px';
}
pfeilL.addEventListener('click', () => showGarden(viewIdx - 1, -1));
pfeilR.addEventListener('click', () => showGarden(viewIdx + 1, 1));

/* Wischen nach links/rechts (vertikales Scrollen bleibt frei) */
let tStart = null;
szene.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) { tStart = null; return; }
  tStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
szene.addEventListener('touchend', (e) => {
  if (!tStart || !NB_ON || gardenIds().length < 2) return;
  const tc = e.changedTouches[0], dx = tc.clientX - tStart.x, dy = tc.clientY - tStart.y;
  const fast = Date.now() - tStart.t < 700;
  tStart = null;
  if (!fast || Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.6) return;
  if (dx < 0 && viewIdx < gardenIds().length - 1) showGarden(viewIdx + 1, 1);
  else if (dx > 0 && viewIdx > 0) showGarden(viewIdx - 1, -1);
}, { passive: true });
document.addEventListener('keydown', (e) => {
  if (!NB_ON || !blatt.hidden || gardenIds().length < 2) return;
  if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key === 'ArrowRight' && viewIdx < gardenIds().length - 1) showGarden(viewIdx + 1, 1);
  if (e.key === 'ArrowLeft' && viewIdx > 0) showGarden(viewIdx - 1, -1);
});

/* ---------- Mini-Vorschau (einmal gerendertes kleines Bild, kein dauerhaftes Canvas) ---------- */
function miniPreview(plants, level) {
  const w = 72, h = 46, cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d'), hz = 16;
  for (let y = 0; y < hz; y++) { c.fillStyle = css(mix(pal.top, pal.bot, y / hz)); c.fillRect(0, y, w, 1); }
  c.fillStyle = css(pal.near); c.fillRect(0, hz - 3, w, 3);
  for (let y = hz; y < h; y++) { c.fillStyle = css(A(mix(GRASS_TOP, GRASS_BOT, (y - hz) / (h - hz)))); c.fillRect(0, y, w, 1); }
  c.fillStyle = css(A(FENCE_D)); c.fillRect(0, hz - 2, w, 1);
  for (let x = 1; x < w; x += 5) { c.fillStyle = css(A(FENCE)); c.fillRect(x, hz - 4, 1, 5); }
  if (level >= 2) for (let x = 6; x < w; x += 16) { c.fillStyle = css(LANTERN_COLS[((x / 16) | 0) % 3]); c.fillRect(x, 3, 2, 2); }
  const show = plants.slice(0, 6), n = show.length, base = h - 6;
  if (n) {
    c.fillStyle = css(A(WOOD)); c.fillRect(2, base, w - 4, 3);
    c.fillStyle = css(A(SOIL)); c.fillRect(3, base - 1, w - 6, 1);
  }
  const t = today();
  show.forEach((p, i) => {
    const spr = getSprite(p.species, stageOf(p.growth), condition(p, t), false);
    const k = Math.min(0.5, 30 / Math.max(1, spr.height - spr.topRow));
    const dw = spr.width * k, dh = spr.height * k, cx = (w / (n + 1)) * (i + 1);
    c.drawImage(spr, cx - dw / 2, base - dh + 1, dw, dh);
  });
  const img = new Image();
  img.src = cv.toDataURL();
  img.className = 'mini';
  img.alt = '';
  img.width = w * 2; img.height = h * 2;
  return img;
}

/* ---------- Übersicht „Nachbarschaft“ ---------- */
function openNeighborhood() {
  if (!NB_ON) { toast('Die Nachbarschaft ist bald verfügbar.'); return; }
  const keep = blatt.scrollTop;
  openSheet((b) => {
    overviewOpen = true;
    b.setAttribute('aria-label', 'Nachbarschaft');
    b.classList.add('nachbarschaft');
    const nb = nbData(), t = today();
    const liste = el('ul', { class: 'nb-liste' });
    const own = state.garden.plants, ownSt = gardenStatus(own, t);
    const ownRow = el('li', null,
      el('button', { class: 'nb-garten', type: 'button' }, miniPreview(own, levelOfXp(state.garden.xp)),
        el('span', { class: 'nb-text' }, el('strong', null, nb.name || 'Dein Garten'),
          el('span', null, `Dein Garten · Stufe ${levelOfXp(state.garden.xp)} · ${ownSt.emoji}`),
          el('span', { class: 'leise' }, nb.name ? 'wird mit deinen Nachbarn geteilt' : 'noch nicht geteilt'))));
    ownRow.firstChild.addEventListener('click', () => { closeSheet(); showGarden(0, -1); });
    liste.append(ownRow);
    nb.list.forEach((ent, i) => {
      const v = buildView(ent.id), st = gardenStatus(v.plants, t);
      const info = v.loaded ? `Stufe ${v.level} · ${st.text} ${st.emoji}${v.plants.some((p) => wateredToday(p, t)) ? ' · 💧' : ''}${newFotos(ent, v.plants) ? ' · 📸' : ''}` : 'noch nicht geladen';
      const go = el('button', { class: 'nb-garten', type: 'button' }, miniPreview(v.plants, v.level),
        el('span', { class: 'nb-text' }, el('strong', null, v.name), el('span', null, info), el('span', { class: 'leise' }, v.at ? agoText(v.at) : '')));
      go.addEventListener('click', () => { closeSheet(); showGarden(i + 1, 1); });
      const weg = el('button', { class: 'nb-weg', type: 'button', 'aria-label': `${v.name} entfernen` }, '✕');
      const li = el('li', null, go, weg);
      weg.addEventListener('click', () => {
        nbConfirming = true;
        const yes = el('button', { class: 'knopf gefahr', type: 'button' }, 'Entfernen');
        const no = el('button', { class: 'knopf leise', type: 'button' }, 'Behalten');
        yes.addEventListener('click', () => { removeNeighbor(ent.id); toast(`${v.name} ist nicht mehr in deiner Nachbarschaft.`); openNeighborhood(); });
        no.addEventListener('click', () => openNeighborhood());
        li.replaceChildren(el('div', { class: 'nb-frage' }, el('p', { class: 'frage' }, `${v.name} aus der Nachbarschaft entfernen? Du siehst den Garten dann nicht mehr (dein eigener bleibt für sie sichtbar, falls sie dich als Nachbar haben).`), el('div', { class: 'reihe' }, no, yes)));
      });
      liste.append(li);
    });
    const einladen = el('button', { class: 'knopf haupt', type: 'button' }, 'Nachbarn einladen');
    einladen.addEventListener('click', () => invite());
    const nameBtn = el('button', { class: 'knopf', type: 'button' }, nb.name ? 'Gartenname ändern' : 'Gartenname wählen');
    nameBtn.addEventListener('click', () => askName(() => openNeighborhood()));
    const zu = el('button', { class: 'knopf leise', type: 'button' }, 'Schließen');
    zu.addEventListener('click', closeSheet);
    const widgetBtn = el('button', { class: 'knopf', type: 'button' }, '📱 Widget einrichten');
    widgetBtn.addEventListener('click', () => widgetEinrichten());
    const hinweis = nb.list.length ? '' : el('p', { class: 'stimmung leise' }, 'Lade Freunde ein: Ihr seht dann gegenseitig, wie eure Gärten wachsen. Nur ansehen – gießen kann jeder nur seinen eigenen. Die Namen deiner Gewohnheiten bleiben auf deinem Gerät.');
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Nachbarschaft', 3)), liste, hinweis,
      el('div', { class: 'reihe' }, einladen), el('div', { class: 'reihe' }, widgetBtn), el('div', { class: 'reihe' }, nameBtn, zu),
      MOCK ? el('p', { class: 'stimmung leise' }, `Testmodus (Mock, Profil „${MOCK_PROFILE}“) – kein echtes Supabase.`) : '');
  });
  blatt.scrollTop = keep;
  if (Date.now() - lastPollAt > 15000) pollNow(); else schedulePoll();
}
function removeNeighbor(id) {
  const nb = nbData();
  const idx = nb.list.findIndex((x) => x.id === id);
  if (idx < 0) return;
  nb.list.splice(idx, 1);
  delete nbCache[id];
  saveCache(); saveState();
  if (view && view.id === id) showGarden(0);
  else { if (viewIdx > idx) viewIdx--; renderNav(); }
}

/** Gartenname einmal abfragen (änderbar). */
function askName(then) {
  const nb = nbData();
  openSheet((b) => {
    b.setAttribute('aria-label', 'Gartenname');
    const inp = el('input', { class: 'feld', type: 'text', maxlength: String(NAME_MAX), value: nb.name || '', placeholder: 'z. B. Leos Garten', autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'Name deines Gartens' });
    const ok = el('button', { class: 'knopf haupt', type: 'button' }, 'Speichern');
    const ab = el('button', { class: 'knopf leise', type: 'button' }, 'Abbrechen');
    ok.addEventListener('click', () => {
      const v = cleanName(inp.value);
      if (!v) { inp.classList.remove('wackel'); void inp.offsetWidth; inp.classList.add('wackel'); inp.focus(); return; }
      nb.name = v;
      ensureIdentity();
      saveState();
      syncNow(true);
      if (then) then(); else closeSheet();
    });
    ab.addEventListener('click', closeSheet);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Dein Garten', 3)),
      el('p', { class: 'stimmung' }, 'Wie soll dein Garten bei deinen Nachbarn heißen? Geteilt werden nur Pflanzenarten und wie es ihnen geht – nie die Namen deiner Gewohnheiten.'),
      inp, el('div', { class: 'reihe' }, ab, ok));
    if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => inp.focus(), 60);
  });
}

function inviteLink() {
  const u = new URL(location.pathname, location.origin);
  u.searchParams.set('nachbar', state.garden.id);
  if (MOCK) u.searchParams.set('mock', '1');
  return u.toString();
}
/** Einladungslink per Web Share API teilen, sonst kopieren (oder zum Abschreiben zeigen). */
async function invite() {
  if (!NB_ON) { toast('Die Nachbarschaft ist bald verfügbar.'); return; }
  if (!nbData().name) { askName(() => invite()); return; }
  ensureIdentity();
  syncNow(true); // damit der Garten schon da ist, wenn der Link geöffnet wird
  const url = inviteLink(), name = nbData().name;
  if (navigator.share) {
    try { await navigator.share({ title: 'Gewohnheits-Garten', text: `Werde Nachbar von „${name}“ im Gewohnheits-Garten:`, url }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Einladungslink kopiert. Schick ihn deinen Freunden.'); return; }
  catch (e) { /* kein Zugriff: Link zeigen */ }
  openSheet((b) => {
    const inp = el('input', { class: 'feld', type: 'text', readonly: '', value: url, 'aria-label': 'Einladungslink' });
    const zu = el('button', { class: 'knopf leise', type: 'button' }, 'Fertig');
    zu.addEventListener('click', closeSheet);
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Einladung', 3)), el('p', { class: 'stimmung' }, 'Kopiere diesen Link und schick ihn deinen Freunden:'), inp, el('div', { class: 'reihe' }, zu));
    setTimeout(() => { inp.focus(); inp.select(); }, 60);
  });
}

/* ---------- Widget (App „Scriptable“): Skript samt Garten-Code kopieren ----------
   Der Code enthält die Garten-ID und die Namen der Gewohnheiten – er landet nur in der
   Zwischenablage und dann im Skript auf dem eigenen iPhone, nie auf dem Server. */
function widgetCode() {
  const n = {};
  state.garden.plants.forEach((p) => { n[p.id] = nameOf(p).slice(0, 40); });
  const ascii = JSON.stringify({ id: state.garden.id, n }).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  return 'GARTEN1:' + btoa(ascii);
}
async function widgetEinrichten() {
  if (!NB_ON) { toast('Das Widget braucht die Nachbarschaft – sie ist bald verfügbar.'); return; }
  if (!nbData().name) { askName(() => widgetEinrichten()); return; }
  ensureIdentity();
  syncNow(true); // damit das Widget gleich den aktuellen Stand findet
  const skript = fetch('./widget/gewohnheitsgarten-widget.js').then((r) => { if (!r.ok) throw new Error('http'); return r.text(); })
    .then((t) => `// Gewohnheits-Garten · dein Garten-Code (privat, nicht weitergeben)\nconst GARTEN_CODE = '${widgetCode()}';\n\n${t}`);
  let ok = false;
  try { // Safari: ClipboardItem mit Promise, sonst geht der Tipp durch das Laden verloren
    await navigator.clipboard.write([new ClipboardItem({ 'text/plain': skript.then((t) => new Blob([t], { type: 'text/plain' })) })]);
    ok = true;
  } catch (e) {
    try { await navigator.clipboard.writeText(await skript); ok = true; } catch (e2) { /* unten zeigen */ }
  }
  openSheet((b) => {
    b.setAttribute('aria-label', 'Widget einrichten');
    const zu = el('button', { class: 'knopf leise', type: 'button' }, 'Fertig');
    zu.addEventListener('click', closeSheet);
    const app = el('a', { class: 'knopf', href: 'https://apps.apple.com/app/scriptable/id1405459188', target: '_blank', rel: 'noopener' }, 'Scriptable laden');
    const schritte = el('ol', { class: 'widget-schritte' },
      el('li', null, 'Gratis-App „Scriptable“ installieren.'),
      el('li', null, 'Dort „+“ tippen, einfügen, oben „Garten“ nennen, Fertig.'),
      el('li', null, 'Home-Bildschirm lange drücken → „+“ → Scriptable → Widget. Widget antippen → Script: Garten.'));
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Widget', 3)),
      el('p', { class: 'stimmung' }, ok ? 'Das Widget-Skript ist kopiert. 📋' : 'Kopieren hat nicht geklappt – versuch es bitte nochmal.'),
      schritte,
      el('p', { class: 'stimmung leise' }, 'Das Widget zeigt, wer Wasser braucht. Antippen öffnet den Garten – gegossen wird erst mit Foto. Neue Pflanzen? Einfach nochmal einrichten.'),
      el('div', { class: 'reihe' }, app, zu));
  });
}

/** ?nachbar=<id> aus einem Einladungslink: freundlich fragen, dann merken. */
async function handleInviteParam() {
  const raw = params.get('nachbar');
  if (raw == null) return;
  const u = new URL(location.href);
  u.searchParams.delete('nachbar');
  history.replaceState(null, '', u.toString());
  const id = String(raw).trim().toLowerCase();
  if (!NB_ON) { toastLater('Die Nachbarschaft ist bald verfügbar. Dein Garten funktioniert schon.'); return; }
  if (!UUID_RE.test(id)) { toastLater('Dieser Einladungslink ist leider kaputt.'); return; }
  if (id === state.garden.id) { toastLater('Das ist dein eigener Garten. Schick den Link an deine Freunde.'); return; }
  const nb = nbData();
  const known = nb.list.findIndex((x) => x.id === id);
  if (known >= 0) { showGarden(known + 1, 1); return; }
  if (nb.list.length >= NB_MAX) { toastLater(`Mehr als ${NB_MAX} Nachbarn passen nicht an den Zaun. Entferne erst einen.`); return; }
  let row = null, offline = false;
  try { row = (await backend.get([id]))[0] || null; } catch (e) { offline = true; }
  if (!row && !offline) { toastLater('Diesen Garten gibt es (noch) nicht. Vielleicht später nochmal öffnen.'); return; }
  const name = row ? (cleanName(row.name) || 'Nachbargarten') : 'Nachbargarten';
  openSheet((b) => {
    b.setAttribute('aria-label', 'Nachbar hinzufügen');
    const ja = el('button', { class: 'knopf haupt', type: 'button' }, 'Hinzufügen');
    const nein = el('button', { class: 'knopf leise', type: 'button' }, 'Lieber nicht');
    let done = false;
    ja.addEventListener('click', () => {
      if (done) return; done = true;
      if (!nb.list.some((x) => x.id === id)) nb.list.push({ id, name });
      if (row) nbCache[id] = { name, snap: sanitizeSnap(row.snapshot), at: row.updated_at, loaded: Date.now() };
      saveCache(); saveState();
      showGarden(nb.list.length, 1);
      offerReturn(name);
    });
    nein.addEventListener('click', closeSheet);
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Nachbarschaft', 3)),
      el('p', { class: 'stimmung gross' }, `„${name}“ als Nachbar hinzufügen?`),
      el('p', { class: 'stimmung leise' }, offline ? 'Gerade offline – der Garten erscheint, sobald wieder Netz da ist.' : 'Du siehst dann, wie es in diesem Garten wächst. Nur ansehen, nicht gießen.'),
      el('div', { class: 'reihe' }, nein, ja));
  });
}
/** Gegenseitig: eigenen Link zurückschicken anbieten. */
function offerReturn(name) {
  openSheet((b) => {
    const ja = el('button', { class: 'knopf haupt', type: 'button' }, 'Meinen Link schicken');
    const nein = el('button', { class: 'knopf leise', type: 'button' }, 'Später');
    ja.addEventListener('click', () => { closeSheet(); setTimeout(invite, 360); });
    nein.addEventListener('click', closeSheet);
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Willkommen', 3)),
      el('p', { class: 'stimmung' }, `„${name}“ steht jetzt an deinem Zaun. Wisch nach links und rechts, um zwischen den Gärten zu wechseln.`),
      el('p', { class: 'stimmung leise' }, 'Soll „' + name + '“ auch deinen Garten sehen? Dann schick deinen Link zurück.'),
      el('div', { class: 'reihe' }, nein, ja));
  });
}

/* ---------- Testhilfe: erfundene Nachbarn ---------- */
async function fakeNeighbors(n = 3) {
  if (!MOCK) return 'Nur im Mock-Modus (?mock=a).';
  const t = today(), nb = nbData();
  const R = mulberry32((Date.now() & 0xffff) ^ 0x2f);
  const recipes = [
    { name: 'Mias Garten', level: 3, stages: [[1, 'farn', 7], [2, 'kaktus', 1], [3, 'sonnenblume', 3]], water: [true, false, false], late: [0, 2, 9] },
    { name: 'Bens Balkon', level: 9, stages: [[4, 'kirschbaum', 3], [5, 'monstera', 7], [4, 'sonnenblume', 3], [6, 'farn', 7]], water: [true, true, false, true], late: [0, 0, 1, 0] },
    { name: 'Omas Beet', level: 16, stages: [[7, 'kirschbaum', 3], [7, 'sonnenblume', 2], [6, 'kaktus', 1], [7, 'monstera', 5], [5, 'farn', 7]], water: [true, true, false, true, false], late: [0, 0, 3, 0, 0], pause: [4] }
  ].slice(0, clamp(n, 1, 3));
  const added = [];
  for (const rc of recipes) {
    if (nb.list.length >= NB_MAX) break;
    const id = uuid4();
    const plants = rc.stages.map(([st, sp, goal], i) => {
      const last = rc.water[i] ? t : t - 1 - rc.late[i];
      const days = [];
      for (let d = last; d > t - 14; d -= Math.max(1, Math.round(7 / goal))) days.push(d);
      return { id: uuid4(), species: sp, goal, stage: st, growth: STAGE_MIN[st] + R() * 0.9,
        condition: 0, wateredToday: rc.water[i], week: 0, paused: !!(rc.pause && rc.pause.includes(i)),
        last, planted: t - 120, resume: null, days: days.reverse() };
    });
    // 1.3: ein paar Fotos (heute, gestern, vor 3 Tagen) – Mini-Bild in den Schnappschuss, Vollbild ins Backend
    const token = randomToken(), fotos = [];
    for (let i = 0; i < Math.min(plants.length, 1 + (rc.level > 5 ? 1 : 0) + (rc.level > 10 ? 1 : 0)); i++) {
      try {
        const f = await makeFoto(await fakeBild(hashStr(id) + i * 977));
        const d = t - [0, 1, 3][i];
        plants[i].foto = f.thumb ? { d, t: f.thumb } : { d };
        fotos.push([plants[i].id, d, f]);
      } catch (e) { /* ohne Foto weiter */ }
    }
    const snap = { v: 2, id, day: t, level: rc.level, xp: xpFor(rc.level), vitality: 1, deko: [], visible: [], plants };
    await backend.upsert(id, token, rc.name, snap);
    for (const [pid, d, f] of fotos) { try { await backend.putFoto(id, token, pid, d, f.mime, f.data); } catch (e) { /* egal */ } }
    nb.list.push({ id, name: rc.name });
    added.push(rc.name);
  }
  saveState();
  await pollNow(true);
  renderNav();
  return added;
}

function setupNeighborhood() {
  $('szene').append(pfeilL, pfeilR);
  $('titel').after(punkte);
  const knopf = $('nachbarn');
  if (!NB_ON) { knopf.hidden = true; handleInviteParam(); handleGiessParam(); return; }
  knopf.hidden = false;
  knopf.append(houseIcon());
  knopf.addEventListener('click', openNeighborhood);
  ensureIdentity();
  loadCache();
  renderNav();
  addEventListener('online', () => { if (nbData().dirty) scheduleSync(true); else syncFotos(); if (view || overviewOpen) pollNow(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { clearTimeout(pollTimer); return; }
    if (nbData().dirty) scheduleSync(true); else syncFotos();
    if (pollWanted()) { if (Date.now() - lastPollAt > 15000) pollNow(); else schedulePoll(); }
  });
  scheduleSync();                    // beim Start (nur bei Änderung)
  if (nbData().list.length) pollNow(true); // einmal frische Stände für die Punkte-Leiste
  handleInviteParam();
  handleGiessParam();
}
function houseIcon() {
  const c = document.createElement('canvas'); c.width = 13; c.height = 11;
  const x = c.getContext('2d');
  const R = (col, a, b, w, h) => { x.fillStyle = col; x.fillRect(a, b, w, h); };
  for (let i = 0; i < 5; i++) R('#c46f5f', 4 - i + 2, i, 1 + i * 2 + 0, 1);
  R('#fbecd9', 2, 5, 9, 5); R('#7a5a6a', 5, 7, 3, 3); R('#7cc4bd', 3, 6, 2, 2); R('#7cc4bd', 8, 6, 2, 2);
  R('#d8c6b8', 0, 9, 13, 1); R('#d8c6b8', 0, 7, 1, 3); R('#d8c6b8', 12, 7, 1, 3);
  c.className = 'pixeltext';
  c.style.width = '39px'; c.style.height = '33px';
  return c;
}

/* ------------------------------------------------------------------ Foto-Nachweis (1.3)
   Freiwillig: Beim Gießen (Knopf „📸 Nachweis?“) oder im Detail-Blatt ein kleines Foto machen.
   Das Bild wird im Browser verkleinert (≤ 640 px, WebP/JPEG, Ziel ≤ 60 KB) und bekommt den Lofi-Look
   des Gartens: warmer Farbstich, etwas Körnung, leichte Vignette. Dazu ein Mini-Bild (48 px, ≤ 2 KB).
   Lokal: IndexedDB (nie localStorage), pro Pflanze nur das neueste Foto, nach 7 Tagen weg.
   Geteilt (nur mit Gartennamen): Vollbild über die RPC upsert_photo, das Mini-Bild steckt im
   Schnappschuss (begrenzt). Nachbarn laden das Vollbild erst beim Antippen (get_photo).
   Fotos, die ohne Gartennamen gemacht wurden, bleiben immer nur auf dem Gerät. */
const FOTO_TAGE = 7;                 // danach automatisch gelöscht (Server und Gerät)
const FOTO_MAX = 640;                // lange Seite in Pixel
const FOTO_ZIEL = 80000;             // base64-Zeichen ≈ 60 KB (Server erlaubt 90 000)
const THUMB_PX = 48, THUMB_ZIEL = 2000;
const THUMB_ANZAHL = 8, THUMB_BUDGET = 10000; // Mini-Bilder im Schnappschuss: neueste 8, zusammen ≤ 10 000 Zeichen
const NB_FOTO_CACHE = 3;             // Nachbar-Vollbilder im Speicher
const FOTO_MIMES = ['image/webp', 'image/jpeg'];
const THUMB_RE = /^data:image\/(webp|jpeg);base64,[A-Za-z0-9+/]+=*$/;
const B64_RE = /^[A-Za-z0-9+/]+=*$/;
const FOTO_DB = 'gewohnheitsgarten-fotos' + (MOCK ? '.mock.' + MOCK_PROFILE : '');
const MOCK_FOTOS = 'gewohnheitsgarten.mock-photos';

let fotoIdx = new Map();   // Pflanzen-ID -> { plant, day, mime, thumb, size, synced, local } (ohne Vollbild)
let fotosLoaded = false, fotoBusy = false, fotoTarget = null, fotoSyncBusy = false, fotoHintShown = false;
let lastFotoInfo = null;
const nbFotoCache = new Map(); // "garten:pflanze" -> data-URL, höchstens NB_FOTO_CACHE

const fotoFresh = (d, t = today()) => typeof d === 'number' && isFinite(d) && t - d < FOTO_TAGE && d <= t + 1;
const isoDay = (d) => new Date(d * 86400000).toISOString().slice(0, 10);
const dayOfIso = (s) => Math.floor(Date.parse(s) / 86400000);
function dayAgo(d, t = today()) {
  const n = t - d;
  return n <= 0 ? 'heute' : n === 1 ? 'gestern' : `vor ${n} Tagen`;
}
function dateText(d) { const x = new Date(d * 86400000); return `${x.getUTCDate()}.${x.getUTCMonth() + 1}.`; }

/* ---------- IndexedDB: „meta“ (klein, beim Start geladen) und „bild“ (Vollbild, nur bei Bedarf) ---------- */
let idbP = null;
function idb() {
  if (!idbP) idbP = new Promise((res, rej) => {
    if (!window.indexedDB) { rej(new Error('kein IndexedDB')); return; }
    const r = indexedDB.open(FOTO_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'plant' });
      if (!db.objectStoreNames.contains('bild')) db.createObjectStore('bild', { keyPath: 'plant' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return idbP;
}
async function idbRun(stores, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(stores, mode);
    let out;
    const r = fn(tx);
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => res(out);
    tx.onerror = tx.onabort = () => rej(tx.error || new Error('IndexedDB'));
  });
}
const fotoMetaAll = () => idbRun(['meta'], 'readonly', (tx) => tx.objectStore('meta').getAll());
const fotoBild = (pid) => idbRun(['bild'], 'readonly', (tx) => tx.objectStore('bild').get(pid));
const fotoPutMeta = (m) => idbRun(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').put(m); });
const fotoPut = (m, data) => idbRun(['meta', 'bild'], 'readwrite', (tx) => {
  tx.objectStore('meta').put(m); tx.objectStore('bild').put({ plant: m.plant, data });
});
const fotoDelLocal = (pid) => idbRun(['meta', 'bild'], 'readwrite', (tx) => {
  tx.objectStore('meta').delete(pid); tx.objectStore('bild').delete(pid);
});

async function loadFotos() {
  try {
    const all = await fotoMetaAll();
    fotoIdx = new Map((all || []).filter((m) => m && m.plant).map((m) => [m.plant, m]));
  } catch (e) { fotoIdx = new Map(); }
  fotosLoaded = true;
  await purgeFotos();
}
/** Abgelaufene oder verwaiste Fotos vom Gerät löschen (und – falls schon geteilt – auf dem Server). */
let purging = false;
async function purgeFotos() {
  if (purging) return;
  purging = true;
  try {
    const t = today(), ids = new Set(state.garden.plants.map((p) => p.id));
    for (const [pid, m] of [...fotoIdx]) {
      const orphan = !ids.has(pid);
      if (fotoFresh(m.day, t) && !orphan) continue;
      fotoIdx.delete(pid);
      try { await fotoDelLocal(pid); } catch (e) { /* egal */ }
      if (orphan && m.synced) queueFotoDelete(pid); // abgelaufene löscht der Server selbst
    }
  } finally { purging = false; }
}
function queueFotoDelete(pid) {
  const nb = nbData();
  nb.fotoDel = (Array.isArray(nb.fotoDel) ? nb.fotoDel : []).filter((x) => x !== pid).concat(pid).slice(-60);
}

/** Foto einer Pflanze (eigene: aus fotoIdx, Nachbar: aus dem Schnappschuss) – nur wenn jünger als 7 Tage. */
function fotoOf(p) {
  if (p.nb) return p.foto && fotoFresh(p.foto.d) ? p.foto : null;
  const m = fotosLoaded && fotoIdx.get(p.id);
  return m && fotoFresh(m.day) ? { d: m.day, t: m.thumb } : null;
}

/* ---------- Bild verkleinern + Lofi-Look ---------- */
let webpOk = null;
function encodeCv(cv, q) {
  if (webpOk !== false) {
    const u = cv.toDataURL('image/webp', q);
    if (u.startsWith('data:image/webp')) { webpOk = true; return { mime: 'image/webp', url: u }; }
    webpOk = false; // Safari kann (je nach Version) kein WebP schreiben: dann JPEG
  }
  return { mime: 'image/jpeg', url: cv.toDataURL('image/jpeg', q) };
}
const b64Of = (url) => url.slice(url.indexOf(',') + 1);

/** Warmer Farbstich, angehobene Schatten (wie die Garten-Palette), leichte Körnung und Vignette – in einem Durchgang. */
function lofi(c, w, h) {
  const img = c.getImageData(0, 0, w, h), D = img.data;
  const cx = (w - 1) / 2, cy = (h - 1) / 2, inv = 1 / (cx * cx + cy * cy);
  const R = mulberry32((w * 7919 + h) ^ 0x51ed);
  let gRow = new Float32Array(Math.ceil(w / 2) + 1);
  for (let y = 0; y < h; y++) {
    if ((y & 1) === 0) for (let i = 0; i < gRow.length; i++) gRow[i] = (R() - 0.5) * 16; // Körnung in 2×2-Blöcken
    const dy = (y - cy) * (y - cy);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = D[o], g = D[o + 1], b = D[o + 2];
      // sanfter Kontrast + warm, Schwarz leicht violett angehoben
      r = r * 0.9 + 26; g = g * 0.86 + 18; b = b * 0.76 + 26;
      const lum = (r + g + b) / 3;
      r += (lum - r) * 0.1; g += (lum - g) * 0.1; b += (lum - b) * 0.1; // ein Hauch entsättigt
      const d = ((x - cx) * (x - cx) + dy) * inv;
      const v = 1 - 0.38 * d * d;
      const n = gRow[x >> 1];
      D[o] = r * v + n; D[o + 1] = g * v + n; D[o + 2] = b * v * 0.98 + n;
    }
  }
  c.putImageData(img, 0, 0);
}

/** Datei/Blob -> { mime, data (base64), thumb (data-URL) }. Kein Bild bleibt im Speicher hängen. */
async function makeFoto(blob) {
  const src = URL.createObjectURL(blob);
  let img = new Image(), cv = null, tc = null;
  try {
    img.decoding = 'async';
    img.src = src;
    await img.decode();
    const iw = img.naturalWidth, ih = img.naturalHeight;
    if (!iw || !ih) throw new Error('leeres Bild');
    let k = Math.min(1, FOTO_MAX / Math.max(iw, ih));
    let w = Math.max(1, Math.round(iw * k)), h = Math.max(1, Math.round(ih * k));
    cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    let c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, 0, 0, w, h);
    img.removeAttribute('src'); img = null; URL.revokeObjectURL(src);
    lofi(c, w, h);
    // Qualität senken, bis das Ziel passt; notfalls kleiner rechnen
    let q = 0.6, out = encodeCv(cv, q);
    while (b64Of(out.url).length > FOTO_ZIEL) {
      if (q > 0.3) { q = Math.round((q - 0.1) * 100) / 100; }
      else {
        const nw = Math.round(w * 0.8), nh = Math.round(h * 0.8);
        if (nw < 160) break;
        const c2 = document.createElement('canvas'); c2.width = nw; c2.height = nh;
        const x2 = c2.getContext('2d'); x2.imageSmoothingQuality = 'high'; x2.drawImage(cv, 0, 0, nw, nh);
        cv.width = cv.height = 0; cv = c2; c = x2; w = nw; h = nh; q = 0.5;
      }
      out = encodeCv(cv, q);
    }
    const data = b64Of(out.url);
    if (data.length > 89000) throw new Error('zu groß');
    // Mini-Bild: quadratischer Ausschnitt aus der Mitte
    tc = document.createElement('canvas'); tc.width = tc.height = THUMB_PX;
    const tx2 = tc.getContext('2d'); tx2.imageSmoothingQuality = 'high';
    const s = Math.min(w, h);
    tx2.drawImage(cv, (w - s) / 2, (h - s) / 2, s, s, 0, 0, THUMB_PX, THUMB_PX);
    let tq = 0.5, th = encodeCv(tc, tq).url;
    while (th.length > THUMB_ZIEL && tq > 0.15) { tq -= 0.1; th = encodeCv(tc, tq).url; }
    if (th.length > THUMB_ZIEL || !THUMB_RE.test(th)) th = '';
    lastFotoInfo = { mime: out.mime, w, h, q, bytes: Math.floor(data.length * 3 / 4), b64: data.length, thumbChars: th.length, thumbBytes: th ? Math.floor(b64Of(th).length * 3 / 4) : 0 };
    return { mime: out.mime, data, thumb: th };
  } finally {
    if (img) { img.removeAttribute('src'); URL.revokeObjectURL(src); }
    if (cv) cv.width = cv.height = 0;
    if (tc) tc.width = tc.height = 0;
  }
}

/* ---------- Foto aufnehmen ---------- */
const fotoInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', id: 'foto-input', hidden: '', 'aria-hidden': 'true', tabindex: '-1' });
let lastTake = Promise.resolve(null);
fotoInput.addEventListener('change', () => {
  const f = fotoInput.files && fotoInput.files[0], pid = fotoTarget;
  fotoInput.value = '';
  if (f && pid) lastTake = takeFoto(f, pid);
  else fotoDannGiessen = null;
});
fotoInput.addEventListener('cancel', () => { fotoDannGiessen = null; });

/* ---------- 1.5 Widget: ?giessen=<Pflanzen-ID> – nie direkt gießen, immer erst ein Foto ---------- */
let fotoDannGiessen = null;
function handleGiessParam() {
  const raw = params.get('giessen');
  if (raw == null) return;
  const u = new URL(location.href);
  u.searchParams.delete('giessen');
  history.replaceState(null, '', u.toString());
  const p = state.garden.plants.find((x) => x.id === String(raw).trim());
  if (!p) { toastLater('Diese Pflanze gibt es nicht mehr. Richte das Widget neu ein.'); return; }
  const t = today();
  if (wateredToday(p, t)) { toastLater(`${nameOf(p)} ist heute schon gegossen.`); return; }
  if (p.paused != null) { toastLater(`${nameOf(p)} macht gerade Pause.`); return; }
  openSheet((b) => {
    b.setAttribute('aria-label', 'Gießen mit Foto');
    const kamera = el('button', { class: 'knopf haupt', type: 'button' }, '📸 Foto machen');
    const galerie = el('button', { class: 'knopf', type: 'button' }, 'Aus Fotos');
    const ab = el('button', { class: 'knopf leise', type: 'button' }, 'Später');
    const los = (gallery) => {
      if (kamera.dataset.done) return; kamera.dataset.done = '1';
      closeSheet();
      fotoDannGiessen = p.id;
      fotoStart(p, gallery); // im selben Tipp, sonst blockiert Safari die Kamera
    };
    kamera.addEventListener('click', () => los(false));
    galerie.addEventListener('click', () => los(true));
    ab.addEventListener('click', closeSheet);
    b.append(el('div', { class: 'blatt-kopf' }, pixelText('Gießen', 3)),
      el('p', { class: 'stimmung gross' }, '📸'),
      el('p', { class: 'stimmung' }, `${nameOf(p)} bekommt Wasser, sobald du ein kleines Foto als Nachweis gemacht hast.`),
      el('div', { class: 'reihe' }, kamera), el('div', { class: 'reihe' }, ab, galerie));
  });
}

/** Kamera (oder Galerie) öffnen – beim allerersten geteilten Foto vorher kurz der Datenschutz-Hinweis. */
function fotoStart(p, gallery) {
  if (fotoBusy || view) return;
  const go = () => {
    fotoTarget = p.id;
    if (gallery) fotoInput.removeAttribute('capture'); else fotoInput.setAttribute('capture', 'environment');
    fotoInput.value = '';
    fotoInput.click();
  };
  if (sharing() && !state.privat.fotoHinweis) {
    openSheet((b) => {
      b.setAttribute('aria-label', 'Foto-Nachweis');
      const ok = el('button', { class: 'knopf haupt', type: 'button' }, 'Verstanden');
      const ab = el('button', { class: 'knopf leise', type: 'button' }, 'Lieber nicht');
      ok.addEventListener('click', () => {
        if (ok.dataset.done) return; ok.dataset.done = '1';
        state.privat.fotoHinweis = true;
        saveState();
        closeSheet();
        go(); // noch im selben Tipp, sonst blockiert der Browser die Kamera
      });
      ab.addEventListener('click', () => { fotoDannGiessen = null; closeSheet(); });
      b.append(el('div', { class: 'blatt-kopf' }, pixelText('Foto', 3)),
        el('p', { class: 'stimmung gross' }, '📸'),
        el('p', { class: 'stimmung' }, 'Deine Nachbarn sehen dieses Foto. Es wird nach 7 Tagen automatisch gelöscht.'),
        el('div', { class: 'reihe' }, ab, ok));
    });
    return;
  }
  go();
}

async function takeFoto(file, pid) {
  if (fotoBusy) return null;
  const p = state.garden.plants.find((x) => x.id === pid);
  if (!p) return null;
  fotoBusy = true;
  hideNachweis();
  toast('Foto wird entwickelt …');
  try {
    const f = await makeFoto(file);
    const meta = { plant: pid, day: today(), mime: f.mime, thumb: f.thumb, size: f.data.length, synced: false, local: !sharing() };
    await fotoPut(meta, f.data);
    fotoIdx.set(pid, meta);
    const nb = nbData();
    if (Array.isArray(nb.fotoDel)) nb.fotoDel = nb.fotoDel.filter((x) => x !== pid);
    renderLabels();
    if (sharing()) syncFotos();
    if (fotoDannGiessen === pid) { // Widget-Ablauf: erst Foto, dann gießen
      fotoDannGiessen = null;
      giessen(p);
      return lastFotoInfo;
    }
    toast(meta.local ? 'Foto gespeichert. Es bleibt auf deinem Gerät.' : 'Foto hängt jetzt an der Pflanze.');
    openFoto(p);
    return lastFotoInfo;
  } catch (e) {
    const warGiessen = fotoDannGiessen === pid;
    if (warGiessen) fotoDannGiessen = null;
    toast(warGiessen ? 'Das Foto hat leider nicht geklappt. Gegossen wird erst mit Foto.' : 'Das Foto hat leider nicht geklappt.');
    return null;
  } finally { fotoBusy = false; }
}

async function deleteFoto(p) {
  const m = fotoIdx.get(p.id);
  fotoIdx.delete(p.id);
  try { await fotoDelLocal(p.id); } catch (e) { /* egal */ }
  if (m && m.synced) { queueFotoDelete(p.id); saveState(); syncFotos(); }
  renderLabels();
}

/* ---------- Hochladen (offline: bleibt lokal und wird später nachgeholt) ---------- */
async function syncFotos() {
  if (!fotosLoaded || !sharing() || fotoSyncBusy || navigator.onLine === false) return;
  const nb = nbData();
  if (!nb.sent) { scheduleSync(true); return; } // der Garten muss zuerst auf dem Server stehen
  fotoSyncBusy = true;
  let changed = false;
  try {
    for (const pid of (Array.isArray(nb.fotoDel) ? nb.fotoDel.slice() : [])) {
      await backend.delFoto(state.garden.id, nb.token, pid);
      nb.fotoDel = nb.fotoDel.filter((x) => x !== pid);
      changed = true;
    }
    for (const [pid, m] of [...fotoIdx]) {
      if (m.synced || m.local || !fotoFresh(m.day) || !state.garden.plants.some((x) => x.id === pid)) continue;
      const rec = await fotoBild(pid);
      if (!rec || !rec.data) continue;
      await backend.putFoto(state.garden.id, nb.token, pid, m.day, m.mime, rec.data);
      if (fotoIdx.get(pid) !== m) continue; // inzwischen ersetzt: nächste Runde
      m.synced = true;
      await fotoPutMeta(m);
      changed = true;
    }
  } catch (e) {
    if (!fotoHintShown && navigator.onLine !== false && e.status) { fotoHintShown = true; toastLater('Dein Foto bleibt erstmal auf dem Gerät und wird später geteilt.'); }
  } finally {
    fotoSyncBusy = false;
    if (changed) saveState(); // Schnappschuss mit neuen Mini-Bildern teilen
  }
}

/** Für den Schnappschuss: nur geteilte, frische Fotos; Mini-Bilder nur für die neuesten (Budget). */
function fotoSnapshotMap(t) {
  const out = new Map();
  if (!fotosLoaded) return out;
  const ids = new Set(state.garden.plants.map((p) => p.id));
  const list = [...fotoIdx.values()].filter((m) => m.synced && !m.local && ids.has(m.plant) && fotoFresh(m.day, t))
    .sort((a, b) => b.day - a.day);
  let budget = THUMB_BUDGET, n = 0;
  for (const m of list) {
    const f = { d: m.day };
    if (m.thumb && n < THUMB_ANZAHL && m.thumb.length <= budget) { f.t = m.thumb; budget -= m.thumb.length; n++; }
    out.set(m.plant, f);
  }
  return out;
}
function sanitizeFoto(f) {
  if (!f || typeof f !== 'object' || typeof f.d !== 'number' || !isFinite(f.d)) return null;
  const o = { d: Math.round(f.d) };
  if (typeof f.t === 'string' && f.t.length <= 3000 && THUMB_RE.test(f.t)) o.t = f.t;
  return o;
}

/* ---------- Nachbar-Fotos: nur beim Antippen laden, wenige im Speicher ---------- */
async function nbFoto(gid, pid) {
  const key = gid + ':' + pid;
  if (nbFotoCache.has(key)) { const v = nbFotoCache.get(key); nbFotoCache.delete(key); nbFotoCache.set(key, v); return v; }
  const r = await backend.getFoto(gid, pid);
  if (!r || !FOTO_MIMES.includes(r.mime) || typeof r.data !== 'string' || r.data.length > 90000 || !B64_RE.test(r.data)) return null;
  const v = { url: `data:${r.mime};base64,${r.data}`, d: r.day };
  nbFotoCache.set(key, v);
  while (nbFotoCache.size > NB_FOTO_CACHE) nbFotoCache.delete(nbFotoCache.keys().next().value);
  return v;
}
function fotoKeys(plants) { return plants.filter((p) => fotoOf(p)).map((p) => p.id + ':' + p.foto.d + ':' + (p.foto.t ? hashStr(p.foto.t).toString(36) : '')); }
function newFotos(ent, plants) { const seen = new Set(ent.seen || []); return fotoKeys(plants).some((k) => !seen.has(k)); }
function markFotosSeen() {
  if (!view || !view.loaded) return;
  const ent = nbData().list.find((x) => x.id === view.id);
  if (!ent) return;
  const keys = fotoKeys(view.plants);
  if (keys.join() === (ent.seen || []).join()) return;
  ent.seen = keys.slice(0, 60);
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch (e) { /* egal */ }
}

/* ---------- Polaroid groß ---------- */
function openFoto(p) {
  const f = fotoOf(p);
  if (!f) { toast('Dieses Foto ist schon verblüht.'); return; }
  const own = !p.nb, gid = view ? view.id : null;
  let tok = 0, img = null, wrap = null;
  openSheet((b) => {
    b.setAttribute('aria-label', `Foto: ${SPECIES[p.species].name}, ${dayAgo(f.d)}`);
    b.classList.add('foto-blatt');
    img = el('img', { class: 'polaroid-bild', alt: `Foto bei der Pflanze ${SPECIES[p.species].name}` });
    if (f.t) { img.src = f.t; img.classList.add('unscharf'); }
    wrap = el('div', { class: 'polaroid-rahmen lädt' }, img);
    const fig = el('figure', { class: 'polaroid' }, wrap, el('figcaption', null, pixelText(dateText(f.d), 3, true)));
    fig.style.setProperty('--dreh', (((hashStr(p.id + ':' + f.d) % 9) - 4) * 0.6).toFixed(1) + 'deg');
    const cap = el('p', { class: 'polaroid-text' }, `${SPECIES[p.species].name} · ${dayAgo(f.d)}`);
    const zu = el('button', { class: 'knopf leise', type: 'button' }, 'Schließen');
    zu.addEventListener('click', closeSheet);
    const area = el('div', { class: 'reihe' });
    if (own) {
      const showDel = () => {
        const del = el('button', { class: 'knopf', type: 'button' }, 'Foto löschen');
        del.addEventListener('click', () => {
          const yes = el('button', { class: 'knopf gefahr', type: 'button' }, 'Ja, löschen');
          const no = el('button', { class: 'knopf leise', type: 'button' }, 'Behalten');
          yes.addEventListener('click', () => {
            if (yes.dataset.done) return; yes.dataset.done = '1';
            deleteFoto(p); closeSheet(); toast('Foto gelöscht.');
          });
          no.addEventListener('click', showDel);
          area.replaceChildren(el('p', { class: 'frage' }, 'Dieses Foto löschen?'), no, yes);
        });
        area.replaceChildren(zu, del);
      };
      showDel();
    } else area.append(zu);
    b.append(fig, cap, area);
  });
  tok = sheetToken;
  const show = (url) => {
    if (tok !== sheetToken || !img) return;
    img.onload = () => { img.classList.remove('unscharf'); wrap.classList.remove('lädt'); };
    img.src = url;
  };
  const fail = (msg) => { if (tok !== sheetToken || !wrap) return; wrap.classList.remove('lädt'); wrap.classList.add('fehlt'); wrap.dataset.text = msg; };
  if (own) {
    fotoBild(p.id).then((rec) => {
      const m = fotoIdx.get(p.id);
      if (rec && rec.data && m) show(`data:${m.mime};base64,${rec.data}`); else fail('Foto nicht gefunden');
    }).catch(() => fail('Foto nicht gefunden'));
  } else {
    nbFoto(gid, p.id).then((v) => { if (v) show(v.url); else fail('Schon verblüht'); }).catch(() => fail('Gerade offline'));
  }
}

/* ---------- Kleines Polaroid an der Pflanze ---------- */
function fotoPin(s, f) {
  const p = s.p;
  const b = el('button', { class: 'foto-pin', type: 'button', 'aria-label': `Foto ansehen: ${SPECIES[p.species].name}, ${dayAgo(f.d)}` });
  if (f.t) b.append(el('img', { src: f.t, alt: '', width: '20', height: '20' }));
  else b.classList.add('ohne-bild');
  if (f.d < today()) b.classList.add('aelter');
  b.style.left = (s.cx + 11) * PX + 'px';
  b.style.top = (s.base - 9) * PX + 'px';
  b.style.setProperty('--dreh', ((hashStr(p.id) % 2 ? 1 : -1) * (5 + hashStr(p.id) % 5)) + 'deg');
  b.addEventListener('click', (e) => { e.stopPropagation(); openFoto(p); });
  return b;
}

/* ---------- „📸 Nachweis?“ nach dem Gießen – dezent, verschwindet von selbst ---------- */
const nachweis = el('button', { id: 'nachweis', type: 'button', hidden: '' }, '📸 Nachweis?');
let nachweisTimer = 0, nachweisPlant = null;
nachweis.addEventListener('click', () => {
  const p = nachweisPlant;
  hideNachweis();
  if (p && state.garden.plants.includes(p)) fotoStart(p, false);
});
function showNachweis(p) {
  if (view || !blatt.hidden || fotoBusy) return;
  const f = fotoOf(p);
  if (f && f.d === today()) return; // heute schon ein Foto
  const s = slots.find((x) => x.p.id === p.id);
  if (!s) return;
  nachweisPlant = p;
  nachweis.style.left = s.cx * PX + 'px';
  nachweis.style.top = ((s.base + 10) * PX + 34) + 'px';
  nachweis.hidden = false;
  nachweis.classList.remove('weg'); void nachweis.offsetWidth; nachweis.classList.add('da');
  clearTimeout(nachweisTimer);
  nachweisTimer = setTimeout(hideNachweis, 6000);
}
function hideNachweis() {
  clearTimeout(nachweisTimer);
  if (nachweis.hidden) return;
  nachweis.classList.remove('da'); nachweis.classList.add('weg');
  nachweisTimer = setTimeout(() => { nachweis.hidden = true; nachweisPlant = null; }, 300);
}

/* ---------- Testhilfe: buntes Bild ohne Kamera ---------- */
function fakeBild(seed) {
  const R = mulberry32(seed >>> 0);
  const w = 1200, h = 900, cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const c = cv.getContext('2d');
  const hue = Math.floor(R() * 360);
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `hsl(${hue},60%,72%)`); g.addColorStop(1, `hsl(${(hue + 80) % 360},45%,38%)`);
  c.fillStyle = g; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) {
    c.fillStyle = `hsla(${Math.floor(R() * 360)},${50 + R() * 40}%,${40 + R() * 40}%,${0.5 + R() * 0.5})`;
    c.beginPath();
    if (R() < 0.5) c.arc(R() * w, R() * h, 20 + R() * 140, 0, Math.PI * 2);
    else c.rect(R() * w, R() * h, 40 + R() * 260, 30 + R() * 200);
    c.fill();
  }
  c.fillStyle = '#fff6e8'; c.font = 'bold 90px system-ui, sans-serif'; c.fillText('Test ' + ((seed >>> 0) % 100), 60, h - 80);
  return new Promise((res) => cv.toBlob((b) => { cv.width = cv.height = 0; res(b); }, 'image/jpeg', 0.92));
}
/** garten._fakeFoto(pflanzenId?) – füttert das Datei-Feld wie die Kamera. */
async function fakeFoto(pid) {
  const plants = state.garden.plants;
  if (!plants.length) return 'Erst eine Pflanze setzen.';
  const p = plants.find((x) => x.id === pid) || plants.find((x) => { const f = fotoOf(x); return !f || f.d !== today(); }) || plants[0];
  const blob = await fakeBild(Date.now() ^ hashStr(p.id));
  const file = new File([blob], 'test.jpg', { type: 'image/jpeg' });
  fotoTarget = p.id;
  try {
    const dt = new DataTransfer(); dt.items.add(file);
    fotoInput.files = dt.files;
    fotoInput.dispatchEvent(new Event('change'));
  } catch (e) { lastTake = takeFoto(file, p.id); }
  return lastTake;
}

/* ---------- Mock-Backend für Fotos (localStorage, nur Test) ---------- */
function mockFotos() { try { return JSON.parse(localStorage.getItem(MOCK_FOTOS)) || {}; } catch (e) { return {}; } }
function mockFotosSave(db) {
  try { localStorage.setItem(MOCK_FOTOS, JSON.stringify(db)); }
  catch (e) { const er = new Error('voll'); er.status = 507; throw er; }
}
function mockCheckToken(gid, token) {
  const row = mockRead()[gid], h = 'h' + hashStr(token) + '.' + hashStr(token + 'x');
  if (!row || row.token_hash !== h) { const e = new Error('forbidden'); e.status = 403; throw e; }
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
  const raw = localStorage.getItem(STORE);
  state = loadState();
  if (raw && !raw.includes('"schema":2')) saveState(); // 1.0-Daten gleich im neuen Format sichern
  $('titel').append(pixelText('Gewohnheits-Garten', innerWidth < 400 ? 2 : 3));
  $('neu').append(pixelText('+', 5, true));
  $('neu').addEventListener('click', openNew);
  $('leer-neu').addEventListener('click', openNew);
  $('stufe').addEventListener('click', openLevel);
  $('version').textContent = VERSION;
  makeGrain();
  refresh();
  start();
  $('szene').append(nachweis);
  document.body.append(fotoInput);
  setupNeighborhood();
  loadFotos().then(() => { renderLabels(); if (sharing()) syncFotos(); });

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
      $('titel').replaceChildren(titleNode());
      refresh();
      renderNav();
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

window.garten = {
  snapshot: gardenSnapshot, version: VERSION, sprite: previewCanvas,
  // nur für Tests/Debug
  _state: () => state, _simulate: simulateWeeks, _refresh: () => { state = loadState(); refresh(); },
  _setDay: (o) => { dayOffset = o; pendingVis.clear(); refresh(); return today(); },
  _water: (id) => { const p = state.garden.plants.find((x) => x.id === id); const r = water(p); saveState(); return r; },
  _pause: (id) => togglePause(state.garden.plants.find((x) => x.id === id)),
  _cond: (id) => condition(state.garden.plants.find((x) => x.id === id)),
  _draw: () => draw(),
  // Nachbarschaft (Test/Debug)
  _fakeNachbar: fakeNeighbors, _poll: () => pollNow(true), _sync: () => syncNow(true),
  _upload: snapshotForUpload, _nb: () => ({ on: NB_ON, mock: MOCK, profile: MOCK_PROFILE, id: state.garden.id, name: nbData().name, list: nbData().list.slice(), view: view && view.id, idx: viewIdx }),
  _show: (i) => showGarden(i), _invite: inviteLink, _removeNachbar: removeNeighbor,
  // Fotos (1.3)
  _fakeFoto: fakeFoto, _fotoInfo: () => lastFotoInfo, _syncFotos: () => syncFotos(),
  _fotos: () => [...fotoIdx.values()].map((m) => ({ plant: m.plant, day: m.day, mime: m.mime, size: m.size, thumb: m.thumb.length, synced: m.synced, local: m.local })),
  _openFoto: (id) => { const p = vPlants().find((x) => x.id === id); if (p) openFoto(p); }
};
init();
})();
