// Discover engine types. Candidate rows come from public.discover_candidate_pool (migration discover_01).
import type { Candidate } from "../feed/types.ts";

export type DiscoverFilter = "for_you" | "marketplace";

export interface DiscoverCandidate extends Candidate {
  disc_impressions: number;       // unique users who saw the tile
  disc_opens: number;             // unique users who opened it from the grid
  disc_delivered: number;
  disc_seen: number;              // times THIS viewer's grid showed it
  disc_seen_hours: number | null; // hours since the viewer last saw it in the grid
  feed_best: number;              // viewer's best Feed outcome (0 seen .. 5 rewatch)
  feed_acts: number;              // viewer's Feed action bit flags
  likes_24h: number;
  comments_24h: number;
  saves_24h: number;
  caption_fp: string | null;      // normalised caption fingerprint (near-duplicate detection)
  price_minor: number | null;
  inquiries: number;              // unique buyers who inquired (listings)
  list_opens: number;             // unique users who opened the listing detail
}

export interface DTrace {
  features: Record<string, number>;
  weights: Record<string, number>;
  contributions: Record<string, number>;
  mult: number;
  jitter: number;
  total: number;
}

export interface DScored {
  c: DiscoverCandidate;
  score: number;
  emerging: boolean;  // low unique exposure: eligible for the emerging quota
  fresh01: number;    // 1 = brand new, 0.5 = one half-life old
  expo: number;
  trace: DTrace;
}
