// Shared types for the Anaija feed engine. Mirrors the rows returned by feed_candidate_pool / feed_user_profile.
export type FeedMode = "auth" | "guest";
export type Stage = "seed" | "promoted" | "held" | "demoted" | "saturated";

export interface Candidate {
  post_id: number;
  author_id: number;
  kind: "post" | "listing";
  subtype: string | null;
  listing_type: string | null;
  age_hours: number;
  inst: number | null;
  is_video: boolean;
  duration_s: number;
  topics: string[];
  srcs: string[];
  interest_strength: number;
  author_followers: number;
  is_following: boolean;
  creator_score: number;
  impressions: number;
  views: number;
  completions: number;
  rewatches: number;
  skips: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  reposts: number;
  follows_from: number;
  negatives: number;
  delivered: number;
}

export interface Profile {
  user_id: number | null;
  institution_id: number | null;
  following: number;
  consumed_total: number;
  topics: { t: string; s: number }[];
  creators: { id: number; s: number }[];
  hides: number[];
}

export const EMPTY_PROFILE: Profile = {
  user_id: null,
  institution_id: null,
  following: 0,
  consumed_total: 0,
  topics: [],
  creators: [],
  hides: [],
};

export interface ScoreTrace {
  mode: FeedMode;
  stage: Stage;
  boost: number;
  rate: number;
  quality: number;
  features: Record<string, number>;
  weights: Record<string, number>;
  contributions: Record<string, number>;
  jitter: number;
  total: number;
}

export interface Scored {
  c: Candidate;
  score: number;
  trace: ScoreTrace;
}
