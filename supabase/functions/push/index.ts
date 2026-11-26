// Gewohnheits-Garten 2.1 – Edge Function „push“ (Supabase, Deno). Verify JWT: AUS.
// Im Dashboard unter Edge Functions → „push“ mit diesem Code anlegen. Keine Secrets nötig:
//   * Hook-Secret und VAPID-Schlüssel liegen in der gesperrten Tabelle public.push_config
//     (das Secret erzeugt herzen.sql, das VAPID-Paar erzeugt diese Function beim ersten Aufruf selbst).
//   * Gelesen wird mit SUPABASE_SERVICE_ROLE_KEY, den Supabase automatisch als Umgebungsvariable setzt.
// GET  -> { publicKey }  (öffentlicher VAPID-Schlüssel, für config.js)
// POST -> nur mit Header x-hook-secret (kommt aus der Datenbank per pg_net):
//         { subs: [{ endpoint, keys: { p256dh, auth } }], msg: { title, body, tag, url } }
//         Verschickt Web-Push (VAPID + aes128gcm), löscht abgelaufene Abos (404/410).
import webpush from 'npm:web-push@3.6.7';

const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';
// service_role (alter JWT) oder – bei neuen API-Schlüsseln – der erste sb_secret-Schlüssel
function serviceKey(): string {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try { return Object.values(JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'))[0] as string ?? ''; } catch { return ''; }
}
const SRK = serviceKey();
const SUBJECT = 'mailto:garten@blankoleo.github.io';
const ALLOWED = /^https:\/\/(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\//;
const CORS = { 'Access-Control-Allow-Origin': '*' };

type Cfg = { secret: string; vapid_public: string | null; vapid_private: string | null };
let cfg: Cfg | null = null;

const rest = (path: string, init: RequestInit = {}) => fetch(`${SB_URL}/rest/v1/${path}`, {
  ...init,
  headers: { apikey: SRK, ...(SRK.startsWith('eyJ') ? { Authorization: `Bearer ${SRK}` } : {}), 'Content-Type': 'application/json', ...(init.headers ?? {}) },
});

const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function loadCfg(): Promise<Cfg> {
  if (cfg && cfg.vapid_public) return cfg;
  const r = await rest('push_config?id=eq.1&select=secret,vapid_public,vapid_private');
  if (!r.ok) throw new Error('config ' + r.status);
  const row = (await r.json())[0] as Cfg | undefined;
  if (!row) throw new Error('config fehlt');
  if (!row.vapid_public || !row.vapid_private) {
    // Erstes Mal: eigenes VAPID-Paar (P-256) erzeugen und nur in push_config speichern
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = new Uint8Array(65);
    pub[0] = 4; pub.set(unb64u(jwk.x!), 1); pub.set(unb64u(jwk.y!), 33);
    const upd = await rest('push_config?id=eq.1&vapid_public=is.null', {
      method: 'PATCH', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ vapid_public: b64u(pub), vapid_private: jwk.d }),
    });
    if (!upd.ok) throw new Error('vapid speichern ' + upd.status);
    cfg = null;
    return loadCfg(); // nochmal lesen (falls ein paralleler Aufruf schneller war)
  }
  cfg = row;
  return row;
}

function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  try {
    const c = await loadCfg();
    if (req.method === 'GET') return json({ publicKey: c.vapid_public });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    if (!sameSecret(req.headers.get('x-hook-secret') ?? '', c.secret)) return json({ error: 'forbidden' }, 401);

    const { subs, msg } = await req.json();
    const list = (Array.isArray(subs) ? subs : []).filter((s) =>
      s && typeof s.endpoint === 'string' && ALLOWED.test(s.endpoint) && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string'
    ).slice(0, 300);
    const payload = JSON.stringify({
      title: clip(msg?.title, 80) || 'Gewohnheits-Garten',
      body: clip(msg?.body, 160),
      tag: clip(msg?.tag, 80) || 'garten',
      url: /^\.\/(\?[A-Za-z0-9=._&-]*)?$/.test(String(msg?.url ?? '')) ? msg.url : './',
    });
    webpush.setVapidDetails(SUBJECT, c.vapid_public!, c.vapid_private!);
    let sent = 0;
    const dead: string[] = [], errors: string[] = [];
    await Promise.all(list.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, payload, { TTL: 86400, urgency: 'normal' });
        sent++;
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.endpoint);
        else errors.push(String(code ?? (e as Error).message).slice(0, 120));
      }
    }));
    for (const ep of dead) await rest(`push_subs?endpoint=eq.${encodeURIComponent(ep)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    console.log(JSON.stringify({ sent, removed: dead.length, errors }));
    return json({ sent, removed: dead.length, errors });
  } catch (e) {
    console.error('push', (e as Error).message);
    return json({ error: 'intern' }, 500);
  }
});
