/// <reference path="../_shared/deno-shim.d.ts" />
import type { Context, Hono } from "hono";
import { serviceClient, type SupabaseClient } from "../_shared/auth.ts";
import { r2ObjectExists, resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError } from "../_shared/services/communityAccess.ts";
import { createPost, deletePost, updatePost, ValidationError } from "../_shared/services/postService.ts";
import { hasCap, type StaffRole } from "../_shared/services/platformStaff.ts";
import { staffCtx } from "./core.ts";
import { posInt, readBody } from "./util.ts";

const STATUSES = ["draft", "scheduled", "publishing", "published", "archived"];
const VIS = ["public", "campus", "followers"];
const KEY_RE = /^\d{1,12}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i;
const ACCT_RE = /^[a-z0-9_]{2,30}$/;
const MISSED_MS = 6 * 3600_000;
const MAX_ATTEMPTS = 5;
const MAX_MEDIA = 10;

// ── access ────────────────────────────────────────────────────────────────────────────────────────────
interface Scope { all: boolean; ids: Map<number, boolean> } // account id -> can_publish assignment
type Ctx = { supabase: SupabaseClient; userId: number; role: StaffRole; scope: Scope };

async function ctx(c: Context): Promise<Ctx> {
  const s = await staffCtx(c);
  if (!(hasCap(s.role, "content.write") || hasCap(s.role, "content.publish") || hasCap(s.role, "analytics.view"))) {
    throw new HttpError(404, "Not found.");
  }
  let scope: Scope;
  if (hasCap(s.role, "accounts.manage")) scope = { all: true, ids: new Map() };
  else {
    const { data, error } = await s.supabase.from("platform_account_admins").select("account_user_id, can_publish")
      .eq("staff_user_id", s.userId).is("revoked_at", null);
    if (error) throw error;
    scope = { all: false, ids: new Map((data ?? []).map((r: any) => [r.account_user_id as number, r.can_publish === true])) };
  }
  return { ...s, scope };
}

const canView = (s: Scope, id: number) => s.all || s.ids.has(id);
const canPub = (s: Scope, id: number) => s.all || s.ids.get(id) === true;

function caps(x: Pick<Ctx, "role" | "scope">, row: any) {
  const view = canView(x.scope, row.account_user_id);
  const write = view && hasCap(x.role, "content.write");
  const pub = view && hasCap(x.role, "content.publish") && canPub(x.scope, row.account_user_id);
  const st = row.status as string;
  return {
    edit: st === "draft" ? write || pub : st === "scheduled" || st === "published" ? pub : false,
    publish: pub && (st === "draft" || st === "scheduled"),
    archive: st === "draft" ? write || pub : st === "scheduled" || st === "published" ? pub : false,
  };
}

async function loadItem(x: Ctx, c: Context) {
  const id = posInt(c.req.param("id"));
  if (!id) throw new HttpError(404, "Not found.");
  const { data, error } = await x.supabase.from("platform_content").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data || !canView(x.scope, data.account_user_id)) throw new HttpError(404, "Not found.");
  return data as any;
}

async function accountByKey(supabase: SupabaseClient, key: string) {
  if (!ACCT_RE.test(key)) throw new HttpError(404, "Not found.");
  const { data, error } = await supabase.from("platform_accounts").select("user_id, account_key, status").eq("account_key", key).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Not found.");
  return data as { user_id: number; account_key: string; status: string };
}

async function auditAs(supabase: SupabaseClient, actor: number | null, action: string, target: { kind?: string; id?: number }, detail: Record<string, unknown>) {
  const { error } = await supabase.from("platform_audit_log").insert({
    actor_id: actor, action, target_kind: target.kind ?? null, target_id: target.id ?? null, detail,
  });
  if (error) throw error;
}

// ── payload (createPost input shape, narrowed to what the studio supports) ──────────────────────────
const num = (v: unknown, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
};
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

function cleanMedia(raw: any, errors: Record<string, string>): Record<string, unknown>[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_MEDIA) { errors.media = `Up to ${MAX_MEDIA} files.`; return []; }
  const out: Record<string, unknown>[] = [];
  for (const m of raw) {
    if (!m || (m.type !== "image" && m.type !== "video") || typeof m.storage_key !== "string" || !KEY_RE.test(m.storage_key)) {
      errors.media = "Invalid media."; return [];
    }
    if (m.thumbnail_key !== undefined && m.thumbnail_key !== null && (typeof m.thumbnail_key !== "string" || !KEY_RE.test(m.thumbnail_key))) {
      errors.media = "Invalid thumbnail."; return [];
    }
    const mime = str(m.mime_type, 100);
    const o: Record<string, unknown> = {
      type: m.type, storage_key: m.storage_key,
      thumbnail_key: m.thumbnail_key ?? undefined,
      width: num(m.width, 20000), height: num(m.height, 20000),
      duration_seconds: num(m.duration_seconds, 36000), size_bytes: num(m.size_bytes, 2e9),
      mime_type: mime && /^(image|video)\//.test(mime) ? mime : undefined,
      blurhash: str(m.blurhash, 100), dominant_color: str(m.dominant_color, 20), aspect_ratio: num(m.aspect_ratio, 100),
    };
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    out.push(o);
  }
  return out;
}

const keysOf = (p: any): string[] =>
  ((p?.media ?? []) as any[]).flatMap((m) => [m.storage_key, m.thumbnail_key].filter(Boolean) as string[]);

// `known` = keys already stored on this item (verified when first added). Anything new must be the actor's own upload.
async function cleanPayload(raw: any, actor: number, known: Set<string>): Promise<Record<string, unknown>> {
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = { type: "post" };

  const caption = String(raw?.caption ?? "").trim();
  if (caption.length > 2200) errors.caption = "Caption must be 2200 characters or fewer.";
  else if (caption) out.caption = caption;

  const vis = String(raw?.visibility ?? "public");
  if (!VIS.includes(vis)) errors.visibility = "Visibility must be public, followers or campus.";
  out.visibility = vis;

  out.allow_comments = raw?.allow_comments !== false;

  const media = cleanMedia(raw?.media, errors);
  if (media.length) out.media = media;
  if (Object.keys(errors).length) throw new HttpError(422, "Validation failed.", errors);

  const fresh = keysOf(out).filter((k) => !known.has(k));
  if (fresh.some((k) => !k.startsWith(`${actor}/`))) throw new HttpError(422, "Validation failed.", { media: "File does not belong to you." });
  const found = await Promise.all(fresh.map((k) => r2ObjectExists(k)));
  if (found.some((ok) => !ok)) throw new HttpError(422, "Validation failed.", { media: "File not found in storage." });
  return out;
}

const publishable = (p: any) => !!String(p?.caption ?? "").trim() || ((p?.media ?? []) as unknown[]).length > 0;

// ── presentation ─────────────────────────────────────────────────────────────────────────────────────
async function acctInfo(supabase: SupabaseClient, ids: number[]) {
  const out = new Map<number, any>();
  if (!ids.length) return out;
  const [a, u] = await Promise.all([
    supabase.from("platform_accounts").select("user_id, account_key, status").in("user_id", ids),
    supabase.from("users").select("id, name, username, avatar_key, avatar").in("id", ids),
  ]);
  if (a.error) throw a.error;
  if (u.error) throw u.error;
  const ub = new Map((u.data ?? []).map((r: any) => [r.id, r]));
  for (const r of a.data ?? []) {
    const usr: any = ub.get(r.user_id);
    out.set(r.user_id, {
      key: r.account_key, status: r.status, name: usr?.name ?? null, username: usr?.username ?? null,
      avatar: resolveAvatarUrl(usr?.avatar_key ?? usr?.avatar),
    });
  }
  return out;
}

async function loadStats(supabase: SupabaseClient, rows: any[]) {
  const out = new Map<number, any>();
  const ids = rows.filter((r) => r.post_id).map((r) => r.post_id as number);
  if (!ids.length) return out;
  const [p, f] = await Promise.all([
    supabase.from("posts").select("id, views_count, likes_count, comments_count, shares_count, reposts_count, bookmarks_count").in("id", ids),
    supabase.from("feed_post_stats").select("post_id, impressions, delivered, completions, skips, negatives, follows_from").in("post_id", ids),
  ]);
  if (p.error) throw p.error;
  if (f.error) throw f.error;
  const fb = new Map((f.data ?? []).map((r: any) => [r.post_id, r]));
  for (const r of p.data ?? []) {
    const s: any = fb.get(r.id) ?? {};
    out.set(r.id, {
      views: Number(r.views_count ?? 0), likes: Number(r.likes_count ?? 0), comments: Number(r.comments_count ?? 0),
      shares: Number(r.shares_count ?? 0), reposts: Number(r.reposts_count ?? 0), saves: Number(r.bookmarks_count ?? 0),
      impressions: s.impressions ?? 0, delivered: s.delivered ?? 0, completions: s.completions ?? 0,
      skips: s.skips ?? 0, negatives: s.negatives ?? 0, follows_from: s.follows_from ?? 0,
    });
  }
  return out;
}

const mediaOut = (m: any) => ({
  ...m,
  url: resolveAvatarUrl(m.storage_key),
  thumbnail_url: m.thumbnail_key ? resolveAvatarUrl(m.thumbnail_key) : null,
});

async function present(x: Ctx, rows: any[]) {
  const accts = await acctInfo(x.supabase, [...new Set(rows.map((r) => r.account_user_id as number))]);
  const stats = await loadStats(x.supabase, rows.filter((r) => r.status === "published"));
  return rows.map((r) => {
    const p = r.payload ?? {};
    return {
      id: r.id, status: r.status, account: accts.get(r.account_user_id) ?? null,
      caption: p.caption ?? "", visibility: p.visibility ?? "public", allow_comments: p.allow_comments !== false,
      media: ((p.media ?? []) as any[]).map(mediaOut),
      scheduled_at: r.scheduled_at, published_at: r.published_at, post_id: r.post_id,
      last_error: r.last_error, created_at: r.created_at, updated_at: r.updated_at,
      stats: stats.get(r.post_id) ?? null,
      can: caps(x, r),
    };
  });
}

// ── publisher ────────────────────────────────────────────────────────────────────────────────────────
type PublishResult = { ok: true; post_id: number } | { ok: false; error: string; status: number };

// `row` is already claimed (status 'publishing'). Whatever happens, the row leaves 'publishing'.
async function runPublish(supabase: SupabaseClient, row: any, actor: number | null, via: "manual" | "cron"): Promise<PublishResult> {
  const prev = row.scheduled_at ? "scheduled" : "draft";
  const release = async (error: string, count: boolean, toDraft = false) => {
    const attempts = (row.attempts ?? 0) + (count ? 1 : 0);
    const draft = toDraft || (prev === "scheduled" && attempts >= MAX_ATTEMPTS);
    await supabase.from("platform_content").update({
      status: draft ? "draft" : prev, scheduled_at: draft ? null : row.scheduled_at,
      attempts, last_error: error.slice(0, 300), claimed_at: null, updated_at: new Date().toISOString(),
    }).eq("id", row.id).eq("status", "publishing");
  };
  try {
    if (via === "cron" && row.scheduled_at && Date.now() - new Date(row.scheduled_at).getTime() > MISSED_MS) {
      await release("The scheduled time passed before it could publish. Review it and reschedule.", false, true);
      return { ok: false, error: "missed_window", status: 409 };
    }
    const { data: acct, error: ae } = await supabase.from("platform_accounts").select("status").eq("user_id", row.account_user_id).maybeSingle();
    if (ae) throw ae;
    if (acct?.status !== "active") {
      await release("The account isn't live yet.", false);
      return { ok: false, error: "Activate the account before publishing.", status: 409 };
    }
    if (!publishable(row.payload)) {
      await release("Add a caption or media first.", false, true);
      return { ok: false, error: "Add a caption or media first.", status: 422 };
    }

    const { data: user, error: ue } = await supabase.from("users").select("*").eq("id", row.account_user_id).single();
    if (ue) throw ue;
    // One feed engine: the real createPost, as the official account. Media was verified when it was saved.
    const post: any = await createPost(supabase, row.account_user_id, user, { ...row.payload, client_request_id: row.request_id }, { trustedSource: true });

    const now = new Date().toISOString();
    const { error: pe } = await supabase.from("platform_content").update({
      status: "published", post_id: post.id, published_at: now, published_by: actor,
      claimed_at: null, last_error: null, updated_at: now,
    }).eq("id", row.id);
    if (pe) throw pe;
    await auditAs(supabase, actor, "content.publish", { kind: "post", id: post.id }, { content_id: row.id, via })
      .catch((e) => console.error("audit failed after publish", e));
    return { ok: true, post_id: post.id };
  } catch (e) {
    const msg = e instanceof ValidationError ? Object.values(e.errors).join("; ") : String((e as any)?.message ?? e);
    console.error("platform publish failed", row.id, msg);
    await release(msg, true).catch(() => {});
    return { ok: false, error: msg, status: e instanceof ValidationError ? 422 : 500 };
  }
}

const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────
export function registerContent(app: Hono<any, any, any>) {
  // Scheduler entry point (pg_cron -> here). Fails closed: no secret configured, or a wrong one, is a plain 404.
  app.post("/content/publish-due", async (c) => {
    const secret = Deno.env.get("PLATFORM_CRON_SECRET");
    const sent = c.req.header("x-cron-secret");
    if (!secret || !sent || !same(sent, secret)) return json({ message: "Not found." }, 404);
    const supabase = serviceClient();
    const { data, error } = await supabase.rpc("platform_content_claim_due", { p_limit: 10 });
    if (error) throw error;
    let published = 0;
    for (const row of (data ?? []) as any[]) {
      const r = await runPublish(supabase, row, null, "cron");
      if (r.ok) published++;
    }
    return json({ ok: true, claimed: (data ?? []).length, published });
  });

  app.get("/content", async (c) => {
    const x = await ctx(c);
    const status = c.req.query("status");
    const key = c.req.query("account");
    const cursor = posInt(c.req.query("cursor"));

    let ids: number[] | null = x.scope.all ? null : [...x.scope.ids.keys()];
    if (key) {
      const a = await accountByKey(x.supabase, key);
      if (ids && !ids.includes(a.user_id)) return json({ data: [], next_cursor: null });
      ids = [a.user_id];
    }
    if (ids && !ids.length) return json({ data: [], next_cursor: null });

    let q = x.supabase.from("platform_content").select("*").order("id", { ascending: false }).limit(31);
    if (ids) q = q.in("account_user_id", ids);
    if (status && STATUSES.includes(status)) q = q.eq("status", status); else q = q.neq("status", "archived");
    if (cursor) q = q.lt("id", cursor);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as any[];
    const page = rows.slice(0, 30);
    return json({ data: await present(x, page), next_cursor: rows.length > 30 ? String(page[page.length - 1].id) : null });
  });

  app.get("/content/:id", async (c) => {
    const x = await ctx(c);
    const row = await loadItem(x, c);
    return json((await present(x, [row]))[0]);
  });

  app.post("/content", async (c) => {
    const x = await ctx(c);
    if (!hasCap(x.role, "content.write")) throw new HttpError(404, "Not found.");
    const body = await readBody(c);
    const acct = await accountByKey(x.supabase, String(body.account ?? ""));
    if (!canView(x.scope, acct.user_id)) throw new HttpError(404, "Not found.");
    if (acct.status === "suspended") throw new HttpError(409, "This account is suspended.");

    const payload = await cleanPayload(body.payload ?? {}, x.userId, new Set());
    const { data, error } = await x.supabase.from("platform_content")
      .insert({ account_user_id: acct.user_id, payload, created_by: x.userId, updated_by: x.userId }).select("*").single();
    if (error) throw error;
    await auditAs(x.supabase, x.userId, "content.create", { kind: "content", id: data.id }, { key: acct.account_key });
    return json((await present(x, [data]))[0], 201);
  });

  app.patch("/content/:id", async (c) => {
    const x = await ctx(c);
    const row = await loadItem(x, c);
    if (row.status === "publishing" || row.status === "archived") throw new HttpError(409, `Can't edit an item that is ${row.status}.`);
    if (!caps(x, row).edit) throw new HttpError(404, "Not found.");
    const incoming = (await readBody(c)).payload ?? {};

    let cleaned: Record<string, unknown>;
    if (row.status === "published") {
      // Live posts: text, audience and comments only. Media is fixed once published.
      const merged = { ...(row.payload ?? {}) } as Record<string, unknown>;
      for (const k of ["caption", "visibility", "allow_comments"]) if (incoming[k] !== undefined) merged[k] = incoming[k];
      cleaned = await cleanPayload(merged, x.userId, new Set(keysOf(row.payload)));
      const r = await updatePost(x.supabase, row.post_id, row.account_user_id, {
        caption: (cleaned.caption as string | undefined) ?? "", visibility: cleaned.visibility, allow_comments: cleaned.allow_comments,
      });
      if (!("ok" in r)) throw new HttpError(409, "The published post could not be found.");
    } else {
      cleaned = await cleanPayload({ ...(row.payload ?? {}), ...incoming }, x.userId, new Set(keysOf(row.payload)));
    }

    const { data, error } = await x.supabase.from("platform_content")
      .update({ payload: cleaned, updated_by: x.userId, updated_at: new Date().toISOString(), last_error: null })
      .eq("id", row.id).eq("status", row.status).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, "This item changed. Reload and try again.");
    await auditAs(x.supabase, x.userId, "content.edit", { kind: "content", id: row.id },
      { status: row.status, fields: Object.keys(incoming) });
    return json((await present(x, [data]))[0]);
  });

  app.post("/content/:id/schedule", async (c) => {
    const x = await ctx(c);
    const row = await loadItem(x, c);
    if (!caps(x, row).publish) throw new HttpError(row.status === "draft" || row.status === "scheduled" ? 404 : 409, row.status === "draft" || row.status === "scheduled" ? "Not found." : `Can't schedule an item that is ${row.status}.`);
    const at = new Date(String((await readBody(c)).at ?? ""));
    if (Number.isNaN(at.getTime())) throw new HttpError(422, "Validation failed.", { at: "Pick a valid date and time." });
    if (at.getTime() < Date.now() + 60_000) throw new HttpError(422, "Validation failed.", { at: "Pick a time at least a minute from now." });
    if (at.getTime() > Date.now() + 90 * 86_400_000) throw new HttpError(422, "Validation failed.", { at: "Schedule within the next 90 days." });
    if (!publishable(row.payload)) throw new HttpError(422, "Validation failed.", { caption: "Add a caption or media first." });

    const { data, error } = await x.supabase.from("platform_content")
      .update({ status: "scheduled", scheduled_at: at.toISOString(), attempts: 0, last_error: null, updated_by: x.userId, updated_at: new Date().toISOString() })
      .eq("id", row.id).in("status", ["draft", "scheduled"]).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, "This item changed. Reload and try again.");
    await auditAs(x.supabase, x.userId, "content.schedule", { kind: "content", id: row.id }, { at: at.toISOString() });
    return json((await present(x, [data]))[0]);
  });

  app.post("/content/:id/unschedule", async (c) => {
    const x = await ctx(c);
    const row = await loadItem(x, c);
    if (!caps(x, row).publish) throw new HttpError(404, "Not found.");
    if (row.status !== "scheduled") throw new HttpError(409, "This item isn't scheduled.");
    const { data, error } = await x.supabase.from("platform_content")
      .update({ status: "draft", scheduled_at: null, updated_by: x.userId, updated_at: new Date().toISOString() })
      .eq("id", row.id).eq("status", "scheduled").select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, "This item changed. Reload and try again.");
    await auditAs(x.supabase, x.userId, "content.unschedule", { kind: "content", id: row.id }, {});
    return json((await present(x, [data]))[0]);
  });

  app.post("/content/:id/publish", async (c) => {
    const x = await ctx(c);
    const row = await loadItem(x, c);
    if (!caps(x, row).publish) throw new HttpError(404, "Not found.");
    if (!publishable(row.payload)) throw new HttpError(422, "Validation failed.", { caption: "Add a caption or media first." });

    const { data: claimed, error } = await x.supabase.from("platform_content")
      .update({ status: "publishing", claimed_at: new Date().toISOString(), updated_by: x.userId })
      .eq("id", row.id).in("status", ["draft", "scheduled"]).select("*").maybeSingle();
    if (error) throw error;
    if (!claimed) throw new HttpError(409, "This item is already publishing or was changed.");

    const r = await runPublish(x.supabase, claimed, x.userId, "manual");
    if (!r.ok) throw new HttpError(r.status, r.error);
    const { data: fresh, error: fe } = await x.supabase.from("platform_content").select("*").eq("id", row.id).single();
    if (fe) throw fe;
    return json((await present(x, [fresh]))[0]);
  });

  app.post("/content/:id/archive", async (c) => {
    const x = await ctx(c);
    const row = await loadItem(x, c);
    if (row.status === "archived") return json((await present(x, [row]))[0]);
    if (row.status === "publishing") throw new HttpError(409, "This item is publishing right now.");
    if (!caps(x, row).archive) throw new HttpError(404, "Not found.");

    // A live post is taken down through the normal soft delete, as the account that owns it.
    if (row.status === "published" && row.post_id) await deletePost(x.supabase, row.post_id, row.account_user_id);

    const { data, error } = await x.supabase.from("platform_content")
      .update({ status: "archived", scheduled_at: null, updated_by: x.userId, updated_at: new Date().toISOString() })
      .eq("id", row.id).eq("status", row.status).select("*").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(409, "This item changed. Reload and try again.");
    await auditAs(x.supabase, x.userId, "content.archive", { kind: row.post_id ? "post" : "content", id: row.post_id ?? row.id },
      { content_id: row.id, was: row.status });
    return json((await present(x, [data]))[0]);
  });
}
