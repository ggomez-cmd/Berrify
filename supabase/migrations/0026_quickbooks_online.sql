-- QuickBooks Online connections, vendors, and accounts.
-- Per restaurant. Additive. Apply with `npm run db:apply`, not db:push.
-- Does not drop invoice tables. Does not touch public.shifts or payroll.
-- Refresh and access tokens are service-role only.

create table if not exists public.quickbooks_online_connections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  realm_id text not null,
  refresh_token text,
  access_token text,
  access_token_expires_at timestamptz,
  company_name text,
  is_active boolean not null default true,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, restaurant_id),
  unique (org_id, realm_id)
);

create index if not exists quickbooks_online_connections_org_id_idx
  on public.quickbooks_online_connections (org_id);

create table if not exists public.quickbooks_online_oauth_states (
  state text primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  restaurant_id uuid not null references public.restaurants (id) on delete cascade,
  created_by uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists quickbooks_online_oauth_states_expires_at_idx
  on public.quickbooks_online_oauth_states (expires_at);

create table if not exists public.quickbooks_online_vendors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null references public.quickbooks_online_connections (id) on delete cascade,
  list_id text not null,
  full_name text not null,
  company_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, list_id)
);

create index if not exists quickbooks_online_vendors_org_id_idx
  on public.quickbooks_online_vendors (org_id);

create index if not exists quickbooks_online_vendors_connection_id_idx
  on public.quickbooks_online_vendors (connection_id);

create table if not exists public.quickbooks_online_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null references public.quickbooks_online_connections (id) on delete cascade,
  list_id text not null,
  full_name text not null,
  account_number text,
  account_type text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, list_id)
);

create index if not exists quickbooks_online_accounts_org_id_idx
  on public.quickbooks_online_accounts (org_id);

create index if not exists quickbooks_online_accounts_connection_id_idx
  on public.quickbooks_online_accounts (connection_id);

drop trigger if exists quickbooks_online_connections_set_updated_at on public.quickbooks_online_connections;
create trigger quickbooks_online_connections_set_updated_at
  before update on public.quickbooks_online_connections
  for each row execute function public.set_updated_at();

drop trigger if exists quickbooks_online_vendors_set_updated_at on public.quickbooks_online_vendors;
create trigger quickbooks_online_vendors_set_updated_at
  before update on public.quickbooks_online_vendors
  for each row execute function public.set_updated_at();

drop trigger if exists quickbooks_online_accounts_set_updated_at on public.quickbooks_online_accounts;
create trigger quickbooks_online_accounts_set_updated_at
  before update on public.quickbooks_online_accounts
  for each row execute function public.set_updated_at();

alter table public.quickbooks_online_connections enable row level security;
alter table public.quickbooks_online_oauth_states enable row level security;
alter table public.quickbooks_online_vendors enable row level security;
alter table public.quickbooks_online_accounts enable row level security;

drop policy if exists quickbooks_online_connections_select_manager on public.quickbooks_online_connections;
create policy quickbooks_online_connections_select_manager on public.quickbooks_online_connections
  for select using (public.has_org_role(org_id, array['owner', 'manager']));

drop policy if exists quickbooks_online_vendors_manager on public.quickbooks_online_vendors;
create policy quickbooks_online_vendors_manager on public.quickbooks_online_vendors
  for all using (public.has_org_role(org_id, array['owner', 'manager']))
  with check (public.has_org_role(org_id, array['owner', 'manager']));

drop policy if exists quickbooks_online_accounts_manager on public.quickbooks_online_accounts;
create policy quickbooks_online_accounts_manager on public.quickbooks_online_accounts
  for all using (public.has_org_role(org_id, array['owner', 'manager']))
  with check (public.has_org_role(org_id, array['owner', 'manager']));

revoke all on public.quickbooks_online_connections from public;
revoke all on public.quickbooks_online_connections from authenticated;
revoke all on public.quickbooks_online_oauth_states from public;
revoke all on public.quickbooks_online_oauth_states from authenticated;
revoke all on public.quickbooks_online_vendors from public;
revoke all on public.quickbooks_online_vendors from authenticated;
revoke all on public.quickbooks_online_accounts from public;
revoke all on public.quickbooks_online_accounts from authenticated;

grant select (
  id,
  org_id,
  restaurant_id,
  realm_id,
  company_name,
  is_active,
  last_synced_at,
  last_error,
  created_at,
  updated_at
) on public.quickbooks_online_connections to authenticated;

grant select, insert, update, delete on public.quickbooks_online_vendors to authenticated;
grant select, insert, update, delete on public.quickbooks_online_accounts to authenticated;

grant all on public.quickbooks_online_connections to service_role;
grant all on public.quickbooks_online_oauth_states to service_role;
grant all on public.quickbooks_online_vendors to service_role;
grant all on public.quickbooks_online_accounts to service_role;
