// supabase/functions/_shared/services/communityService.ts
import type { SupabaseClient } from "../auth.ts";
import { resolveAvatarUrl } from "../avatar.ts";
import { formatPost } from "./feedService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";
import { getFacePile } from "./communityFaces.ts";
import { ACTIONS, HttpError, ROLES, canRead, loadAccess, rank, viewerCan, type Access } from "./communityAccess.ts";

const PAGE_SIZE = 20;
const MAX_CURSOR = Number.MAX_SAFE_INTEGER;
const CATEGORIES = ["class", "department", "faculty", "campus", "creator", "interest", "professional", "seller", "other"];
const JOIN_POLICIES = ["open", "request", "invite"];
const DISCOVERABILITY = ["listed", "unlisted"];
const READ_POLICIES = ["public_preview", "members_only"];

const decodeCursor = (c: string | null): number => {
  if (!c) return MAX_CURSOR;
  try {
    const n = parseInt(atob(c), 10);
    return Number.isFinite(n) ? n : MAX_CURSOR;
  } catch {
    return MAX_CURSOR;
  }
};

// ─── Formatting ───────────────────────────────────────────────────────────

/** One membership query + one pending-request query for the whole page (no per-row lookups). */
export async function formatCommunities(supabase: SupabaseClient, rows: any[], viewerId: number | null) {
  const ids = rows.map((r) => r.id);
  const roles = new Map<number, string>();
  const pending = new Set<number>();
  if (viewerId && ids.length) {
    const [m, r] = await Promise.all([
      supabase.from("community_members").select("community_id, role").eq("user_id", viewerId).in("community_id", ids),
      supabase.from("community_join_requests").select("community_id")
        .eq("user_id", viewerId).eq("status", "pending").in("community_id", ids),
    ]);
    for (const x of m.data ?? []) roles.set(x.community_id, x.role);
    for (const x of r.data ?? []) pending.add(x.community_id);
  }
  return rows.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    avatar: resolveAvatarUrl(c.avatar_key),
    cover: resolveAvatarUrl(c.cover_key),
    category: c.category,
    institution_id: c.institution_id,
    faculty: c.faculty, department: c.department, level: c.level,
    course_code: c.course_code, academic_session: c.academic_session,
    members_count: c.members_count ?? 0,
    posts_count: c.posts_count ?? 0,
    discoverability: c.discoverability,
    join_policy: c.join_policy,
    read_policy: c.read_policy,
    status: c.status,
    is_member: roles.has(c.id),
    my_role: roles.get(c.id) ?? null,
    request_status: pending.has(c.id) ? "pending" : null,
  }));
}

/** Legacy single-row shape (Discover / Search imports). */
export async function formatCommunity(supabase: SupabaseClient, c: any, viewerId: number | null) {
  return (await formatCommunities(supabase, [c], viewerId))[0];
}

// ─── Discovery ────────────────────────────────────────────────────────────

const LISTED = (q: any) => q.eq("is_active", true).eq("status", "active").eq("discoverability", "listed");

export async function listCommunities(
  supabase: SupabaseClient,
  opts: { viewerId: number | null; institutionId?: number | null; search?: string | null; page?: number; category?: string | null },
) {
  const page = Math.max(1, opts.page ?? 1);
  const from = (page - 1) * PAGE_SIZE;
  let query = LISTED(supabase.from("communities").select("*"));

  const term = (opts.search ?? "").replace(/[^\p{L}\p{N} \-]/gu, "").trim().slice(0, 60);
  if (term) query = query.or(`name.ilike.%${term}%,course_code.ilike.%${term}%,department.ilike.%${term}%`);
  if (opts.institutionId) query = query.eq("institution_id", opts.institutionId);
  if (opts.category && CATEGORIES.includes(opts.category)) query = query.eq("category", opts.category);

  const { data, error } = await query
    .order("members_count", { ascending: false }).order("id", { ascending: false })
    .range(from, from + PAGE_SIZE);
  if (error) throw error;

  const hasMore = (data?.length ?? 0) > PAGE_SIZE;
  const rows = (data ?? []).slice(0, PAGE_SIZE);
  return { data: await formatCommunities(supabase, rows, opts.viewerId), has_more: hasMore };
}

/** Discover fold-in: popular listed communities the viewer hasn't joined, biased to their campus. */
export async function getSuggestedCommunities(
  supabase: SupabaseClient, viewerId: number, institutionId: number | null, limit: number,
) {
  const { data: memberships } = await supabase.from("community_members").select("community_id").eq("user_id", viewerId);
  const joined = (memberships ?? []).map((m: any) => m.community_id);
  let query = LISTED(supabase.from("communities").select("*"));
  if (joined.length) query = query.not("id", "in", `(${joined.join(",")})`);
  if (institutionId) query = query.eq("institution_id", institutionId);
  const { data, error } = await query.order("members_count", { ascending: false }).limit(limit);
  if (error) throw error;
  return formatCommunities(supabase, data ?? [], viewerId);
}

export async function listMine(supabase: SupabaseClient, userId: number) {
  const { data, error } = await supabase.from("community_members")
    .select("role, joined_at, community:communities(*)")
    .eq("user_id", userId).order("joined_at", { ascending: false }).limit(100);
  if (error) throw error;
  const rows = (data ?? []).map((r: any) => r.community)
    .filter((c: any) => c && c.is_active && c.status !== "suspended");
  const formatted = await formatCommunities(supabase, rows, userId);

  const convIds = rows.map((c: any) => c.chat_conversation_id).filter(Boolean);
  const unread = new Map<number, number>();
  if (convIds.length) {
    const { data: parts } = await supabase.from("conversation_participants")
      .select("conversation_id, unread_count").eq("user_id", userId).in("conversation_id", convIds);
    for (const p of parts ?? []) unread.set(p.conversation_id, p.unread_count ?? 0);
  }
  return formatted.map((f, i) => ({
    ...f,
    chat_conversation_id: rows[i].chat_conversation_id ?? null,
    chat_unread: unread.get(rows[i].chat_conversation_id) ?? 0,
  }));
}

// ─── Detail (header + About) ──────────────────────────────────────────────

export async function getCommunity(supabase: SupabaseClient, ref: string, viewerId: number | null) {
  const a = await loadAccess(supabase, ref, viewerId);
  if (!a) return { notFound: true as const };
  return { community: await formatCommunity(supabase, a.community, viewerId) };
}

export async function getCommunityDetail(supabase: SupabaseClient, ref: string | number, viewerId: number | null) {
  const a = await loadAccess(supabase, ref, viewerId);
  if (!a) return null;
  if (a.banned) throw new HttpError(403, "You can't access this community.");
  const c = a.community;
  const base = await formatCommunity(supabase, c, viewerId);
  const readable = canRead(a);
  const open = readable && (!!a.role || c.read_policy === "public_preview");

  let staff: any[] = [];
  if (open) {
    const [m, d] = await Promise.all([
      supabase.from("community_members")
        .select("role, user:users!community_members_user_id_fkey(id, name, username, avatar_key, avatar)")
        .eq("community_id", c.id).neq("role", "member").limit(30),
      supabase.from("community_designations").select("user_id, kind, scope_label")
        .eq("community_id", c.id).is("revoked_at", null).limit(60),
    ]);
    const byUser = new Map<number, any[]>();
    for (const x of d.data ?? []) byUser.set(x.user_id, [...(byUser.get(x.user_id) ?? []), { kind: x.kind, scope_label: x.scope_label }]);
    staff = (m.data ?? []).filter((x: any) => x.user).map((x: any) => ({
      id: x.user.id, name: x.user.name, username: x.user.username,
      avatar: resolveAvatarUrl(x.user.avatar_key ?? x.user.avatar),
      role: x.role, designations: byUser.get(x.user.id) ?? [],
    }));
  }

  const face_pile = open ? await getFacePile(supabase, c.id, viewerId) : [];

  return {
    ...base,
    face_pile,
    rules: open ? c.rules ?? [] : [],
    links: open ? c.links ?? [] : [],
    permissions: a.role ? c.permissions : null,
    staff,
    my_designations: a.designations.map((x) => ({ kind: x.kind, scope_label: x.scope_label })),
    chat_conversation_id: a.role ? c.chat_conversation_id : null,
    can: viewerCan(a),
  };
}

// ─── Create / update ──────────────────────────────────────────────────────

// deno-lint-ignore no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
function text(v: unknown, max: number, multiline = false): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/\r\n?/g, "\n").replace(CTRL, "").trim();
  return (multiline ? s.replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ")).slice(0, max);
}
function mediaKey(v: unknown, userId: number): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  return v.startsWith(`${userId}/`) && !v.includes("..") && v.length <= 300 ? v : undefined;
}

function buildFields(raw: unknown, userId: number, current: any | null) {
  const b: Record<string, any> = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as any) : {};
  const e: Record<string, string> = {};
  const f: Record<string, unknown> = {};
  const has = (k: string) => b[k] !== undefined;

  if (current === null || has("name")) {
    const n = text(b.name, 60);
    if (n.length < 3) e.name = "Give the community a name (3 to 60 characters).";
    else f.name = n;
  }
  if (has("description")) f.description = text(b.description, 500, true) || null;

  const pick = (k: string, allowed: string[]) => {
    if (!has(k)) return;
    if (allowed.includes(b[k])) f[k] = b[k];
    else e[k] = `Invalid ${k.replace("_", " ")}.`;
  };
  pick("category", CATEGORIES);
  pick("join_policy", JOIN_POLICIES);
  pick("discoverability", DISCOVERABILITY);
  pick("read_policy", READ_POLICIES);

  for (const k of ["course_code", "academic_session", "department", "faculty", "level"]) {
    if (has(k)) f[k] = text(b[k], 60) || null;
  }
  for (const k of ["avatar_key", "cover_key"]) {
    if (!has(k)) continue;
    const key = mediaKey(b[k], userId);
    if (key === undefined) e[k] = "Invalid image.";
    else f[k] = key;
  }
  if (has("rules")) {
    const list = Array.isArray(b.rules) ? b.rules : [];
    f.rules = list.slice(0, 10)
      .map((r: any) => text(typeof r === "string" ? r : r?.text, 200)).filter(Boolean).map((t: string) => ({ text: t }));
  }
  if (has("links")) {
    const list = Array.isArray(b.links) ? b.links : [];
    const out: { label: string; url: string }[] = [];
    for (const l of list.slice(0, 5)) {
      try {
        const u = new URL(String(l?.url ?? ""));
        if (u.protocol !== "https:" && u.protocol !== "http:") continue;
        out.push({ label: text(l?.label, 40) || u.hostname, url: u.toString() });
      } catch { /* skip invalid */ }
    }
    f.links = out;
  }
  if (has("permissions")) {
    const p: Record<string, string> = { ...(current?.permissions ?? {}) };
    const given = b.permissions && typeof b.permissions === "object" ? b.permissions : {};
    for (const k of ACTIONS) {
      if (given[k] === undefined) continue;
      if ((ROLES as readonly string[]).includes(given[k])) p[k] = given[k];
      else e.permissions = "Invalid permission level.";
    }
    f.permissions = p;
  }
  return { f, e };
}

const slugify = (name: string) => {
  const s = name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "community";
  return /^\d+$/.test(s) ? `c-${s}` : s; // never all digits: those are read as ids
};
const suffix = () => Math.random().toString(36).slice(2, 6);

export async function createCommunity(supabase: SupabaseClient, userId: number, body: unknown): Promise<number> {
  const { data: user } = await supabase.from("users")
    .select("id, institution_id, profile_completed, username").eq("id", userId).maybeSingle();
  if (!user || !(user.profile_completed || user.username)) throw new HttpError(403, "Finish setting up your profile first.");

  const { count: total } = await supabase.from("communities").select("id", { count: "exact", head: true }).eq("creator_id", userId);
  if ((total ?? 0) >= 10) throw new HttpError(429, "You've reached the community limit.");
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count: recent } = await supabase.from("communities").select("id", { count: "exact", head: true })
    .eq("creator_id", userId).gte("created_at", since);
  if ((recent ?? 0) >= 3) throw new HttpError(429, "You can create up to 3 communities a day.");

  const { f, e } = buildFields(body, userId, null);
  const wanted = (body as any)?.institution_id;
  if (wanted !== undefined && wanted !== null) {
    if (!user.institution_id || Number(wanted) !== Number(user.institution_id)) e.institution_id = "You can only link your own campus.";
    else f.institution_id = user.institution_id;
  }
  if (Object.keys(e).length) throw new HttpError(422, "Validation failed.", e);

  const base = slugify(String(f.name));
  for (let i = 0; i < 6; i++) {
    const slug = i === 0 ? base : `${base}-${suffix()}`;
    const { data, error } = await supabase.rpc("community_create", { p_creator: userId, p: { ...f, slug } });
    if (!error) return data as number;
    if ((error as { code?: string }).code !== "23505") throw error;
  }
  throw new HttpError(409, "Couldn't find a free link for that name. Try a different name.");
}

export async function updateCommunity(supabase: SupabaseClient, a: Access, actorId: number, body: unknown) {
  const { f, e } = buildFields(body, actorId, a.community);
  if (Object.keys(e).length) throw new HttpError(422, "Validation failed.", e);
  if (!Object.keys(f).length) return;
  f.updated_at = new Date().toISOString();
  const { error } = await supabase.from("communities").update(f).eq("id", a.community.id);
  if (error) throw error;
  if ("name" in f || "avatar_key" in f) {
    await supabase.from("conversations").update({
      title: (f.name as string | undefined) ?? a.community.name,
      avatar_key: "avatar_key" in f ? f.avatar_key : a.community.avatar_key,
    }).eq("community_id", a.community.id);
  }
  await supabase.from("community_mod_log").insert({
    community_id: a.community.id, actor_id: actorId, action: "update_settings", note: Object.keys(f).join(",").slice(0, 200),
  });
}

// ─── Join / leave (server-side policy, never a blind toggle) ──────────────

const membersCount = async (supabase: SupabaseClient, id: number) =>
  (await supabase.from("communities").select("members_count").eq("id", id).maybeSingle()).data?.members_count ?? 0;

export async function joinCommunity(supabase: SupabaseClient, communityId: number, userId: number, message: string | null) {
  const open = await supabase.rpc("community_join_open", { p_community: communityId, p_user: userId });
  if (open.error) throw open.error;
  let state = open.data as string;
  if (state === "needs_request") {
    const r = await supabase.rpc("community_request_join", { p_community: communityId, p_user: userId, p_message: message });
    if (r.error) throw r.error;
    state = r.data as string;
    if (state === "requested") await notifyStaffOfRequest(supabase, communityId, userId);
  }
  return { state, members_count: await membersCount(supabase, communityId) };
}

export async function leaveCommunity(supabase: SupabaseClient, communityId: number, userId: number) {
  const { data: m } = await supabase.from("community_members").select("role")
    .eq("community_id", communityId).eq("user_id", userId).maybeSingle();
  if (!m) return { state: "not_member" as const };
  if (m.role === "owner") return { state: "owner" as const };
  await supabase.from("community_designations").update({ revoked_at: new Date().toISOString(), revoked_by: userId })
    .eq("community_id", communityId).eq("user_id", userId).is("revoked_at", null);
  const { error } = await supabase.from("community_members").delete().eq("community_id", communityId).eq("user_id", userId);
  if (error) throw error;
  return { state: "left" as const };
}

/** Legacy endpoint used by the Flutter app: toggles, but through the same policy checks. */
export async function toggleMembership(supabase: SupabaseClient, communityId: number, userId: number) {
  const { data: c } = await supabase.from("communities").select("id").eq("id", communityId).eq("is_active", true).maybeSingle();
  if (!c) return { notFound: true as const };
  const { data: m } = await supabase.from("community_members").select("role")
    .eq("community_id", communityId).eq("user_id", userId).maybeSingle();
  if (m) {
    const r = await leaveCommunity(supabase, communityId, userId);
    return { is_member: r.state === "owner", members_count: await membersCount(supabase, communityId), status: r.state };
  }
  const r = await joinCommunity(supabase, communityId, userId, null);
  return { is_member: r.state === "joined", members_count: r.members_count, status: r.state };
}

// ─── Notifications (ride the existing activity inbox + push outbox) ───────

export async function notify(
  supabase: SupabaseClient,
  n: { recipient: number; actor: number | null; kind: string; groupKey: string; dedupe: string; community: number; payload: Record<string, unknown>; push?: boolean },
) {
  const { error } = await supabase.rpc("community_notify", {
    p_recipient: n.recipient, p_actor: n.actor, p_kind: n.kind, p_group_key: n.groupKey, p_dedupe: n.dedupe,
    p_community: n.community, p_payload: n.payload, p_push: n.push ?? true,
  });
  if (error) console.error("community_notify failed", n.kind, error.message);
}

async function notifyStaffOfRequest(supabase: SupabaseClient, communityId: number, requesterId: number) {
  const [{ data: c }, { data: staff }] = await Promise.all([
    supabase.from("communities").select("name, slug").eq("id", communityId).maybeSingle(),
    supabase.from("community_members").select("user_id").eq("community_id", communityId)
      .in("role", ["owner", "admin", "moderator"]).limit(10),
  ]);
  if (!c) return;
  for (const s of staff ?? []) {
    await notify(supabase, {
      recipient: s.user_id, actor: requesterId, kind: "community_request",
      groupKey: `community_request:${communityId}:${s.user_id}`,
      dedupe: `community_request:${communityId}:${requesterId}:${s.user_id}`,
      community: communityId, payload: { community: c.name, slug: c.slug },
    });
  }
}

export async function notifyDecision(
  supabase: SupabaseClient, communityId: number, requesterId: number, actorId: number, approved: boolean,
) {
  const { data: c } = await supabase.from("communities").select("name, slug").eq("id", communityId).maybeSingle();
  if (!c) return;
  await notify(supabase, {
    recipient: requesterId, actor: actorId, kind: "community_decision",
    groupKey: `community_decision:${communityId}:${requesterId}:${Date.now()}`,
    dedupe: `community_decision:${communityId}:${requesterId}:${approved ? "y" : "n"}:${Date.now()}`,
    community: communityId, payload: { community: c.name, slug: c.slug, approved },
  });
}

// ─── Feed ─────────────────────────────────────────────────────────────────

/** Callers must have passed canRead() first. Pinned posts ride on the first page only. */
export async function getCommunityPosts(
  supabase: SupabaseClient, communityId: number, userId: number | null, cursor: string | null, cdnBase: string,
) {
  const cursorId = decodeCursor(cursor);
  const SEL = "*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), media:post_media(*)";
  const base = () => supabase.from("posts").select(SEL)
    .eq("community_id", communityId).eq("community_feed", true).in("type", ["post", "listing"])
    .eq("is_active", true).is("deleted_at", null).eq("processing_status", "ready");

  const [pinnedRes, listRes] = await Promise.all([
    cursor ? Promise.resolve({ data: [] as any[], error: null }) :
      base().not("community_pinned_at", "is", null).order("community_pinned_at", { ascending: false }).limit(3),
    base().is("community_pinned_at", null).lt("id", cursorId).order("id", { ascending: false }).limit(PAGE_SIZE + 1),
  ]);
  if (pinnedRes.error) throw pinnedRes.error;
  if (listRes.error) throw listRes.error;

  const rows = listRes.data ?? [];
  const hasMore = rows.length > PAGE_SIZE;
  const page = rows.slice(0, PAGE_SIZE);
  const pinned = pinnedRes.data ?? [];
  const all = [...pinned, ...page];
  await batchAttachAudio(supabase, all);

  const liked = new Set<number>();
  if (userId && all.length) {
    const { data } = await supabase.from("post_likes").select("post_id").eq("user_id", userId).in("post_id", all.map((p: any) => p.id));
    for (const r of data ?? []) liked.add(r.post_id);
  }
  const followed = new Set<number>();
  if (userId && all.length) {
    const { data } = await supabase.from("follows").select("following_id")
      .eq("follower_id", userId).in("following_id", [...new Set(all.map((p: any) => p.user_id as number))]);
    for (const r of data ?? []) followed.add(r.following_id);
  }
  const pinnedIds = new Set(pinned.map((p: any) => p.id));
  const posts = await Promise.all(all.map(async (p: any) => {
    const out: any = await formatPost(supabase, p, cdnBase, liked.has(p.id));
    if (out?.author) out.author.is_following = followed.has(p.user_id);
    return Object.assign(out, { community_pinned: pinnedIds.has(p.id) });
  }));

  return {
    posts,
    next_cursor: hasMore && page.length ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}

export { rank };
