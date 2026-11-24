-- Gewohnheits-Garten 1.3 „Foto-Nachweis“ – Supabase-Ergänzung (ohne Storage-Bucket)
-- Voraussetzung: schema.sql (Tabelle public.gardens) ist schon ausgeführt.
-- In Supabase → SQL Editor → „New query“ komplett einfügen und „Run“ drücken.
-- Kann gefahrlos mehrmals ausgeführt werden.
--
-- Sicherheitsidee (wie bei gardens):
--   * Tabelle photos ist für anon/authenticated komplett gesperrt (RLS an, keine Policies, keine Rechte).
--   * Schreiben/Löschen nur über upsert_photo / delete_photo mit dem geheimen Geräte-Token des Gartens
--     (SHA-256-Hash muss zu gardens.token_hash passen).
--   * Lesen nur über get_photo(garten, pflanze): Wer die Garten-ID kennt, sieht dessen Fotos – einzeln,
--     keine Liste. Nur Fotos, die jünger als 7 Tage sind.
--   * Pro Pflanze genau ein Foto (Primärschlüssel), höchstens 30 pro Garten, nur WebP/JPEG,
--     höchstens 90 000 base64-Zeichen (≈ 66 KB). Älter als 7 Tage wird bei jedem Hochladen gelöscht.

create table if not exists public.photos (
  garden_id   uuid        not null references public.gardens (id) on delete cascade,
  plant_id    text        not null check (plant_id ~ '^[A-Za-z0-9-]{1,64}$'),
  taken_on    date        not null,
  mime        text        not null check (mime in ('image/webp', 'image/jpeg')),
  data        text        not null check (char_length(data) between 1 and 90000),
  created_at  timestamptz not null default now(),
  primary key (garden_id, plant_id)
);
create index if not exists photos_created_at_idx on public.photos (created_at);

alter table public.photos enable row level security;
-- Absichtlich KEINE Policies.
revoke all on table public.photos from public, anon, authenticated;

-- Hochladen / Ersetzen – nur mit passendem Token
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
  -- Datum: höchstens 6 Tage alt (sonst schon abgelaufen), höchstens 1 Tag in der Zukunft (Zeitzonen)
  if p_taken_on is null or p_taken_on <= current_date - 7 or p_taken_on > current_date + 1 then
    raise exception 'datum ungueltig' using errcode = '22023';
  end if;

  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  perform 1 from public.gardens g where g.id = p_garden and g.token_hash = v_hash;
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;

  -- Aufräumen: alles, was älter als 7 Tage ist (in allen Gärten)
  delete from public.photos
  where taken_on <= current_date - 7 or created_at <= now() - interval '7 days';

  insert into public.photos as ph (garden_id, plant_id, taken_on, mime, data, created_at)
  values (p_garden, p_plant, p_taken_on, p_mime, p_data, now())
  on conflict (garden_id, plant_id) do update
    set taken_on = excluded.taken_on,
        mime = excluded.mime,
        data = excluded.data,
        created_at = now()
  returning ph.created_at into v_at;

  -- höchstens 30 Fotos pro Garten: die ältesten fliegen raus
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

-- Löschen – nur mit passendem Token
create or replace function public.delete_photo(p_garden uuid, p_token text, p_plant text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_hash text;
begin
  if p_garden is null or p_plant is null then
    raise exception 'garten oder pflanze fehlt' using errcode = '22023';
  end if;
  if p_token is null or char_length(p_token) < 32 or char_length(p_token) > 128 then
    raise exception 'token ungueltig' using errcode = '22023';
  end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  perform 1 from public.gardens g where g.id = p_garden and g.token_hash = v_hash;
  if not found then
    raise exception 'falsches token' using errcode = '42501';
  end if;
  delete from public.photos ph where ph.garden_id = p_garden and ph.plant_id = p_plant;
  return found;
end;
$$;

-- Lesen – ein einzelnes Foto, nur wenn jünger als 7 Tage
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
    and ph.taken_on > current_date - 7
    and ph.created_at > now() - interval '7 days'
  limit 1;
$$;

-- Rechte: nur Ausführen für anon (die App) und authenticated
revoke all on function public.upsert_photo(uuid, text, text, date, text, text) from public, anon, authenticated;
revoke all on function public.delete_photo(uuid, text, text) from public, anon, authenticated;
revoke all on function public.get_photo(uuid, text) from public, anon, authenticated;
grant execute on function public.upsert_photo(uuid, text, text, date, text, text) to anon, authenticated;
grant execute on function public.delete_photo(uuid, text, text) to anon, authenticated;
grant execute on function public.get_photo(uuid, text) to anon, authenticated;

-- PostgREST die neuen Funktionen sofort bekannt machen
notify pgrst, 'reload schema';
