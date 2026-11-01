/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, type SupabaseClient } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { HttpError, can, canRead, isStaff, loadAccess, rank, type Access } from "../_shared/services/communityAccess.ts";
import { notify } from "../_shared/services/communityService.ts";
import { createPost } from "../_shared/services/postService.ts";
import { prepareResource, saveResource } from "./library.ts";
import { broadcastToConversation } from "../_shared/services/realtimeService.ts";

const int = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
// Runs after the response where the runtime allows it; never throws.
const bg = (p: Promise<unknown>) => {
  const rt = (globalThis as any).EdgeRuntime;
  const safe = p.catch((e) => console.error("background task failed", e));
  if (rt?.waitUntil) rt.waitUntil(safe);
};
const KIND_LABEL: Record<string, string> = {
  class_rep: "Class Representative", course_rep: "Course Representative",
  dept_exec: "Departmental Executive", contributor: "Community Contributor",
};
const REASONS = ["spam", "harassment", "hate", "sexual", "violence", "misinformation", "privacy", "other"];
const REPORTABLE = ["post", "comment", "message", "resource"]; // session posts are reported through /session-report

const roleOf = async (supabase: SupabaseClient, cid: number, uid: number | null) =>
  uid ? ((await supabase.from("community_members").select("role").eq("community_id", cid).eq("user_id", uid).maybeSingle()).data?.role ?? null) : null;
const mustOutrank = (a: Access, target: string | null) => {
  if (rank(a.role) <= rank(target)) throw new HttpError(403, "You can't moderate this member.");
};
const log = (supabase: SupabaseClient, cid: number, actor: number, action: string, t: { user?: number | null; kind?: string; id?: number } = {}, note?: string) =>
  supabase.from("community_mod_log").insert({
    community_id: cid, actor_id: actor, action, target_user_id: t.user ?? null, target_kind: t.kind ?? null, target_id: t.id ?? null, note: note?.slice(0, 200) ?? null,
  });

/** Keeps at most 3 pinned posts: pinning a 4th drops the oldest pin. */
async function pinPost(supabase: SupabaseClient, communityId: number, postId: number) {
  const { data: pinned } = await supabase.from("posts").select("id").eq("community_id", communityId)
    .not("community_pinned_at", "is", null).order("community_pinned_at", { ascending: true });
  const drop = (pinned ?? []).length - 2;
  if (drop > 0) {
    await supabase.from("posts").update({ community_pinned_at: null }).in("id", (pinned ?? []).slice(0, drop).map((p: any) => p.id));
  }
  await supabase.from("posts").update({ community_pinned_at: new Date().toISOString() }).eq("id", postId);
}

async function announceToMembers(supabase: SupabaseClient, a: Access, actorId: number, postId: number, title: string) {
  const { data: members } = await supabase.from("community_members").select("user_id")
    .eq("community_id", a.community.id).eq("announce_notify", true).neq("user_id", actorId).limit(2000);
  const ids = (members ?? []).map((m: any) => m.user_id as number);
  for (let i = 0; i < ids.length; i += 25) {
    await Promise.all(ids.slice(i, i + 25).map((uid) => notify(supabase, {
      recipient: uid, actor: actorId, kind: "community_announcement",
      groupKey: `community_announcement:${postId}:${uid}`, dedupe: `community_announcement:${postId}:${uid}`,
      community: a.community.id, payload: { community: a.community.name, slug: a.community.slug, post_id: postId, title },
    })));
  }
}

async function removePost(supabase: SupabaseClient, a: Access, actorId: number, postId: number, reason: string | null) {
  const { data: p } = await supabase.from("posts").select("id, user_id, community_id").eq("id", postId).maybeSingle();
  if (!p || p.community_id !== a.community.id) throw new HttpError(404, "Post not found.");
  if (p.user_id !== actorId) mustOutrank(a, await roleOf(supabase, a.community.id, p.user_id));
  await supabase.from("posts").update({ is_active: false, deleted_at: new Date().toISOString(), community_pinned_at: null }).eq("id", postId);
  await supabase.from("library_resources").update({ is_active: false, removed_by: actorId }).eq("post_id", postId);
  await log(supabase, a.community.id, actorId, "remove_post", { user: p.user_id, kind: "post", id: postId }, reason ?? undefined);
  if (p.user_id !== actorId) {
    await notify(supabase, {
      recipient: p.user_id, actor: actorId, kind: "community_moderation",
      groupKey: `community_moderation:post:${postId}`, dedupe: `community_moderation:post:${postId}`,
      community: a.community.id, payload: { community: a.community.name, slug: a.community.slug, action: "post_removed", reason },
    });
  }
}

async function removeComment(supabase: SupabaseClient, a: Access, actorId: number, commentId: number, reason: string | null) {
  const { data: cm } = await supabase.from("comments").select("id, user_id, post_id, parent_id").eq("id", commentId).maybeSingle();
  const { data: post } = cm ? await supabase.from("posts").select("community_id, comments_count").eq("id", cm.post_id).maybeSingle() : { data: null };
  if (!cm || !post || post.community_id !== a.community.id) throw new HttpError(404, "Comment not found.");
  if (cm.user_id !== actorId) mustOutrank(a, await roleOf(supabase, a.community.id, cm.user_id));
  if (!cm.parent_id) {
    await supabase.from("posts").update({ comments_count: Math.max(0, (post.comments_count ?? 1) - 1) }).eq("id", cm.post_id);
  }
  await supabase.from("comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId);
  await log(supabase, a.community.id, actorId, "remove_comment", { user: cm.user_id, kind: "comment", id: commentId }, reason ?? undefined);
  if (cm.user_id !== actorId) {
    await notify(supabase, {
      recipient: cm.user_id, actor: actorId, kind: "community_moderation",
      groupKey: `community_moderation:comment:${commentId}`, dedupe: `community_moderation:comment:${commentId}`,
      community: a.community.id, payload: { community: a.community.name, slug: a.community.slug, action: "comment_removed", reason },
    });
  }
}

async function removeMessage(supabase: SupabaseClient, a: Access, actorId: number, messageId: number, reason: string | null) {
  const { data: m } = await supabase.from("messages").select("id, sender_id, conversation_id, created_at").eq("id", messageId).maybeSingle();
  if (!m || m.conversation_id !== a.community.chat_conversation_id) throw new HttpError(404, "Message not found.");
  if (m.sender_id !== actorId) mustOutrank(a, await roleOf(supabase, a.community.id, m.sender_id));
  await supabase.from("messages").update({ body: null, media_key: null, shared_post_id: null, deleted_at: new Date().toISOString() }).eq("id", messageId);
  const { data: conv } = await supabase.from("conversations").select("last_message_at").eq("id", m.conversation_id).maybeSingle();
  if (conv && conv.last_message_at === m.created_at) {
    await supabase.from("conversations").update({ last_message_body: "This message was removed by a moderator" }).eq("id", m.conversation_id);
  }
  await broadcastToConversation(supabase, m.conversation_id, "message_deleted", { message_id: messageId });
  await log(supabase, a.community.id, actorId, "remove_message", { user: m.sender_id, kind: "message", id: messageId }, reason ?? undefined);
}

export function registerContent(app: Hono<any, any, any>) {
  // Publish into a community. Same body as posts/store, plus the community gate.
  app.post("/post/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    // id or slug: the composer publishes with ?community=<slug>
    const a = await loadAccess(supabase, c.req.param("id"), userId);
    if (!a) throw new HttpError(404, "Not found.");
    const body = await c.req.json().catch(() => ({}));
    if (body?.type === "story") throw new HttpError(422, "Stories can't be shared to a community.");
    const subtype = typeof body?.subtype === "string" ? body.subtype : null;

    if (subtype === "announcement") {
      if (!can(a, "announce")) throw new HttpError(403, "Only authorised members can publish announcements.");
    } else if (subtype === "article") {
      if (!isStaff(a)) throw new HttpError(403, "Only moderators can publish editorials.");
    } else if (!can(a, "post")) {
      throw new HttpError(403, a.role ? "You can't post in this community." : "Join this community to post.");
    }

    // A document in a community is always a library resource: check the right and the details before anything is created.
    let library: Awaited<ReturnType<typeof prepareResource>> | null = null;
    if (subtype === "document") {
      if (!can(a, "library")) throw new HttpError(403, "You can't add documents to this community's library.");
      const lb: any = body?.library && typeof body.library === "object" ? body.library : {};
      library = await prepareResource(supabase, a, { ...lb, title: lb.title ?? body?.content?.title ?? body?.caption });
    }

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await supabase.from("posts").select("id", { count: "exact", head: true })
      .eq("user_id", userId).eq("community_id", a.community.id).gte("created_at", since);
    if ((count ?? 0) >= 20) throw new HttpError(429, "You've posted a lot in the last hour. Try again later.");

    const { data: user, error } = await supabase.from("users").select("*").eq("id", userId).single();
    if (error) throw error;

    const input: Record<string, any> = { ...body, type: body?.type === "listing" ? "listing" : "post", visibility: "private", hashtags: [] };
    delete input.community;
    delete input.library;
    if (subtype === "announcement" && input.content && typeof input.content === "object") {
      input.content = { ...input.content, publisher_id: 1 }; // identity comes from the community, not a campus grant
    }
    const desig = a.designations.find((d) => d.can_announce) ?? a.designations[0];
    const identity = desig
      ? `${KIND_LABEL[desig.kind] ?? "Representative"}${desig.scope_label ? ` · ${desig.scope_label}` : ""}`
      : a.role === "member" ? a.community.name : `${a.role![0].toUpperCase()}${a.role!.slice(1)} · ${a.community.name}`;

    const post = await createPost(supabase, userId, user, input, {
      community: { id: a.community.id, publisher: { id: a.community.id, name: identity, type: "community", institution_id: null } },
    });
    if (post.duplicate) return json({ post_id: post.id, type: post.type, duplicate: true, message: "Already published." });

    if (library) {
      try {
        await saveResource(supabase, a, userId, post.id, userId, library, (body?.library as any)?.in_feed === false);
      } catch (err) {
        await supabase.from("posts").update({ is_active: false, deleted_at: new Date().toISOString() }).eq("id", post.id);
        throw err;
      }
    }

    if (subtype === "announcement") {
      if ((input.content as any)?.priority === "important") await pinPost(supabase, a.community.id, post.id);
      bg(announceToMembers(supabase, a, userId, post.id, String(post.caption ?? "")));
    }
    return json({ post_id: post.id, type: post.type, status: post.processing_status, message: "Published." }, 202);
  });

  app.post("/pin/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can pin posts.");
    const body = await c.req.json().catch(() => ({}));
    const postId = int(body?.post_id);
    if (!postId || typeof body?.pinned !== "boolean") return json({ message: "post_id and pinned are required." }, 422);
    const { data: p } = await supabase.from("posts").select("id, community_id, is_active").eq("id", postId).maybeSingle();
    if (!p || p.community_id !== a.community.id || !p.is_active) throw new HttpError(404, "Post not found.");
    if (body.pinned) await pinPost(supabase, a.community.id, postId);
    else await supabase.from("posts").update({ community_pinned_at: null }).eq("id", postId);
    await log(supabase, a.community.id, userId, body.pinned ? "pin_post" : "unpin_post", { kind: "post", id: postId });
    return json({ pinned: body.pinned });
  });

  app.post("/post-remove/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can remove posts.");
    const body = await c.req.json().catch(() => ({}));
    const postId = int(body?.post_id);
    if (!postId) return json({ message: "post_id is required." }, 422);
    await removePost(supabase, a, userId, postId, typeof body?.reason === "string" ? body.reason.slice(0, 200) : null);
    return json({ ok: true });
  });

  // ── reports ────────────────────────────────────────────────────────────

  app.post("/report/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a || !canRead(a)) throw new HttpError(404, "Not found.");
    const b = await c.req.json().catch(() => ({}));
    const targetId = int(b?.target_id);
    if (!REPORTABLE.includes(b?.kind) || !targetId || !REASONS.includes(b?.reason)) return json({ message: "kind, target_id and reason are required." }, 422);

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await supabase.from("content_reports").select("id", { count: "exact", head: true })
      .eq("reporter_id", userId).gte("created_at", since);
    if ((count ?? 0) >= 20) throw new HttpError(429, "You've sent a lot of reports. Please try again later.");

    let ok = false;
    if (b.kind === "post") {
      const { data } = await supabase.from("posts").select("community_id").eq("id", targetId).maybeSingle();
      ok = data?.community_id === a.community.id;
    } else if (b.kind === "comment") {
      const { data: cm } = await supabase.from("comments").select("post_id").eq("id", targetId).maybeSingle();
      const { data: p } = cm ? await supabase.from("posts").select("community_id").eq("id", cm.post_id).maybeSingle() : { data: null };
      ok = p?.community_id === a.community.id;
    } else if (b.kind === "resource") {
      const { data } = await supabase.from("library_resources").select("community_id").eq("id", targetId).eq("is_active", true).maybeSingle();
      ok = data?.community_id === a.community.id;
    } else {
      const { data } = await supabase.from("messages").select("conversation_id").eq("id", targetId).maybeSingle();
      ok = !!a.role && data?.conversation_id === a.community.chat_conversation_id;
    }
    if (!ok) throw new HttpError(404, "Nothing to report.");

    const { error } = await supabase.from("content_reports").insert({
      reporter_id: userId, community_id: a.community.id, target_kind: b.kind, target_id: targetId,
      reason: b.reason, details: typeof b.details === "string" ? b.details.slice(0, 500) || null : null,
    });
    if (error && (error as { code?: string }).code !== "23505") throw error;
    return json({ ok: true, already_reported: !!error }, error ? 200 : 201);
  });

  app.get("/reports/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can see reports.");
    const status = ["open", "actioned", "dismissed"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : "open";
    const { data, error } = await supabase.from("content_reports")
      .select("id, target_kind, target_id, reason, details, status, created_at")
      .eq("community_id", a.community.id).eq("status", status).order("created_at", { ascending: false }).limit(50);
    if (error) throw error;
    const rows = data ?? [];
    const ids = (k: string) => rows.filter((r: any) => r.target_kind === k).map((r: any) => r.target_id);
    const preview = new Map<string, { text: string | null; author_id: number | null }>();
    const [posts, comments, messages] = await Promise.all([
      ids("post").length ? supabase.from("posts").select("id, caption, user_id").in("id", ids("post")) : { data: [] },
      ids("comment").length ? supabase.from("comments").select("id, body, user_id").in("id", ids("comment")) : { data: [] },
      ids("message").length ? supabase.from("messages").select("id, body, sender_id").in("id", ids("message")) : { data: [] },
    ]);
    for (const p of posts.data ?? []) preview.set(`post:${p.id}`, { text: p.caption, author_id: p.user_id });
    for (const x of comments.data ?? []) preview.set(`comment:${x.id}`, { text: x.body, author_id: x.user_id });
    for (const m of messages.data ?? []) preview.set(`message:${m.id}`, { text: m.body, author_id: m.sender_id });
    return json({ data: rows.map((r: any) => ({ ...r, preview: preview.get(`${r.target_kind}:${r.target_id}`) ?? null })) });
  });

  app.post("/report-handle/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can handle reports.");
    const b = await c.req.json().catch(() => ({}));
    const reportId = int(b?.report_id);
    if (!reportId || !["dismiss", "remove"].includes(b?.action)) return json({ message: "report_id and action are required." }, 422);
    const { data: r } = await supabase.from("content_reports").select("id, target_kind, target_id, status")
      .eq("id", reportId).eq("community_id", a.community.id).maybeSingle();
    if (!r) throw new HttpError(404, "Report not found.");
    if (r.status !== "open") throw new HttpError(409, "This report was already handled.");

    if (b.action === "remove") {
      if (r.target_kind === "post") await removePost(supabase, a, userId, r.target_id, "Reported content");
      else if (r.target_kind === "comment") await removeComment(supabase, a, userId, r.target_id, "Reported content");
      else if (r.target_kind === "message") await removeMessage(supabase, a, userId, r.target_id, "Reported content");
      else if (r.target_kind === "resource") {
        await supabase.from("library_resources").update({ is_active: false, removed_by: userId }).eq("id", r.target_id).eq("community_id", a.community.id);
      }
    }
    const status = b.action === "remove" ? "actioned" : "dismissed";
    await supabase.from("content_reports").update({ status, handled_by: userId, handled_at: new Date().toISOString() })
      .eq("community_id", a.community.id).eq("target_kind", r.target_kind).eq("target_id", r.target_id).eq("status", "open");
    await log(supabase, a.community.id, userId, `report_${status}`, { kind: r.target_kind, id: r.target_id });
    return json({ status });
  });

  // Staff removal of a chat message or comment without a report.
  app.post("/remove/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can remove content.");
    const b = await c.req.json().catch(() => ({}));
    const targetId = int(b?.target_id);
    if (!targetId || !["comment", "message"].includes(b?.kind)) return json({ message: "kind and target_id are required." }, 422);
    const reason = typeof b.reason === "string" ? b.reason.slice(0, 200) : null;
    if (b.kind === "comment") await removeComment(supabase, a, userId, targetId, reason);
    else await removeMessage(supabase, a, userId, targetId, reason);
    return json({ ok: true });
  });
}
