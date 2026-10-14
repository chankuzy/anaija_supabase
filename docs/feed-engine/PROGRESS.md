# Anaija Feed Intelligence Engine: progress

## Audit findings (do not redo)
- /feed (auth-only, 15/page): for_you = engagement_score DESC, id DESC. NOTHING writes engagement_score, so it is chronological in practice.
- following/campus = id DESC. Visibility never checked in /feed (1 'followers' post is visible to everyone today). Blocks, author is_active, listing status not checked either. posts-store does not validate `visibility`.
- post_views has UNIQUE(post_id,user_id): view dedupe works but carries no quality signal. Left untouched.
- Auth: custom tokens. requireAuth / verifyTokenOptional in _shared/auth.ts. All functions use the service-role client, so authz lives in function code, not RLS.
- Stories already excluded from /feed (FEED_TYPES). getStoriesForUser separate.
- discoverService has its own ranking (4 lenses + round-robin diversify). People lens = newest same-institution users with N+1 follower counts. To be re-pointed at the people engine later.
- createPost never fills post_hashtags (syncHashtags only bumps hashtags.posts_count, never decremented). Interests read posts.hashtags JSON + post_categories + subtype.
- posts-share discards the user id, no dedupe, no visibility check: shares_count is inflatable. PLAN: rewrite posts-share to call feed_ingest_events with a 'share' event (keep legacy counter).
- rateLimitService is push-specific: not reusable. feed_ingest_events has its own limiter.
- Flutter: HomeFeedNotifier parses every item as Listing from data['posts']; "Not interested" is local-only (listing_options_sheet.dart -> removeListing). Media pipeline is solid: do not touch.
- Guest entry: ApiClient attaches a token only if one exists; app starts at Splash -> AuthChoiceScreen -> MainShell (no guest path yet).
- Prod data at audit: 12 users, 216 posts (92 stories), ~120 eligible. community posts = 0. visibility values: public, followers.
- Repo migration files drift from prod (cron). Prod is the source of truth. Regenerate schema.sql at the end.
- dev-login is deployed (email+password token mint). Remove after benchmarking (bench_feed.sh holds its password).

## Decisions
- Engine in supabase/functions/_shared/feed/. Endpoints: feed (auth), feed-public, feed-events, feed-feedback, people-dismiss, feed-debug.
- Candidate pools via Postgres functions; scoring/distribution/composition in TypeScript; weights in feed_config (DB).
- Pagination: signed cursor {session,pos} over feed_sessions (30 min TTL). Each page re-checks eligibility via feed_filter_visible.
- Response: items[] typed (post | people_suggestion | discovery). Keep legacy `posts` array for one release.
- Visibility: public | followers | campus | private. Guests need visibility='public' AND public_since IS NOT NULL. Legacy rows NOT backfilled automatically.
- All stats count unique users (feed_exposures.acts bit flags). Client sends raw metrics only; server classifies outcome.
- Distribution lifecycle is a pure function of feed_post_stats + age + config (no state table). feed_post_stats.delivered is bumped per delivered page to bound exploratory exposure.
- Server-only signals (like/comment/save/repost/follow) come from DB triggers; clients cannot claim them. Client may claim follow_from_post only if the follows row exists.

## Phase status
- [x] Phase 1 audit/contracts
- [ ] Phase 2 data foundation
  - [x] 2026_feed_engine_01_foundation.sql (run + verify pending)
  - [x] 2026_feed_engine_02_signals.sql (written; run + tests pending): feed_config, feed_classify, affinity tables (+decay), people_suggestions, engagement/follow triggers, feed_ingest_events, seed from existing engagement
- [ ] Phase 3 recommendation core: 03 = candidate source functions + ranking/distribution/composition config
- [ ] Phases 4-8

## Pending approval
- Legacy guest backfill (recommended pre-launch; run only if approved):
  update public.posts set public_since = created_at where visibility='public' and public_since is null and type in ('post','listing');

## Next step
Run 01 and 02 and paste the verify/test output. Then write migration 03 (candidate SQL functions + ranking config).

## Log
- 2026-10-13: migration 01 + 02 applied. Ingest test passed (accepted 2 / rejected 1; unique-user stats correct). Seed produced 218 topic rows / 94 creator rows.
  - Finding: fmt:/inst:/sub: affinities saturate at the cap for active users -> scorer uses SHARE of positive affinity per family, not raw value.
  - Finding: distribution caps (seed_cap=10, expand_cap=60) are sized for ~12 users; raise as users grow.
  - Guest pool is empty until legacy public_since backfill is approved (see "Pending approval").
- 2026-10-13: migration 03 written (feed_post_topic view, 8 source fns, feed_candidate_pool, feed_user_profile, feed_mark_delivered, config keys: candidates/rank/quality/dist/compose).
  - Scale note: feed_post_topic is computed on the fly; replace with a maintained post_topics table when 30-day eligible posts > ~20k.
  - Next: TS modules in _shared/feed/ (types, config, scoring, distribution + Deno tests), then composer.
- 2026-10-14: migration 03 verified (guest_leak=0, self_leak=0, classifier correct, per-viewer pools 36-52, guest pool 45).
  - Finding: ~45 candidates per viewer => heavy users hit caught-up after ~3 pages. Caught-up is the NORMAL launch state: composer must return caught_up:true + discovery options, never recycle seen content.
- 2026-10-14: Phase 3 TS written in supabase/functions/_shared/feed/: types.ts, config.ts (loadConfig, 60s cache, deep-merge over defaults), distribution.ts (effectiveExposure, postQuality, distributionStage), scoring.ts (buildProfileIndex, scoreCandidate, rankCandidates, topFactors), scoring_test.ts (14 behavioural tests; run `deno test --no-check` in that dir).
  - Next: composer.ts (diversity/pacing/listing slots/exploration/people-suggestion eligibility/caught-up) + session.ts (signed cursor over feed_sessions) + feed/index.ts rewrite + feed-public + feed-events + feed-feedback.
- 2026-10-14: scoring_test.ts 14/14 pass.
- 2026-10-14: composer.ts (compose, suggestionThreshold/Due/Slot), session.ts (signCursor/verifyCursor, createSession/getSession/advanceSession/replaceSessionItems, mergeRebuild), composer_test.ts, session_test.ts written (run `deno test -A --no-check` in _shared/feed).
  - Listing pacing limits are HARD (min score, 1/page, gap 10): surplus listings stay out of the session by design.
  - relevance_floor_ratio (0.35) is read from feed_config.compose if present, else defaults in composer.ts.
  - Session items are the retry/replay source of truth: a suggestion unit is persisted into session.items when inserted so a retried page is identical.
  - SECRET REQUIRED before deploying feed functions: npx supabase secrets set FEED_CURSOR_SECRET=$(openssl rand -hex 32)
  - Next: engine.ts (orchestrator: load config+profile, candidate pool RPC, rank, compose, session create/advance/rebuild, hydrate posts via existing formatPost/formatListing, typed items, caught-up), then feed/index.ts rewrite, feed-public, feed-events, feed-feedback.
- 2026-10-14: composer/session tests pass (33/33 total). Migration 04 (feed_chrono_pool for following/campus). session.ts patched (k format tag, rebuilds patch).
- 2026-10-14: engine.ts (getFeed: session resolve, build, suggestion scheduling, rebuild, advance, hydration w/ delivery-time visibility recheck, typed response, caught-up + next_actions), feed/index.ts REWRITTEN (legacy-compatible `posts` array kept; legacy fallback on first-page engine failure only; backup ~/feed_index.ts.pre-engine.bak), new functions feed-public, feed-events, feed-feedback (+ config.toml blocks), scripts/feed_smoke.py.
  - Guest policy: viewerId always null in feed-public, token ignored; guest pool cached 60s per instance (user-independent); no shared HTTP caching (sessions are stateful).
  - People units: scheduling + hydration live; provider absent => suppressed until Phase 6.
  - Known limits: concurrent identical page requests may both compute (advanceSession guard makes only one count as a delivery); rebuild batches don't enforce author gap across the boundary.
  - Open: remove legacy fallback in feed/index.ts once stable; remove dev-login; rewrite posts-share to emit a 'share' event; /campus-feed still legacy (Flutter moves to /feed?scope=campus in Phase 7).
  - Next: Phase 6 people engine (migration 05: candidate SQL + people provider), then posts-share + users-follow/dismiss wiring, then Phase 7 Flutter.
- 2026-10-14: Phase 6 backend: migration 05 (feed_people_candidates + 'people' config + follows indexes), _shared/feed/people.ts (scorePeople, pickGroup, peopleProvider), people_test.ts, feed/index.ts wired with peopleProvider.
  - DECISION: no people-dismiss endpoint. Impressions/open/follow/dismiss all go through /feed-events (suggestion_* kinds, validated in feed_ingest_events); trg_feed_follow stamps followed_at.
  - Suggestion units never repeat a person within a session (provider reads earlier units from feed_sessions). Weak wide-only candidates are suppressed by people.min_score (0.15).
  - Next: verify with real users, then posts-share -> 'share' event, then Phase 7 Flutter.
