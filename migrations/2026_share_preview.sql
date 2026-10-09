-- Old shares stored the raw type as the inbox preview.
update public.conversations
set last_message_body = 'Shared a post'
where last_message_body = '[post_share]';
