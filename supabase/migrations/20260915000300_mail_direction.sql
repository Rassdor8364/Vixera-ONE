-- Vixera One — migration 14: which way a message went.
--
-- Mail the user sent is their own context (who they wrote to, about what);
-- it did not arrive needing them. Until now the Gmail connector marked it
-- only in metadata and the linker scored it as received mail. `direction`
-- makes it a column the linker, the rules and the Field read: `received`
-- (the default, and everything synced before this migration) or `sent`.
alter table public.mail_messages
  add column direction text not null default 'received'
    constraint mail_messages_direction_check check (direction in ('received', 'sent'));
comment on column public.mail_messages.direction is 'received (arrived for the user) or sent (the user wrote it)';
