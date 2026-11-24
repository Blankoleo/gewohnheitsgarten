/* Gewohnheits-Garten – Konfiguration für die Nachbarschaft (1.2).
   Beide Werte stehen in Supabase unter Project Settings → API (bzw. „Connect“):
     supabaseUrl      Project URL, z. B. 'https://abcdefghijklmnop.supabase.co'
     supabaseAnonKey  der öffentliche Schlüssel: „anon public“ (eyJ…) oder „publishable“ (sb_publishable_…)
   NIE den service_role- bzw. secret-Schlüssel eintragen!
   Bleiben beide leer, ist die Nachbarschaft ausgeblendet und die App läuft wie 1.1. */
window.GARTEN_CONFIG = { supabaseUrl: '', supabaseAnonKey: '' };
