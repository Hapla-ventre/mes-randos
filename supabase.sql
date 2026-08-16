-- À coller dans Supabase > SQL Editor > New query > Run

create table if not exists hikes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) default auth.uid(),
  name text not null,
  date date,
  notes text,
  coordinates jsonb not null,       -- [[lat, lng], ...] tracé cliqué par l'utilisateur
  elevations jsonb,                 -- [alt_m, ...] échantillonné le long du tracé densifié
  distance_km numeric,
  elevation_gain_m numeric,
  elevation_loss_m numeric,
  created_at timestamptz not null default now()
);

alter table hikes enable row level security;

create policy "Users can view their own hikes"
  on hikes for select
  using (auth.uid() = user_id);

create policy "Users can insert their own hikes"
  on hikes for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own hikes"
  on hikes for update
  using (auth.uid() = user_id);

create policy "Users can delete their own hikes"
  on hikes for delete
  using (auth.uid() = user_id);
