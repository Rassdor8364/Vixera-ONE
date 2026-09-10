-- Vixera One — context spine, migration 1: types, entities, relationships.
--
-- Principles (see docs/schema.md):
--   * every domain row carries user_id (seam 1), even though there is one user today
--   * provider schemas never leak in: connectors write normalized rows only
--   * the context graph is one typed edge table, validated by trigger
--   * child rows can only reference parents of the same user: composite FKs on (user_id, id)
--   * polymorphic subjects (context_events, conclusions, handoffs.focus) are validated by trigger
--   * everything here is idempotent enough to re-run on a fresh database

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enumerations (mirrored in packages/domain; a test keeps them in sync)
-- ---------------------------------------------------------------------------
create type public.platform as enum ('windows', 'android', 'macos', 'ios', 'ipados', 'web', 'server');
create type public.provider_id as enum ('google', 'microsoft', 'plaid', 'praxion', 'mock');
create type public.connector_capability as enum ('mail', 'calendar', 'bank', 'document');
create type public.connector_account_status as enum ('active', 'paused', 'needs_reauth', 'error', 'disconnected');
create type public.credential_location as enum ('server_vault', 'device', 'none');
create type public.sync_status as enum ('idle', 'running', 'error');
create type public.person_identity_kind as enum ('email', 'phone', 'provider');
create type public.thread_status as enum ('active', 'quiet', 'archived');
create type public.document_source as enum ('mail_attachment', 'share', 'capture', 'drop', 'praxion', 'filesystem', 'handoff', 'connector');
create type public.money_account_type as enum ('checking', 'savings', 'credit', 'loan', 'investment', 'other');
create type public.time_event_status as enum ('confirmed', 'tentative', 'cancelled');
create type public.attention as enum ('needs_attention', 'quiet', 'dismissed');
create type public.handoff_state as enum ('pending', 'delivered', 'accepted', 'expired', 'cancelled');
create type public.ingest_kind as enum ('file', 'image', 'url', 'text');
create type public.ingest_source as enum ('share', 'capture', 'drop', 'clipboard', 'command');
create type public.ingest_status as enum ('received', 'processed', 'failed');
create type public.action_request_status as enum ('queued', 'running', 'done', 'failed');
create type public.entity_type as enum (
  'person', 'thread', 'document', 'mail_message', 'money_account', 'money_transaction',
  'time_event', 'context_event', 'conclusion', 'ingest_item', 'handoff', 'device'
);
create type public.relationship_kind as enum (
  'relates_to', 'belongs_to', 'originated_from', 'has_person', 'has_time', 'has_document',
  'has_money', 'has_mail', 'replaces', 'mentions', 'attached_to', 'about'
);
create type public.relationship_source as enum ('user', 'connector', 'rule', 'model');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.vx_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Users (profile row; identity lives in auth.users)
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
comment on table public.users is 'Vixera profile per auth user. The id IS the user_id used everywhere.';

create or replace function public.vx_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', null))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger vx_on_auth_user_created
  after insert on auth.users
  for each row execute function public.vx_handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  platform public.platform not null,
  name text not null,
  praxion_available boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  constraint devices_user_id_id_unique unique (user_id, id)
);
create index devices_user_idx on public.devices (user_id);

-- ---------------------------------------------------------------------------
-- Connector accounts: one user → many accounts, several per provider
-- ---------------------------------------------------------------------------
create table public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  provider public.provider_id not null,
  external_account_id text not null,
  label text not null,
  address text,
  capabilities public.connector_capability[] not null default '{}',
  status public.connector_account_status not null default 'active',
  credential_location public.credential_location not null default 'none',
  credential_ref text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connector_accounts_unique_account unique (user_id, provider, external_account_id),
  constraint connector_accounts_credential_ref_is_opaque check (credential_ref is null or length(credential_ref) <= 256),
  constraint connector_accounts_user_id_id_unique unique (user_id, id)
);
comment on column public.connector_accounts.credential_ref is 'Opaque reference into the credential store (Vault id or device keychain key). Never a secret.';
create index connector_accounts_user_idx on public.connector_accounts (user_id, provider);
create trigger connector_accounts_updated_at before update on public.connector_accounts
  for each row execute function public.vx_set_updated_at();

-- Independent sync state per (account, capability). One failure never blocks the rest.
create table public.connector_sync_states (
  connector_account_id uuid not null,
  capability public.connector_capability not null,
  user_id uuid not null references public.users (id) on delete cascade,
  enabled boolean not null default true,
  status public.sync_status not null default 'idle',
  checkpoint jsonb,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  consecutive_failures integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (connector_account_id, capability),
  constraint connector_sync_states_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete cascade
);
create index connector_sync_states_user_idx on public.connector_sync_states (user_id);
create trigger connector_sync_states_updated_at before update on public.connector_sync_states
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- People + identities
-- ---------------------------------------------------------------------------
create table public.people (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  display_name text not null,
  primary_email text,
  organization text,
  notes text,
  merged_into_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint people_merged_into_fkey foreign key (user_id, merged_into_id) references public.people (user_id, id) on delete set null (merged_into_id),
  constraint people_user_id_id_unique unique (user_id, id)
);
create index people_user_idx on public.people (user_id);
create index people_user_name_idx on public.people (user_id, lower(display_name));
create trigger people_updated_at before update on public.people
  for each row execute function public.vx_set_updated_at();

create table public.person_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  person_id uuid not null,
  kind public.person_identity_kind not null,
  value text not null,
  raw_value text not null,
  provider text,
  connector_account_id uuid,
  created_at timestamptz not null default now(),
  constraint person_identities_unique_value unique (user_id, kind, value),
  constraint person_identities_person_fkey foreign key (user_id, person_id) references public.people (user_id, id) on delete cascade,
  constraint person_identities_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete set null (connector_account_id)
);
create index person_identities_person_idx on public.person_identities (person_id);

-- ---------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null,
  kind text,
  status public.thread_status not null default 'active',
  summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint threads_user_id_id_unique unique (user_id, id)
);
create index threads_user_idx on public.threads (user_id, status);
create trigger threads_updated_at before update on public.threads
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Documents (context only — Praxion owns rendering/editing state)
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  title text not null,
  mime_type text,
  source public.document_source not null,
  connector_account_id uuid,
  source_ref jsonb not null default '{}'::jsonb,
  location jsonb not null default '{"kind":"none"}'::jsonb,
  praxion_document_id text,
  size_bytes bigint,
  content_hash text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete set null (connector_account_id),
  constraint documents_user_id_id_unique unique (user_id, id)
);
create index documents_user_idx on public.documents (user_id, updated_at desc);
create index documents_user_hash_idx on public.documents (user_id, content_hash) where content_hash is not null;
create index documents_praxion_idx on public.documents (user_id, praxion_document_id) where praxion_document_id is not null;
create trigger documents_updated_at before update on public.documents
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Mail (input to context)
-- ---------------------------------------------------------------------------
create table public.mail_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  connector_account_id uuid not null,
  external_id text not null,
  external_thread_id text,
  subject text,
  snippet text,
  body_text text,
  from_address text,
  from_name text,
  from_person_id uuid,
  to_addresses jsonb not null default '[]'::jsonb,
  cc_addresses jsonb not null default '[]'::jsonb,
  sent_at timestamptz,
  received_at timestamptz not null,
  is_unread boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  labels text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mail_messages_unique_external unique (user_id, connector_account_id, external_id),
  constraint mail_messages_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete cascade,
  constraint mail_messages_from_person_fkey foreign key (user_id, from_person_id) references public.people (user_id, id) on delete set null (from_person_id)
);
create index mail_messages_user_received_idx on public.mail_messages (user_id, received_at desc);
create index mail_messages_thread_idx on public.mail_messages (connector_account_id, external_thread_id);
create index mail_messages_from_person_idx on public.mail_messages (from_person_id) where from_person_id is not null;
create trigger mail_messages_updated_at before update on public.mail_messages
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Money (read only in Phase 1)
-- ---------------------------------------------------------------------------
create table public.money_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  connector_account_id uuid not null,
  external_id text not null,
  name text not null,
  official_name text,
  type public.money_account_type not null default 'other',
  currency char(3) not null,
  balance_current numeric(20, 4),
  balance_available numeric(20, 4),
  balance_as_of timestamptz,
  mask text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint money_accounts_unique_external unique (user_id, connector_account_id, external_id),
  constraint money_accounts_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete cascade,
  constraint money_accounts_user_id_id_unique unique (user_id, id)
);
create index money_accounts_user_idx on public.money_accounts (user_id);
create trigger money_accounts_updated_at before update on public.money_accounts
  for each row execute function public.vx_set_updated_at();

create table public.money_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  connector_account_id uuid not null,
  money_account_id uuid not null,
  external_id text not null,
  amount numeric(20, 4) not null,
  currency char(3) not null,
  description text not null,
  merchant_name text,
  posted_on date not null,
  authorized_at timestamptz,
  pending boolean not null default false,
  category text[] not null default '{}',
  counterparty_person_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint money_transactions_unique_external unique (user_id, connector_account_id, external_id),
  constraint money_transactions_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete cascade,
  constraint money_transactions_money_account_fkey foreign key (user_id, money_account_id) references public.money_accounts (user_id, id) on delete cascade,
  constraint money_transactions_counterparty_fkey foreign key (user_id, counterparty_person_id) references public.people (user_id, id) on delete set null (counterparty_person_id)
);
comment on column public.money_transactions.amount is 'Signed: negative leaves the account, positive arrives. Provider sign conventions are normalized by the connector.';
create index money_transactions_user_posted_idx on public.money_transactions (user_id, posted_on desc);
create index money_transactions_account_idx on public.money_transactions (money_account_id, posted_on desc);
create trigger money_transactions_updated_at before update on public.money_transactions
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Time (calendar as input to context)
-- ---------------------------------------------------------------------------
create table public.time_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  connector_account_id uuid not null,
  external_calendar_id text not null,
  external_id text not null,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  timezone text,
  location text,
  status public.time_event_status not null default 'confirmed',
  organizer jsonb,
  participants jsonb not null default '[]'::jsonb,
  external_link text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint time_events_unique_external unique (user_id, connector_account_id, external_calendar_id, external_id),
  constraint time_events_range check (ends_at >= starts_at),
  constraint time_events_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete cascade
);
create index time_events_user_start_idx on public.time_events (user_id, starts_at);
create trigger time_events_updated_at before update on public.time_events
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Context events (what NOW / Quiet derive from)
-- ---------------------------------------------------------------------------
create table public.context_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  kind text not null,
  subject_type public.entity_type not null,
  subject_id uuid not null,
  title text not null,
  summary text,
  occurred_at timestamptz not null default now(),
  importance smallint not null default 50 check (importance between 0 and 100),
  due_at timestamptz,
  attention public.attention not null default 'needs_attention',
  connector_account_id uuid,
  dedupe_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint context_events_dedupe unique (user_id, dedupe_key),
  constraint context_events_account_fkey foreign key (user_id, connector_account_id) references public.connector_accounts (user_id, id) on delete set null (connector_account_id)
);
create index context_events_user_occurred_idx on public.context_events (user_id, attention, occurred_at desc);
create index context_events_subject_idx on public.context_events (subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- Conclusions (Vixera's own understanding, attached to entities)
-- ---------------------------------------------------------------------------
create table public.conclusions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  subject_type public.entity_type not null,
  subject_id uuid not null,
  text text not null,
  produced_by text not null,
  confidence numeric(4, 3) not null default 1 check (confidence between 0 and 1),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index conclusions_subject_idx on public.conclusions (user_id, subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- Ingest items (explicit share / capture / drop → one pipeline)
-- ---------------------------------------------------------------------------
create table public.ingest_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  device_id uuid,
  kind public.ingest_kind not null,
  source public.ingest_source not null,
  title text,
  text_content text,
  url text,
  mime_type text,
  size_bytes bigint,
  storage_path text,
  status public.ingest_status not null default 'received',
  document_id uuid,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint ingest_items_device_fkey foreign key (user_id, device_id) references public.devices (user_id, id) on delete set null (device_id),
  constraint ingest_items_document_fkey foreign key (user_id, document_id) references public.documents (user_id, id) on delete set null (document_id)
);
create index ingest_items_user_status_idx on public.ingest_items (user_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Handoffs (Vixera-owned cross-device context transfer)
-- ---------------------------------------------------------------------------
create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  source_device_id uuid not null,
  target_device_id uuid,
  state public.handoff_state not null default 'pending',
  focus_type public.entity_type,
  focus_id uuid,
  thread_id uuid,
  document_id uuid,
  artifact_storage_path text,
  praxion_location jsonb,
  conclusions text[] not null default '{}',
  command_history text[] not null default '{}',
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  accepted_at timestamptz,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint handoffs_focus_pair check ((focus_type is null) = (focus_id is null)),
  constraint handoffs_source_device_fkey foreign key (user_id, source_device_id) references public.devices (user_id, id) on delete cascade,
  constraint handoffs_target_device_fkey foreign key (user_id, target_device_id) references public.devices (user_id, id) on delete set null (target_device_id),
  constraint handoffs_thread_fkey foreign key (user_id, thread_id) references public.threads (user_id, id) on delete set null (thread_id),
  constraint handoffs_document_fkey foreign key (user_id, document_id) references public.documents (user_id, id) on delete set null (document_id)
);
create index handoffs_user_state_idx on public.handoffs (user_id, state, created_at desc);

-- ---------------------------------------------------------------------------
-- Action requests (server-side action audit + idempotency)
-- ---------------------------------------------------------------------------
create table public.action_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  action_type text not null,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status public.action_request_status not null default 'queued',
  result jsonb,
  error text,
  attempts integer not null default 0,
  actor_device_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint action_requests_idempotent unique (user_id, idempotency_key),
  constraint action_requests_device_fkey foreign key (user_id, actor_device_id) references public.devices (user_id, id) on delete set null (actor_device_id)
);
create index action_requests_user_status_idx on public.action_requests (user_id, status, created_at desc);
create trigger action_requests_updated_at before update on public.action_requests
  for each row execute function public.vx_set_updated_at();

-- ---------------------------------------------------------------------------
-- Relationships: the context graph
-- ---------------------------------------------------------------------------
create table public.relationships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  from_type public.entity_type not null,
  from_id uuid not null,
  kind public.relationship_kind not null,
  to_type public.entity_type not null,
  to_id uuid not null,
  confidence numeric(4, 3) not null default 1 check (confidence between 0 and 1),
  source public.relationship_source not null default 'user',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint relationships_natural_key unique (user_id, from_type, from_id, kind, to_type, to_id),
  constraint relationships_no_self check (not (from_type = to_type and from_id = to_id))
);
create index relationships_from_idx on public.relationships (user_id, from_type, from_id);
create index relationships_to_idx on public.relationships (user_id, to_type, to_id);

-- Table name for an entity type.
create or replace function public.vx_entity_table(p_type public.entity_type)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_type
    when 'person' then 'people'
    when 'thread' then 'threads'
    when 'document' then 'documents'
    when 'mail_message' then 'mail_messages'
    when 'money_account' then 'money_accounts'
    when 'money_transaction' then 'money_transactions'
    when 'time_event' then 'time_events'
    when 'context_event' then 'context_events'
    when 'conclusion' then 'conclusions'
    when 'ingest_item' then 'ingest_items'
    when 'handoff' then 'handoffs'
    when 'device' then 'devices'
  end;
$$;

-- True when the entity exists AND belongs to the user. Polymorphic FK.
create or replace function public.vx_entity_exists(p_type public.entity_type, p_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  ok boolean;
begin
  execute format('select exists (select 1 from public.%I where id = $1 and user_id = $2)', public.vx_entity_table(p_type))
    into ok using p_id, p_user_id;
  return coalesce(ok, false);
end;
$$;

create or replace function public.vx_validate_relationship()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.vx_entity_exists(new.from_type, new.from_id, new.user_id) then
    raise exception 'relationship source % % does not exist for user', new.from_type, new.from_id
      using errcode = 'foreign_key_violation';
  end if;
  if not public.vx_entity_exists(new.to_type, new.to_id, new.user_id) then
    raise exception 'relationship target % % does not exist for user', new.to_type, new.to_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger relationships_validate before insert or update on public.relationships
  for each row execute function public.vx_validate_relationship();

-- context_events.subject, conclusions.subject and handoffs.focus are polymorphic
-- references too; validate them the same way (existence AND ownership).
create or replace function public.vx_validate_subject()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if not public.vx_entity_exists(new.subject_type, new.subject_id, new.user_id) then
    raise exception 'subject % % does not exist for user', new.subject_type, new.subject_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create or replace function public.vx_validate_handoff_focus()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.focus_type is not null and not public.vx_entity_exists(new.focus_type, new.focus_id, new.user_id) then
    raise exception 'handoff focus % % does not exist for user', new.focus_type, new.focus_id
      using errcode = 'foreign_key_violation';
  end if;
  return new;
end;
$$;

create trigger context_events_validate before insert or update on public.context_events
  for each row execute function public.vx_validate_subject();
create trigger conclusions_validate before insert or update on public.conclusions
  for each row execute function public.vx_validate_subject();
create trigger handoffs_validate before insert or update on public.handoffs
  for each row execute function public.vx_validate_handoff_focus();

-- When an entity disappears, its edges, events and conclusions go with it.
create or replace function public.vx_on_entity_deleted()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  t public.entity_type := tg_argv[0]::public.entity_type;
begin
  delete from public.relationships
    where user_id = old.user_id
      and ((from_type = t and from_id = old.id) or (to_type = t and to_id = old.id));
  delete from public.context_events where user_id = old.user_id and subject_type = t and subject_id = old.id;
  delete from public.conclusions where user_id = old.user_id and subject_type = t and subject_id = old.id;
  return old;
end;
$$;

create trigger people_entity_deleted after delete on public.people for each row execute function public.vx_on_entity_deleted('person');
create trigger threads_entity_deleted after delete on public.threads for each row execute function public.vx_on_entity_deleted('thread');
create trigger documents_entity_deleted after delete on public.documents for each row execute function public.vx_on_entity_deleted('document');
create trigger mail_messages_entity_deleted after delete on public.mail_messages for each row execute function public.vx_on_entity_deleted('mail_message');
create trigger money_accounts_entity_deleted after delete on public.money_accounts for each row execute function public.vx_on_entity_deleted('money_account');
create trigger money_transactions_entity_deleted after delete on public.money_transactions for each row execute function public.vx_on_entity_deleted('money_transaction');
create trigger time_events_entity_deleted after delete on public.time_events for each row execute function public.vx_on_entity_deleted('time_event');
create trigger context_events_entity_deleted after delete on public.context_events for each row execute function public.vx_on_entity_deleted('context_event');
create trigger conclusions_entity_deleted after delete on public.conclusions for each row execute function public.vx_on_entity_deleted('conclusion');
create trigger ingest_items_entity_deleted after delete on public.ingest_items for each row execute function public.vx_on_entity_deleted('ingest_item');
create trigger handoffs_entity_deleted after delete on public.handoffs for each row execute function public.vx_on_entity_deleted('handoff');
create trigger devices_entity_deleted after delete on public.devices for each row execute function public.vx_on_entity_deleted('device');

-- Neighbors of an entity in either direction. Used by the Field and One Command.
create or replace function public.vx_neighbors(p_type public.entity_type, p_id uuid)
returns table (
  relationship_id uuid,
  kind public.relationship_kind,
  direction text,
  neighbor_type public.entity_type,
  neighbor_id uuid,
  confidence numeric,
  source public.relationship_source
)
language sql
stable
set search_path = ''
as $$
  select r.id, r.kind, 'out'::text, r.to_type, r.to_id, r.confidence, r.source
    from public.relationships r
    where r.from_type = p_type and r.from_id = p_id
  union all
  select r.id, r.kind, 'in'::text, r.from_type, r.from_id, r.confidence, r.source
    from public.relationships r
    where r.to_type = p_type and r.to_id = p_id;
$$;

-- Idempotent edge creation used by the linker and by server actions.
create or replace function public.vx_relate(
  p_user_id uuid,
  p_from_type public.entity_type, p_from_id uuid,
  p_kind public.relationship_kind,
  p_to_type public.entity_type, p_to_id uuid,
  p_confidence numeric default 1,
  p_source public.relationship_source default 'user',
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.relationships (user_id, from_type, from_id, kind, to_type, to_id, confidence, source, metadata)
  values (p_user_id, p_from_type, p_from_id, p_kind, p_to_type, p_to_id, p_confidence, p_source, p_metadata)
  on conflict (user_id, from_type, from_id, kind, to_type, to_id)
    do update set confidence = greatest(public.relationships.confidence, excluded.confidence)
  returning id into v_id;
  return v_id;
end;
$$;
