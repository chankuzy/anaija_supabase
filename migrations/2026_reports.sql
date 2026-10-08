CREATE TABLE IF NOT EXISTS public.reports (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  category text NOT NULL CHECK (category IN ('bug','account','marketplace','safety','suggestion')),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reports_pkey PRIMARY KEY (id),
  CONSTRAINT reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE INDEX IF NOT EXISTS reports_user_created_idx ON public.reports (user_id, created_at DESC);
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
