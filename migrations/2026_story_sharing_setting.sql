ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS allow_story_sharing boolean NOT NULL DEFAULT true;
