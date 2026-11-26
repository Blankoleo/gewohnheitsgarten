-- Gewohnheits-Garten 2.3 „Stabil“ – Supabase-Ergänzung (nach schema.sql, fotos.sql, konten.sql, gemeinde.sql, herzen.sql)
-- In Supabase → SQL Editor → „New query“ komplett einfügen und „Run“ drücken.
-- Kann gefahrlos mehrmals ausgeführt werden. Löscht keine Gärten, Fotos oder Konten.
-- Alte App-Versionen laufen weiter: Signaturen bleiben gleich, Neues kommt als neue Funktion daneben.
--
-- Inhalt:
--   * _garten_tag(): Tag wie in der App (Berlin, Wechsel um 3 Uhr) – für Foto-Frische statt current_date.
--   * get_photo2: Fotos nur noch mit Konto (get_photo wird ganz unten für anon/authenticated entzogen).
--   * get_gardens (Widget, ohne Konto): nur noch Pflanzenzustand – ohne Gartenname, Gewohnheitsnamen, Mini-Bilder.
--   * upsert_garden/upsert_photo: Neu anlegen bzw. Fotos nur mit einem Token, das zu einem Konto gehört.
--   * account_register: Gemeinde-Code-Fehlversuche werden gezählt (alle zusammen höchstens 20 pro Stunde,
--     danach GG003). Statt raise antwortet die Funktion mit HTTP 400 + {code:'GG002'} (response.status),
--     damit der Zähler gespeichert wird – alte Apps sehen dieselbe Fehlermeldung wie bisher.
--   * account_login: Sperre wächst mit jeder Sperre (5, 15, 60, 240, 1440 Minuten), zurück erst nach Erfolg.
--     Neue Passwörter brauchen mindestens 8 Zeichen.
--   * Token: liegt nicht mehr im Klartext in accounts.state, sondern mit dem Passwort verschlüsselt in token_enc
--     (alte Konten: beim nächsten Anmelden). account_login/-pull/-save geben den state wie bisher MIT Token zurück.
--     account_change_pw erneuert dabei das Token (Konto + Garten) und gibt {ok, token} zurück.
--   * _rate mit pg_advisory_xact_lock (gleichzeitige Aufrufe zählen richtig).
--   * community_changes(p_user, p_token, p_since): nur geänderte Gärten seit p_since (Server-Zeit) + alle IDs.

create extension if not exists pgcrypto with schema extensions;

/* ---------------------------------------------------------------- Tabellen/Spalten */
alter table public.accounts add column if not exists token_enc bytea;
alter table public.accounts add column if not exists lock_level int not null default 0;

create table if not exists public.register_fails (
  at timestamptz not null default now()
);
create index if not exists register_fails_at_idx on public.register_fails (at);
alter table public.register_fails enable row level security;
revoke all on table public.register_fails from public, anon, authenticated;

/* ---------------------------------------------------------------- Hilfen (nicht öffentlich) */
create or replace function public._garten_tag()
returns date
language sql
stable
set search_path = public, pg_temp
as $$ select ((now() at time zone 'Europe/Berlin') - interval '3 hours')::date $$;

-- state mit Token (privat.nb.token) zurückgeben – so, wie die App ihn erwartet
create or replace function public._acct_with_token(p_state jsonb, p_tok text)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p_tok is null or p_state is null or jsonb_typeof(p_state) <> 'object' then p_state
    else jsonb_set(
           jsonb_set(
             jsonb_set(p_state, '{privat}',
               coalesce(case when jsonb_typeof(p_state -> 'privat') = 'object' then p_state -> 'privat' end, '{}'::jsonb), true),
             '{privat,nb}',
             coalesce(case when jsonb_typeof(p_state #> '{privat,nb}') = 'object' then p_state #> '{privat,nb}' end, '{}'::jsonb), true),
           '{privat,nb,token}', to_jsonb(p_tok), true) end
$$;

create or replace function public._tok_hash(p_tok text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$ select encode(sha256(convert_to(p_tok, 'UTF8')), 'hex') $$;

-- Zählt eine Aktion; zu viele in der letzten Stunde -> GG011 (2.3: gesperrt pro Konto + Art, zählt auch parallel richtig)
create or replace function public._rate(p_user text, p_kind text, p_max int)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(hashtext(coalesce(p_user, '') || ':' || coalesce(p_kind, '')));
  if (select count(*) from public.social_log l
      where l.username = p_user and l.kind = p_kind and l.at > now() - interval '1 hour') >= p_max then
    raise exception 'zu viele' using errcode = 'GG011';
  end if;
  insert into public.social_log (username, kind) values (p_user, p_kind);
end;
$$;

-- Frisches Foto mit genau diesem Tag? -> Besitzer, sonst Fehler (2.3: Garten-Tag statt current_date)
create or replace function public._foto_owner(p_garden uuid, p_plant text, p_day date)
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare v_owner text;
begin
  perform 1 from public.photos ph
  where ph.garden_id = p_garden and ph.plant_id = p_plant and ph.taken_on = p_day
    and ph.taken_on > public._garten_tag() - 7 and ph.created_at > now() - interval '7 days';
  if not found then
    raise exception 'foto weg' using errcode = 'GG010';
  end if;
  v_owner := public._garden_owner(p_garden);
  if v_owner is null then
    raise exception 'foto weg' using errcode = 'GG010';
  end if;
  return v_owner;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public._garten_tag()', 'public._acct_with_token(jsonb, text)', 'public._tok_hash(text)',
                           'public._rate(text, text, int)', 'public._foto_owner(uuid, text, date)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

/* ---------------------------------------------------------------- Gärten */
-- Schreiben: wie bisher, aber einen NEUEN Garten anlegen nur mit einem Token, das zu einem Konto gehört
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
  v_hash := public._tok_hash(p_token);

  perform 1 from public.gardens g where g.id = p_id;
  if not found then
    perform 1 from public.accounts a where a.token_hash = v_hash;
    if not found then
      raise exception 'kein konto' using errcode = '42501';
    end if;
  end if;

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

-- Widget (ohne Konto): nur der Zustand der Pflanzen – ohne Gartenname, Gewohnheitsnamen und Mini-Bilder
create or replace function public.get_gardens(p_ids uuid[])
returns table (id uuid, name text, snapshot jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.id, ''::text,
         case when jsonb_typeof(g.snapshot -> 'plants') = 'array' then
           jsonb_set(g.snapshot, '{plants}', coalesce((
             select jsonb_agg(case when jsonb_typeof(x.p) = 'object' then x.p - 'name' - 'foto' else x.p end order by x.o)
             from jsonb_array_elements(g.snapshot -> 'plants') with ordinality as x(p, o)), '[]'::jsonb))
         else g.snapshot end,
         g.updated_at
  from public.gardens g
  where g.id = any (p_ids[1:50]);
$$;

/* ---------------------------------------------------------------- Fotos */
create or replace function public.upsert_photo(
  p_garden uuid, p_token text, p_plant text, p_taken_on date, p_mime text, p_data text)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text;
  v_at   timestamptz;
  v_tag  date := public._garten_tag();
begin
  if p_garden is null then
    raise exception 'garten fehlt' using errcode = '22023';
  end if;
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'token ungueltig' using errcode = '22023';
  end if;
  if p_plant is null or p_plant !~ '^[A-Za-z0-9-]{1,64}$' then
    raise exception 'pflanze ungueltig' using errcode = '22023';
  end if;
  if p_mime is null or p_mime not in ('image/webp', 'image/jpeg') then
    raise exception 'nur image/webp oder image/jpeg' using errcode = '22023';
  end if;
  if p_data is null or char_length(p_data) < 1 or char_length(p_data) > 90000
     or p_data !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'bild ungueltig oder zu gross' using errcode = '22023';
  end if;
  if p_taken_on is null or p_taken_on <= v_tag - 7 or p_taken_on > v_tag + 1 then
    raise exception 'datum ungueltig' using errcode = '22023';
  end if;

  v_hash := public._tok_hash(p_token);
  perform 1 from public.gardens g where g.id = p_garden and g.token_hash = v_hash;
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  perform 1 from public.accounts a where a.token_hash = v_hash;
  if not found then
    raise exception 'kein konto' using errcode = '42501';
  end if;

  delete from public.photos
  where taken_on <= v_tag - 7 or created_at <= now() - interval '7 days';

  insert into public.photos as ph (garden_id, plant_id, taken_on, mime, data, created_at)
  values (p_garden, p_plant, p_taken_on, p_mime, p_data, now())
  on conflict (garden_id, plant_id) do update
    set taken_on = excluded.taken_on,
        mime = excluded.mime,
        data = excluded.data,
        created_at = now()
  returning ph.created_at into v_at;

  delete from public.photos ph
  where ph.garden_id = p_garden
    and ph.plant_id in (
      select x.plant_id from public.photos x
      where x.garden_id = p_garden
      order by x.created_at desc, x.plant_id
      offset 30
    );

  return v_at;
end;
$$;

-- Alt (bis 2.2.4): bleibt nur für den Übergang, wird unten für anon/authenticated entzogen
create or replace function public.get_photo(p_garden uuid, p_plant text)
returns table (mime text, data text, taken_on date)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ph.mime, ph.data, ph.taken_on
  from public.photos ph
  where ph.garden_id = p_garden
    and ph.plant_id = p_plant
    and ph.taken_on > public._garten_tag() - 7
    and ph.created_at > now() - interval '7 days'
  limit 1;
$$;

-- 2.3: ein Foto nur für Konten der Gemeinde, nur Fotos von Gärten der Gemeinde
create or replace function public.get_photo2(p_user text, p_token text, p_garden uuid, p_plant text)
returns table (mime text, data text, taken_on date)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
#variable_conflict use_column
begin
  if public._acct_ok(p_user, p_token) is null then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  if public._garden_owner(p_garden) is null then
    return;
  end if;
  return query
    select ph.mime, ph.data, ph.taken_on
    from public.photos ph
    where ph.garden_id = p_garden
      and ph.plant_id = p_plant
      and ph.taken_on > public._garten_tag() - 7
      and ph.created_at > now() - interval '7 days'
    limit 1;
end;
$$;

-- Herzen + Kommentare (wie herzen.sql, nur mit Garten-Tag statt current_date)
create or replace function public.photo_social(p_user text, p_token text, p_fotos jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_ok(p_user, p_token);
  v_out  jsonb := '[]'::jsonb;
  r      record;
  v_owner text;
begin
  if v_user is null then raise exception 'falsches token' using errcode = '42501'; end if;
  if p_fotos is null or jsonb_typeof(p_fotos) <> 'array' or jsonb_array_length(p_fotos) > 60 then
    raise exception 'liste ungueltig' using errcode = '22023';
  end if;
  for r in
    select distinct ph.garden_id, ph.plant_id, ph.taken_on
    from jsonb_array_elements(p_fotos) x
    join public.photos ph
      on (x ->> 'g') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and (x ->> 'd') ~ '^\d{4}-\d{2}-\d{2}$'
     and ph.garden_id = (x ->> 'g')::uuid and ph.plant_id = (x ->> 'p') and ph.taken_on = (x ->> 'd')::date
    where jsonb_typeof(x) = 'object'
      and ph.taken_on > public._garten_tag() - 7 and ph.created_at > now() - interval '7 days'
  loop
    v_owner := public._garden_owner(r.garden_id);
    continue when v_owner is null;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'g', r.garden_id, 'p', r.plant_id, 'd', r.taken_on,
      'herz', exists (select 1 from public.photo_likes l
                      where l.garden_id = r.garden_id and l.plant_id = r.plant_id and l.taken_on = r.taken_on),
      'mine', exists (select 1 from public.photo_likes l
                      where l.garden_id = r.garden_id and l.plant_id = r.plant_id and l.taken_on = r.taken_on and l.username = v_user),
      'who', case when v_owner = v_user then coalesce((
               select jsonb_agg(public._acct_display(l.username) order by l.created_at)
               from public.photo_likes l
               where l.garden_id = r.garden_id and l.plant_id = r.plant_id and l.taken_on = r.taken_on
                 and l.username <> v_user), '[]'::jsonb) else '[]'::jsonb end,
      'comments', coalesce((
        select jsonb_agg(jsonb_build_object('id', c.id, 'u', public._acct_display(c.username), 't', c.body,
                                            'at', c.created_at, 'own', c.username = v_user,
                                            'del', c.username = v_user or v_owner = v_user) order by c.created_at, c.id)
        from public.photo_comments c
        where c.garden_id = r.garden_id and c.plant_id = r.plant_id and c.taken_on = r.taken_on), '[]'::jsonb)
    ));
  end loop;
  return v_out;
end;
$$;

/* ---------------------------------------------------------------- Konten */
-- Anlegen nur mit Gemeinde-Code. Name vergeben -> GG001, Code falsch -> GG002, zu viele Fehlversuche -> GG003.
-- Code-Fehler: HTTP-Status per response.status statt raise, damit der Fehlversuch gespeichert bleibt.
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
  if (select count(*) from public.register_fails f where f.at > now() - interval '1 hour') >= 20 then
    perform set_config('response.status', '429', true);
    return jsonb_build_object('code', 'GG003', 'message', 'zu viele fehlversuche', 'details', null, 'hint', null);
  end if;
  select c.code_hash into v_hash from public.community c where c.id = 1;
  if v_hash is null or p_code is null or char_length(p_code) > 64
     or extensions.crypt(lower(btrim(p_code)), v_hash) <> v_hash then
    insert into public.register_fails (at) values (now());
    delete from public.register_fails f where f.at < now() - interval '1 day';
    perform set_config('response.status', '400', true);
    return jsonb_build_object('code', 'GG002', 'message', 'gemeinde-code falsch', 'details', null, 'hint', null);
  end if;
  if v_user !~ '^[a-z0-9_.äöüß-]{3,24}$' then
    raise exception 'name ungueltig' using errcode = '22023';
  end if;
  if p_pw is null or char_length(p_pw) < 8 or char_length(p_pw) > 72 then
    raise exception 'passwort zu kurz' using errcode = '22023';
  end if;
  perform public._acct_check_state(p_state);
  v_tok := public._acct_token(p_state);
  begin
    insert into public.accounts (username, pw_hash, token_hash, token_enc, state, state_rev)
    values (v_user, extensions.crypt(p_pw, extensions.gen_salt('bf', 8)), public._tok_hash(v_tok),
            extensions.pgp_sym_encrypt(v_tok, p_pw), p_state #- '{privat,nb,token}', 1);
  exception when unique_violation then
    raise exception 'name vergeben' using errcode = 'GG001';
  end;
  return jsonb_build_object('ok', true, 'user', v_user, 'rev', 1);
end;
$$;

-- Anmelden: {ok:true, user, rev, state (mit Token)} oder {ok:false, error:'falsch'|'gesperrt', wait:Sekunden}
create or replace function public.account_login(p_user text, p_pw text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  a      public.accounts%rowtype;
  v_min  int;
  v_tok  text;
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
    if a.fails + 1 >= 5 then
      v_min := (array[5, 15, 60, 240, 1440])[least(coalesce(a.lock_level, 0) + 1, 5)];
      update public.accounts
        set fails = 0, lock_level = least(coalesce(a.lock_level, 0) + 1, 5),
            locked_until = now() + make_interval(mins => v_min)
        where username = v_user;
      return jsonb_build_object('ok', false, 'error', 'gesperrt', 'wait', v_min * 60);
    end if;
    update public.accounts set fails = a.fails + 1, locked_until = null where username = v_user;
    return jsonb_build_object('ok', false, 'error', 'falsch');
  end if;

  -- Token: verschlüsselt (2.3) oder noch aus dem alten state – dann jetzt verschlüsseln
  if a.token_enc is not null then
    begin
      v_tok := extensions.pgp_sym_decrypt(a.token_enc, p_pw);
    exception when others then
      v_tok := null;
    end;
    if v_tok is not null and public._tok_hash(v_tok) <> a.token_hash then v_tok := null; end if;
  end if;
  if v_tok is null then
    v_tok := a.state #>> '{privat,nb,token}';
    if v_tok is not null and public._tok_hash(v_tok) = a.token_hash then
      update public.accounts
        set token_enc = extensions.pgp_sym_encrypt(v_tok, p_pw), state = a.state #- '{privat,nb,token}'
        where username = v_user;
    else
      v_tok := null;
    end if;
  end if;
  update public.accounts set fails = 0, lock_level = 0, locked_until = null where username = v_user;
  return jsonb_build_object('ok', true, 'user', a.username, 'rev', a.state_rev,
                            'state', public._acct_with_token(a.state, v_tok));
end;
$$;

-- Speichern mit Token (wie bisher). Token wird nicht im state gespeichert, sobald es verschlüsselt vorliegt.
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
    where username = v_user and token_hash = public._tok_hash(p_token)
    for update;
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  if p_base_rev is distinct from a.state_rev then
    return jsonb_build_object('ok', false, 'conflict', true, 'rev', a.state_rev,
                              'state', public._acct_with_token(a.state, p_token));
  end if;
  update public.accounts
    set state = case when a.token_enc is not null then p_state #- '{privat,nb,token}' else p_state end,
        state_rev = a.state_rev + 1, updated_at = now()
    where username = v_user;
  return jsonb_build_object('ok', true, 'rev', a.state_rev + 1);
end;
$$;

-- Neueren Stand holen: {ok:true, rev, state? (mit Token)}
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
    where username = v_user and token_hash = public._tok_hash(p_token);
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  if p_have_rev is not null and a.state_rev <= p_have_rev then
    return jsonb_build_object('ok', true, 'rev', a.state_rev);
  end if;
  return jsonb_build_object('ok', true, 'rev', a.state_rev, 'state', public._acct_with_token(a.state, p_token));
end;
$$;

-- Passwort ändern (altes Passwort nötig, zählt Fehlversuche wie login). Erneuert das Token (Konto + Garten):
-- andere Geräte müssen sich danach neu anmelden. -> {ok:true, token} oder Antwort von account_login
create or replace function public.account_change_pw(p_user text, p_old text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_name(p_user);
  r      jsonb;
  a      public.accounts%rowtype;
  v_tok  text := encode(extensions.gen_random_bytes(32), 'hex');
  v_gid  text;
begin
  if p_new is null or char_length(p_new) < 8 or char_length(p_new) > 72 then
    raise exception 'passwort zu kurz' using errcode = '22023';
  end if;
  r := public.account_login(p_user, p_old);
  if not (r ->> 'ok')::boolean then
    return r - 'state';
  end if;
  select * into a from public.accounts where username = v_user for update;
  v_gid := a.state #>> '{garden,id}';
  if v_gid ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update public.gardens g set token_hash = public._tok_hash(v_tok)
      where g.id = v_gid::uuid and g.token_hash = a.token_hash;
  end if;
  update public.accounts
    set pw_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 8)),
        token_hash = public._tok_hash(v_tok),
        token_enc = extensions.pgp_sym_encrypt(v_tok, p_new),
        state = a.state #- '{privat,nb,token}',
        updated_at = now()
    where username = v_user;
  return jsonb_build_object('ok', true, 'token', v_tok);
end;
$$;

/* ---------------------------------------------------------------- Gemeinde: nur Änderungen */
-- {now: Server-Zeit, ids: [alle Gärten der Gemeinde außer dem eigenen], gardens: [nur geändert seit p_since]}
-- p_since = null -> alle. 10 s Puffer gegen gleichzeitige Speicherungen.
create or replace function public.community_changes(p_user text, p_token text, p_since timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_ok(p_user, p_token);
  v_out  jsonb;
begin
  if v_user is null then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  with rows as (
    select g.id, coalesce(nullif(g.name, ''), a.username) as name, g.snapshot, g.updated_at, a.created_at, a.username
    from public.accounts a
    join public.gardens g
      on g.id = case when (a.state #>> '{garden,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (a.state #>> '{garden,id}')::uuid end
     and g.token_hash = a.token_hash
    where a.username <> v_user
    order by a.created_at, a.username
    limit 100
  )
  select jsonb_build_object(
    'now', now(),
    'ids', coalesce(jsonb_agg(r.id order by r.created_at, r.username), '[]'::jsonb),
    'gardens', coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'snapshot', r.snapshot, 'updated_at', r.updated_at)
                                  order by r.created_at, r.username)
                        filter (where p_since is null or r.updated_at > p_since - interval '10 seconds'), '[]'::jsonb))
  into v_out
  from rows r;
  return v_out;
end;
$$;

/* ---------------------------------------------------------------- Rechte */
do $$
declare f text;
begin
  foreach f in array array[
    'public.upsert_garden(uuid, text, text, jsonb)',
    'public.get_gardens(uuid[])',
    'public.upsert_photo(uuid, text, text, date, text, text)',
    'public.get_photo2(text, text, uuid, text)',
    'public.photo_social(text, text, jsonb)',
    'public.account_register(text, text, jsonb, text)',
    'public.account_login(text, text)',
    'public.account_save(text, text, jsonb, bigint)',
    'public.account_pull(text, text, bigint)',
    'public.account_change_pw(text, text, text)',
    'public.community_changes(text, text, timestamptz)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

-- ERST NACHDEM die App 2.3 (nutzt get_photo2) live ist: altes get_photo ohne Konto entziehen
revoke all on function public.get_photo(uuid, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
