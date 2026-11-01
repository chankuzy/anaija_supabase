-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.migrations (
  id integer NOT NULL DEFAULT nextval('migrations_id_seq'::regclass),
  migration character varying NOT NULL,
  batch integer NOT NULL,
  CONSTRAINT migrations_pkey PRIMARY KEY (id)
);
CREATE TABLE public.users (
  id bigint NOT NULL DEFAULT nextval('users_id_seq'::regclass),
  name character varying,
  username character varying UNIQUE,
  email character varying UNIQUE,
  phone character varying UNIQUE,
  avatar character varying,
  avatar_key character varying,
  bio character varying,
  location character varying,
  links json,
  provider character varying NOT NULL DEFAULT 'phone'::character varying CHECK (provider::text = ANY (ARRAY['phone'::character varying, 'google'::character varying, 'facebook'::character varying]::text[])),
  provider_id character varying,
  is_verified boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  profile_completed boolean NOT NULL DEFAULT false,
  phone_verified_at timestamp without time zone,
  email_verified_at timestamp without time zone,
  password character varying,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  deleted_at timestamp without time zone,
  institution_id bigint,
  faculty character varying,
  level character varying,
  campus_role character varying,
  campus_verified boolean NOT NULL DEFAULT false,
  cover_key text,
  cover_url text,
  tagline text,
  allow_story_sharing boolean NOT NULL DEFAULT true,
  feed_start_muted boolean NOT NULL DEFAULT false,
  feed_autoplay_video boolean NOT NULL DEFAULT true,
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT 1 FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.cache (
  key character varying NOT NULL,
  value text NOT NULL,
  expiration bigint NOT NULL,
  CONSTRAINT cache_pkey PRIMARY KEY (key)
);
CREATE TABLE public.cache_locks (
  key character varying NOT NULL,
  owner character varying NOT NULL,
  expiration bigint NOT NULL,
  CONSTRAINT cache_locks_pkey PRIMARY KEY (key)
);
CREATE TABLE public.jobs (
  id bigint NOT NULL DEFAULT nextval('jobs_id_seq'::regclass),
  queue character varying NOT NULL,
  payload text NOT NULL,
  attempts smallint NOT NULL,
  reserved_at integer,
  available_at integer NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT jobs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.job_batches (
  id character varying NOT NULL,
  name character varying NOT NULL,
  total_jobs integer NOT NULL,
  pending_jobs integer NOT NULL,
  failed_jobs integer NOT NULL,
  failed_job_ids text NOT NULL,
  options text,
  cancelled_at integer,
  created_at integer NOT NULL,
  finished_at integer,
  CONSTRAINT job_batches_pkey PRIMARY KEY (id)
);
CREATE TABLE public.failed_jobs (
  id bigint NOT NULL DEFAULT nextval('failed_jobs_id_seq'::regclass),
  uuid character varying NOT NULL UNIQUE,
  connection text NOT NULL,
  queue text NOT NULL,
  payload text NOT NULL,
  exception text NOT NULL,
  failed_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT failed_jobs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.otp_codes (
  id bigint NOT NULL DEFAULT nextval('otp_codes_id_seq'::regclass),
  phone character varying NOT NULL,
  code character varying NOT NULL,
  expires_at timestamp without time zone NOT NULL,
  used boolean NOT NULL DEFAULT false,
  attempts smallint NOT NULL DEFAULT '0'::smallint,
  ip_address character varying,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT otp_codes_pkey PRIMARY KEY (id)
);
CREATE TABLE public.personal_access_tokens (
  id bigint NOT NULL DEFAULT nextval('personal_access_tokens_id_seq'::regclass),
  tokenable_type character varying NOT NULL,
  tokenable_id bigint NOT NULL,
  name text NOT NULL,
  token character varying NOT NULL UNIQUE,
  abilities text,
  last_used_at timestamp without time zone,
  expires_at timestamp without time zone,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT personal_access_tokens_pkey PRIMARY KEY (id)
);
CREATE TABLE public.posts (
  id bigint NOT NULL DEFAULT nextval('posts_id_seq'::regclass),
  user_id bigint NOT NULL,
  caption character varying,
  video_key character varying NOT NULL,
  thumbnail_key character varying,
  duration_seconds integer NOT NULL DEFAULT 0,
  resolutions json,
  processing_status character varying NOT NULL DEFAULT 'pending'::character varying CHECK (processing_status::text = ANY (ARRAY['pending'::character varying, 'processing'::character varying, 'ready'::character varying, 'failed'::character varying]::text[])),
  processing_job_id character varying,
  views_count bigint NOT NULL DEFAULT '0'::bigint,
  likes_count bigint NOT NULL DEFAULT '0'::bigint,
  comments_count bigint NOT NULL DEFAULT '0'::bigint,
  shares_count bigint NOT NULL DEFAULT '0'::bigint,
  reposts_count bigint NOT NULL DEFAULT '0'::bigint,
  engagement_score numeric NOT NULL DEFAULT '0'::numeric,
  is_active boolean NOT NULL DEFAULT true,
  allow_comments boolean NOT NULL DEFAULT true,
  allow_duet boolean NOT NULL DEFAULT true,
  hashtags json,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  deleted_at timestamp without time zone,
  type character varying NOT NULL DEFAULT 'post'::character varying,
  subtype character varying,
  context json,
  visibility character varying NOT NULL DEFAULT 'public'::character varying CHECK (visibility::text = ANY (ARRAY['public'::character varying, 'followers'::character varying, 'campus'::character varying, 'private'::character varying]::text[])),
  expires_at timestamp without time zone,
  latitude numeric,
  longitude numeric,
  is_featured boolean NOT NULL DEFAULT false,
  listing_type character varying,
  search_vector tsvector DEFAULT (setweight(to_tsvector('english'::regconfig, (COALESCE(caption, ''::character varying))::text), 'A'::"char") || setweight(to_tsvector('english'::regconfig, COALESCE((hashtags)::text, ''::text)), 'B'::"char")),
  bookmarks_count integer NOT NULL DEFAULT 0,
  slideshow_config jsonb,
  audio_config jsonb,
  audio_asset_id bigint,
  community_id bigint,
  pinned_at timestamp with time zone,
  client_request_id uuid,
  allow_story_sharing boolean,
  public_since timestamp with time zone,
  institution_id bigint,
  content jsonb,
  community_feed boolean NOT NULL DEFAULT true,
  community_pinned_at timestamp with time zone,
  CONSTRAINT posts_pkey PRIMARY KEY (id),
  CONSTRAINT posts_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT posts_audio_asset_id_fkey FOREIGN KEY (audio_asset_id) REFERENCES public.audio_assets(id),
  CONSTRAINT posts_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT posts_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.post_likes (
  id bigint NOT NULL DEFAULT nextval('post_likes_id_seq'::regclass),
  user_id bigint NOT NULL,
  post_id bigint NOT NULL,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone,
  CONSTRAINT post_likes_pkey PRIMARY KEY (id),
  CONSTRAINT post_likes_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT post_likes_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.comments (
  id bigint NOT NULL DEFAULT nextval('comments_id_seq'::regclass),
  user_id bigint NOT NULL,
  post_id bigint NOT NULL,
  parent_id bigint,
  body character varying NOT NULL,
  likes_count integer NOT NULL DEFAULT 0,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  deleted_at timestamp without time zone,
  CONSTRAINT comments_pkey PRIMARY KEY (id),
  CONSTRAINT comments_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT comments_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT comments_parent_id_foreign FOREIGN KEY (parent_id) REFERENCES public.comments(id)
);
CREATE TABLE public.user_feed_cursors (
  id bigint NOT NULL DEFAULT nextval('user_feed_cursors_id_seq'::regclass),
  user_id bigint NOT NULL UNIQUE,
  last_post_id bigint NOT NULL DEFAULT '0'::bigint,
  last_fetched_at timestamp without time zone,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT user_feed_cursors_pkey PRIMARY KEY (id),
  CONSTRAINT user_feed_cursors_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.bookmarks (
  id bigint NOT NULL DEFAULT nextval('bookmarks_id_seq'::regclass),
  user_id bigint NOT NULL,
  post_id bigint NOT NULL,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone,
  CONSTRAINT bookmarks_pkey PRIMARY KEY (id),
  CONSTRAINT bookmarks_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT bookmarks_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.reposts (
  id bigint NOT NULL DEFAULT nextval('reposts_id_seq'::regclass),
  user_id bigint NOT NULL,
  post_id bigint NOT NULL,
  quote character varying,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone,
  CONSTRAINT reposts_pkey PRIMARY KEY (id),
  CONSTRAINT reposts_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT reposts_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.follows (
  id bigint NOT NULL DEFAULT nextval('follows_id_seq'::regclass),
  follower_id bigint NOT NULL,
  following_id bigint NOT NULL,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  notify_posts boolean NOT NULL DEFAULT false,
  CONSTRAINT follows_pkey PRIMARY KEY (id),
  CONSTRAINT follows_follower_id_foreign FOREIGN KEY (follower_id) REFERENCES public.users(id),
  CONSTRAINT follows_following_id_foreign FOREIGN KEY (following_id) REFERENCES public.users(id)
);
CREATE TABLE public.post_media (
  id bigint NOT NULL DEFAULT nextval('post_media_id_seq'::regclass),
  post_id bigint NOT NULL,
  media_type character varying NOT NULL,
  storage_key character varying NOT NULL,
  hls_key character varying,
  thumbnail_key character varying,
  waveform json,
  width smallint,
  height smallint,
  duration_seconds integer,
  resolutions json,
  processing_status character varying NOT NULL DEFAULT 'pending'::character varying CHECK (processing_status::text = ANY (ARRAY['pending'::character varying, 'processing'::character varying, 'ready'::character varying, 'failed'::character varying]::text[])),
  sort_order smallint NOT NULL DEFAULT '0'::smallint,
  mime_type character varying,
  size_bytes bigint,
  blurhash character varying,
  dominant_color character varying,
  original_width smallint,
  original_height smallint,
  aspect_ratio numeric,
  optimized boolean NOT NULL DEFAULT false,
  waveform_peaks character varying,
  audio_duration numeric,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  purged_at timestamp with time zone,
  CONSTRAINT post_media_pkey PRIMARY KEY (id),
  CONSTRAINT post_media_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.listing_details (
  id bigint NOT NULL DEFAULT nextval('listing_details_id_seq'::regclass),
  post_id bigint NOT NULL UNIQUE,
  price_minor bigint NOT NULL DEFAULT '0'::bigint,
  currency character varying NOT NULL DEFAULT 'NGN'::character varying,
  price_type character varying NOT NULL DEFAULT 'negotiable'::character varying,
  condition character varying,
  status character varying NOT NULL DEFAULT 'available'::character varying,
  contact_preference character varying NOT NULL DEFAULT 'chat'::character varying,
  contact_phone character varying,
  pickup_info character varying,
  quantity smallint NOT NULL DEFAULT '1'::smallint,
  views_count bigint NOT NULL DEFAULT '0'::bigint,
  inquiries_count bigint NOT NULL DEFAULT '0'::bigint,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  business_name character varying,
  business_description character varying,
  fulfillment_type character varying,
  accepting_orders boolean,
  delivery_available boolean NOT NULL DEFAULT false,
  opening_hours json,
  estimated_delivery integer,
  service_radius_km smallint,
  minimum_order_price bigint,
  verification_status character varying NOT NULL DEFAULT 'unverified'::character varying,
  location_info jsonb,
  CONSTRAINT listing_details_pkey PRIMARY KEY (id),
  CONSTRAINT listing_details_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.conversations (
  id bigint NOT NULL DEFAULT nextval('conversations_id_seq'::regclass),
  type character varying NOT NULL DEFAULT 'direct'::character varying,
  title character varying,
  avatar_key character varying,
  last_message_body text,
  last_message_at timestamp without time zone,
  last_message_by bigint,
  messages_count bigint NOT NULL DEFAULT '0'::bigint,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  community_id bigint,
  CONSTRAINT conversations_pkey PRIMARY KEY (id),
  CONSTRAINT conversations_last_message_by_foreign FOREIGN KEY (last_message_by) REFERENCES public.users(id),
  CONSTRAINT conversations_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id)
);
CREATE TABLE public.listing_inquiries (
  id bigint NOT NULL DEFAULT nextval('listing_inquiries_id_seq'::regclass),
  post_id bigint NOT NULL,
  buyer_id bigint NOT NULL,
  seller_id bigint NOT NULL,
  status character varying NOT NULL DEFAULT 'pending'::character varying,
  message character varying,
  conversation_id bigint,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT listing_inquiries_pkey PRIMARY KEY (id),
  CONSTRAINT listing_inquiries_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT listing_inquiries_buyer_id_foreign FOREIGN KEY (buyer_id) REFERENCES public.users(id),
  CONSTRAINT listing_inquiries_seller_id_foreign FOREIGN KEY (seller_id) REFERENCES public.users(id),
  CONSTRAINT listing_inquiries_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversations(id)
);
CREATE TABLE public.institutions (
  id bigint NOT NULL DEFAULT nextval('institutions_id_seq'::regclass),
  name character varying NOT NULL,
  short_name character varying,
  slug character varying NOT NULL UNIQUE,
  country character varying NOT NULL DEFAULT 'NG'::character varying,
  state character varying,
  city character varying,
  latitude numeric,
  longitude numeric,
  logo_key character varying,
  is_active boolean NOT NULL DEFAULT true,
  metadata json,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT institutions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.categories (
  id bigint NOT NULL DEFAULT nextval('categories_id_seq'::regclass),
  parent_id bigint,
  name character varying NOT NULL,
  slug character varying NOT NULL UNIQUE,
  icon character varying,
  color character varying,
  applies_to character varying NOT NULL DEFAULT 'all'::character varying,
  is_active boolean NOT NULL DEFAULT true,
  sort_order smallint NOT NULL DEFAULT '0'::smallint,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT categories_pkey PRIMARY KEY (id),
  CONSTRAINT categories_parent_id_foreign FOREIGN KEY (parent_id) REFERENCES public.categories(id)
);
CREATE TABLE public.post_categories (
  post_id bigint NOT NULL,
  category_id bigint NOT NULL,
  CONSTRAINT post_categories_pkey PRIMARY KEY (post_id, category_id),
  CONSTRAINT post_categories_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_categories_category_id_foreign FOREIGN KEY (category_id) REFERENCES public.categories(id)
);
CREATE TABLE public.story_views (
  id bigint NOT NULL DEFAULT nextval('story_views_id_seq'::regclass),
  post_id bigint NOT NULL,
  user_id bigint NOT NULL,
  viewed_at timestamp without time zone NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT story_views_pkey PRIMARY KEY (id),
  CONSTRAINT story_views_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT story_views_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.conversation_participants (
  id bigint NOT NULL DEFAULT nextval('conversation_participants_id_seq'::regclass),
  conversation_id bigint NOT NULL,
  user_id bigint NOT NULL,
  role character varying NOT NULL DEFAULT 'member'::character varying,
  unread_count integer NOT NULL DEFAULT 0,
  last_read_at timestamp without time zone,
  is_muted boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone DEFAULT now(),
  request_status character varying NOT NULL DEFAULT 'accepted'::character varying CHECK (request_status::text = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])),
  requested_at timestamp without time zone,
  cleared_at timestamp without time zone,
  CONSTRAINT conversation_participants_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_participants_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversations(id),
  CONSTRAINT conversation_participants_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.messages (
  id bigint NOT NULL DEFAULT nextval('messages_id_seq'::regclass),
  conversation_id bigint NOT NULL,
  sender_id bigint NOT NULL,
  type character varying NOT NULL DEFAULT 'text'::character varying,
  body text,
  shared_post_id bigint,
  reply_to_id bigint,
  media_key character varying,
  media_type character varying,
  reactions json,
  read_at timestamp without time zone,
  deleted_at timestamp without time zone,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone,
  deleted_for_sender boolean NOT NULL DEFAULT false,
  client_temp_id text,
  CONSTRAINT messages_pkey PRIMARY KEY (id),
  CONSTRAINT messages_conversation_id_foreign FOREIGN KEY (conversation_id) REFERENCES public.conversations(id),
  CONSTRAINT messages_sender_id_foreign FOREIGN KEY (sender_id) REFERENCES public.users(id),
  CONSTRAINT messages_shared_post_id_foreign FOREIGN KEY (shared_post_id) REFERENCES public.posts(id),
  CONSTRAINT messages_reply_to_id_foreign FOREIGN KEY (reply_to_id) REFERENCES public.messages(id)
);
CREATE TABLE public.notifications (
  id uuid NOT NULL,
  user_id bigint NOT NULL,
  actor_id bigint,
  type character varying NOT NULL,
  notifiable_type character varying,
  notifiable_id bigint,
  body character varying,
  read_at timestamp without time zone,
  created_at timestamp without time zone DEFAULT now(),
  updated_at timestamp without time zone,
  aggregate_count integer NOT NULL DEFAULT 1,
  actor_ids ARRAY NOT NULL DEFAULT '{}'::bigint[],
  comment_id bigint,
  CONSTRAINT notifications_pkey PRIMARY KEY (id),
  CONSTRAINT notifications_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT notifications_actor_id_foreign FOREIGN KEY (actor_id) REFERENCES public.users(id),
  CONSTRAINT notifications_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id)
);
CREATE TABLE public.post_views (
  id bigint NOT NULL DEFAULT nextval('post_views_id_seq'::regclass),
  post_id bigint NOT NULL,
  user_id bigint,
  viewer_hash character varying,
  viewed_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT post_views_pkey PRIMARY KEY (id),
  CONSTRAINT post_views_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_views_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_devices (
  push_token character varying UNIQUE,
  push_platform character varying,
  push_enabled boolean NOT NULL DEFAULT true,
  token_verified_at timestamp without time zone,
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint,
  device_name character varying,
  device_hash character varying,
  platform_deprecated character varying,
  fcm_token_deprecated character varying,
  ip_address character varying,
  last_active_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT user_devices_pkey PRIMARY KEY (id),
  CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.media_variants (
  id bigint NOT NULL DEFAULT nextval('media_variants_id_seq'::regclass),
  post_media_id bigint NOT NULL,
  media_type character varying NOT NULL,
  format character varying NOT NULL,
  dimension smallint NOT NULL,
  storage_key character varying NOT NULL,
  size_bytes bigint,
  width smallint,
  height smallint,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT media_variants_pkey PRIMARY KEY (id),
  CONSTRAINT media_variants_post_media_id_foreign FOREIGN KEY (post_media_id) REFERENCES public.post_media(id)
);
CREATE TABLE public.hashtags (
  id bigint NOT NULL DEFAULT nextval('hashtags_id_seq'::regclass),
  tag character varying NOT NULL UNIQUE,
  posts_count bigint NOT NULL DEFAULT '0'::bigint,
  created_at timestamp without time zone,
  updated_at timestamp without time zone,
  CONSTRAINT hashtags_pkey PRIMARY KEY (id)
);
CREATE TABLE public.post_hashtags (
  post_id bigint NOT NULL,
  hashtag_id bigint NOT NULL,
  CONSTRAINT post_hashtags_pkey PRIMARY KEY (post_id, hashtag_id),
  CONSTRAINT post_hashtags_post_id_foreign FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT post_hashtags_hashtag_id_foreign FOREIGN KEY (hashtag_id) REFERENCES public.hashtags(id)
);
CREATE TABLE public.message_receipts (
  id bigint NOT NULL DEFAULT nextval('message_receipts_id_seq'::regclass),
  message_id bigint NOT NULL,
  user_id bigint NOT NULL,
  read_at timestamp without time zone NOT NULL DEFAULT now(),
  CONSTRAINT message_receipts_pkey PRIMARY KEY (id),
  CONSTRAINT message_receipts_message_id_foreign FOREIGN KEY (message_id) REFERENCES public.messages(id),
  CONSTRAINT message_receipts_user_id_foreign FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.comment_likes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  comment_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT comment_likes_pkey PRIMARY KEY (id),
  CONSTRAINT comment_likes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT comment_likes_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id)
);
CREATE TABLE public.audio_assets (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  name text NOT NULL,
  storage_key text NOT NULL,
  mime_type text,
  duration_ms integer NOT NULL DEFAULT 0,
  file_size integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  source_start_ms integer NOT NULL DEFAULT 0,
  client_request_id uuid,
  CONSTRAINT audio_assets_pkey PRIMARY KEY (id),
  CONSTRAINT audio_assets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.communities (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text,
  avatar_key text,
  institution_id bigint,
  creator_id bigint NOT NULL,
  members_count integer NOT NULL DEFAULT 0,
  posts_count integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  cover_key text,
  category text NOT NULL DEFAULT 'other'::text CHECK (category = ANY (ARRAY['class'::text, 'department'::text, 'faculty'::text, 'campus'::text, 'creator'::text, 'interest'::text, 'professional'::text, 'seller'::text, 'other'::text])),
  faculty text,
  department text,
  level text,
  course_code text,
  academic_session text,
  discoverability text NOT NULL DEFAULT 'listed'::text CHECK (discoverability = ANY (ARRAY['listed'::text, 'unlisted'::text])),
  join_policy text NOT NULL DEFAULT 'open'::text CHECK (join_policy = ANY (ARRAY['open'::text, 'request'::text, 'invite'::text])),
  read_policy text NOT NULL DEFAULT 'public_preview'::text CHECK (read_policy = ANY (ARRAY['public_preview'::text, 'members_only'::text])),
  permissions jsonb NOT NULL DEFAULT '{"chat": "member", "post": "member", "invite": "moderator", "library": "moderator", "session": "moderator", "announce": "moderator"}'::jsonb,
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  links jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'active'::text CHECK (status = ANY (ARRAY['active'::text, 'archived'::text, 'suspended'::text])),
  archived_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  realtime_key uuid NOT NULL DEFAULT gen_random_uuid(),
  chat_conversation_id bigint,
  moment_settings jsonb NOT NULL DEFAULT '{"verdict": "member", "dept_war": "member", "hot_seat": "member", "one_question": "member", "confession_drop": "member", "dept_war_official": "representative"}'::jsonb,
  CONSTRAINT communities_pkey PRIMARY KEY (id),
  CONSTRAINT communities_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id),
  CONSTRAINT communities_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id),
  CONSTRAINT communities_chat_conversation_id_fkey FOREIGN KEY (chat_conversation_id) REFERENCES public.conversations(id)
);
CREATE TABLE public.community_members (
  community_id bigint NOT NULL,
  user_id bigint NOT NULL,
  role text NOT NULL DEFAULT 'member'::text CHECK (role = ANY (ARRAY['owner'::text, 'admin'::text, 'moderator'::text, 'member'::text])),
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  joined_via text NOT NULL DEFAULT 'direct'::text CHECK (joined_via = ANY (ARRAY['direct'::text, 'request'::text, 'invite'::text, 'creator'::text])),
  chat_notify text NOT NULL DEFAULT 'mentions'::text CHECK (chat_notify = ANY (ARRAY['all'::text, 'mentions'::text, 'none'::text])),
  announce_notify boolean NOT NULL DEFAULT true,
  muted_until timestamp with time zone,
  CONSTRAINT community_members_pkey PRIMARY KEY (community_id, user_id),
  CONSTRAINT community_members_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_highlights (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  title text NOT NULL,
  icon_key text NOT NULL DEFAULT 'star'::text,
  cover_url text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_highlights_pkey PRIMARY KEY (id),
  CONSTRAINT user_highlights_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_highlight_posts (
  highlight_id bigint NOT NULL,
  post_id bigint NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  CONSTRAINT user_highlight_posts_pkey PRIMARY KEY (highlight_id, post_id),
  CONSTRAINT user_highlight_posts_highlight_id_fkey FOREIGN KEY (highlight_id) REFERENCES public.user_highlights(id),
  CONSTRAINT user_highlight_posts_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.user_presence (
  user_id bigint NOT NULL,
  screen text,
  entity_type text,
  entity_id bigint,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_presence_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_presence_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.notification_preferences (
  user_id bigint NOT NULL,
  push_enabled boolean NOT NULL DEFAULT true,
  likes boolean NOT NULL DEFAULT true,
  comments boolean NOT NULL DEFAULT true,
  follows boolean NOT NULL DEFAULT true,
  messages boolean NOT NULL DEFAULT true,
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start smallint,
  quiet_hours_end smallint,
  timezone_offset_minutes integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  hide_message_preview boolean NOT NULL DEFAULT false,
  CONSTRAINT notification_preferences_pkey PRIMARY KEY (user_id),
  CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.push_log (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  category text NOT NULL,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT push_log_pkey PRIMARY KEY (id),
  CONSTRAINT push_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.notification_dispatch_log (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  notification_id uuid NOT NULL,
  user_id bigint NOT NULL,
  type text NOT NULL,
  decision text NOT NULL,
  reason text,
  checked_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT notification_dispatch_log_pkey PRIMARY KEY (id)
);
CREATE TABLE public.user_blocks (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  blocker_id bigint NOT NULL,
  blocked_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_blocks_pkey PRIMARY KEY (id),
  CONSTRAINT user_blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.users(id),
  CONSTRAINT user_blocks_blocked_id_fkey FOREIGN KEY (blocked_id) REFERENCES public.users(id)
);
CREATE TABLE public.reports (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  category text NOT NULL CHECK (category = ANY (ARRAY['bug'::text, 'account'::text, 'marketplace'::text, 'safety'::text, 'suggestion'::text])),
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT reports_pkey PRIMARY KEY (id),
  CONSTRAINT reports_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.media_deletions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  storage_key text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source = ANY (ARRAY['expired_story'::text, 'deleted_post'::text, 'orphan'::text, 'audio_asset'::text, 'replaced_avatar'::text, 'replaced_cover'::text])),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'deleted'::text, 'failed'::text, 'skipped'::text])),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  skip_reason text,
  size_bytes bigint,
  eligible_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,
  CONSTRAINT media_deletions_pkey PRIMARY KEY (id)
);
CREATE TABLE public.storage_cleanup_runs (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  started_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone,
  dry_run boolean NOT NULL,
  stats jsonb,
  error text,
  CONSTRAINT storage_cleanup_runs_pkey PRIMARY KEY (id)
);
CREATE TABLE public.activity_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  recipient_id bigint NOT NULL,
  kind text NOT NULL,
  group_key text NOT NULL,
  target_kind text,
  target_id bigint,
  content_id bigint,
  actor_count integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  target_count integer NOT NULL DEFAULT 0,
  actors_preview ARRAY NOT NULL DEFAULT '{}'::bigint[],
  targets_preview ARRAY NOT NULL DEFAULT '{}'::bigint[],
  first_event_at timestamp with time zone NOT NULL,
  last_event_at timestamp with time zone NOT NULL,
  seen_at timestamp with time zone,
  read_at timestamp with time zone,
  closed_at timestamp with time zone,
  retracted_at timestamp with time zone,
  expires_at timestamp with time zone,
  dismissed_at timestamp with time zone,
  last_push_at timestamp with time zone,
  last_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_comment_id bigint,
  CONSTRAINT activity_items_pkey PRIMARY KEY (id),
  CONSTRAINT activity_items_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id)
);
CREATE TABLE public.activity_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  recipient_id bigint NOT NULL,
  actor_id bigint,
  kind text NOT NULL,
  target_kind text NOT NULL,
  target_id bigint,
  content_id bigint,
  comment_id bigint,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  item_id bigint,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  retracted_at timestamp with time zone,
  CONSTRAINT activity_events_pkey PRIMARY KEY (id),
  CONSTRAINT activity_events_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id),
  CONSTRAINT activity_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id),
  CONSTRAINT activity_events_comment_id_fkey FOREIGN KEY (comment_id) REFERENCES public.comments(id),
  CONSTRAINT activity_events_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.activity_items(id)
);
CREATE TABLE public.activity_policy (
  kind text NOT NULL,
  merge boolean NOT NULL DEFAULT true,
  window_secs integer NOT NULL DEFAULT 0,
  max_life_secs integer NOT NULL DEFAULT 0,
  restore_secs integer NOT NULL DEFAULT 0,
  push_mode text NOT NULL DEFAULT 'each'::text CHECK (push_mode = ANY (ARRAY['each'::text, 'item'::text, 'none'::text])),
  push_cooldown_secs integer NOT NULL DEFAULT 0,
  CONSTRAINT activity_policy_pkey PRIMARY KEY (kind)
);
CREATE TABLE public.push_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  recipient_id bigint NOT NULL,
  kind text NOT NULL,
  item_id bigint,
  event_id bigint,
  conversation_id bigint,
  message_id bigint,
  collapse_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'suppressed'::text, 'retry'::text, 'dead'::text])),
  attempts integer NOT NULL DEFAULT 0,
  reason text,
  last_error text,
  next_attempt_at timestamp with time zone NOT NULL DEFAULT now(),
  claimed_at timestamp with time zone,
  sent_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT push_outbox_pkey PRIMARY KEY (id),
  CONSTRAINT push_outbox_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES public.users(id),
  CONSTRAINT push_outbox_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.activity_items(id),
  CONSTRAINT push_outbox_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.activity_events(id)
);
CREATE TABLE public.user_activity_topics (
  user_id bigint NOT NULL,
  topic uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_activity_topics_pkey PRIMARY KEY (user_id),
  CONSTRAINT user_activity_topics_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.activity_errors (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  at timestamp with time zone NOT NULL DEFAULT now(),
  fn text,
  error text,
  detail jsonb,
  CONSTRAINT activity_errors_pkey PRIMARY KEY (id)
);
CREATE TABLE public.feed_post_stats (
  post_id bigint NOT NULL,
  impressions integer NOT NULL DEFAULT 0,
  views integer NOT NULL DEFAULT 0,
  completions integer NOT NULL DEFAULT 0,
  rewatches integer NOT NULL DEFAULT 0,
  skips integer NOT NULL DEFAULT 0,
  likes integer NOT NULL DEFAULT 0,
  comments integer NOT NULL DEFAULT 0,
  saves integer NOT NULL DEFAULT 0,
  shares integer NOT NULL DEFAULT 0,
  reposts integer NOT NULL DEFAULT 0,
  follows_from integer NOT NULL DEFAULT 0,
  negatives integer NOT NULL DEFAULT 0,
  first_exposed_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  delivered integer NOT NULL DEFAULT 0,
  CONSTRAINT feed_post_stats_pkey PRIMARY KEY (post_id),
  CONSTRAINT feed_post_stats_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.feed_exposures (
  user_id bigint NOT NULL,
  post_id bigint NOT NULL,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  seen_count smallint NOT NULL DEFAULT 1,
  best_outcome smallint NOT NULL DEFAULT 0,
  negative boolean NOT NULL DEFAULT false,
  src text,
  acts smallint NOT NULL DEFAULT 0,
  CONSTRAINT feed_exposures_pkey PRIMARY KEY (user_id, post_id),
  CONSTRAINT feed_exposures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT feed_exposures_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.feed_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  user_id bigint NOT NULL,
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['impression'::text, 'consume'::text, 'share'::text, 'profile_visit'::text, 'listing_open'::text, 'not_interested'::text, 'hide_creator'::text, 'follow_from_post'::text, 'like'::text, 'comment'::text, 'save'::text, 'repost'::text, 'follow'::text, 'suggestion_impression'::text, 'open'::text, 'suggestion_open'::text, 'suggestion_follow'::text, 'suggestion_dismiss'::text])),
  origin text NOT NULL DEFAULT 'client'::text CHECK (origin = ANY (ARRAY['client'::text, 'server'::text])),
  post_id bigint,
  target_user_id bigint,
  session_id uuid,
  surface text,
  src text,
  slot smallint,
  dwell_ms integer CHECK (dwell_ms IS NULL OR dwell_ms >= 0 AND dwell_ms <= 3600000),
  watch_ms integer CHECK (watch_ms IS NULL OR watch_ms >= 0 AND watch_ms <= 3600000),
  media_ms integer CHECK (media_ms IS NULL OR media_ms >= 0 AND media_ms <= 14400000),
  loops smallint CHECK (loops IS NULL OR loops >= 0 AND loops <= 100),
  outcome text CHECK (outcome IS NULL OR (outcome = ANY (ARRAY['skip'::text, 'glance'::text, 'view'::text, 'complete'::text, 'rewatch'::text]))),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT feed_events_pkey PRIMARY KEY (id),
  CONSTRAINT feed_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT feed_events_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT feed_events_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id)
);
CREATE TABLE public.feed_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id bigint,
  mode text NOT NULL DEFAULT 'auth'::text CHECK (mode = ANY (ARRAY['auth'::text, 'guest'::text])),
  scope text NOT NULL DEFAULT 'for_you'::text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  pos integer NOT NULL DEFAULT 0,
  delivered integer NOT NULL DEFAULT 0,
  consumed integer NOT NULL DEFAULT 0,
  suggestions_shown smallint NOT NULL DEFAULT 0,
  consumed_at_last_suggestion integer NOT NULL DEFAULT 0,
  rebuilds smallint NOT NULL DEFAULT 0,
  config_version text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '00:30:00'::interval),
  CONSTRAINT feed_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT feed_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.feed_config (
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT feed_config_pkey PRIMARY KEY (key)
);
CREATE TABLE public.user_topic_affinity (
  user_id bigint NOT NULL,
  topic text NOT NULL,
  score real NOT NULL DEFAULT 0,
  events integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_topic_affinity_pkey PRIMARY KEY (user_id, topic),
  CONSTRAINT user_topic_affinity_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_creator_affinity (
  user_id bigint NOT NULL,
  creator_id bigint NOT NULL,
  score real NOT NULL DEFAULT 0,
  pos_events integer NOT NULL DEFAULT 0,
  neg_events integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_creator_affinity_pkey PRIMARY KEY (user_id, creator_id),
  CONSTRAINT user_creator_affinity_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT user_creator_affinity_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id)
);
CREATE TABLE public.user_creator_hides (
  user_id bigint NOT NULL,
  creator_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT user_creator_hides_pkey PRIMARY KEY (user_id, creator_id),
  CONSTRAINT user_creator_hides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT user_creator_hides_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id)
);
CREATE TABLE public.people_suggestions (
  user_id bigint NOT NULL,
  target_id bigint NOT NULL,
  shown_count smallint NOT NULL DEFAULT 0,
  first_shown_at timestamp with time zone,
  last_shown_at timestamp with time zone,
  opened_at timestamp with time zone,
  dismissed_at timestamp with time zone,
  followed_at timestamp with time zone,
  reason text,
  CONSTRAINT people_suggestions_pkey PRIMARY KEY (user_id, target_id),
  CONSTRAINT people_suggestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT people_suggestions_target_id_fkey FOREIGN KEY (target_id) REFERENCES public.users(id)
);
CREATE TABLE public.discover_exposures (
  user_id bigint NOT NULL,
  post_id bigint NOT NULL,
  first_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  last_seen_at timestamp with time zone NOT NULL DEFAULT now(),
  seen_count smallint NOT NULL DEFAULT 0,
  opened_at timestamp with time zone,
  open_count smallint NOT NULL DEFAULT 0,
  src text,
  CONSTRAINT discover_exposures_pkey PRIMARY KEY (user_id, post_id),
  CONSTRAINT discover_exposures_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT discover_exposures_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.discover_post_stats (
  post_id bigint NOT NULL,
  impressions integer NOT NULL DEFAULT 0,
  opens integer NOT NULL DEFAULT 0,
  delivered integer NOT NULL DEFAULT 0,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT discover_post_stats_pkey PRIMARY KEY (post_id),
  CONSTRAINT discover_post_stats_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id)
);
CREATE TABLE public.message_deletions (
  message_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp without time zone DEFAULT now(),
  CONSTRAINT message_deletions_pkey PRIMARY KEY (message_id, user_id),
  CONSTRAINT message_deletions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id),
  CONSTRAINT message_deletions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.poll_votes (
  post_id bigint NOT NULL,
  user_id bigint NOT NULL,
  option_id smallint NOT NULL CHECK (option_id >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT poll_votes_pkey PRIMARY KEY (post_id, user_id, option_id),
  CONSTRAINT poll_votes_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT poll_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.publisher_grants (
  id bigint NOT NULL DEFAULT nextval('publisher_grants_id_seq'::regclass),
  user_id bigint NOT NULL,
  display_name text NOT NULL,
  publisher_type text NOT NULL DEFAULT 'organisation'::text CHECK (publisher_type = ANY (ARRAY['institution'::text, 'department'::text, 'organisation'::text, 'staff'::text])),
  institution_id bigint,
  can_announce boolean NOT NULL DEFAULT true,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT publisher_grants_pkey PRIMARY KEY (id),
  CONSTRAINT publisher_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT publisher_grants_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
);
CREATE TABLE public.community_designations (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  user_id bigint NOT NULL,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['class_rep'::text, 'course_rep'::text, 'dept_exec'::text, 'contributor'::text])),
  scope_label text,
  can_announce boolean NOT NULL DEFAULT false,
  granted_by bigint,
  granted_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone,
  revoked_by bigint,
  CONSTRAINT community_designations_pkey PRIMARY KEY (id),
  CONSTRAINT community_designations_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_designations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT community_designations_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id),
  CONSTRAINT community_designations_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id)
);
CREATE TABLE public.community_join_requests (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  user_id bigint NOT NULL,
  message text CHECK (message IS NULL OR char_length(message) <= 300),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'cancelled'::text])),
  decided_by bigint,
  decided_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT community_join_requests_pkey PRIMARY KEY (id),
  CONSTRAINT community_join_requests_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_join_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT community_join_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id)
);
CREATE TABLE public.community_invites (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  token text NOT NULL UNIQUE,
  label text,
  created_by bigint NOT NULL,
  max_uses integer CHECK (max_uses IS NULL OR max_uses > 0),
  uses integer NOT NULL DEFAULT 0,
  expires_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT community_invites_pkey PRIMARY KEY (id),
  CONSTRAINT community_invites_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
CREATE TABLE public.community_bans (
  community_id bigint NOT NULL,
  user_id bigint NOT NULL,
  banned_by bigint,
  reason text,
  expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT community_bans_pkey PRIMARY KEY (community_id, user_id),
  CONSTRAINT community_bans_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_bans_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT community_bans_banned_by_fkey FOREIGN KEY (banned_by) REFERENCES public.users(id)
);
CREATE TABLE public.community_mod_log (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  actor_id bigint,
  action text NOT NULL,
  target_user_id bigint,
  target_kind text,
  target_id bigint,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT community_mod_log_pkey PRIMARY KEY (id),
  CONSTRAINT community_mod_log_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_mod_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id)
);
CREATE TABLE public.community_collections (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  name text NOT NULL CHECK (char_length(name) >= 1 AND char_length(name) <= 60),
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by bigint,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT community_collections_pkey PRIMARY KEY (id),
  CONSTRAINT community_collections_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_collections_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id)
);
CREATE TABLE public.library_resources (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  post_id bigint NOT NULL UNIQUE,
  uploader_id bigint NOT NULL,
  title text NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  doc_type text NOT NULL DEFAULT 'other'::text CHECK (doc_type = ANY (ARRAY['past_question'::text, 'lecture_note'::text, 'slides'::text, 'textbook'::text, 'assignment'::text, 'syllabus'::text, 'project'::text, 'other'::text])),
  course_code text,
  academic_session text,
  subject text,
  collection_id bigint,
  is_active boolean NOT NULL DEFAULT true,
  removed_by bigint,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  search_vector tsvector DEFAULT to_tsvector('simple'::regconfig, ((((((((COALESCE(title, ''::text) || ' '::text) || COALESCE(course_code, ''::text)) || ' '::text) || COALESCE(subject, ''::text)) || ' '::text) || COALESCE(description, ''::text)) || ' '::text) || COALESCE(academic_session, ''::text))),
  CONSTRAINT library_resources_pkey PRIMARY KEY (id),
  CONSTRAINT library_resources_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT library_resources_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id),
  CONSTRAINT library_resources_uploader_id_fkey FOREIGN KEY (uploader_id) REFERENCES public.users(id),
  CONSTRAINT library_resources_collection_id_fkey FOREIGN KEY (collection_id) REFERENCES public.community_collections(id),
  CONSTRAINT library_resources_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.users(id)
);
CREATE TABLE public.content_reports (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  reporter_id bigint NOT NULL,
  community_id bigint,
  target_kind text NOT NULL CHECK (target_kind = ANY (ARRAY['post'::text, 'comment'::text, 'message'::text, 'session_post'::text, 'resource'::text, 'community'::text, 'user'::text])),
  target_id bigint NOT NULL,
  reason text NOT NULL CHECK (reason = ANY (ARRAY['spam'::text, 'harassment'::text, 'hate'::text, 'sexual'::text, 'violence'::text, 'misinformation'::text, 'privacy'::text, 'other'::text])),
  details text CHECK (details IS NULL OR char_length(details) <= 500),
  status text NOT NULL DEFAULT 'open'::text CHECK (status = ANY (ARRAY['open'::text, 'actioned'::text, 'dismissed'::text])),
  handled_by bigint,
  handled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT content_reports_pkey PRIMARY KEY (id),
  CONSTRAINT content_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id),
  CONSTRAINT content_reports_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT content_reports_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES public.users(id)
);
CREATE TABLE public.community_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  community_id bigint NOT NULL,
  host_id bigint NOT NULL,
  code text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'anonymous_feed'::text CHECK (type = 'anonymous_feed'::text),
  title text NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 120),
  description text CHECK (description IS NULL OR char_length(description) <= 500),
  status text NOT NULL DEFAULT 'live'::text CHECK (status = ANY (ARRAY['scheduled'::text, 'live'::text, 'ended'::text])),
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  ended_at timestamp with time zone,
  ended_by bigint,
  allow_preview boolean NOT NULL DEFAULT true,
  replies_enabled boolean NOT NULL DEFAULT true,
  reactions_enabled boolean NOT NULL DEFAULT true,
  notify_members boolean NOT NULL DEFAULT false,
  realtime_key uuid NOT NULL DEFAULT gen_random_uuid(),
  posts_count integer NOT NULL DEFAULT 0,
  participants_count integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT community_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT community_sessions_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES public.users(id),
  CONSTRAINT community_sessions_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT community_sessions_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.users(id)
);
CREATE TABLE public.session_posts (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  session_id bigint NOT NULL,
  parent_id bigint,
  author_id bigint NOT NULL,
  alias_no integer NOT NULL,
  body text NOT NULL CHECK (char_length(body) >= 1 AND char_length(body) <= 1000),
  reactions_count integer NOT NULL DEFAULT 0,
  replies_count integer NOT NULL DEFAULT 0,
  removed_at timestamp with time zone,
  removed_by bigint,
  removed_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_posts_pkey PRIMARY KEY (id),
  CONSTRAINT session_posts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.community_sessions(id),
  CONSTRAINT session_posts_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.session_posts(id),
  CONSTRAINT session_posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id),
  CONSTRAINT session_posts_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.users(id)
);
CREATE TABLE public.session_aliases (
  session_id bigint NOT NULL,
  user_id bigint NOT NULL,
  alias_no integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_aliases_pkey PRIMARY KEY (session_id, user_id),
  CONSTRAINT session_aliases_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.community_sessions(id),
  CONSTRAINT session_aliases_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.session_reactions (
  post_id bigint NOT NULL,
  user_id bigint NOT NULL,
  kind text NOT NULL DEFAULT 'like'::text CHECK (kind = ANY (ARRAY['like'::text, 'fire'::text, 'laugh'::text, 'wow'::text, 'sad'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_reactions_pkey PRIMARY KEY (post_id, user_id),
  CONSTRAINT session_reactions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.session_posts(id),
  CONSTRAINT session_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.session_blocks (
  session_id bigint NOT NULL,
  user_id bigint NOT NULL,
  blocked_by bigint,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT session_blocks_pkey PRIMARY KEY (session_id, user_id),
  CONSTRAINT session_blocks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.community_sessions(id),
  CONSTRAINT session_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT session_blocks_blocked_by_fkey FOREIGN KEY (blocked_by) REFERENCES public.users(id)
);
CREATE TABLE public.moments (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  code text NOT NULL UNIQUE,
  community_id bigint NOT NULL,
  creator_id bigint NOT NULL,
  type text NOT NULL CHECK (type = ANY (ARRAY['hot_seat'::text, 'verdict'::text, 'confession_drop'::text, 'dept_war'::text, 'one_question'::text])),
  status text NOT NULL DEFAULT 'active'::text CHECK (status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'active'::text, 'closed'::text, 'completed'::text, 'cancelled'::text])),
  title text NOT NULL CHECK (char_length(title) >= 1 AND char_length(title) <= 200),
  body text CHECK (body IS NULL OR char_length(body) <= 600),
  anonymous boolean NOT NULL DEFAULT false,
  allow_anonymous_entries boolean NOT NULL DEFAULT true,
  allow_preview boolean NOT NULL DEFAULT true,
  is_official boolean NOT NULL DEFAULT false,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  ended_at timestamp with time zone,
  ended_by bigint,
  cancel_reason text,
  soon_notified_at timestamp with time zone,
  realtime_key uuid NOT NULL DEFAULT gen_random_uuid(),
  participants_count integer NOT NULL DEFAULT 0,
  entries_count integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moments_pkey PRIMARY KEY (id),
  CONSTRAINT moments_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT moments_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.users(id),
  CONSTRAINT moments_ended_by_fkey FOREIGN KEY (ended_by) REFERENCES public.users(id)
);
CREATE TABLE public.moment_hot_seats (
  moment_id bigint NOT NULL,
  type text NOT NULL DEFAULT 'hot_seat'::text CHECK (type = 'hot_seat'::text),
  submissions_closed_at timestamp with time zone,
  answer_until timestamp with time zone NOT NULL,
  CONSTRAINT moment_hot_seats_pkey PRIMARY KEY (moment_id),
  CONSTRAINT moment_hot_seats_moment_id_type_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_hot_seats_moment_id_type_fkey FOREIGN KEY (type) REFERENCES public.moments(type)
);
CREATE TABLE public.moment_confession_drops (
  moment_id bigint NOT NULL,
  type text NOT NULL DEFAULT 'confession_drop'::text CHECK (type = 'confession_drop'::text),
  reveal_at timestamp with time zone NOT NULL,
  reveal_mode text NOT NULL DEFAULT 'sequential'::text CHECK (reveal_mode = ANY (ARRAY['all'::text, 'sequential'::text, 'manual'::text])),
  reveal_interval_secs integer NOT NULL DEFAULT 20 CHECK (reveal_interval_secs >= 5 AND reveal_interval_secs <= 3600),
  max_per_user integer NOT NULL DEFAULT 3 CHECK (max_per_user >= 1 AND max_per_user <= 10),
  reveal_notified_at timestamp with time zone,
  CONSTRAINT moment_confession_drops_pkey PRIMARY KEY (moment_id),
  CONSTRAINT moment_confession_drops_moment_id_type_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_confession_drops_moment_id_type_fkey FOREIGN KEY (type) REFERENCES public.moments(type)
);
CREATE TABLE public.moment_options (
  moment_id bigint NOT NULL,
  type text NOT NULL DEFAULT 'verdict'::text CHECK (type = 'verdict'::text),
  idx smallint NOT NULL CHECK (idx >= 0 AND idx <= 9),
  label text NOT NULL CHECK (char_length(label) >= 1 AND char_length(label) <= 80),
  votes_count integer NOT NULL DEFAULT 0,
  CONSTRAINT moment_options_pkey PRIMARY KEY (moment_id, idx),
  CONSTRAINT moment_options_moment_id_type_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_options_moment_id_type_fkey FOREIGN KEY (type) REFERENCES public.moments(type)
);
CREATE TABLE public.moment_votes (
  moment_id bigint NOT NULL,
  user_id bigint NOT NULL,
  option_idx smallint NOT NULL,
  side_community_id bigint,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_votes_pkey PRIMARY KEY (moment_id, user_id),
  CONSTRAINT moment_votes_side_community_id_fkey FOREIGN KEY (side_community_id) REFERENCES public.communities(id),
  CONSTRAINT moment_votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT moment_votes_moment_id_option_idx_fkey FOREIGN KEY (moment_id) REFERENCES public.moment_options(moment_id),
  CONSTRAINT moment_votes_moment_id_option_idx_fkey FOREIGN KEY (option_idx) REFERENCES public.moment_options(idx)
);
CREATE TABLE public.moment_war_config (
  moment_id bigint NOT NULL,
  type text NOT NULL DEFAULT 'dept_war'::text CHECK (type = 'dept_war'::text),
  challenge_type text NOT NULL CHECK (challenge_type = ANY (ARRAY['trivia'::text, 'riddle'::text, 'campus_knowledge'::text, 'creative'::text, 'voting'::text])),
  points_per_item integer NOT NULL DEFAULT 10 CHECK (points_per_item >= 1 AND points_per_item <= 100),
  min_participants integer NOT NULL DEFAULT 3 CHECK (min_participants >= 1 AND min_participants <= 50),
  invite_expires_at timestamp with time zone,
  message text CHECK (message IS NULL OR char_length(message) <= 300),
  winner_community_id bigint,
  results jsonb,
  CONSTRAINT moment_war_config_pkey PRIMARY KEY (moment_id),
  CONSTRAINT moment_war_config_winner_community_id_fkey FOREIGN KEY (winner_community_id) REFERENCES public.communities(id),
  CONSTRAINT moment_war_config_moment_id_type_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_war_config_moment_id_type_fkey FOREIGN KEY (type) REFERENCES public.moments(type)
);
CREATE TABLE public.moment_war_sides (
  moment_id bigint NOT NULL,
  community_id bigint NOT NULL,
  side text NOT NULL CHECK (side = ANY (ARRAY['challenger'::text, 'challenged'::text])),
  status text NOT NULL DEFAULT 'pending'::text CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'declined'::text])),
  proposed_by bigint,
  decided_by bigint,
  decided_at timestamp with time zone,
  CONSTRAINT moment_war_sides_pkey PRIMARY KEY (moment_id, community_id),
  CONSTRAINT moment_war_sides_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_war_sides_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id),
  CONSTRAINT moment_war_sides_proposed_by_fkey FOREIGN KEY (proposed_by) REFERENCES public.users(id),
  CONSTRAINT moment_war_sides_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.users(id)
);
CREATE TABLE public.moment_war_items (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  moment_id bigint NOT NULL,
  idx smallint NOT NULL CHECK (idx >= 0 AND idx <= 29),
  kind text NOT NULL CHECK (kind = ANY (ARRAY['choice'::text, 'text'::text])),
  prompt text NOT NULL CHECK (char_length(prompt) >= 1 AND char_length(prompt) <= 300),
  choices ARRAY,
  correct_idx smallint,
  accepted ARRAY,
  CONSTRAINT moment_war_items_pkey PRIMARY KEY (id),
  CONSTRAINT moment_war_items_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id)
);
CREATE TABLE public.moment_war_answers (
  item_id bigint NOT NULL,
  user_id bigint NOT NULL,
  community_id bigint NOT NULL,
  choice_idx smallint,
  answer_text text CHECK (answer_text IS NULL OR char_length(answer_text) <= 120),
  correct boolean NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_war_answers_pkey PRIMARY KEY (item_id, user_id),
  CONSTRAINT moment_war_answers_item_id_fkey FOREIGN KEY (item_id) REFERENCES public.moment_war_items(id),
  CONSTRAINT moment_war_answers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT moment_war_answers_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id)
);
CREATE TABLE public.moment_participants (
  moment_id bigint NOT NULL,
  user_id bigint NOT NULL,
  side_community_id bigint,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_participants_pkey PRIMARY KEY (moment_id, user_id),
  CONSTRAINT moment_participants_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT moment_participants_side_community_id_fkey FOREIGN KEY (side_community_id) REFERENCES public.communities(id)
);
CREATE TABLE public.moment_aliases (
  moment_id bigint NOT NULL,
  user_id bigint NOT NULL,
  alias_no integer NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_aliases_pkey PRIMARY KEY (moment_id, user_id),
  CONSTRAINT moment_aliases_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_aliases_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.moment_entries (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  moment_id bigint NOT NULL,
  parent_id bigint,
  kind text NOT NULL CHECK (kind = ANY (ARRAY['question'::text, 'comment'::text, 'confession'::text, 'response'::text, 'submission'::text])),
  author_id bigint NOT NULL,
  side_community_id bigint,
  is_anonymous boolean NOT NULL DEFAULT true,
  alias_no integer,
  body text NOT NULL CHECK (char_length(body) >= 1 AND char_length(body) <= 1500),
  answer text CHECK (answer IS NULL OR char_length(answer) <= 1500),
  answered_at timestamp with time zone,
  status text NOT NULL DEFAULT 'visible'::text CHECK (status = ANY (ARRAY['pending'::text, 'visible'::text, 'approved'::text, 'answered'::text, 'skipped'::text, 'dismissed'::text, 'rejected'::text, 'removed'::text])),
  flags ARRAY NOT NULL DEFAULT '{}'::text[],
  reveal_at timestamp with time zone,
  upvotes_count integer NOT NULL DEFAULT 0,
  reactions_count integer NOT NULL DEFAULT 0,
  replies_count integer NOT NULL DEFAULT 0,
  client_key text CHECK (client_key IS NULL OR char_length(client_key) <= 64),
  moderated_by bigint,
  moderated_at timestamp with time zone,
  moderation_note text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_entries_pkey PRIMARY KEY (id),
  CONSTRAINT moment_entries_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_entries_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.moment_entries(id),
  CONSTRAINT moment_entries_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id),
  CONSTRAINT moment_entries_side_community_id_fkey FOREIGN KEY (side_community_id) REFERENCES public.communities(id),
  CONSTRAINT moment_entries_moderated_by_fkey FOREIGN KEY (moderated_by) REFERENCES public.users(id)
);
CREATE TABLE public.moment_reactions (
  entry_id bigint NOT NULL,
  user_id bigint NOT NULL,
  kind text NOT NULL DEFAULT 'like'::text CHECK (kind = ANY (ARRAY['like'::text, 'fire'::text, 'laugh'::text, 'wow'::text, 'sad'::text, 'upvote'::text])),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_reactions_pkey PRIMARY KEY (entry_id, user_id),
  CONSTRAINT moment_reactions_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.moment_entries(id),
  CONSTRAINT moment_reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.moment_reminders (
  moment_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_reminders_pkey PRIMARY KEY (moment_id, user_id),
  CONSTRAINT moment_reminders_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_reminders_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id)
);
CREATE TABLE public.moment_blocks (
  moment_id bigint NOT NULL,
  user_id bigint NOT NULL,
  blocked_by bigint,
  reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_blocks_pkey PRIMARY KEY (moment_id, user_id),
  CONSTRAINT moment_blocks_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_blocks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id),
  CONSTRAINT moment_blocks_blocked_by_fkey FOREIGN KEY (blocked_by) REFERENCES public.users(id)
);
CREATE TABLE public.moment_reports (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  moment_id bigint NOT NULL,
  entry_id bigint,
  reporter_id bigint NOT NULL,
  reason text NOT NULL CHECK (reason = ANY (ARRAY['spam'::text, 'harassment'::text, 'hate'::text, 'sexual'::text, 'violence'::text, 'misinformation'::text, 'privacy'::text, 'other'::text])),
  details text CHECK (details IS NULL OR char_length(details) <= 500),
  status text NOT NULL DEFAULT 'open'::text CHECK (status = ANY (ARRAY['open'::text, 'actioned'::text, 'dismissed'::text])),
  handled_by bigint,
  handled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT moment_reports_pkey PRIMARY KEY (id),
  CONSTRAINT moment_reports_moment_id_fkey FOREIGN KEY (moment_id) REFERENCES public.moments(id),
  CONSTRAINT moment_reports_entry_id_fkey FOREIGN KEY (entry_id) REFERENCES public.moment_entries(id),
  CONSTRAINT moment_reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.users(id),
  CONSTRAINT moment_reports_handled_by_fkey FOREIGN KEY (handled_by) REFERENCES public.users(id)
);