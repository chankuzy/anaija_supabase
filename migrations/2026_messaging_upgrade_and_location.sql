-- Migration: 2026_messaging_upgrade_and_location.sql
-- Supports per-user message deletion and structured location metadata for listings.

-- 1. Per-user message deletion tracking (Delete for me)
CREATE TABLE IF NOT EXISTS public.message_deletions (
  message_id bigint NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamp without time zone DEFAULT now(),
  CONSTRAINT message_deletions_pkey PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_deletions_user_id ON public.message_deletions(user_id);

-- 2. Structured location metadata on listing_details
ALTER TABLE public.listing_details
  ADD COLUMN IF NOT EXISTS location_info jsonb;
