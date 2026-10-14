// Candidate scoring. Pure + deterministic given (candidates, profile, config, seed).
// score = sum(w_i * f_i) - w_neg * neg - w_sat * sat + jitter, every feature normalised to 0..1
// (discovery is the distribution boost, which can be negative for demoted posts).
import type { Candidate, FeedMode, Profile, Scored, ScoreTrace } from "./types.ts";
import { EMPTY_PROFILE } from "./types.ts";
import type { FeedConfig } from "./config.ts";
import { distributionStage, effectiveExposure, postQuality } from "./distribution.ts";

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const squash = (x: number, scale: number) => 1 - Math.exp(-Math.max(x, 0) / Math.max(scale, 1e-6));

export function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967295;
}

export interface ProfileIndex {
  personalised: boolean;
  institution: number | null;
  topics: Map<string, number>;
  creators: Map<number, number>;
  fmtShare: Record<string, number>;
  instShare: Map<number, number>;
}

export function buildProfileIndex(profile: Profile, cfg: FeedConfig): ProfileIndex {
  const topics = new Map<string, number>();
  for (const x of profile.topics) topics.set(x.t, x.s);
  const creators = new Map<number, number>();
  for (const x of profile.creators) creators.set(x.id, x.s);

  const fmtPos: Record<string, number> = { video: 0, image: 0, listing: 0 };
  let fmtSum = 0;
  const instPos = new Map<number, number>();
  let instSum = 0;
  for (const [k, s] of topics) {
    if (s <= 0) continue;
    if (k.startsWith("fmt:")) {
      const f = k.slice(4);
      if (f in fmtPos) { fmtPos[f] += s; fmtSum += s; }
    } else if (k.startsWith("inst:")) {
      const id = Number(k.slice(5));
      if (Number.isFinite(id)) { instPos.set(id, s); instSum += s; }
    }
  }
  // Format and institution affinities saturate at the cap for active users, so only their SHARE is used.
  const base = cfg.rank.format_baseline;
  const fmtShare: Record<string, number> = { video: base, image: base, listing: base };
  if (fmtSum > 0) for (const f of Object.keys(fmtPos)) fmtShare[f] = fmtPos[f] / fmtSum;
  const instShare = new Map<number, number>();
  if (instSum > 0) for (const [id, s] of instPos) instShare.set(id, s / instSum);

  const minT = cfg.affinity.min_topic_score;
  const minC = cfg.affinity.min_creator_score;
  const personalised = profile.user_id != null && (
    profile.topics.some((x) => !x.t.startsWith("fmt:") && !x.t.startsWith("inst:") && x.s >= minT) ||
    profile.creators.some((x) => x.s >= minC));

  return { personalised, institution: profile.institution_id, topics, creators, fmtShare, instShare };
}

function prefixWeight(topic: string, table: Record<string, number>): number {
  for (const [p, w] of Object.entries(table)) if (topic.startsWith(p)) return w;
  return 1;
}

export function scoreCandidate(
  c: Candidate, idx: ProfileIndex, cfg: FeedConfig, mode: FeedMode, seed: string, jitterAmp: number,
): Scored {
  const R = cfg.rank;
  const auth = mode === "auth";
  const w = !auth ? R.guest : c.kind === "listing" ? R.listing : R.auth;

  // --- personal relevance (authenticated only) ---------------------------------------------------
  let interest = 0, topicNeg = 0;
  if (auth) {
    let raw = 0, negRaw = 0;
    for (const t of c.topics) {
      const s = idx.topics.get(t);
      if (s === undefined) continue;
      const pw = prefixWeight(t, R.topic_prefix_weight);
      if (s > 0) raw += (s >= cfg.affinity.min_topic_score ? s : s * 0.3) * pw; // weak signals count 30%
      else if (s <= cfg.affinity.neg_topic_score) negRaw += -s * pw;
    }
    interest = squash(raw, R.interest_scale);
    topicNeg = squash(negRaw, R.interest_scale);
  }

  const cs = auth ? (idx.creators.get(c.author_id) ?? 0) : 0;
  const creator = cs > 0 ? squash(cs, R.creator_scale) : 0;
  const creatorNeg = cs <= cfg.affinity.neg_topic_score ? squash(-cs, R.creator_scale) : 0;

  const follow = auth && c.is_following ? 1 : 0;

  let campus = 0;
  if (auth && c.inst != null) {
    const same = idx.institution != null && c.inst === idx.institution ? 1 : 0;
    const aff = (idx.instShare.get(c.inst) ?? 0) * R.inst_affinity_weight;
    campus = Math.max(same, aff);
  }

  const fmtKey = c.kind === "listing" ? "listing" : c.is_video ? "video" : "image";
  const format = auth
    ? clamp01(0.5 + ((idx.fmtShare[fmtKey] ?? R.format_baseline) - R.format_baseline) * R.format_gain)
    : 0.5;

  // --- content signals ----------------------------------------------------------------------------
  const hl = c.kind === "listing" ? R.fresh_halflife_h.listing : R.fresh_halflife_h.post;
  const fresh = Math.pow(0.5, Math.max(c.age_hours, 0) / hl);
  const { rate, quality } = postQuality(c, cfg.quality);

  // --- distribution: bounded exploration, gated by relevance --------------------------------------
  const exposure = effectiveExposure(c.impressions, c.delivered);
  const dist = distributionStage(exposure, quality, c.age_hours, cfg.dist);
  const relevance = Math.max(interest, creator, campus, follow);
  const gate = !auth || !idx.personalised
    ? 1
    : Math.max(clamp01(relevance / R.discovery_relevance_floor), c.srcs.includes("explore") ? 0.5 : 0);
  const boost = dist.boost > 0 ? dist.boost * gate : dist.boost;

  const small = 1 / (1 + Math.max(c.author_followers, 0) / R.small_followers_scale);
  const neg = clamp01(Math.max(creatorNeg, topicNeg) + clamp01((c.negatives / Math.max(c.impressions, 5)) * 2));
  const sat = clamp01((exposure - cfg.dist.expand_cap) / Math.max(1, cfg.dist.saturation_cap - cfg.dist.expand_cap));

  const features: Record<string, number> = {
    follow, interest, creator, campus, format, quality, fresh, discovery: boost, small, neg, sat,
  };
  const weights = w as unknown as Record<string, number>;
  const contributions: Record<string, number> = {};
  let total = 0;
  for (const k of Object.keys(features)) {
    const v = k === "neg" || k === "sat" ? -weights[k] * features[k] : weights[k] * features[k];
    contributions[k] = v;
    total += v;
  }
  const jitter = hash01(`${seed}:${c.post_id}`) * jitterAmp;
  total += jitter;

  const trace: ScoreTrace = {
    mode, stage: dist.stage, boost, rate, quality, features, weights, contributions, jitter, total,
  };
  return { c, score: total, trace };
}

export function rankCandidates(
  cands: Candidate[], profile: Profile, cfg: FeedConfig,
  opts: { mode: FeedMode; seed: string; jitter?: number },
): Scored[] {
  const idx = buildProfileIndex(opts.mode === "guest" ? EMPTY_PROFILE : profile, cfg);
  const amp = opts.jitter ?? cfg.rank.jitter;
  return cands
    .map((c) => scoreCandidate(c, idx, cfg, opts.mode, opts.seed, amp))
    .sort((a, b) => b.score - a.score || b.c.post_id - a.c.post_id);
}

/** Names of the largest positive contributions (for tracing and, later, honest labels). */
export function topFactors(t: ScoreTrace, n = 3): string[] {
  return Object.entries(t.contributions)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}
