-- Gewohnheits-Garten 1.2 „Nachbarschaft“ – Supabase-Schema
-- Einmal komplett in Supabase → SQL Editor → „New query“ einfügen und „Run“ drücken.
-- Kann gefahrlos mehrmals ausgeführt werden.
--
-- Sicherheitsidee:
--   * Die Tabelle ist für anon/authenticated komplett gesperrt (RLS an, keine Policies, keine Rechte).
--   * Lesen nur über get_gardens(ids): Wer eine Garten-ID kennt (aus dem Einladungslink), sieht diesen
--     Garten. Eine Liste aller Gärten gibt es nicht.
--   * Schreiben nur über upsert_garden(...): Beim ersten Hochladen wird ein SHA-256-Hash des geheimen
--     Geräte-Tokens gespeichert; danach darf nur schreiben, wer dasselbe Token schickt.
--   * Snapshot höchstens 20 KB, Name höchstens 40 Zeichen.

create table if not exists public.gardens (
  id          uuid primary key,
  token_hash  text        not null check (char_length(token_hash) = 64),
  name        text        not null default '' check (char_length(name) <= 40),
  snapshot    jsonb       not null default '{}'::jsonb check (octet_length(snapshot::text) <= 20480),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.gardens enable row level security;
-- Absichtlich KEINE Policies: ohne Policy sieht/ändert anon über die REST-API nichts direkt.
revoke all on table public.gardens from public, anon, authenticated;

-- Schreiben (anlegen oder aktualisieren) – nur mit passendem Token
create or replace function public.upsert_garden(p_id uuid, p_token text, p_name text, p_snapshot jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text;
  v_name text;
  v_at   timestamptz;
begin
  if p_id is null then
    raise exception 'id fehlt' using errcode = '22023';
  end if;
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'token ungueltig' using errcode = '22023';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or octet_length(p_snapshot::text) > 20480 then
    raise exception 'snapshot ungueltig oder groesser als 20 KB' using errcode = '22023';
  end if;
  v_name := left(btrim(coalesce(p_name, '')), 40);
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');

  insert into public.gardens as g (id, token_hash, name, snapshot, updated_at)
  values (p_id, v_hash, v_name, p_snapshot, now())
  on conflict (id) do update
    set name = excluded.name,
        snapshot = excluded.snapshot,
        updated_at = now()
    where g.token_hash = excluded.token_hash
  returning g.updated_at into v_at;

  if v_at is null then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  return v_at;
end;
$$;

-- Lesen – nur Gärten, deren IDs man kennt (höchstens 50 auf einmal), ohne Token-Hash
create or replace function public.get_gardens(p_ids uuid[])
returns table (id uuid, name text, snapshot jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.id, g.name, g.snapshot, g.updated_at
  from public.gardens g
  where g.id = any (p_ids[1:50]);
$$;

-- Rechte: Funktionen dürfen anon (die App) und authenticated aufrufen, sonst niemand
revoke all on function public.upsert_garden(uuid, text, text, jsonb) from public;
revoke all on function public.get_gardens(uuid[]) from public;
grant execute on function public.upsert_garden(uuid, text, text, jsonb) to anon, authenticated;
grant execute on function public.get_gardens(uuid[]) to anon, authenticated;

-- PostgREST die neuen Funktionen sofort bekannt machen
notify pgrst, 'reload schema';
