/// <reference path="../_shared/deno-shim.d.ts" />
import type { SupabaseClient } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { HttpError, isStaff, loadAccess, rank, type Access } from "../_shared/services/communityAccess.ts";
import { notify } from "../_shared/services/communityService.ts";
import { broadcastBatch } from "../_shared/services/realtimeService.ts";

export { HttpError, isStaff, loadAccess };
export type { Access, SupabaseClient };

// Privacy rule for every file in this function: moments.creator_id and moment_entries.author_id are read server-side only
// (rate limits, blocks, is_mine, notifying that person) and are NEVER returned. Mod-log rows never carry a target user.

export const TYPES = ["hot_seat", "verdict", "confession_drop", "dept_war", "one_question"] as const;
export const MODES = ["off", "member", "moderator", "admin"];
const DEFAULTS: Record<string, string> = {
  hot_seat: "member", verdict: "member", one_question: "member", confession_drop: "member", dept_war: "member", dept_war_official: "representative",
};
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
// deno-lint-ignore no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const int = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
export const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => ALPHABET[b % ALPHABET.length]).join("");
export const clean = (v: unknown, max: number, multiline = false) => {
  if (typeof v !== "string") return "";
  const s = v.replace(/\r\n?/g, "\n").replace(CTRL, "").trim();
  return (multiline ? s.replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ")).slice(0, max);
};
export const isoOrNull = (v: unknown): string | null | undefined => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};
export const later = (p: Promise<unknown>) => {
  const safe = p.catch((e) => console.error("background task failed", e));
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(safe);
};

// ── content scan: private details are blocked outright; names/accusations/handles are flagged for staff ────────────
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]{2,}/;
const PHONE = /(?:\+?\d[\s().-]?){9,}/;
const HANDLE = /(?:^|\s)@[a-z0-9_.]{3,}/i;
const TITLE_NAME = /\b(?:Mr|Mrs|Miss|Ms|Dr|Prof|Engr|Pastor)\.?\s+[A-Z][a-z]{2,}/;
const ACCUSE = /\b(rapist|raped|molest\w*|thief|stole|steals?|cultist|fraudster|scammer|cheat(?:s|ed|er)?|abuser|sleeps? with|slept with)\b/i;
export function scan(body: string): { block: string | null; flags: string[] } {
  if (EMAIL.test(body)) return { block: "Please remove email addresses.", flags: [] };
  if (PHONE.test(body)) return { block: "Please remove phone numbers.", flags: [] };
  const flags: string[] = [];
  if (HANDLE.test(body)) flags.push("handle");
  if (TITLE_NAME.test(body)) flags.push("named_person");
  if (ACCUSE.test(body)) flags.push("accusation");
  return { block: null, flags };
}

// ── permissions ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const momentSettings = (a: Access): Record<string, string> => ({ ...DEFAULTS, ...(a.community.moment_settings ?? {}) });
export function canCreate(a: Access, type: string): boolean {
  if (!a.role || a.banned || a.community.status !== "active") return false;
  const need = momentSettings(a)[type];
  return !!need && need !== "off" && rank(a.role) >= rank(need);
}

// ── plumbing ───────────────────────────────────────────────────────────────────────────────────────────────────────────
export const ping = (m: any, kind: string) => broadcastBatch([{ topic: `moment:${m.realtime_key}`, event: "changed", payload: { kind } }]);
export const modLog = (supabase: SupabaseClient, m: any, actor: number, action: string, t: { kind?: string; id?: number } = {}, note?: string) =>
  supabase.from("community_mod_log").insert({
    community_id: m.community_id, actor_id: actor, action, target_kind: t.kind ?? "moment", target_id: t.id ?? m.id, note: note?.slice(0, 200) ?? null,
  });
export const notifyParticipants = async (supabase: SupabaseClient, momentId: number, kind: string) => {
  const { data } = await supabase.from("moment_participants").select("user_id").eq("moment_id", momentId).limit(500);
  await supabase.rpc("moments_notify", { p_moment: momentId, p_kind: kind, p_recipients: (data ?? []).map((r: any) => r.user_id) });
};
// the creator is told about a moderator action; the message never names the moderator
export const tellCreator = (supabase: SupabaseClient, m: any, a: Access, action: string, reason: string | null) =>
  notify(supabase, {
    recipient: m.creator_id, actor: null, kind: "moment_mod", groupKey: `moment_mod:${m.id}:${action}`, dedupe: `moment_mod:${m.id}:${action}`,
    community: m.community_id, payload: { community: a.community.name, slug: a.community.slug, code: m.code, type: m.type, title: m.title, action, reason },
  });
export { notify };

export const userCard = (u: any) => ({ name: u.name ?? null, username: u.username ?? null, avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar) });

// ── registries (Department Wars plugs in here) ─────────────────────────────────────────────────────────────────────────
export type CreateCtx = { b: any; startMs: number; a: Access; userId: number; errors: Record<string, string> };
export type Creator = (x: CreateCtx) => { fields: Record<string, unknown>; after?: (supabase: SupabaseClient, id: number) => Promise<void> };
export const creators = new Map<string, Creator>();
export const configViewers = new Map<string, (supabase: SupabaseClient, m: any, cfg: any, st: Standing, viewer: number | null) => Promise<unknown>>();

// ── lifecycle ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const CFG_TABLE: Record<string, string> = { hot_seat: "moment_hot_seats", confession_drop: "moment_confession_drops", dept_war: "moment_war_config" };
export async function cfgOf(supabase: SupabaseClient, m: any) {
  const t = CFG_TABLE[m.type];
  if (!t) return null;
  const { data } = await supabase.from(t).select("*").eq("moment_id", m.id).maybeSingle();
  return data;
}

/** True when a transition is due. Mirrors moments_tick(); the API calls the tick so cron lag never shows. */
export async function anyOverdue(supabase: SupabaseClient, rows: any[]): Promise<boolean> {
  const now = Date.now();
  const due = (t: string | null) => !!t && Date.parse(t) <= now;
  for (const m of rows) {
    if (m.status === "scheduled" && (due(m.starts_at) || due(m.ends_at))) return true;
    if (m.status === "active" && due(m.ends_at)) return true;
  }
  const iso = new Date(now).toISOString();
  const ids = (st: string, ty: string) => rows.filter((r) => r.status === st && r.type === ty).map((r) => r.id as number);
  const hs = ids("closed", "hot_seat"), cd = ids("closed", "confession_drop"), wr = ids("draft", "dept_war");
  const [a, b, c] = await Promise.all([
    hs.length ? supabase.from("moment_hot_seats").select("moment_id").in("moment_id", hs).lte("answer_until", iso).limit(1) : { data: [] },
    cd.length ? supabase.from("moment_confession_drops").select("moment_id").in("moment_id", cd).lte("reveal_at", iso).is("reveal_notified_at", null).limit(1) : { data: [] },
    wr.length ? supabase.from("moment_war_config").select("moment_id").in("moment_id", wr).lte("invite_expires_at", iso).limit(1) : { data: [] },
  ]);
  return (a.data ?? []).length + (b.data ?? []).length + (c.data ?? []).length > 0;
}
export const tickNow = (supabase: SupabaseClient) => supabase.rpc("moments_tick");

export async function loadMoment(supabase: SupabaseClient, codeRaw: string) {
  const code = String(codeRaw ?? "").toLowerCase();
  if (!/^[a-z0-9]{6,20}$/.test(code)) throw new HttpError(404, "Moment not found.");
  const read = async () => {
    const { data, error } = await supabase.from("moments").select("*").eq("code", code).maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "Moment not found.");
    return data;
  };
  let m = await read();
  if (await anyOverdue(supabase, [m])) {
    await tickNow(supabase);
    m = await read();
  }
  return { m, cfg: await cfgOf(supabase, m) };
}

// Members of either side of a Department War can see it even though it lives under the challenger community.
async function inWar(supabase: SupabaseClient, momentId: number, viewer: number): Promise<boolean> {
  const { data: s } = await supabase.from("moment_war_sides").select("community_id").eq("moment_id", momentId);
  const ids = (s ?? []).map((x: any) => x.community_id as number);
  if (!ids.length) return false;
  const { data } = await supabase.from("community_members").select("community_id").eq("user_id", viewer).in("community_id", ids).limit(1);
  return !!data?.length;
}

export async function standing(supabase: SupabaseClient, m: any, viewer: number | null) {
  const a = await loadAccess(supabase, m.community_id, viewer);
  if (!a) throw new HttpError(404, "This Moment isn't available.");
  if (a.banned) throw new HttpError(403, "You can't access this community.");
  const member = !!a.role;
  let blocked = false, muted = false, reminder = false;
  if (viewer && member) {
    const [b, mu, r] = await Promise.all([
      supabase.from("moment_blocks").select("user_id").eq("moment_id", m.id).eq("user_id", viewer).maybeSingle(),
      supabase.from("community_members").select("muted_until").eq("community_id", m.community_id).eq("user_id", viewer).maybeSingle(),
      supabase.from("moment_reminders").select("user_id").eq("moment_id", m.id).eq("user_id", viewer).maybeSingle(),
    ]);
    blocked = !!b.data;
    muted = !!(mu.data?.muted_until && new Date(mu.data.muted_until) > new Date());
    reminder = !!r.data;
  }
  let canView = member || (m.allow_preview && a.community.read_policy === "public_preview");
  if (!canView && viewer && m.type === "dept_war") canView = await inWar(supabase, m.id, viewer);
  const host = !!viewer && viewer === m.creator_id;
  const active = m.status === "active" && a.community.status === "active";
  const ok = member && !blocked && !muted;
  return {
    a, member, blocked, muted, reminder, canView, host, active, staff: isStaff(a), moderate: host || isStaff(a),
    canParticipate: ok && active,
    canComment: ok && (m.type === "confession_drop" ? ["closed", "completed"].includes(m.status) : active),
  };
}
export type Standing = Awaited<ReturnType<typeof standing>>;

export const hasVoted = async (supabase: SupabaseClient, momentId: number, viewer: number | null) =>
  !!viewer && !!(await supabase.from("moment_votes").select("user_id").eq("moment_id", momentId).eq("user_id", viewer).maybeSingle()).data;

// ── views ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function configView(supabase: SupabaseClient, m: any, cfg: any, st: Standing, viewer: number | null): Promise<unknown> {
  const head = (q: any) => q.then((r: any) => r.count ?? 0);
  const entries = () => supabase.from("moment_entries").select("id", { count: "exact", head: true }).eq("moment_id", m.id).is("parent_id", null);
  if (m.type === "hot_seat") {
    const [open, answered] = await Promise.all([head(entries().eq("status", "visible")), head(entries().eq("status", "answered"))]);
    return { submissions_closed: m.status !== "active", answer_until: cfg?.answer_until ?? null, open_count: open, answered_count: answered };
  }
  if (m.type === "verdict") {
    const [{ data: opts }, myVote] = await Promise.all([
      supabase.from("moment_options").select("idx, label, votes_count").eq("moment_id", m.id).order("idx"),
      viewer ? supabase.from("moment_votes").select("option_idx").eq("moment_id", m.id).eq("user_id", viewer).maybeSingle() : Promise.resolve({ data: null as any }),
    ]);
    const mine: number | null = myVote.data ? myVote.data.option_idx : null;
    // Results are withheld until the viewer has voted or the Moment is over.
    const visible = mine !== null || ["closed", "completed"].includes(m.status);
    const total = (opts ?? []).reduce((s: number, o: any) => s + o.votes_count, 0);
    return {
      my_vote: mine, results_visible: visible, total_votes: visible ? total : null,
      options: (opts ?? []).map((o: any) => ({
        idx: o.idx, label: o.label,
        ...(visible ? { votes: o.votes_count, pct: total ? Math.round((o.votes_count / total) * 100) : 0 } : {}),
      })),
    };
  }
  if (m.type === "confession_drop") {
    const approved = () => entries().eq("kind", "confession").eq("status", "approved");
    const [ap, rv] = await Promise.all([head(approved()), head(approved().lte("reveal_at", new Date().toISOString()))]);
    return { reveal_at: cfg?.reveal_at ?? null, reveal_mode: cfg?.reveal_mode ?? null, reveal_interval_secs: cfg?.reveal_interval_secs ?? null,
      max_per_user: cfg?.max_per_user ?? null, approved_count: ap, revealed_count: rv };
  }
  const fn = configViewers.get(m.type);
  return fn ? await fn(supabase, m, cfg, st, viewer) : null;
}

export async function momentView(supabase: SupabaseClient, m: any, cfg: any, st: Standing, viewer: number | null) {
  const show = st.canView && (m.status !== "cancelled" || st.moderate);
  const c = st.a.community;
  let host: unknown = null;
  if (show && !m.anonymous) {
    const { data: h } = await supabase.from("users").select("name, username, avatar_key, avatar").eq("id", m.creator_id).maybeSingle();
    host = h ? userCard(h) : null;
  }
  let mine = 0;
  if (viewer && st.member) {
    const { count } = await supabase.from("moment_entries").select("id", { count: "exact", head: true })
      .eq("moment_id", m.id).eq("author_id", viewer).is("parent_id", null).in("status", ["pending", "visible", "approved", "answered", "skipped"]);
    mine = count ?? 0;
  }
  return {
    id: m.id, code: m.code, path: `/m/${m.code}`, type: m.type, status: m.status,
    title: show ? m.title : null, body: show ? m.body : null, cancel_reason: show ? m.cancel_reason : null,
    anonymous: m.anonymous, allow_anonymous_entries: m.allow_anonymous_entries, is_official: m.is_official,
    starts_at: m.starts_at, ends_at: m.ends_at, ended_at: m.ended_at, created_at: m.created_at,
    participants_count: show ? m.participants_count : 0, entries_count: show ? m.entries_count : 0,
    realtime_key: show ? m.realtime_key : null,
    host,
    community: { id: c.id, name: c.name, slug: c.slug, avatar: resolveAvatarUrl(c.avatar_key), members_count: c.members_count, join_policy: c.join_policy, read_policy: c.read_policy },
    config: show ? await configView(supabase, m, cfg, st, viewer) : null,
    viewer: {
      authenticated: viewer !== null, is_member: st.member, can_view: st.canView,
      can_participate: st.canParticipate, can_comment: st.canComment,
      is_host: st.host, can_moderate: st.moderate, is_staff: st.staff, blocked: st.blocked, muted: st.muted,
      join: st.member ? null : c.join_policy, reminder: st.reminder, my_entries: mine,
    },
  };
}
