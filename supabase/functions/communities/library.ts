/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, type SupabaseClient } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError, can, isStaff, loadAccess, type Access } from "../_shared/services/communityAccess.ts";

// Library = metadata over a canonical document POST (posts.subtype='document'). The file is uploaded once and the same post
// is what Feed, Chat shares and the PDF viewer use, so nothing is duplicated and access follows the community.
// Flow: client publishes via POST /communities/post/:id (subtype document), then POST /communities/library-add/:id.
const DOC_TYPES = ["past_question", "lecture_note", "slides", "textbook", "assignment", "syllabus", "project", "other"];
const PAGE = 20;
// deno-lint-ignore no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const int = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const txt = (v: unknown, max: number) =>
  typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(CTRL, "").trim().replace(/\n{3,}/g, "\n\n").slice(0, max) : "";
const opt = (v: unknown, max: number) => txt(v, max).replace(/\s+/g, " ") || null;
const log = (supabase: SupabaseClient, cid: number, actor: number, action: string, id: number, note?: string) =>
  supabase.from("community_mod_log").insert({ community_id: cid, actor_id: actor, action, target_kind: "resource", target_id: id, note: note?.slice(0, 200) ?? null });

async function member(c: any) {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const a = await loadAccess(supabase, c.req.param("id"), userId);
  if (!a) throw new HttpError(404, "Not found.");
  if (a.banned) throw new HttpError(403, "You can't access this community.");
  if (!a.role) throw new HttpError(403, "Join this community to open its library.");
  return { supabase, userId, a };
}

async function hydrate(supabase: SupabaseClient, rows: any[]) {
  if (!rows.length) return [];
  const [u, p] = await Promise.all([
    supabase.from("users").select("id, name, username, avatar_key, avatar").in("id", [...new Set(rows.map((r) => r.uploader_id))]),
    supabase.from("posts").select("id, content, community_feed, is_active, media:post_media(media_type, storage_key, thumbnail_key, size_bytes, mime_type)").in("id", rows.map((r) => r.post_id)),
  ]);
  const users = new Map((u.data ?? []).map((x: any) => [x.id, x]));
  const posts = new Map((p.data ?? []).map((x: any) => [x.id, x]));
  return rows.filter((r) => posts.get(r.post_id)?.is_active).map((r) => {
    const post: any = posts.get(r.post_id);
    const doc = (post.media ?? []).find((m: any) => m.media_type === "document");
    const user: any = users.get(r.uploader_id);
    return {
      id: r.id, post_id: r.post_id, title: r.title, description: r.description, doc_type: r.doc_type,
      course_code: r.course_code, academic_session: r.academic_session, subject: r.subject,
      collection_id: r.collection_id, created_at: r.created_at, in_feed: post.community_feed !== false,
      uploader: user ? { id: user.id, name: user.name, username: user.username, avatar: resolveAvatarUrl(user.avatar_key ?? user.avatar) } : null,
      file: doc ? {
        url: resolveAvatarUrl(doc.storage_key), thumbnail: doc.thumbnail_key ? resolveAvatarUrl(doc.thumbnail_key) : null,
        size: doc.size_bytes, mime: doc.mime_type, name: post.content?.file?.name ?? null,
      } : null,
    };
  });
}

function fields(b: any, a: Access, partial: boolean) {
  const f: Record<string, unknown> = {};
  const e: Record<string, string> = {};
  if (!partial || b.title !== undefined) {
    const t = txt(b.title, 120).replace(/\s+/g, " ");
    if (!t) e.title = "Add a title."; else f.title = t;
  }
  if (b.description !== undefined) f.description = txt(b.description, 500) || null;
  if (b.doc_type !== undefined) {
    if (DOC_TYPES.includes(b.doc_type)) f.doc_type = b.doc_type; else e.doc_type = "Invalid document type.";
  }
  if (b.course_code !== undefined) f.course_code = opt(b.course_code, 20)?.toUpperCase() ?? null;
  if (b.academic_session !== undefined) f.academic_session = opt(b.academic_session, 20);
  if (b.subject !== undefined) f.subject = opt(b.subject, 60);
  void a;
  return { f, e };
}

async function checkCollection(supabase: SupabaseClient, a: Access, id: unknown) {
  if (id === undefined) return undefined;
  if (id === null || id === "") return null;
  const cid = int(id);
  if (!cid) throw new HttpError(422, "Invalid collection.");
  const { data } = await supabase.from("community_collections").select("id").eq("id", cid).eq("community_id", a.community.id).maybeSingle();
  if (!data) throw new HttpError(422, "Collection not found.");
  return cid;
}

// Shared by library-add and by POST /communities/post (a document post is always a library resource).
export async function prepareResource(supabase: SupabaseClient, a: Access, b: any) {
  const { f, e } = fields(b, a, false);
  const col = await checkCollection(supabase, a, b?.collection_id);
  if (Object.keys(e).length) throw new HttpError(422, "Validation failed.", e);
  return { f, col };
}

export async function saveResource(
  supabase: SupabaseClient, a: Access, actor: number, postId: number, uploaderId: number,
  p: { f: Record<string, unknown>; col: number | null | undefined }, libraryOnly: boolean,
) {
  const extra = p.col !== undefined ? { collection_id: p.col } : {};
  let created = true;
  const ins = await supabase.from("library_resources")
    .insert({ community_id: a.community.id, post_id: postId, uploader_id: uploaderId, doc_type: "other", ...p.f, ...extra })
    .select("*").single();
  let data: any = ins.data;
  if (ins.error) {
    if ((ins.error as { code?: string }).code !== "23505") throw ins.error;
    // Already in the library (an older client adding after the post, or a retry): update instead of failing.
    const upd = await supabase.from("library_resources")
      .update({ ...p.f, ...extra, is_active: true })
      .eq("post_id", postId).eq("community_id", a.community.id).select("*").single();
    if (upd.error) throw upd.error;
    data = upd.data;
    created = false;
  }
  if (libraryOnly) await supabase.from("posts").update({ community_feed: false }).eq("id", postId);
  if (created) await log(supabase, a.community.id, actor, "add_resource", data.id);
  return { data, created };
}

export function registerLibrary(app: Hono<any, any, any>) {
  app.get("/library/:id", async (c) => {
    const { supabase, a } = await member(c);
    const cursor = int(c.req.query("cursor")) ?? Number.MAX_SAFE_INTEGER;
    let q = supabase.from("library_resources").select("*").eq("community_id", a.community.id).eq("is_active", true).lt("id", cursor);
    const term = (c.req.query("q") ?? "").replace(/[^\p{L}\p{N} \-]/gu, "").trim().slice(0, 60);
    if (term) q = q.or(`title.ilike.%${term}%,course_code.ilike.%${term}%,subject.ilike.%${term}%,description.ilike.%${term}%`);
    const dt = c.req.query("doc_type");
    if (dt && DOC_TYPES.includes(dt)) q = q.eq("doc_type", dt);
    const cc = (c.req.query("course_code") ?? "").replace(/[^\p{L}\p{N} \-]/gu, "").trim().slice(0, 20);
    if (cc) q = q.ilike("course_code", cc);
    const ses = (c.req.query("session") ?? "").replace(/[^\p{L}\p{N} \/\-]/gu, "").trim().slice(0, 20);
    if (ses) q = q.eq("academic_session", ses);
    const col = int(c.req.query("collection_id"));
    if (col) q = q.eq("collection_id", col);
    const { data, error } = await q.order("id", { ascending: false }).limit(PAGE + 1);
    if (error) throw error;
    const rows = data ?? [];
    const page = rows.slice(0, PAGE);
    const out: Record<string, unknown> = {
      data: await hydrate(supabase, page),
      next_cursor: rows.length > PAGE ? String(page[page.length - 1].id) : null,
      has_more: rows.length > PAGE,
    };
    if (!c.req.query("cursor")) {
      const [cols, meta] = await Promise.all([
        supabase.from("community_collections").select("id, name, description").eq("community_id", a.community.id).order("sort_order").order("id"),
        supabase.from("library_resources").select("collection_id, course_code, academic_session").eq("community_id", a.community.id).eq("is_active", true).limit(2000),
      ]);
      const counts = new Map<number, number>();
      const codes = new Set<string>();
      const sessions = new Set<string>();
      for (const r of meta.data ?? []) {
        if (r.collection_id) counts.set(r.collection_id, (counts.get(r.collection_id) ?? 0) + 1);
        if (r.course_code) codes.add(r.course_code);
        if (r.academic_session) sessions.add(r.academic_session);
      }
      out.collections = (cols.data ?? []).map((x: any) => ({ ...x, count: counts.get(x.id) ?? 0 }));
      out.facets = { course_codes: [...codes].sort().slice(0, 40), sessions: [...sessions].sort().reverse().slice(0, 20), doc_types: DOC_TYPES };
    }
    return json(out);
  });

  app.get("/library-show/:id/:rid", async (c) => {
    const { supabase, a } = await member(c);
    const { data } = await supabase.from("library_resources").select("*")
      .eq("id", int(c.req.param("rid")) ?? 0).eq("community_id", a.community.id).eq("is_active", true).maybeSingle();
    const [res] = data ? await hydrate(supabase, [data]) : [];
    if (!res) throw new HttpError(404, "Resource not found.");
    return json({ resource: res });
  });

  app.post("/library-add/:id", async (c) => {
    const { supabase, userId, a } = await member(c);
    if (!can(a, "library")) throw new HttpError(403, "You can't add to this library.");
    const b = await c.req.json().catch(() => ({}));
    const postId = int(b?.post_id);
    if (!postId) return json({ message: "post_id is required." }, 422);
    const { data: post } = await supabase.from("posts").select("id, user_id, community_id, subtype, caption, is_active").eq("id", postId).maybeSingle();
    if (!post || post.community_id !== a.community.id || !post.is_active || post.subtype !== "document") throw new HttpError(404, "Document not found.");
    if (post.user_id !== userId && !isStaff(a)) throw new HttpError(403, "You can only add your own documents.");
    const prepared = await prepareResource(supabase, a, { ...b, title: b?.title ?? post.caption });
    const { data, created } = await saveResource(supabase, a, userId, postId, post.user_id, prepared, b?.in_feed === false);
    return json({ resource: (await hydrate(supabase, [data]))[0] }, created ? 201 : 200);
  });

  app.post("/library-update/:id", async (c) => {
    const { supabase, userId, a } = await member(c);
    const b = await c.req.json().catch(() => ({}));
    const rid = int(b?.resource_id);
    if (!rid) return json({ message: "resource_id is required." }, 422);
    const { data: r } = await supabase.from("library_resources").select("*").eq("id", rid).eq("community_id", a.community.id).eq("is_active", true).maybeSingle();
    if (!r) throw new HttpError(404, "Resource not found.");
    if (r.uploader_id !== userId && !isStaff(a)) throw new HttpError(403, "You can't edit this resource.");
    const { f, e } = fields(b, a, true);
    const col = await checkCollection(supabase, a, b?.collection_id);
    if (Object.keys(e).length) throw new HttpError(422, "Validation failed.", e);
    if (col !== undefined) f.collection_id = col;
    if (Object.keys(f).length) {
      const { error } = await supabase.from("library_resources").update(f).eq("id", rid);
      if (error) throw error;
    }
    const { data } = await supabase.from("library_resources").select("*").eq("id", rid).single();
    return json({ resource: (await hydrate(supabase, [data]))[0] });
  });

  app.post("/library-remove/:id", async (c) => {
    const { supabase, userId, a } = await member(c);
    const b = await c.req.json().catch(() => ({}));
    const rid = int(b?.resource_id);
    if (!rid) return json({ message: "resource_id is required." }, 422);
    const { data: r } = await supabase.from("library_resources").select("id, post_id, uploader_id").eq("id", rid).eq("community_id", a.community.id).eq("is_active", true).maybeSingle();
    if (!r) throw new HttpError(404, "Resource not found.");
    if (r.uploader_id !== userId && !isStaff(a)) throw new HttpError(403, "You can't remove this resource.");
    await supabase.from("library_resources").update({ is_active: false, removed_by: userId }).eq("id", rid);
    // A library-only document has nowhere else to live, so it goes with the entry.
    const { data: p } = await supabase.from("posts").select("community_feed").eq("id", r.post_id).maybeSingle();
    if (p && p.community_feed === false) {
      await supabase.from("posts").update({ is_active: false, deleted_at: new Date().toISOString() }).eq("id", r.post_id);
    }
    await log(supabase, a.community.id, userId, "remove_resource", rid);
    return json({ ok: true });
  });

  app.post("/collection-save/:id", async (c) => {
    const { supabase, userId, a } = await member(c);
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can manage collections.");
    const b = await c.req.json().catch(() => ({}));
    const name = txt(b?.name, 60).replace(/\s+/g, " ");
    if (!name) return json({ message: "Give the collection a name." }, 422);
    const description = txt(b?.description, 200) || null;
    const id = int(b?.collection_id);
    if (id) {
      const { data, error } = await supabase.from("community_collections").update({ name, description })
        .eq("id", id).eq("community_id", a.community.id).select("id, name, description").maybeSingle();
      if (error) throw error;
      if (!data) throw new HttpError(404, "Collection not found.");
      return json({ collection: data });
    }
    const { count } = await supabase.from("community_collections").select("id", { count: "exact", head: true }).eq("community_id", a.community.id);
    if ((count ?? 0) >= 30) throw new HttpError(422, "That's the most collections a community can have.");
    const { data, error } = await supabase.from("community_collections")
      .insert({ community_id: a.community.id, name, description, created_by: userId, sort_order: count ?? 0 })
      .select("id, name, description").single();
    if (error) throw error;
    return json({ collection: data }, 201);
  });

  app.post("/collection-remove/:id", async (c) => {
    const { supabase, a } = await member(c);
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can manage collections.");
    const b = await c.req.json().catch(() => ({}));
    const id = int(b?.collection_id);
    if (!id) return json({ message: "collection_id is required." }, 422);
    await supabase.from("community_collections").delete().eq("id", id).eq("community_id", a.community.id); // resources fall back to uncategorised
    return json({ ok: true });
  });
}
