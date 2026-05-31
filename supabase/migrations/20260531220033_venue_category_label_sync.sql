-- Keep a human-readable category label (emoji + natural language) in sync
-- with the canonical category slug on public.venues.
--
-- Canonical source:
--   public.venue_categories.slug  -> standard machine name
--   public.venue_categories.label -> human label (emoji + text)
--
-- Why:
-- - Consumer cards need display-ready category copy without client-side
--   mapping logic.
-- - We still preserve the canonical slug for ranking/analytics.

alter table public.venues
  add column if not exists category_label text;

comment on column public.venues.category_label is
  'Human-readable category (emoji + natural language) derived from venues.category via venue_categories.';

create or replace function public.sync_venue_category_label()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.category is null or btrim(new.category) = '' then
    new.category_label := null;
    return new;
  end if;

  select vc.label
    into new.category_label
    from public.venue_categories vc
   where vc.slug = new.category
   limit 1;

  if new.category_label is null then
    -- Graceful fallback for legacy/non-canonical values.
    new.category_label := initcap(replace(new.category, '_', ' '));
  end if;

  return new;
end;
$function$;

drop trigger if exists venues_sync_category_label on public.venues;
create trigger venues_sync_category_label
before insert or update of category on public.venues
for each row execute function public.sync_venue_category_label();

-- Backfill existing rows.
update public.venues v
   set category_label = coalesce(
     (select c.label from public.venue_categories c where c.slug = v.category limit 1),
     initcap(replace(v.category, '_', ' '))
   )
 where v.category is not null;

update public.venues
   set category_label = null
 where category is null;

notify pgrst, 'reload schema';
