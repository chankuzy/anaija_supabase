// Distribution lifecycle + quality estimate. Pure functions.
//
//   seed       : < seed_cap unique exposures. Bounded exploratory distribution, relevance-gated by the scorer.
//   promoted   : enough evidence AND smoothed quality >= promote_q  -> reach expands
//   held       : enough evidence, middling quality                  -> no boost
//   demoted    : enough evidence AND smoothed quality < demote_q    -> reach shrinks
//   saturated  : >= saturation_cap exposures                        -> promotion fades, saturation penalty applies
//
// Counts are UNIQUE users (feed_exposures bit flags); authors never count toward their own posts.
import type { Candidate, Stage } from "./types.ts";
import type { FeedConfig } from "./config.ts";

/** Exposure is the larger of reported unique impressions and 70% of pages served (guards dropped events). */
export function effectiveExposure(impressions: number, delivered: number): number {
  return Math.max(impressions, Math.floor(delivered * 0.7));
}

export function postQuality(
  c: Pick<Candidate, "impressions" | "views" | "completions" | "rewatches" | "skips" | "likes" | "comments" |
    "saves" | "shares" | "reposts" | "follows_from" | "negatives">,
  q: FeedConfig["quality"],
): { rate: number; quality: number } {
  const u = q.unit;
  const n = Math.max(c.impressions, c.views, 0);
  // views are cumulative (complete and rewatch are subsets), so each stage adds its own unit on top.
  let pos = c.views * u.view + c.completions * u.complete + c.rewatches * u.rewatch +
    c.likes * u.like + c.comments * u.comment + c.saves * u.save +
    (c.shares + c.reposts) * u.share + c.follows_from * u.follow;
  pos = Math.min(pos, (n + 4) * 5); // hard ceiling on credit per impression
  const neg = c.skips * q.neg_unit.skip + c.negatives * q.neg_unit.negative;
  const rate = (pos - neg + q.prior_rate * q.prior_strength) / (n + q.prior_strength);
  const quality = 1 - Math.exp(-Math.max(rate, 0) / q.squash);
  return { rate, quality };
}

export function distributionStage(
  exposure: number,
  quality: number,
  ageHours: number,
  d: FeedConfig["dist"],
): { stage: Stage; boost: number } {
  if (exposure < d.seed_cap) {
    const decay = Math.max(0.3, Math.pow(0.5, ageHours / d.seed_age_halflife_h));
    return { stage: "seed", boost: d.boost_seed * decay };
  }
  if (exposure >= d.saturation_cap) return { stage: "saturated", boost: 0 };
  if (quality >= d.promote_q) return { stage: "promoted", boost: d.boost_promote };
  if (quality < d.demote_q) return { stage: "demoted", boost: d.penalty_demote };
  return { stage: "held", boost: 0 };
}
