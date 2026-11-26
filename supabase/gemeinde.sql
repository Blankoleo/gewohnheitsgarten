-- Gewohnheits-Garten 2.0 „Gemeinde“ – Supabase-Ergänzung (nach schema.sql, fotos.sql, konten.sql)
-- In Supabase → SQL Editor → „New query“ komplett einfügen und „Run“ drücken.
-- Kann gefahrlos mehrmals ausgeführt werden. Löscht keine Daten.
--
-- Idee:
--   * Ohne Konto kein Garten. Ein Konto anlegen geht nur mit dem Gemeinde-Code.
--   * Alle Konten sind automatisch in derselben Gemeinde und sehen sich gegenseitig am Zaun.
--
-- Sicherheit (wie bei gardens/accounts):
--   * Tabelle community ist für anon/authenticated komplett gesperrt (RLS an, keine Policies, keine Rechte).
--   * Der Code steht NIE im Repo (das ist öffentlich!). Er liegt nur in community:
--       code_hash  bcrypt-Hash, damit prüft account_register
--       code       Klartext, damit angemeldete Mitglieder ihn in der App sehen und weitergeben können
--     Code per Dashboard setzen bzw. ändern (SQL Editor, <CODE> ersetzen, NICHT hier speichern).
--     Klein geschrieben speichern (lower), denn die App und account_register vergleichen klein geschrieben:
--       insert into public.community (id, code_hash, code)
--       values (1, extensions.crypt(lower('<CODE>'), extensions.gen_salt('bf', 8)), lower('<CODE>'))
--       on conflict (id) do update set code_hash = excluded.code_hash, code = excluded.code;
--   * account_register(p_user, p_pw, p_state, p_code): falscher Code -> errcode GG002, vorher 1 s Pause
--     (bremst Durchprobieren). Die alte Variante ohne Code (1.6/1.7) wird gelöscht.
--   * community_gardens(p_user, p_token): alle Konten-Gärten außer dem eigenen, nur mit gültigem Konto-Token
--     (Prüfung wie account_pull). Ein Garten zählt nur, wenn sein Token-Hash zu dem des Kontos passt –
--     niemand kann einen fremden Garten in sein Konto „einhängen“. Gärten ohne Konto erscheinen nicht.
--   * community_code(p_user, p_token): der Code im Klartext – ebenfalls nur mit gültigem Konto-Token.
--   * Bestehende Konten bleiben gültig und sind automatisch Mitglieder.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.community (
  id         int  primary key check (id = 1),
  code_hash  text not null,
  code       text not null check (char_length(code) <= 64)
);
alter table public.community enable row level security;
-- Absichtlich KEINE Policies.
revoke all on table public.community from public, anon, authenticated;

-- Konto + Token prüfen: Benutzername oder null
create or replace function public._acct_ok(p_user text, p_token text)
returns text
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  select a.username
  from public.accounts a
  where a.username = public._acct_name(p_user)
    and p_token is not null and char_length(p_token) between 32 and 128
    and a.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;
revoke all on function public._acct_ok(text, text) from public, anon, authenticated;

-- Anlegen nur mit Gemeinde-Code. Name vergeben -> GG001, Code falsch -> GG002.
drop function if exists public.account_register(text, text, jsonb);
create or replace function public.account_register(p_user text, p_pw text, p_state jsonb, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  v_hash text;
  v_tok  text;
begin
  -- zuerst der Code: Wer ihn nicht kennt, erfährt auch nicht, ob ein Name vergeben ist
  select c.code_hash into v_hash from public.community c where c.id = 1;
  if v_hash is null or p_code is null or char_length(p_code) > 64
     or extensions.crypt(lower(btrim(p_code)), v_hash) <> v_hash then
    perform pg_sleep(1);
    raise exception 'gemeinde-code falsch' using errcode = 'GG002';
  end if;
  if v_user !~ '^[a-z0-9_.äöüß-]{3,24}$' then
    raise exception 'name ungueltig' using errcode = '22023';
  end if;
  if p_pw is null or char_length(p_pw) < 6 or char_length(p_pw) > 72 then
    raise exception 'passwort zu kurz' using errcode = '22023';
  end if;
  perform public._acct_check_state(p_state);
  v_tok := public._acct_token(p_state);
  begin
    insert into public.accounts (username, pw_hash, token_hash, state, state_rev)
    values (v_user, extensions.crypt(p_pw, extensions.gen_salt('bf', 8)),
            encode(sha256(convert_to(v_tok, 'UTF8')), 'hex'), p_state, 1);
  exception when unique_violation then
    raise exception 'name vergeben' using errcode = 'GG001';
  end;
  return jsonb_build_object('ok', true, 'user', v_user, 'rev', 1);
end;
$$;

-- Alle Gärten der Gemeinde (außer dem eigenen), älteste Konten zuerst
create or replace function public.community_gardens(p_user text, p_token text)
returns table (id uuid, name text, snapshot jsonb, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
declare
  v_user text := public._acct_ok(p_user, p_token);
begin
  if v_user is null then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  return query
    select g.id, coalesce(nullif(g.name, ''), a.username), g.snapshot, g.updated_at
    from public.accounts a
    join public.gardens g
      on g.id = case when (a.state #>> '{garden,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (a.state #>> '{garden,id}')::uuid end
     and g.token_hash = a.token_hash
    where a.username <> v_user
    order by a.created_at, a.username
    limit 100;
end;
$$;

-- Gemeinde-Code zum Weitergeben – nur für Mitglieder
create or replace function public.community_code(p_user text, p_token text)
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if public._acct_ok(p_user, p_token) is null then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  return (select c.code from public.community c where c.id = 1);
end;
$$;

-- Rechte: nur die drei öffentlichen Funktionen, nur für anon/authenticated
revoke all on function public.account_register(text, text, jsonb, text) from public, anon, authenticated;
revoke all on function public.community_gardens(text, text) from public, anon, authenticated;
revoke all on function public.community_code(text, text) from public, anon, authenticated;
grant execute on function public.account_register(text, text, jsonb, text) to anon, authenticated;
grant execute on function public.community_gardens(text, text) to anon, authenticated;
grant execute on function public.community_code(text, text) to anon, authenticated;

notify pgrst, 'reload schema';
