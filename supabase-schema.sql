create table if not exists public.tasks (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  description text not null default '',
  category text not null check (category in ('Study', 'Work', 'Personal', 'Other')),
  priority text not null check (priority in ('low', 'medium', 'high')),
  due_date date,
  status text not null check (status in ('pending', 'in-progress', 'completed')),
  favorite boolean not null default false,
  subtasks jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  source_id text,
  primary key (user_id, id)
);

alter table public.tasks add column if not exists favorite boolean not null default false;
alter table public.tasks add column if not exists subtasks jsonb not null default '[]'::jsonb;

alter table public.tasks enable row level security;

revoke all on public.tasks from anon;
grant select, insert, update, delete on public.tasks to authenticated;

drop policy if exists "Users can read their own tasks" on public.tasks;
create policy "Users can read their own tasks"
  on public.tasks for select
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own tasks" on public.tasks;
create policy "Users can create their own tasks"
  on public.tasks for insert
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own tasks" on public.tasks;
create policy "Users can update their own tasks"
  on public.tasks for update
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own tasks" on public.tasks;
create policy "Users can delete their own tasks"
  on public.tasks for delete
  using ((select auth.uid()) = user_id);
