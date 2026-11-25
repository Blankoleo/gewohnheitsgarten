-- Gewohnheits-Garten 1.6 „Konto“ – Supabase-Ergänzung (seit 2.0 danach gemeinde.sql ausführen)
-- Ein simples Konto aus Name + Passwort (ohne E-Mail), damit der Garten auf allen Geräten derselbe ist.
-- In Supabase → SQL Editor → „New query“ komplett einfügen und „Run“ drücken.
-- Kann gefahrlos mehrmals ausgeführt werden. Ändert nichts an gardens/photos.
--
-- Sicherheitsidee (wie bei gardens):
--   * Tabelle accounts ist für anon/authenticated komplett gesperrt (RLS an, keine Policies, keine Rechte).
--   * Passwort nur als bcrypt-Hash (pgcrypto, crypt + gen_salt('bf', 8)). Kein Zurücksetzen möglich.
--   * Anmelden (account_login) zählt Fehlversuche: nach 5 Fehlern 5 Minuten gesperrt.
--     (Ergebnis als jsonb statt Fehler, damit der Zähler nicht mit der Transaktion zurückgerollt wird.)
--   * Danach arbeiten die Geräte mit dem geheimen Garten-Token (state.privat.nb.token, 64 Hex-Zeichen):
--     account_save / account_pull prüfen SHA-256(Token) gegen token_hash. Alle Geräte eines Kontos teilen
--     dadurch Garten-ID + Token, upsert_garden/upsert_photo klappen von überall.
--   * state höchstens 200 KB, state_rev zählt jede Speicherung hoch (Konflikterkennung).

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.accounts (
  username      text        primary key check (username ~ '^[a-z0-9_.äöüß-]{3,24}$'),
  pw_hash       text        not null,
  token_hash    text        not null check (char_length(token_hash) = 64),
  state         jsonb       not null default '{}'::jsonb check (octet_length(state::text) <= 204800),
  state_rev     bigint      not null default 1,
  fails         int         not null default 0,
  locked_until  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.accounts enable row level security;
-- Absichtlich KEINE Policies.
revoke all on table public.accounts from public, anon, authenticated;

-- Name normalisieren: klein, ohne Rand-Leerzeichen
create or replace function public._acct_name(p_user text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select lower(btrim(coalesce(p_user, ''))) $$;
revoke all on function public._acct_name(text) from public, anon, authenticated;

-- Token aus dem Garten-Stand lesen und prüfen
create or replace function public._acct_token(p_state jsonb)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare v text;
begin
  v := p_state #>> '{privat,nb,token}';
  if v is null or char_length(v) < 32 or char_length(v) > 128 then
    raise exception 'token im garten fehlt' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function public._acct_token(jsonb) from public, anon, authenticated;

create or replace function public._acct_check_state(p_state jsonb)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_state is null or jsonb_typeof(p_state) <> 'object'
     or jsonb_typeof(p_state -> 'garden') <> 'object' or octet_length(p_state::text) > 204800 then
    raise exception 'garten ungueltig oder groesser als 200 KB' using errcode = '22023';
  end if;
end;
$$;
revoke all on function public._acct_check_state(jsonb) from public, anon, authenticated;

-- Anlegen (account_register): seit 2.0 in gemeinde.sql – nur noch mit Gemeinde-Code.
-- Die alte Variante ohne Code wird hier bewusst nicht mehr angelegt (und in gemeinde.sql gelöscht).

-- Anmelden: {ok:true, user, rev, state} oder {ok:false, error:'falsch'|'gesperrt', wait:Sekunden}
create or replace function public.account_login(p_user text, p_pw text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  a      public.accounts%rowtype;
begin
  select * into a from public.accounts where username = v_user for update;
  if not found then
    perform extensions.crypt(coalesce(p_pw, ''), extensions.gen_salt('bf', 8)); -- gleiche Dauer
    return jsonb_build_object('ok', false, 'error', 'falsch');
  end if;
  if a.locked_until is not null and a.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'gesperrt',
      'wait', ceil(extract(epoch from a.locked_until - now()))::int);
  end if;
  if p_pw is null or extensions.crypt(p_pw, a.pw_hash) <> a.pw_hash then
    update public.accounts
      set fails = case when a.fails + 1 >= 5 then 0 else a.fails + 1 end,
          locked_until = case when a.fails + 1 >= 5 then now() + interval '5 minutes' else null end
      where username = v_user;
    if a.fails + 1 >= 5 then
      return jsonb_build_object('ok', false, 'error', 'gesperrt', 'wait', 300);
    end if;
    return jsonb_build_object('ok', false, 'error', 'falsch');
  end if;
  update public.accounts set fails = 0, locked_until = null where username = v_user;
  return jsonb_build_object('ok', true, 'user', a.username, 'rev', a.state_rev, 'state', a.state);
end;
$$;

-- Speichern mit Token. p_base_rev = Revision, auf der das Gerät aufbaut.
-- {ok:true, rev} oder bei veraltetem Stand {ok:false, conflict:true, rev, state} (Gerät führt zusammen).
-- Falsches Token -> Fehler 42501.
create or replace function public.account_save(p_user text, p_token text, p_state jsonb, p_base_rev bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  a      public.accounts%rowtype;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'token ungueltig' using errcode = '22023';
  end if;
  perform public._acct_check_state(p_state);
  if public._acct_token(p_state) <> p_token then
    raise exception 'token passt nicht zum garten' using errcode = '22023';
  end if;
  select * into a from public.accounts
    where username = v_user and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    for update;
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  if p_base_rev is distinct from a.state_rev then
    return jsonb_build_object('ok', false, 'conflict', true, 'rev', a.state_rev, 'state', a.state);
  end if;
  update public.accounts set state = p_state, state_rev = a.state_rev + 1, updated_at = now()
    where username = v_user;
  return jsonb_build_object('ok', true, 'rev', a.state_rev + 1);
end;
$$;

-- Neueren Stand holen: {ok:true, rev, state?} – state nur, wenn rev > p_have_rev.
create or replace function public.account_pull(p_user text, p_token text, p_have_rev bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  a      public.accounts%rowtype;
begin
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'token ungueltig' using errcode = '22023';
  end if;
  select * into a from public.accounts
    where username = v_user and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  if p_have_rev is not null and a.state_rev <= p_have_rev then
    return jsonb_build_object('ok', true, 'rev', a.state_rev);
  end if;
  return jsonb_build_object('ok', true, 'rev', a.state_rev, 'state', a.state);
end;
$$;

-- Passwort ändern (altes Passwort nötig, zählt Fehlversuche wie login)
create or replace function public.account_change_pw(p_user text, p_old text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  r      jsonb;
begin
  if p_new is null or char_length(p_new) < 6 or char_length(p_new) > 72 then
    raise exception 'passwort zu kurz' using errcode = '22023';
  end if;
  r := public.account_login(p_user, p_old);
  if not (r ->> 'ok')::boolean then
    return r - 'state';
  end if;
  update public.accounts set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 8))
    where username = v_user;
  return jsonb_build_object('ok', true);
end;
$$;

-- Rechte: nur die vier öffentlichen Funktionen (account_register: gemeinde.sql), nur für anon/authenticated
revoke all on function public.account_login(text, text) from public, anon, authenticated;
revoke all on function public.account_save(text, text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.account_pull(text, text, bigint) from public, anon, authenticated;
revoke all on function public.account_change_pw(text, text, text) from public, anon, authenticated;
grant execute on function public.account_login(text, text) to anon, authenticated;
grant execute on function public.account_save(text, text, jsonb, bigint) to anon, authenticated;
grant execute on function public.account_pull(text, text, bigint) to anon, authenticated;
grant execute on function public.account_change_pw(text, text, text) to anon, authenticated;

notify pgrst, 'reload schema';
