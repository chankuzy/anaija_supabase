// Discover scoring. Pure + deterministic given (candidates, profile, config, seed).
// score = (sum_i w_i * f_i) * penalty_multiplier + jitter, every feature normalised to 0..1.
// Posts and listings use separate weight tables and separate quality tracks: they never compete on
// incompatible metrics (video completion vs inquiries).
import type { FeedConfig } from "../feed/config.ts";
import { effectiveExposure, postQuality } from "../feed/distribution.ts";
import { buildProfileIndex, hash01, type ProfileIndex } from "../feed/scoring.ts";
import { EMPTY_PROFILE, type Profile } from "../feed/types.ts";
import type { DiscoverConfig } from "./config.ts";
import type { DiscoverCandidate, DScored, DTrace } from "./types.ts";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const squash = (x: number, scale: number) => 1 - Math.exp(-Math.max(x, 0) / Math.max(scale, 1e-6));
const isMajor = (t: string) => t.startsWith("#") || t.startsWith("cat:");
const ENGAGED_MASK = 2 | 4 | 8 | 16 | 32 | 64 | 256; // shared, liked, commented, saved, reposted, followed, listing opened

/** Hashtag/category topics only: the ones that describe WHAT a post is about. */
export const majorTopics = (c: { topics: string[] }): string[] => c.topics.filter(isMajor);

function prefixWeight(topic: string, table: Record<string, number>): number {
  for (const [p, w] of Object.entries(table)) if (topic.startsWith(p)) return w;
  return 1;
}

/** Listing quality: inquiries/saves/opens/likes per exposure, smoothed by a prior. Ignores video metrics. */
export function listingQuality(c: DiscoverCandidate, d: DiscoverConfig): number {
  const L = d.listing;
  const pos = c.inquiries * L.inquiry_unit + c.saves * L.save_unit + c.list_opens * L.open_unit + c.likes * L.like_unit;
  const n = Math.max(c.impressions + c.disc_impressions, c.list_opens, 0);
  const rate = (pos + L.prior_rate * L.prior_strength) / (n + L.prior_strength);
  return 1 - Math.exp(-Math.max(rate, 0) / L.squash);
}

export function scoreDiscover(
  c: DiscoverCandidate, idx: ProfileIndex, d: DiscoverConfig, f: FeedConfig, seed: string,
): DScored {
  const listing = c.kind === "listing";

  // quality: smoothed engagement quality blended with the Discover open-rate (also smoothed) ----------
  const fq = listing ? listingQuality(c, d) : postQuality(c, f.quality).quality;
  const pr = d.ctr.prior_rate, ps = d.ctr.prior_strength;
  const ctr = (c.disc_opens + pr * ps) / (c.disc_impressions + ps);
  const ctrNorm = clamp01(ctr / (2 * pr));
  const quality = clamp01((1 - d.ctr.blend) * fq + d.ctr.blend * ctrNorm);

  // campus: strong preference, never a wall --------------------------------------------------------
  let campus: number;
  if (idx.institution == null || c.inst == null) campus = d.campus.neutral;
  else if (c.inst === idx.institution) campus = 1;
  else {
    campus = clamp01(Math.max(
      (idx.instShare.get(c.inst) ?? 0) * d.campus.inst_affinity_weight,
      d.campus.cross_floor + d.campus.cross_quality_gain * quality,
    ));
  }

  // freshness ----------------------------------------------------------------------------------------
  const hl = listing ? d.fresh_halflife_h.listing : d.fresh_halflife_h.post;
  const fresh = Math.pow(0.5, Math.max(c.age_hours, 0) / hl);

  // personal interest: capped, so it can never run the grid ---------------------------------------------
  const minT = f.affinity.min_topic_score;
  let raw = 0;
  for (const t of c.topics) {
    const s = idx.topics.get(t);
    if (s !== undefined && s >= minT) raw += s * prefixWeight(t, f.rank.topic_prefix_weight);
  }
  const cs = idx.creators.get(c.author_id) ?? 0;
  const topicInterest = clamp01(squash(raw, d.interest.scale) / d.interest.cap);
  const creatorInterest = cs > 0 ? squash(cs, d.interest.creator_scale) * 0.7 : 0;
  const interest = idx.personalised ? Math.max(topicInterest, creatorInterest) : 0;

  // novelty: the counterweight to interest ----------------------------------------------------------------
  const expo = effectiveExposure(c.impressions + c.disc_impressions, c.delivered + c.disc_delivered);
  const majors = majorTopics(c);
  const knownTopics = majors.filter((t) => (idx.topics.get(t) ?? 0) >= minT).length;
  const topicNew = majors.length ? 1 - knownTopics / majors.length : 0.5;
  let creatorNew = cs > 0 ? 1 - squash(cs, d.interest.creator_scale) : 1;
  if (c.is_following) creatorNew = Math.min(creatorNew, 0.4);
  const unseen = c.disc_seen === 0 ? (c.feed_best < 3 ? 1 : 0.4) : 0.2;
  const expoTerm = 1 / (1 + expo / d.novelty.expo_scale);
  const N = d.novelty;
  const novelty = clamp01(N.emerging_w * expoTerm + N.topic_w * topicNew + N.creator_w * creatorNew + N.unseen_w * unseen);

  // trending momentum: last-24h unique-user actions, damped for very young posts ------------------------------
  const m = c.likes_24h + 2 * c.comments_24h + 3 * c.saves_24h;
  const trending = squash(m, d.trending.scale) * (0.5 + 0.5 * clamp01(c.age_hours / d.trending.min_age_h));

  const features: Record<string, number> = { campus, quality, fresh, novelty, interest };
  if (listing) features.avail = c.price_minor != null && c.price_minor > 0 ? 1 : 0.5;
  else features.trending = trending;
  const weights = (listing ? d.listing_weights : d.weights) as unknown as Record<string, number>;

  let base = 0;
  const contributions: Record<string, number> = {};
  for (const k of Object.keys(weights)) {
    const v = weights[k] * (features[k] ?? 0);
    contributions[k] = v;
    base += v;
  }

  // penalties (multiplicative): what they already have, what they already saw here, what they rejected ------------
  const P = d.penalty;
  const consumedPen = c.feed_best >= 3 ? P.consumed : 0;
  const engagedPen = (c.feed_acts & ENGAGED_MASK) !== 0 ? P.engaged : 0;
  const seenPen = c.disc_seen > 0
    ? P.disc_seen * Math.pow(0.5, (c.disc_seen_hours ?? 0) / P.disc_seen_decay_h) * Math.min(1, 0.6 + 0.2 * c.disc_seen)
    : 0;
  const negRate = clamp01((c.negatives / Math.max(c.impressions, 5)) * 2);
  const creatorNeg = cs <= f.affinity.neg_topic_score ? clamp01(-cs / d.interest.creator_scale) : 0;
  const negPen = clamp01(P.neg * Math.max(negRate, creatorNeg));
  const mult = (1 - consumedPen) * (1 - engagedPen) * (1 - seenPen) * (1 - negPen);

  const jitter = hash01(`${seed}:${c.post_id}`) * d.jitter;
  const total = base * mult + jitter;

  const trace: DTrace = { features, weights, contributions, mult, jitter, total };
  return { c, score: total, emerging: expo < (d.candidates.emerging_cap ?? 15), fresh01: fresh, expo, trace };
}

export function rankDiscover(
  cands: DiscoverCandidate[], profile: Profile, f: FeedConfig, d: DiscoverConfig, seed: string,
): DScored[] {
  const idx = buildProfileIndex(profile ?? EMPTY_PROFILE, f);
  return cands
    .map((c) => scoreDiscover(c, idx, d, f, seed))
    .sort((a, b) => b.score - a.score || b.c.post_id - a.c.post_id);
}

export function topFactors(t: DTrace, n = 3): string[] {
  return Object.entries(t.contributions).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k]) => k);
}
