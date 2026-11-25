// Gewohnheits-Garten – Widget für die App „Scriptable“ (iPhone, gratis im App Store)
// Einrichten:
//   1. In der Garten-App: 🏠 → „Widget einrichten“ → kopiert dieses Skript samt deinem Garten-Code.
//   2. In Scriptable: „+“ → einfügen → oben Namen geben (z. B. „Garten“) → Fertig.
//   3. Home-Bildschirm lange drücken → „+“ → Scriptable → Widget hinzufügen → antippen → Script: Garten.
//   Neue Pflanzen? Einfach Schritt 1–2 wiederholen (oder im Skript ▶ → „Code neu einfügen“).
// Das Widget gießt nie selbst. Ein Tipp auf eine Pflanze öffnet den Garten,
// dort wird erst nach einem Foto gegossen.
// Die Namen deiner Gewohnheiten liegen nur hier im Schlüsselbund des iPhones.

const APP = 'https://blankoleo.github.io/gewohnheitsgarten/';
const SB_URL = 'https://fmzsujdvrjmsgchfkodb.supabase.co';
const SB_KEY = 'sb_publishable_m5qvaWDCBkx6YG9yvI1Bfg_yHLCLCyg'; // öffentlicher Schlüssel, steht auch in der App
const KEY = 'gewohnheitsgarten.widget';

const SPECIES = {
  farn: ['Farn', '#7cb88c'], sonnenblume: ['Sonnenblume', '#f6c458'], kaktus: ['Kaktus', '#ec8caa'],
  kirschbaum: ['Kirschbaum', '#f6b0c4'], monstera: ['Monstera', '#60a078'], mohn: ['Mohn', '#e4403c'],
  kornblume: ['Kornblume', '#5c84ec'], lavendel: ['Lavendel', '#9c78d6']
};
const C = { bg1: '#2b2238', bg2: '#3d2f4a', text: '#f6ead8', dim: '#b8a8b8', ok: '#9ed39a', durst: '#f4c06a', welk: '#e8907a' };

/* ---------- Einrichtung ---------- */
function loadSetup() {
  if (!Keychain.contains(KEY)) return null;
  try { return JSON.parse(Keychain.get(KEY)); } catch (e) { return null; }
}
function parseCode(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/GARTEN1:([A-Za-z0-9+/=_-]+)/);
  if (!m) return null;
  try {
    // Der Code ist reines ASCII (Umlaute als \uXXXX im JSON), daher ist die Dekodierung eindeutig.
    const json = Data.fromBase64String(m[1].replace(/-/g, '+').replace(/_/g, '/')).toRawString();
    const o = JSON.parse(json);
    if (!/^[0-9a-f-]{36}$/i.test(o.id)) return null;
    return { id: o.id.toLowerCase(), names: o.n || {} };
  } catch (e) { return null; }
}
async function setup() {
  const a = new Alert();
  a.title = 'Gewohnheits-Garten';
  a.message = 'Füge den Code aus der Garten-App ein (🏠 → „Widget einrichten“).';
  a.addTextField('GARTEN1:…', Pasteboard.paste() || '');
  a.addAction('Speichern');
  a.addCancelAction('Abbrechen');
  if ((await a.present()) === -1) return null;
  const cfg = parseCode(a.textFieldValue(0));
  const done = new Alert();
  if (!cfg) { done.title = 'Das ist kein Garten-Code.'; done.message = 'Kopiere ihn in der App nochmal und versuch es erneut.'; done.addAction('OK'); await done.present(); return null; }
  Keychain.set(KEY, JSON.stringify(cfg));
  done.title = 'Fertig 🌱';
  done.message = `${Object.keys(cfg.names).length} Pflanzen erkannt. Jetzt das Widget auf den Home-Bildschirm legen.`;
  done.addAction('OK');
  await done.present();
  return cfg;
}

/* ---------- Garten laden (wie bei den Nachbarn: nur lesen) ---------- */
async function fetchGarden(id) {
  const r = new Request(`${SB_URL}/rest/v1/rpc/get_gardens`);
  r.method = 'POST';
  r.headers = { apikey: SB_KEY, 'Content-Type': 'application/json', Accept: 'application/json' }; // sb_publishable: nur als apikey
  r.body = JSON.stringify({ p_ids: [id] });
  r.timeoutInterval = 15;
  const rows = await r.loadJSON();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
const CACHE = FileManager.local().joinPath(FileManager.local().documentsDirectory(), 'gewohnheitsgarten-cache.json');
async function gardenOrCache(id) {
  const fm = FileManager.local();
  try {
    const g = await fetchGarden(id);
    if (g) fm.writeString(CACHE, JSON.stringify(g));
    return g;
  } catch (e) {
    return fm.fileExists(CACHE) ? JSON.parse(fm.readString(CACHE)) : null;
  }
}

/* ---------- Zustand wie in der App berechnen (Stand: heute, nicht vom letzten Hochladen) ---------- */
const dayNumber = (d) => Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
const weekday = (t) => ((t + 3) % 7 + 7) % 7;
const grace = (g) => g >= 7 ? 1 : Math.ceil(7 / g) + 1;
const wiltSpan = (g) => g >= 7 ? 3 : Math.max(3, Math.ceil(7 / g));
function status(p, t) {
  if (p.paused) return 'pause';
  if (p.last != null && p.last >= t) return 'ok';
  const w0 = t - weekday(t);
  const week = (p.days || []).filter((d) => d >= w0 && d <= t).length;
  if (p.goal < 7 && week >= p.goal) return 'woche';
  let ref = p.last != null ? p.last : (p.planted || t) - 1;
  if (p.resume != null) ref = Math.max(ref, p.resume - 1);
  const o = (t - ref) - grace(p.goal);
  if (o >= wiltSpan(p.goal)) return 'welk';
  if (o > 0) return 'haengt';
  return 'durst';
}
const LABEL = { ok: '✓ gegossen', woche: '✓ Woche geschafft', pause: 'Pause', durst: '💧 heute dran', haengt: '💧 hängt', welk: '💧 welk' };
const COLOR = { ok: C.ok, woche: C.ok, pause: C.dim, durst: C.durst, haengt: C.durst, welk: C.welk };
const order = { welk: 0, haengt: 1, durst: 2, ok: 3, woche: 4, pause: 5 };

/* ---------- Widget bauen ---------- */
function base() {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [new Color(C.bg1), new Color(C.bg2)];
  g.locations = [0, 1];
  w.backgroundGradient = g;
  w.setPadding(12, 14, 12, 14);
  w.url = APP;
  w.refreshAfterDate = new Date(Date.now() + 20 * 60 * 1000);
  return w;
}
function text(stack, s, size, color, bold) {
  const t = stack.addText(s);
  t.font = bold ? Font.boldRoundedSystemFont(size) : Font.roundedSystemFont(size);
  t.textColor = new Color(color);
  t.lineLimit = 1;
  return t;
}
function message(title, sub) {
  const w = base();
  text(w, '🌱 Garten', 13, C.dim, true);
  w.addSpacer();
  text(w, title, 15, C.text, true).lineLimit = 2;
  if (sub) { w.addSpacer(4); text(w, sub, 11, C.dim).lineLimit = 3; }
  return w;
}

function build(cfg, row, family) {
  const t = dayNumber(new Date());
  const plants = ((row.snapshot && row.snapshot.plants) || []).filter((p) => p && p.id && SPECIES[p.species]);
  if (!plants.length) return message('Noch keine Pflanzen geteilt.', 'Öffne den Garten einmal, dann erscheinen sie hier.');
  const list = plants.map((p) => ({ p, s: status(p, t), name: cfg.names[p.id] || SPECIES[p.species][0] }))
    .sort((a, b) => order[a.s] - order[b.s]);
  const done = list.filter((x) => x.s === 'ok' || x.s === 'woche' || x.s === 'pause').length;

  const w = base();
  const head = w.addStack();
  head.centerAlignContent();
  text(head, '🌱 Garten', 13, C.dim, true);
  head.addSpacer();
  text(head, `${done}/${list.length}`, 13, done === list.length ? C.ok : C.durst, true);
  w.addSpacer(family === 'small' ? 6 : 8);

  const max = family === 'small' ? 4 : family === 'large' ? 11 : 4;
  const shown = family === 'small' ? list.filter((x) => order[x.s] <= 2).slice(0, max) : list.slice(0, max);
  if (family === 'small' && !shown.length) {
    w.addSpacer();
    text(w, 'Alles gegossen ✨', 15, C.ok, true).lineLimit = 2;
    w.addSpacer();
    return w;
  }
  for (const x of shown) {
    const r = w.addStack();
    r.centerAlignContent();
    r.spacing = 6;
    // Tipp öffnet den Garten mit Foto-Pflicht – gegossen wird erst dort
    if (family !== 'small') r.url = `${APP}?giessen=${encodeURIComponent(x.p.id)}`;
    const dot = r.addStack();
    dot.size = new Size(9, 9);
    dot.cornerRadius = 2; // eckig, wie Pixel
    dot.backgroundColor = new Color(SPECIES[x.p.species][1]);
    text(r, x.name, family === 'small' ? 12 : 13, C.text, order[x.s] <= 2);
    r.addSpacer();
    if (family !== 'small') text(r, x.s === 'durst' && x.p.goal < 7 ? '💧 diese Woche' : LABEL[x.s], 11, COLOR[x.s]);
    w.addSpacer(family === 'large' ? 6 : 3);
  }
  const rest = (family === 'small' ? list.filter((x) => order[x.s] <= 2).length : list.length) - shown.length;
  if (rest > 0) text(w, `+ ${rest} weitere`, 10, C.dim);
  w.addSpacer();
  return w;
}

/* ---------- Start ---------- */
// GARTEN_CODE wird von der App beim Kopieren oben eingefügt (eigener Garten + Pflanzennamen).
const EINGEBAUT = typeof GARTEN_CODE !== 'undefined' ? GARTEN_CODE : '';
let cfg = parseCode(EINGEBAUT) || loadSetup(); // frisch kopierter Code gewinnt (neue Pflanzennamen)
if (config.runsInApp && !config.runsInWidget) {
  const a = new Alert();
  a.title = 'Gewohnheits-Garten';
  a.message = cfg ? 'Widget ist eingerichtet.' : 'Noch nicht eingerichtet.';
  a.addAction(cfg ? 'Code neu einfügen' : 'Code einfügen');
  if (cfg) a.addAction('Vorschau');
  a.addCancelAction('Fertig');
  const i = await a.present();
  if (i === 0) cfg = await setup();
  if (i === 1 || (i === 0 && cfg)) {
    const row = cfg ? await gardenOrCache(cfg.id) : null;
    const w = row ? build(cfg, row, 'medium') : message('Garten nicht gefunden.', 'Ist er mit der Nachbarschaft verbunden?');
    await w.presentMedium();
  }
  Script.complete();
} else {
  const family = config.widgetFamily || 'medium';
  let w;
  if (!cfg) w = message('Tippen zum Einrichten', 'Öffne dieses Skript einmal in Scriptable.');
  else {
    const row = await gardenOrCache(cfg.id);
    w = row ? build(cfg, row, family) : message('Garten nicht erreichbar.', 'Öffne den Garten einmal und teile ihn mit den Nachbarn.');
  }
  if (!cfg) w.url = URLScheme.forRunningScript();
  Script.setWidget(w);
  Script.complete();
}
