/* Gewohnheits-Garten – Konfiguration für die Nachbarschaft (1.2).
   Beide Werte stehen in Supabase unter Project Settings → API (bzw. „Connect“):
     supabaseUrl      Project URL, z. B. 'https://abcdefghijklmnop.supabase.co'
     supabaseAnonKey  der öffentliche Schlüssel: „anon public“ (eyJ…) oder „publishable“ (sb_publishable_…)
   NIE den service_role- bzw. secret-Schlüssel eintragen!
   vapidPublicKey   (2.1) öffentlicher Schlüssel für Push-Mitteilungen – liefert die Edge Function „push“ per GET.
                    Der private Schlüssel liegt nur in Supabase (Tabelle push_config), nie hier.
   Bleiben beide leer, ist die Nachbarschaft ausgeblendet und die App läuft wie 1.1. */
window.GARTEN_CONFIG = { supabaseUrl: 'https://fmzsujdvrjmsgchfkodb.supabase.co', supabaseAnonKey: 'sb_publishable_m5qvaWDCBkx6YG9yvI1Bfg_yHLCLCyg',
  vapidPublicKey: 'BA2WKp4n2us_IS6b7utDQN5O2BYT295QLLkSWoX_g7Io5aBDSVPV9GZ262gDVX-Au9QLjXjxBjnDVFmwxwhj5fI' };
