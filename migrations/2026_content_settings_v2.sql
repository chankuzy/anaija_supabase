ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS allow_story_sharing boolean;
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS feed_start_muted boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS feed_autoplay_video boolean NOT NULL DEFAULT true;
