-- Gewohnheits-Garten 2.1 „Herzen“ – Supabase-Ergänzung (nach schema.sql, fotos.sql, konten.sql, gemeinde.sql)
-- In Supabase → SQL Editor → „New query“ komplett einfügen und „Run“ drücken.
-- Kann gefahrlos mehrmals ausgeführt werden. Löscht keine Gärten, Fotos oder Konten.
--
-- Inhalt:
--   * Herzen + kurze Kommentare an Fotos der Gemeinde (photo_likes, photo_comments).
--     Sie gehören zu genau einem Foto (garden_id, plant_id, taken_on) und verschwinden mit ihm:
--     Fremdschlüssel auf photos mit on delete cascade, ein neues Bild an derselben Pflanze setzt sie zurück.
--   * Web-Push: Abos pro Gerät (push_subs), Auslöser per pg_net an die Edge Function „push“,
--     tägliche Gieß-Erinnerung per pg_cron.
--
-- Sicherheit (wie bisher):
--   * Alle neuen Tabellen: RLS an, keine Policies, alle Rechte für anon/authenticated entzogen.
--   * Nur security-definer-RPCs mit festem search_path, jede prüft Konto + Token (_acct_ok).
--     Ein Foto zählt nur, wenn sein Garten zu einem Konto der Gemeinde gehört (_garden_owner).
--   * Geheimnisse stehen NIE im Repo: push_config (Hook-Secret, VAPID-Schlüssel) erzeugt die Datenbank
--     bzw. die Edge Function selbst. Nur der öffentliche VAPID-Schlüssel steht in config.js.
--   * Grenzen: Kommentar 1–140 Zeichen, 30 Kommentare/Stunde und 200 Herz-Tipps/Stunde pro Konto,
--     50 Kommentare pro Foto, 10 Geräte-Abos pro Konto. Push-Endpunkte nur bei bekannten Push-Diensten.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

/* ---------------------------------------------------------------- Tabellen */
create table if not exists public.photo_likes (
  garden_id   uuid        not null,
  plant_id    text        not null,
  taken_on    date        not null,
  username    text        not null references public.accounts (username) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (garden_id, plant_id, taken_on, username),
  foreign key (garden_id, plant_id) references public.photos (garden_id, plant_id) on delete cascade
);

create table if not exists public.photo_comments (
  id          bigint generated always as identity primary key,
  garden_id   uuid        not null,
  plant_id    text        not null,
  taken_on    date        not null,
  username    text        not null references public.accounts (username) on delete cascade,
  body        text        not null check (char_length(body) between 1 and 140),
  created_at  timestamptz not null default now(),
  foreign key (garden_id, plant_id) references public.photos (garden_id, plant_id) on delete cascade
);
create index if not exists photo_comments_foto_idx on public.photo_comments (garden_id, plant_id, taken_on, created_at);

create table if not exists public.social_log (
  username  text        not null,
  kind      text        not null,
  at        timestamptz not null default now()
);
create index if not exists social_log_idx on public.social_log (username, kind, at);

create table if not exists public.push_subs (
  endpoint    text        primary key,
  username    text        not null references public.accounts (username) on delete cascade,
  p256dh      text        not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}=*$'),
  auth        text        not null check (auth ~ '^[A-Za-z0-9_-]{16,32}=*$'),
  prefs       jsonb       not null default '{"herzen": true, "giessen": true, "fotos": true}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists push_subs_user_idx on public.push_subs (username);

-- Schon verschickt? (gegen doppelte Mitteilungen, Drosselung)
create table if not exists public.push_sent (
  key  text        primary key,
  at   timestamptz not null default now()
);

-- Hook-Secret (von der Datenbank erzeugt) + VAPID-Schlüssel (erzeugt die Edge Function beim ersten Aufruf)
create table if not exists public.push_config (
  id            int  primary key check (id = 1),
  url           text not null,
  secret        text not null,
  vapid_public  text,
  vapid_private text
);
insert into public.push_config (id, url, secret)
values (1, 'https://fmzsujdvrjmsgchfkodb.supabase.co/functions/v1/push', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (id) do nothing;

do $$
declare t text;
begin
  foreach t in array array['photo_likes', 'photo_comments', 'social_log', 'push_subs', 'push_sent', 'push_config'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;
-- Absichtlich KEINE Policies. Die Edge Function (service_role) liest nur push_config und löscht tote Abos.
grant select, update on table public.push_config to service_role;
grant select, delete on table public.push_subs to service_role;

/* ---------------------------------------------------------------- Hilfen (nicht öffentlich) */
-- Konto, dem ein Garten gehört (nur Konten der Gemeinde), sonst null
create or replace function public._garden_owner(p_garden uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select a.username
  from public.accounts a
  join public.gardens g on g.id = p_garden and g.token_hash = a.token_hash
  where lower(a.state #>> '{garden,id}') = p_garden::text
  limit 1
$$;

-- Name, wie ihn die Gemeinde sieht (Gartenname, sonst Kontoname)
create or replace function public._acct_display(p_user text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(nullif(g.name, ''), a.username)
  from public.accounts a
  left join public.gardens g
    on g.id = case when (a.state #>> '{garden,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   then (a.state #>> '{garden,id}')::uuid end
   and g.token_hash = a.token_hash
  where a.username = p_user
$$;

-- Frisches Foto mit genau diesem Tag? -> Besitzer, sonst Fehler
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
    and ph.taken_on > current_date - 7 and ph.created_at > now() - interval '7 days';
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

-- Zählt eine Aktion; zu viele in der letzten Stunde -> GG011
create or replace function public._rate(p_user text, p_kind text, p_max int)
returns void
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (select count(*) from public.social_log l
      where l.username = p_user and l.kind = p_kind and l.at > now() - interval '1 hour') >= p_max then
    raise exception 'zu viele' using errcode = 'GG011';
  end if;
  insert into public.social_log (username, kind) values (p_user, p_kind);
end;
$$;

-- Mitteilung an Konten schicken (nur Abos, die diese Art wollen). Darf nie etwas kaputt machen.
create or replace function public._push_send(p_users text[], p_pref text, p_msg jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_cfg  public.push_config%rowtype;
  v_subs jsonb;
begin
  select * into v_cfg from public.push_config where id = 1;
  if v_cfg.id is null then return; end if;
  select jsonb_agg(jsonb_build_object('endpoint', s.endpoint, 'keys', jsonb_build_object('p256dh', s.p256dh, 'auth', s.auth)))
    into v_subs
  from public.push_subs s
  where s.username = any (p_users)
    and coalesce((s.prefs ->> p_pref)::boolean, true);
  if v_subs is null then return; end if;
  perform net.http_post(
    url := v_cfg.url,
    body := jsonb_build_object('subs', v_subs, 'msg', p_msg),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', v_cfg.secret),
    timeout_milliseconds := 15000);
exception when others then
  raise warning 'push nicht verschickt: %', sqlerrm;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['public._garden_owner(uuid)', 'public._acct_display(text)', 'public._foto_owner(uuid, text, date)',
                           'public._rate(text, text, int)', 'public._push_send(text[], text, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

/* ---------------------------------------------------------------- Neues Bild: Herzen/Kommentare zurücksetzen, Gemeinde benachrichtigen */
create or replace function public._photo_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner text;
begin
  if tg_op = 'UPDATE' then
    if new.data is not distinct from old.data and new.taken_on is not distinct from old.taken_on then
      return new;
    end if;
    delete from public.photo_likes l where l.garden_id = old.garden_id and l.plant_id = old.plant_id;
    delete from public.photo_comments c where c.garden_id = old.garden_id and c.plant_id = old.plant_id;
  end if;
  begin
    v_owner := public._garden_owner(new.garden_id);
    -- höchstens eine „Neue Fotos“-Mitteilung pro Person und Stunde
    if v_owner is not null then
      insert into public.push_sent (key) values ('foto:' || v_owner || ':' || to_char(now(), 'YYYYMMDDHH24'))
      on conflict do nothing;
      if found then
        perform public._push_send(
          array(select a.username from public.accounts a where a.username <> v_owner),
          'fotos',
          jsonb_build_object('title', '📸 ' || public._acct_display(v_owner) || ' hat ein Foto gemacht',
                             'body', 'Schau mal in den Garten.', 'tag', 'foto-' || v_owner,
                             'url', './?foto=' || new.garden_id || '.' || new.plant_id));
      end if;
    end if;
  exception when others then
    raise warning 'foto-push: %', sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public._photo_changed() from public, anon, authenticated;
drop trigger if exists photos_social on public.photos;
create trigger photos_social after insert or update on public.photos
for each row execute function public._photo_changed();

/* ---------------------------------------------------------------- RPCs: Herzen + Kommentare */
-- Herz an/aus -> {ok, mine}
create or replace function public.photo_like_toggle(p_user text, p_token text, p_garden uuid, p_plant text, p_day date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user  text := public._acct_ok(p_user, p_token);
  v_owner text;
begin
  if v_user is null then raise exception 'falsches token' using errcode = '42501'; end if;
  v_owner := public._foto_owner(p_garden, p_plant, p_day);
  perform public._rate(v_user, 'herz', 200);
  delete from public.photo_likes l
  where l.garden_id = p_garden and l.plant_id = p_plant and l.taken_on = p_day and l.username = v_user;
  if found then return jsonb_build_object('ok', true, 'mine', false); end if;
  insert into public.photo_likes (garden_id, plant_id, taken_on, username) values (p_garden, p_plant, p_day, v_user);
  if v_owner <> v_user then
    -- pro Person und Foto nur einmal melden (auch wenn jemand an/aus/an tippt)
    insert into public.push_sent (key) values ('herz:' || v_user || ':' || p_garden || ':' || p_plant || ':' || p_day)
    on conflict do nothing;
    if found then
      perform public._push_send(array[v_owner], 'herzen',
        jsonb_build_object('title', '❤️ ' || public._acct_display(v_user) || ' mag dein Foto',
                           'body', 'Tippe, um es anzusehen.', 'tag', 'herz-' || p_plant,
                           'url', './?foto=' || p_garden || '.' || p_plant));
    end if;
  end if;
  return jsonb_build_object('ok', true, 'mine', true);
end;
$$;

-- Kommentar schreiben -> {id}
create or replace function public.photo_comment_add(p_user text, p_token text, p_garden uuid, p_plant text, p_day date, p_text text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user  text := public._acct_ok(p_user, p_token);
  v_owner text;
  v_text  text;
  v_id    bigint;
begin
  if v_user is null then raise exception 'falsches token' using errcode = '42501'; end if;
  if p_text is null or char_length(p_text) > 400 then raise exception 'kommentar zu lang' using errcode = '22023'; end if;
  v_text := btrim(regexp_replace(p_text, '[[:cntrl:]]+', ' ', 'g'));
  if char_length(v_text) < 1 or char_length(v_text) > 140 then
    raise exception 'kommentar leer oder zu lang' using errcode = '22023';
  end if;
  v_owner := public._foto_owner(p_garden, p_plant, p_day);
  if (select count(*) from public.photo_comments c
      where c.garden_id = p_garden and c.plant_id = p_plant and c.taken_on = p_day) >= 50 then
    raise exception 'genug kommentare' using errcode = 'GG011';
  end if;
  perform public._rate(v_user, 'kommentar', 30);
  insert into public.photo_comments (garden_id, plant_id, taken_on, username, body)
  values (p_garden, p_plant, p_day, v_user, v_text)
  returning id into v_id;
  if v_owner <> v_user then
    perform public._push_send(array[v_owner], 'herzen',
      jsonb_build_object('title', '💬 ' || public._acct_display(v_user) || ' zu deinem Foto',
                         'body', left(v_text, 120), 'tag', 'kommentar-' || p_plant,
                         'url', './?foto=' || p_garden || '.' || p_plant));
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- Kommentar löschen: eigene, oder alle unter dem eigenen Foto
create or replace function public.photo_comment_delete(p_user text, p_token text, p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_ok(p_user, p_token);
begin
  if v_user is null then raise exception 'falsches token' using errcode = '42501'; end if;
  delete from public.photo_comments c
  where c.id = p_id
    and (c.username = v_user or public._garden_owner(c.garden_id) = v_user);
  return found;
end;
$$;

-- Herzen + Kommentare zu mehreren Fotos. p_fotos: [{"g": garten, "p": pflanze, "d": "YYYY-MM-DD"}, …] (höchstens 60)
-- -> [{g, p, d, herz (gibt es Herzen?), mine, who (Namen, nur beim eigenen Foto), comments: [{id, u, t, at, del}]}]
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
      and ph.taken_on > current_date - 7 and ph.created_at > now() - interval '7 days'
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

/* ---------------------------------------------------------------- RPCs: Push-Abo */
-- Abo + Einstellungen speichern (ein Eintrag pro Gerät, endpoint eindeutig) -> prefs
create or replace function public.push_save(p_user text, p_token text, p_sub jsonb, p_prefs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user  text := public._acct_ok(p_user, p_token);
  v_ep    text := p_sub ->> 'endpoint';
  v_prefs jsonb;
begin
  if v_user is null then raise exception 'falsches token' using errcode = '42501'; end if;
  if v_ep is null or char_length(v_ep) > 1000
     or v_ep !~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)/' then
    raise exception 'abo ungueltig' using errcode = '22023';
  end if;
  v_prefs := jsonb_build_object(
    'herzen',  coalesce(p_prefs ->> 'herzen', 'true') <> 'false',
    'giessen', coalesce(p_prefs ->> 'giessen', 'true') <> 'false',
    'fotos',   coalesce(p_prefs ->> 'fotos', 'true') <> 'false');
  insert into public.push_subs as s (endpoint, username, p256dh, auth, prefs)
  values (v_ep, v_user, p_sub #>> '{keys,p256dh}', p_sub #>> '{keys,auth}', v_prefs)
  on conflict (endpoint) do update
    set username = excluded.username, p256dh = excluded.p256dh, auth = excluded.auth,
        prefs = excluded.prefs, updated_at = now();
  -- höchstens 10 Geräte pro Konto: die ältesten fliegen raus
  delete from public.push_subs s
  where s.username = v_user and s.endpoint in (
    select x.endpoint from public.push_subs x where x.username = v_user order by x.updated_at desc offset 10);
  return v_prefs;
exception when check_violation or not_null_violation then
  raise exception 'abo ungueltig' using errcode = '22023';
end;
$$;

create or replace function public.push_delete(p_user text, p_token text, p_endpoint text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_user text := public._acct_ok(p_user, p_token);
begin
  if v_user is null then raise exception 'falsches token' using errcode = '42501'; end if;
  delete from public.push_subs s where s.endpoint = p_endpoint and s.username = v_user;
  return found;
end;
$$;

/* ---------------------------------------------------------------- Gieß-Erinnerung (pg_cron, 19:30 Berlin) */
-- Durst wie im Widget (status()): nicht Pause, heute nicht gegossen, Wochenziel noch nicht erreicht.
-- 2.2: Tag wechselt um 3 Uhr nachts; Pause endet bei pe, neuer Rhythmus ng gilt ab nf.
create or replace function public._push_reminder()
returns int
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_local timestamp := now() at time zone 'Europe/Berlin';
  v_t     int := ((v_local - interval '3 hours')::date - date '1970-01-01');
  v_w0    int;
  v_n     int;
  v_cnt   int := 0;
  r       record;
begin
  v_w0 := v_t - ((v_t + 3) % 7 + 7) % 7;
  -- Aufräumen
  delete from public.push_sent where at < now() - interval '9 days';
  delete from public.social_log where at < now() - interval '2 days';
  if extract(hour from v_local) <> 19 then return 0; end if;
  for r in
    select a.username, g.snapshot
    from public.accounts a
    join public.gardens g
      on g.id = case when (a.state #>> '{garden,id}') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     then (a.state #>> '{garden,id}')::uuid end
     and g.token_hash = a.token_hash
    where exists (select 1 from public.push_subs s
                  where s.username = a.username and coalesce((s.prefs ->> 'giessen')::boolean, true))
  loop
    select count(*) into v_n
    from jsonb_array_elements(case when jsonb_typeof(r.snapshot -> 'plants') = 'array' then r.snapshot -> 'plants' else '[]'::jsonb end) p
    cross join lateral (select case when jsonb_typeof(p -> 'ng') = 'number' and jsonb_typeof(p -> 'nf') = 'number'
                                     and (p ->> 'nf')::numeric <= v_t then (p ->> 'ng')::numeric
                                    else coalesce((p ->> 'goal')::numeric, 7) end as goal) gg
    where not (coalesce((p ->> 'paused')::boolean, false)
               and not (jsonb_typeof(p -> 'pe') = 'number' and (p ->> 'pe')::numeric <= v_t))
      and not (jsonb_typeof(p -> 'last') = 'number' and (p ->> 'last')::numeric >= v_t)
      and not (gg.goal < 7
               and (select count(*) from jsonb_array_elements(case when jsonb_typeof(p -> 'days') = 'array' then p -> 'days' else '[]'::jsonb end) d
                    where jsonb_typeof(d) = 'number' and d::text::numeric >= v_w0 and d::text::numeric <= v_t)
                   >= gg.goal);
    continue when v_n = 0;
    insert into public.push_sent (key) values ('giessen:' || r.username || ':' || v_t) on conflict do nothing;
    continue when not found;
    perform public._push_send(array[r.username], 'giessen',
      jsonb_build_object('title', '💧 Dein Garten hat Durst',
                         'body', case when v_n = 1 then 'Eine Pflanze wartet heute noch auf Wasser.'
                                      else v_n || ' Pflanzen warten heute noch auf Wasser.' end,
                         'tag', 'giessen', 'url', './'));
    v_cnt := v_cnt + 1;
  end loop;
  return v_cnt;
end;
$$;
revoke all on function public._push_reminder() from public, anon, authenticated;

-- 17:30 und 18:30 UTC; die Funktion macht nur um 19 Uhr Berliner Zeit etwas (Sommer- und Winterzeit)
select cron.schedule('garten-giess-erinnerung', '30 17,18 * * *', 'select public._push_reminder()');

/* ---------------------------------------------------------------- Rechte */
do $$
declare f text;
begin
  foreach f in array array[
    'public.photo_like_toggle(text, text, uuid, text, date)',
    'public.photo_comment_add(text, text, uuid, text, date, text)',
    'public.photo_comment_delete(text, text, bigint)',
    'public.photo_social(text, text, jsonb)',
    'public.push_save(text, text, jsonb, jsonb)',
    'public.push_delete(text, text, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to anon, authenticated', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
