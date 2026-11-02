create table public.sets (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  cards jsonb not null default '[]',
  best_match real,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sets_user_id_idx on public.sets (user_id);

alter table public.sets enable row level security;

create policy "Users manage own sets" on public.sets
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.sets to authenticated;
