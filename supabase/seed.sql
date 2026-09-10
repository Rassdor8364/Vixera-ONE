-- Vixera One — DEVELOPMENT seed. Applied by `supabase db reset` locally only.
-- Never applied to a deployed project (`supabase db push` does not run seeds).
--
-- 1. The development identity: a fixed UUID (DEV_USER_ID in packages/domain).
--    The email is only a login credential for the local auth server; the UUID
--    is the identity. Password: vixera-dev-password
-- 2. A small fixture graph so the Field has something to show before any
--    connector is linked. The production Field reads real spine data only.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change, is_sso_user
) values (
  '00000000-0000-4000-8000-000000000001', '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'dev@vixera.local',
  extensions.crypt('vixera-dev-password', extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}'::jsonb, '{"display_name":"Development user"}'::jsonb,
  now(), now(), '', '', '', '', false
) on conflict (id) do nothing;

insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
values (
  '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001', 'email',
  '{"sub":"00000000-0000-4000-8000-000000000001","email":"dev@vixera.local","email_verified":true}'::jsonb,
  now(), now(), now()
) on conflict do nothing;

-- The auth trigger creates public.users; make sure it is there even if the
-- trigger did not fire (e.g. shimmed local Postgres).
insert into public.users (id, display_name)
values ('00000000-0000-4000-8000-000000000001', 'Development user')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Dev fixtures (the brief's example world)
-- ---------------------------------------------------------------------------
insert into public.devices (id, user_id, platform, name, praxion_available)
values
  ('00000000-0000-4000-8000-0000d0000001', '00000000-0000-4000-8000-000000000001', 'windows', 'Dev Windows', false),
  ('00000000-0000-4000-8000-0000d0000002', '00000000-0000-4000-8000-000000000001', 'android', 'Dev Android', false)
on conflict (id) do nothing;

insert into public.connector_accounts (id, user_id, provider, external_account_id, label, address, capabilities, status, credential_location)
values
  ('00000000-0000-4000-8000-0000c0000001', '00000000-0000-4000-8000-000000000001', 'mock', 'mock-mail-1', 'Mock mail (dev)', 'dev@vixera.local', '{mail,calendar}', 'active', 'none'),
  ('00000000-0000-4000-8000-0000c0000002', '00000000-0000-4000-8000-000000000001', 'mock', 'mock-bank-1', 'Mock bank (dev)', null, '{bank}', 'active', 'none')
on conflict (id) do nothing;

insert into public.connector_sync_states (connector_account_id, capability, user_id)
values
  ('00000000-0000-4000-8000-0000c0000001', 'mail', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-0000c0000001', 'calendar', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-0000c0000002', 'bank', '00000000-0000-4000-8000-000000000001')
on conflict do nothing;

insert into public.people (id, user_id, display_name, primary_email, organization)
values
  ('00000000-0000-4000-8000-0000a1000001', '00000000-0000-4000-8000-000000000001', 'Eric Lindqvist', 'eric@lindqvist.studio', 'Lindqvist Studio'),
  ('00000000-0000-4000-8000-0000a1000002', '00000000-0000-4000-8000-000000000001', 'Marta Ruiz', 'marta@ruiz.law', 'Ruiz Legal'),
  ('00000000-0000-4000-8000-0000a1000003', '00000000-0000-4000-8000-000000000001', 'Priya Natarajan', 'priya@northwind.com', 'Northwind Co.')
on conflict (id) do nothing;

insert into public.person_identities (user_id, person_id, kind, value, raw_value)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000a1000001', 'email', 'eric@lindqvist.studio', 'Eric@Lindqvist.studio'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000a1000002', 'email', 'marta@ruiz.law', 'marta@ruiz.law'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000a1000003', 'email', 'priya@northwind.com', 'priya@northwind.com')
on conflict do nothing;

insert into public.threads (id, user_id, title, kind, summary)
values
  ('00000000-0000-4000-8000-0000b1000001', '00000000-0000-4000-8000-000000000001', 'Brand', 'project', 'Brand system with Lindqvist Studio'),
  ('00000000-0000-4000-8000-0000b1000002', '00000000-0000-4000-8000-000000000001', 'Northwind pilot', 'engagement', 'Pilot with Northwind Co.'),
  ('00000000-0000-4000-8000-0000b1000003', '00000000-0000-4000-8000-000000000001', 'Company', 'legal', 'Operating agreement and company matters')
on conflict (id) do nothing;

insert into public.documents (id, user_id, title, mime_type, source, location, metadata)
values
  ('00000000-0000-4000-8000-0000f1000001', '00000000-0000-4000-8000-000000000001', 'Invoice #0231', 'application/pdf', 'mail_attachment', '{"kind":"none"}', '{"amount":"4800.00","currency":"USD","due_on":"2026-09-15","status":"unpaid"}'),
  ('00000000-0000-4000-8000-0000f1000002', '00000000-0000-4000-8000-000000000001', 'Operating agreement v3.pdf', 'application/pdf', 'drop', '{"kind":"none"}', '{"pages":18}')
on conflict (id) do nothing;

insert into public.mail_messages (id, user_id, connector_account_id, external_id, external_thread_id, subject, snippet, from_address, from_name, from_person_id, to_addresses, received_at, attachments)
values
  ('00000000-0000-4000-8000-0000e1000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000c0000001', 'mock-msg-1', 'mock-thr-1',
   'Invoice #0231 — brand system final delivery', 'Hi Daniel, attached is the revised invoice for the brand system…',
   'eric@lindqvist.studio', 'Eric Lindqvist', '00000000-0000-4000-8000-0000a1000001',
   '[{"email":"dev@vixera.local","name":null}]', now() - interval '1 day',
   '[{"attachmentId":"att-1","filename":"invoice-0231.pdf","mimeType":"application/pdf","sizeBytes":118000}]')
on conflict (id) do nothing;

insert into public.time_events (id, user_id, connector_account_id, external_calendar_id, external_id, title, starts_at, ends_at, location, participants)
values
  ('00000000-0000-4000-8000-0000e2000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000c0000001', 'primary', 'mock-evt-1',
   'Northwind kickoff', date_trunc('day', now()) + interval '1 day 15 hours', date_trunc('day', now()) + interval '1 day 15 hours 45 minutes', 'Zoom',
   '[{"email":"priya@northwind.com","name":"Priya Natarajan","response":"accepted","isOrganizer":true,"isSelf":false}]')
on conflict (id) do nothing;

insert into public.money_accounts (id, user_id, connector_account_id, external_id, name, type, currency, balance_current, balance_available, balance_as_of, mask)
values
  ('00000000-0000-4000-8000-0000a2000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000c0000002', 'mock-acct-1', 'Business checking', 'checking', 'USD', 18250.40, 17900.40, now(), '4471')
on conflict (id) do nothing;

insert into public.money_transactions (id, user_id, connector_account_id, money_account_id, external_id, amount, currency, description, merchant_name, posted_on)
values
  ('00000000-0000-4000-8000-0000a3000001', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000c0000002', '00000000-0000-4000-8000-0000a2000001', 'mock-tx-1', 12400.00, 'USD', 'NORTHWIND CO PAYOUT', 'Northwind Co.', current_date - 2),
  ('00000000-0000-4000-8000-0000a3000002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000c0000002', '00000000-0000-4000-8000-0000a2000001', 'mock-tx-2', -2400.00, 'USD', 'LINDQVIST STUDIO DEPOSIT', 'Lindqvist Studio', current_date - 20)
on conflict (id) do nothing;

-- The graph from the brief.
do $$
begin
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'person', '00000000-0000-4000-8000-0000a1000001', 'relates_to', 'document', '00000000-0000-4000-8000-0000f1000001', 1, 'rule');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'document', '00000000-0000-4000-8000-0000f1000001', 'belongs_to', 'thread', '00000000-0000-4000-8000-0000b1000001', 1, 'user');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'document', '00000000-0000-4000-8000-0000f1000001', 'originated_from', 'mail_message', '00000000-0000-4000-8000-0000e1000001', 1, 'connector');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'document', '00000000-0000-4000-8000-0000f1000001', 'relates_to', 'money_transaction', '00000000-0000-4000-8000-0000a3000002', 0.7, 'rule');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'thread', '00000000-0000-4000-8000-0000b1000001', 'has_person', 'person', '00000000-0000-4000-8000-0000a1000001', 1, 'user');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'thread', '00000000-0000-4000-8000-0000b1000002', 'has_person', 'person', '00000000-0000-4000-8000-0000a1000003', 1, 'user');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'thread', '00000000-0000-4000-8000-0000b1000002', 'has_time', 'time_event', '00000000-0000-4000-8000-0000e2000001', 1, 'rule');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'thread', '00000000-0000-4000-8000-0000b1000002', 'has_money', 'money_transaction', '00000000-0000-4000-8000-0000a3000001', 0.8, 'rule');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'thread', '00000000-0000-4000-8000-0000b1000003', 'has_person', 'person', '00000000-0000-4000-8000-0000a1000002', 1, 'user');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'document', '00000000-0000-4000-8000-0000f1000002', 'belongs_to', 'thread', '00000000-0000-4000-8000-0000b1000003', 1, 'user');
  perform public.vx_relate('00000000-0000-4000-8000-000000000001', 'mail_message', '00000000-0000-4000-8000-0000e1000001', 'has_person', 'person', '00000000-0000-4000-8000-0000a1000001', 1, 'connector');
end $$;

insert into public.context_events (user_id, kind, subject_type, subject_id, title, summary, occurred_at, importance, due_at, dedupe_key)
values
  ('00000000-0000-4000-8000-000000000001', 'money.invoice.due', 'document', '00000000-0000-4000-8000-0000f1000001', 'Eric''s invoice is due', '$4,800 · Brand thread · unpaid', now() - interval '1 day', 60, date_trunc('day', now()) + interval '1 day 12 hours', 'seed:invoice-0231-due'),
  ('00000000-0000-4000-8000-000000000001', 'mail.received', 'mail_message', '00000000-0000-4000-8000-0000e1000001', 'Eric sent the revised invoice', 'Invoice #0231 — brand system final delivery', now() - interval '1 day', 40, null, 'seed:mail-1'),
  ('00000000-0000-4000-8000-000000000001', 'time.event.upcoming', 'time_event', '00000000-0000-4000-8000-0000e2000001', 'Northwind kickoff tomorrow 15:00', 'Priya is attending', now() - interval '2 hours', 45, date_trunc('day', now()) + interval '1 day 15 hours', 'seed:evt-1'),
  ('00000000-0000-4000-8000-000000000001', 'money.transaction.posted', 'money_transaction', '00000000-0000-4000-8000-0000a3000001', '$12,400 arrived from Northwind', 'Business checking', now() - interval '2 days', 30, null, 'seed:tx-1')
on conflict (user_id, dedupe_key) do nothing;

insert into public.conclusions (user_id, subject_type, subject_id, text, produced_by, confidence)
values ('00000000-0000-4000-8000-000000000001', 'document', '00000000-0000-4000-8000-0000f1000002', 'Clause 7.1 now covers contractors — would include Eric''s brand work.', 'rule:seed', 0.9);
