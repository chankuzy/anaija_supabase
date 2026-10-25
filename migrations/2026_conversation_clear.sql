ALTER TABLE public.conversation_participants
  ADD COLUMN IF NOT EXISTS cleared_at timestamp without time zone;
