-- ============================================================
-- MyERP — Supabase schema (fresh / re-runnable version)
-- Run this once in Supabase: Project → SQL Editor → New query → paste → Run
--
-- Safe to run again from scratch: it drops its own objects first, so if
-- something got into a half-broken state while you were testing, this
-- cleans it up. It does NOT delete anyone from Authentication → Users —
-- do that by hand first if you want a totally clean slate.
-- ============================================================

drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop function if exists public.generate_member_id(text);
drop table if exists public.profiles cascade;

-- one row per person, linked 1:1 to Supabase's own auth.users table
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  member_id    text unique,                 -- e.g. STU-83920, FAC-11938, ADM-00001
  role         text not null check (role in ('Student','Faculty','Admin')),
  name         text not null default '',
  email        text not null,
  headline     text not null default '',
  phone        text not null default '',
  address      text not null default '',
  photo        text not null default '',    -- data:image/... URL, same as the old localStorage version
  details      jsonb not null default '{}'::jsonb,  -- role-specific fields, see JS for the field lists
  created_at   timestamptz not null default now()
);

-- lock the table down: everyone can only see/edit THEIR OWN row.
-- Rows are created by the trigger below (which runs with elevated
-- privileges), so ordinary users never need an INSERT policy at all —
-- one less way for this to go wrong.
alter table public.profiles enable row level security;

create policy "read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Generates a friendly, unique ID for a given role and retries on the rare
-- chance of a collision. SECURITY DEFINER so it can check the whole table
-- for duplicates even though callers can normally only see their own row.
create or replace function public.generate_member_id(p_role text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix text;
  candidate text;
begin
  prefix := case p_role
    when 'Student' then 'STU'
    when 'Faculty' then 'FAC'
    else 'ADM'
  end;
  loop
    candidate := prefix || '-' || lpad(floor(random() * 100000)::text, 5, '0');
    exit when not exists (select 1 from public.profiles where member_id = candidate);
  end loop;
  return candidate;
end;
$$;

-- Automatically creates the profile row — including the generated ID — the
-- INSTANT someone signs up, by reading the "user metadata" the sign-up form
-- sends along. This runs inside the database itself (not from the browser),
-- so it always happens exactly once, atomically, even if:
--   • your project has "Confirm email" turned on (no browser session exists
--     yet at that point, so a client-side insert would have nothing to work with)
--   • the person's connection drops right after clicking "Create account"
--   • two people sign up at the exact same instant (generate_member_id
--     re-checks for collisions itself)
--
-- Security note: role is clamped to Student/Faculty here on purpose — since
-- the anon key is public, someone could otherwise call auth.signUp() directly
-- from the browser console with role:"Admin" in the metadata and hand
-- themselves an admin account. Real admin rows are only ever set by you,
-- by hand, see the bottom of this file.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  safe_role text := case when meta->>'role' in ('Student','Faculty') then meta->>'role' else 'Student' end;
begin
  insert into public.profiles (id, member_id, role, name, email, headline, phone, address, details)
  values (
    new.id,
    public.generate_member_id(safe_role),
    safe_role,
    coalesce(meta->>'name', ''),
    new.email,
    coalesce(meta->>'headline', ''),
    coalesce(meta->>'phone', ''),
    coalesce(meta->>'address', ''),
    coalesce(meta->'details', '{}'::jsonb)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Admin accounts are NOT self-registered.
--
-- 1. Authentication → Users → Add user, create the admin's login (email +
--    password). The trigger above fires immediately and gives them a
--    Student profile by default — that's expected, fix it in step 2.
-- 2. Copy their UUID from that same Users screen, then run this
--    (edit the values first) to turn that row into a real Admin row:
-- ============================================================
-- update public.profiles set
--   role       = 'Admin',
--   member_id  = public.generate_member_id('Admin'),
--   name       = 'Rohan Verma',
--   headline   = 'Department administrator',
--   details    = '{"office":"Department office"}'::jsonb
-- where id = 'paste-the-auth-user-uuid-here';
