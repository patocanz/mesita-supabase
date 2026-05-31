-- 0061 — venue_categories lookup table.
--
-- Mesita's controlled category vocabulary: 100 categories in two sections
-- (50 Food & Nightlife + 50 Experiences & Wellness). "slug" is the canonical,
-- restaurant-stripped machine value (mexican, night_club, padel_club); "label"
-- is the emoji + natural-language display name. Canonical source is the Notion
-- "Categories" DB; this table mirrors it for app use.
--
-- Like membership_tiers, this is non-secret config: world-readable, writes are
-- service-role only (RLS on, no write policy). The seed lives in
-- seed_venue_categories() so this migration and admin_reset_database() share one
-- source of truth; a reset re-seeds idempotently (config is never truncated).

create table public.venue_categories (
  slug       text primary key,
  label      text not null,
  section    text not null check (section in ('Food & Nightlife', 'Experiences & Wellness')),
  sort_order smallint not null,
  created_at timestamptz not null default now()
);

create or replace function public.seed_venue_categories()
returns void
language sql
set search_path = ''
as $function$
  insert into public.venue_categories (slug, label, section, sort_order) values
    ('mexican', '🌮 Mexican', 'Food & Nightlife', 1),
    ('taco', '🌮 Tacos', 'Food & Nightlife', 2),
    ('seafood', '🦐 Seafood', 'Food & Nightlife', 3),
    ('steak_house', '🥩 Steakhouse', 'Food & Nightlife', 4),
    ('italian', '🍝 Italian', 'Food & Nightlife', 5),
    ('pizza', '🍕 Pizza', 'Food & Nightlife', 6),
    ('japanese', '🍱 Japanese', 'Food & Nightlife', 7),
    ('sushi', '🍣 Sushi', 'Food & Nightlife', 8),
    ('ramen', '🍜 Ramen', 'Food & Nightlife', 9),
    ('chinese', '🥡 Chinese', 'Food & Nightlife', 10),
    ('thai', '🌶️ Thai', 'Food & Nightlife', 11),
    ('korean', '🍲 Korean', 'Food & Nightlife', 12),
    ('vietnamese', '🍜 Vietnamese', 'Food & Nightlife', 13),
    ('indian', '🍛 Indian', 'Food & Nightlife', 14),
    ('middle_eastern', '🧆 Middle Eastern', 'Food & Nightlife', 15),
    ('mediterranean', '🫒 Mediterranean', 'Food & Nightlife', 16),
    ('greek', '🥙 Greek', 'Food & Nightlife', 17),
    ('spanish', '🥘 Spanish', 'Food & Nightlife', 18),
    ('french', '🥐 French', 'Food & Nightlife', 19),
    ('american', '🍟 American', 'Food & Nightlife', 20),
    ('argentinian', '🥩 Argentinian', 'Food & Nightlife', 21),
    ('brazilian', '🍖 Brazilian', 'Food & Nightlife', 22),
    ('peruvian', '🐟 Peruvian', 'Food & Nightlife', 23),
    ('asian_fusion', '🥢 Asian Fusion', 'Food & Nightlife', 24),
    ('burger', '🍔 Burgers', 'Food & Nightlife', 25),
    ('sandwich', '🥪 Sandwiches', 'Food & Nightlife', 26),
    ('bbq', '🍖 BBQ', 'Food & Nightlife', 27),
    ('breakfast', '🍳 Breakfast', 'Food & Nightlife', 28),
    ('brunch', '🥞 Brunch', 'Food & Nightlife', 29),
    ('vegan', '🌱 Vegan', 'Food & Nightlife', 30),
    ('vegetarian', '🥬 Vegetarian', 'Food & Nightlife', 31),
    ('healthy', '🥑 Healthy', 'Food & Nightlife', 32),
    ('salad', '🥗 Salads', 'Food & Nightlife', 33),
    ('fast_food', '🍟 Fast Food', 'Food & Nightlife', 34),
    ('fine_dining', '🍽️ Fine Dining', 'Food & Nightlife', 35),
    ('food_truck', '🚚 Food Truck', 'Food & Nightlife', 36),
    ('buffet', '🍲 Buffet', 'Food & Nightlife', 37),
    ('deli', '🥓 Deli', 'Food & Nightlife', 38),
    ('cafe', '☕ Café', 'Food & Nightlife', 39),
    ('coffee_shop', '☕ Coffee Shop', 'Food & Nightlife', 40),
    ('bakery', '🥐 Bakery', 'Food & Nightlife', 41),
    ('dessert_shop', '🍰 Desserts', 'Food & Nightlife', 42),
    ('ice_cream', '🍦 Ice Cream', 'Food & Nightlife', 43),
    ('juice_bar', '🧃 Juice Bar', 'Food & Nightlife', 44),
    ('bar', '🍺 Bar', 'Food & Nightlife', 45),
    ('pub', '🍺 Pub', 'Food & Nightlife', 46),
    ('cocktail_bar', '🍸 Cocktail Bar', 'Food & Nightlife', 47),
    ('wine_bar', '🍷 Wine Bar', 'Food & Nightlife', 48),
    ('brewery', '🍻 Brewery', 'Food & Nightlife', 49),
    ('night_club', '🪩 Nightclub', 'Food & Nightlife', 50),
    ('bowling_alley', '🎳 Bowling', 'Experiences & Wellness', 51),
    ('karaoke', '🎤 Karaoke', 'Experiences & Wellness', 52),
    ('escape_room', '🗝️ Escape Room', 'Experiences & Wellness', 53),
    ('arcade', '🕹️ Arcade', 'Experiences & Wellness', 54),
    ('billiards', '🎱 Billiards', 'Experiences & Wellness', 55),
    ('board_game_cafe', '🎲 Board Game Café', 'Experiences & Wellness', 56),
    ('virtual_golf', '⛳ Virtual Golf', 'Experiences & Wellness', 57),
    ('mini_golf', '⛳ Mini Golf', 'Experiences & Wellness', 58),
    ('laser_tag', '🔫 Laser Tag', 'Experiences & Wellness', 59),
    ('axe_throwing', '🪓 Axe Throwing', 'Experiences & Wellness', 60),
    ('trampoline_park', '🤸 Trampoline Park', 'Experiences & Wellness', 61),
    ('go_kart', '🏎️ Go-Karts', 'Experiences & Wellness', 62),
    ('movie_theater', '🎬 Movie Theater', 'Experiences & Wellness', 63),
    ('amusement_park', '🎡 Amusement Park', 'Experiences & Wellness', 64),
    ('water_park', '🌊 Water Park', 'Experiences & Wellness', 65),
    ('casino', '🎰 Casino', 'Experiences & Wellness', 66),
    ('gym', '💪 Gym', 'Experiences & Wellness', 67),
    ('yoga_studio', '🧘 Yoga Studio', 'Experiences & Wellness', 68),
    ('pilates_studio', '🧘 Pilates Studio', 'Experiences & Wellness', 69),
    ('crossfit_box', '🏋️ CrossFit', 'Experiences & Wellness', 70),
    ('climbing_gym', '🧗 Climbing Gym', 'Experiences & Wellness', 71),
    ('padel_club', '🎾 Padel Club', 'Experiences & Wellness', 72),
    ('tennis_club', '🎾 Tennis Club', 'Experiences & Wellness', 73),
    ('golf_course', '⛳ Golf Course', 'Experiences & Wellness', 74),
    ('soccer_field', '⚽ Soccer Field', 'Experiences & Wellness', 75),
    ('swimming_pool', '🏊 Swimming Pool', 'Experiences & Wellness', 76),
    ('dance_studio', '💃 Dance Studio', 'Experiences & Wellness', 77),
    ('martial_arts', '🥋 Martial Arts', 'Experiences & Wellness', 78),
    ('spa', '💆 Spa', 'Experiences & Wellness', 79),
    ('temazcal', '🔥 Temazcal', 'Experiences & Wellness', 80),
    ('hot_springs', '♨️ Hot Springs', 'Experiences & Wellness', 81),
    ('massage', '💆 Massage', 'Experiences & Wellness', 82),
    ('sauna', '🧖 Sauna', 'Experiences & Wellness', 83),
    ('barbershop', '💈 Barbershop', 'Experiences & Wellness', 84),
    ('hair_salon', '💇 Hair Salon', 'Experiences & Wellness', 85),
    ('nail_salon', '💅 Nail Salon', 'Experiences & Wellness', 86),
    ('beauty_salon', '💄 Beauty Salon', 'Experiences & Wellness', 87),
    ('wellness_center', '🌿 Wellness Center', 'Experiences & Wellness', 88),
    ('tattoo_studio', '🖋️ Tattoo Studio', 'Experiences & Wellness', 89),
    ('medical_spa', '💉 Medical Spa', 'Experiences & Wellness', 90),
    ('museum', '🏛️ Museum', 'Experiences & Wellness', 91),
    ('art_gallery', '🖼️ Art Gallery', 'Experiences & Wellness', 92),
    ('aquarium', '🐠 Aquarium', 'Experiences & Wellness', 93),
    ('zoo', '🦁 Zoo', 'Experiences & Wellness', 94),
    ('observation_deck', '🌆 Observation Deck', 'Experiences & Wellness', 95),
    ('winery', '🍷 Winery', 'Experiences & Wellness', 96),
    ('theater', '🎭 Theater', 'Experiences & Wellness', 97),
    ('concert_venue', '🎸 Concert Venue', 'Experiences & Wellness', 98),
    ('botanical_garden', '🌷 Botanical Garden', 'Experiences & Wellness', 99),
    ('cultural_center', '🎟️ Cultural Center', 'Experiences & Wellness', 100)
  on conflict (slug) do update set
    label      = excluded.label,
    section    = excluded.section,
    sort_order = excluded.sort_order;
$function$;

select public.seed_venue_categories();

alter table public.venue_categories enable row level security;

create policy venue_categories_select_all on public.venue_categories
  for select using (true);

grant select on public.venue_categories to anon, authenticated;

-- Extend the reset routine: venue_categories is config (like membership_tiers),
-- so it is NOT truncated — it is re-seeded idempotently so a reset always leaves
-- the full 100-category vocabulary present.
create or replace function public.admin_reset_database()
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'auth'
as $function$
declare
  deleted_users bigint;
begin
  truncate table
    public.consumer_subscriptions,
    public.stripe_events,
    public.reservations,
    public.coupons,
    public.saved_venues,
    public.cashback_ledger,
    public.tickets,
    public.venue_verifications,
    public.business_invites,
    public.staff_invites,
    public.venue_roles,
    public.venue_members,
    public.venues,
    public.consumers,
    public.businesses
  restart identity cascade;

  -- Re-seed membership config so a fresh env always has both tiers.
  insert into public.membership_tiers
    (key, label, rank, follower_threshold, monthly_reservation_limit, price_cents, currency, recommendation_weight)
  values
    ('free',    'Free',    0, null, 2,    0,     'MXN', 1.0),
    ('premium', 'Premium', 1, 1000, null, 20000, 'MXN', 1.5)
  on conflict (key) do update set
    label                     = excluded.label,
    rank                      = excluded.rank,
    follower_threshold        = excluded.follower_threshold,
    monthly_reservation_limit = excluded.monthly_reservation_limit,
    price_cents               = excluded.price_cents,
    currency                  = excluded.currency,
    recommendation_weight     = excluded.recommendation_weight;

  -- Re-seed the category vocabulary (config, never truncated).
  perform public.seed_venue_categories();

  delete from auth.users u
  where u.email is null
     or lower(u.email) not in (
       select lower(email) from public.super_admins
     );
  get diagnostics deleted_users = row_count;

  return jsonb_build_object(
    'ok', true,
    'deleted_auth_users', deleted_users,
    'reset_at', now()
  );
end;
$function$;

notify pgrst, 'reload schema';
