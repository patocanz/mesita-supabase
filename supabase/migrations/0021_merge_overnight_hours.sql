-- 0021_merge_overnight_hours.sql
--
-- Reshape venues.hours: legacy split-at-midnight pairs (day N has a
-- range ending at 23:59 + day N+1 has a range starting at 00:00)
-- become a single overnight range on day N, where `close <= open`
-- semantically means the close is the next day.
--
-- The split shape was a UI-driven simplification that backfired — a
-- Fri 6pm–2am venue rendered as two unrelated rows (Friday and
-- Saturday), which managers read as a closed-and-reopen-at-midnight
-- mess. One range per real-world shift carries the same information
-- without the visual fork. 24/7 days (00:00→23:59) and same-day split
-- shifts (lunch + dinner) are left alone — the merge only triggers
-- when both the tail-at-23:59 and head-at-00:00 pattern exists on
-- consecutive days.
--
-- The tail and head ranges can appear at any index in their day's
-- array — Google's period order isn't sorted by clock time — so the
-- merge scans the whole array per direction instead of peeking at
-- index 0 / last.

comment on column public.venues.hours is
  'Normalised weekly hours from Google Places. Shape: { "monday": [{"open":"HH:MM","close":"HH:MM"}], ... } using lowercase English day keys. Multiple ranges per day cover same-day split shifts (lunch + dinner). Overnight shifts live as a single range on the opening day where close <= open means the close is the next day. Closed days omit the key. closes_at remains as a denormalised "latest close today" signal.';

create or replace function pg_temp.merge_overnight_pair(
  h jsonb,
  day_a text,
  day_b text
) returns jsonb as $$
declare
  a_ranges jsonb := h -> day_a;
  b_ranges jsonb := h -> day_b;
  tail_idx int := -1;
  head_idx int := -1;
  i int;
  r jsonb;
  new_close text;
begin
  if a_ranges is null or b_ranges is null then return h; end if;
  if jsonb_array_length(a_ranges) = 0 or jsonb_array_length(b_ranges) = 0 then
    return h;
  end if;

  -- Tail: any range in day A that ends exactly at 23:59 and does NOT
  -- open at 00:00 (the 00:00→23:59 case is a full-day range, not an
  -- overnight tail, and stays put).
  for i in 0..jsonb_array_length(a_ranges) - 1 loop
    r := a_ranges -> i;
    if (r ->> 'close') = '23:59' and (r ->> 'open') <> '00:00' then
      tail_idx := i;
      exit;
    end if;
  end loop;

  -- Head: any range in day B that opens exactly at 00:00 and does NOT
  -- close at 23:59 (the 00:00→23:59 case is a full-day range).
  for i in 0..jsonb_array_length(b_ranges) - 1 loop
    r := b_ranges -> i;
    if (r ->> 'open') = '00:00' and (r ->> 'close') <> '23:59' then
      head_idx := i;
      exit;
    end if;
  end loop;

  if tail_idx < 0 or head_idx < 0 then return h; end if;

  new_close := (b_ranges -> head_idx) ->> 'close';

  h := jsonb_set(
    h,
    array[day_a, tail_idx::text, 'close'],
    to_jsonb(new_close),
    false
  );

  h := jsonb_set(
    h,
    array[day_b],
    b_ranges - head_idx,
    false
  );

  -- An emptied day would leak as `"tuesday": []`; drop it so the
  -- storage shape stays "closed days omit the key entirely".
  if jsonb_array_length(h -> day_b) = 0 then
    h := h - day_b;
  end if;

  return h;
end;
$$ language plpgsql;

do $$
declare
  v_id uuid;
  v_hours jsonb;
  v_new jsonb;
  v_prev jsonb;
  days text[] := array['monday','tuesday','wednesday','thursday','friday','saturday','sunday'];
  i int;
begin
  for v_id, v_hours in
    select id, hours from public.venues where hours is not null
  loop
    v_new := v_hours;

    -- Repeat the seven-day sweep until no further merges fire — this
    -- catches the rare case of a day with multiple overnight pairs in
    -- the same direction, and any cascading from Sun→Mon wraparound.
    loop
      v_prev := v_new;
      for i in 1..7 loop
        v_new := pg_temp.merge_overnight_pair(v_new, days[i], days[(i % 7) + 1]);
      end loop;
      exit when v_new = v_prev;
    end loop;

    if v_new <> v_hours then
      update public.venues set hours = v_new where id = v_id;
    end if;
  end loop;
end $$;
