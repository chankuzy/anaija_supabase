/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, verifyTokenOptional } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import {
  HttpError, clampInt, clean, configView, hasVoted, int, later, loadMoment, modLog, notify, ping, scan, standing, userCard,
  type SupabaseClient,
} from "./core.ts";

const E = "id, parent_id, kind, author_id, is_anonymous, alias_no, body, answer, answered_at, status, upvotes_count, reactions_count, replies_count, reveal_at, created_at";
const PAGE = 30;
const REACTIONS = ["like", "fire", "laugh", "wow", "sad"];
const REASONS = ["spam", "harassment", "hate", "sexual", "violence", "misinformation", "privacy", "other"];
const LIMIT: Record<string, number> = { question: 300, response: 800, confession: 1200, comment: 500 };
const SHOWN = ["visible", "approved", "answered", "skipped"];

export async function formatEntries(supabase: SupabaseClient, rows: any[], viewer: number | null) {
  if (!rows.length) return [];
  const mine = new Map<number, string>();
  if (viewer) {
    const { data } = await supabase.from("moment_reactions").select("entry_id, kind").eq("user_id", viewer).in("entry_id", rows.map((r) => r.id));
    for (const r of data ?? []) mine.set(r.entry_id, r.kind);
  }
  const named = [...new Set(rows.filter((r) => !r.is_anonymous).map((r) => r.author_id as number))];
  const people = new Map<number, any>();
  if (named.length) {
    const { data } = await supabase.from("users").select("id, name, username, avatar_key, avatar").in("id", named);
    for (const u of data ?? []) people.set(u.id, userCard(u));
  }
  // author_id is used here only for is_mine and the named-author lookup; it is not in the output.
  return rows.map((r) => ({
    id: r.id, parent_id: r.parent_id, kind: r.kind, body: r.body, answer: r.answer, answered_at: r.answered_at, status: r.status,
    author: r.is_anonymous ? { anonymous: true, alias: `Anon ${r.alias_no}` } : { anonymous: false, ...(people.get(r.author_id) ?? { name: null, username: null, avatar: null }) },
    upvotes_count: r.upvotes_count, reactions_count: r.reactions_count, replies_count: r.replies_count,
    reveal_at: r.reveal_at, created_at: r.created_at,
    is_mine: viewer !== null && r.author_id === viewer, my_reaction: mine.get(r.id) ?? null,
  }));
}

const revealed = (e: any) => e.status === "approved" && !!e.reveal_at && Date.parse(e.reveal_at) <= Date.now();

async function removeEntry(supabase: SupabaseClient, m: any, actor: number, entryId: number, reason: string | null, block: boolean) {
  const { data: e } = await supabase.from("moment_entries").select("id, author_id, status").eq("id", entryId).eq("moment_id", m.id).maybeSingle();
  if (!e) throw new HttpError(404, "Entry not found.");
  const now = new Date().toISOString();
  if (e.status !== "removed") await supabase.from("moment_entries").update({ status: "removed", moderated_by: actor, moderated_at: now, moderation_note: reason }).eq("id", entryId);
  if (block) {
    await supabase.from("moment_blocks").upsert({ moment_id: m.id, user_id: e.author_id, blocked_by: actor, reason }, { onConflict: "moment_id,user_id", ignoreDuplicates: true });
  }
  await supabase.from("moment_reports").update({ status: "actioned", handled_by: actor, handled_at: now }).eq("moment_id", m.id).eq("entry_id", entryId).eq("status", "open");
  await modLog(supabase, m, actor, block ? "remove_moment_entry_block" : "remove_moment_entry", { kind: "moment_entry", id: entryId }, reason ?? undefined);
  await ping(m, "removed");
}

export function registerEntries(app: Hono<any, any, any>) {
  // ── reading ───────────────────────────────────────────────────────────────────────────────────────────────────────
  app.get("/entries/:code", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, viewer);
    if (!st.canView || ((m.status === "cancelled" || m.status === "draft") && !st.moderate)) throw new HttpError(403, "Join this community to see this Moment.");
    const base = () => supabase.from("moment_entries").select(E).eq("moment_id", m.id).is("parent_id", null);
    const filter = c.req.query("filter") ?? "open";
    const cursor = int(c.req.query("cursor"));
    let rows: any[] = [];
    let next: string | null = null;
    let locked = false;
    const byId = async (q: any) => {
      const { data, error } = await (cursor ? q.lt("id", cursor) : q).order("id", { ascending: false }).limit(PAGE + 1);
      if (error) throw error;
      const all = data ?? [];
      rows = all.slice(0, PAGE);
      if (all.length > PAGE) next = String(rows[rows.length - 1].id);
    };

    if (m.type === "hot_seat") {
      let q = base();
      if (filter === "answered") q = q.eq("status", "answered").order("answered_at", { ascending: false });
      else if (filter === "skipped") {
        if (!st.host) throw new HttpError(403, "Only the host can see skipped questions.");
        q = q.eq("status", "skipped").order("id", { ascending: false });
      } else q = q.eq("status", "visible").order("upvotes_count", { ascending: false }).order("id", { ascending: false });
      const { data, error } = await q.limit(100);
      if (error) throw error;
      rows = data ?? [];
    } else if (m.type === "verdict") {
      if (!["closed", "completed"].includes(m.status) && !(await hasVoted(supabase, m.id, viewer))) locked = true;
      else await byId(base().eq("status", "visible"));
    } else if (m.type === "one_question") {
      if (c.req.query("sort") === "top") {
        const { data, error } = await base().eq("status", "visible").order("reactions_count", { ascending: false }).order("id", { ascending: false }).limit(50);
        if (error) throw error;
        rows = data ?? [];
      } else await byId(base().eq("status", "visible"));
    } else if (m.type === "confession_drop") {
      // Only revealed, approved confessions ever leave the server. Newest reveal first; the cursor is an offset.
      const off = int(c.req.query("cursor")) ?? 0;
      const { data, error } = await base().eq("kind", "confession").eq("status", "approved").lte("reveal_at", new Date().toISOString())
        .order("reveal_at", { ascending: false }).order("id", { ascending: false }).range(off, off + PAGE);
      if (error) throw error;
      const all = data ?? [];
      rows = all.slice(0, PAGE);
      if (all.length > PAGE) next = String(off + PAGE);
    } else {
      await byId(base().eq("status", "visible"));
    }
    return json({ entries: await formatEntries(supabase, rows, viewer), next_cursor: next, has_more: next !== null, locked });
  });

  app.get("/replies/:code", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, viewer);
    if (!st.canView) throw new HttpError(403, "Join this community to see this Moment.");
    const parent = int(c.req.query("entry_id"));
    if (!parent) return json({ message: "entry_id is required." }, 422);
    const { data: p } = await supabase.from("moment_entries").select("id, kind, status, reveal_at").eq("id", parent).eq("moment_id", m.id).maybeSingle();
    if (!p) throw new HttpError(404, "Entry not found.");
    if (m.type === "confession_drop" && !revealed(p)) throw new HttpError(404, "Entry not found.");
    if (m.type === "verdict" && !["closed", "completed"].includes(m.status) && !(await hasVoted(supabase, m.id, viewer))) return json({ replies: [], locked: true });
    const { data, error } = await supabase.from("moment_entries").select(E).eq("moment_id", m.id).eq("parent_id", parent).eq("status", "visible").order("id", { ascending: true }).limit(200);
    if (error) throw error;
    return json({ replies: await formatEntries(supabase, data ?? [], viewer) });
  });

  // ── writing ───────────────────────────────────────────────────────────────────────────────────────────────────────
  app.post("/entry/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.member) throw new HttpError(403, "Join the community to take part.");
    if (st.blocked) throw new HttpError(403, "You can't take part in this Moment.");
    if (st.muted) throw new HttpError(403, "You're muted in this community right now.");
    if (m.type === "dept_war") throw new HttpError(422, "Use the challenge endpoints for Department Wars.");

    const b = await c.req.json().catch(() => ({}));
    const clientKey = clean(b?.client_key, 64) || null;
    if (clientKey) { // idempotent retry: the same key returns the original entry
      const { data: ex } = await supabase.from("moment_entries").select(E).eq("moment_id", m.id).eq("author_id", userId).eq("client_key", clientKey).maybeSingle();
      if (ex) return json({ entry: (await formatEntries(supabase, [ex], userId))[0], duplicate: true });
    }
    const parentId = b?.parent_id == null ? null : int(b.parent_id);
    if (b?.parent_id != null && !parentId) return json({ message: "Invalid reply target." }, 422);

    let kind = "";
    let status = "visible";
    const mineCount = async (statuses: string[], parentNull = true) => {
      let q = supabase.from("moment_entries").select("id", { count: "exact", head: true }).eq("moment_id", m.id).eq("author_id", userId).in("status", statuses);
      if (parentNull) q = q.is("parent_id", null);
      return (await q).count ?? 0;
    };
    if (m.type === "hot_seat") {
      if (m.status !== "active") throw new HttpError(409, "Questions are closed.");
      if (st.host) throw new HttpError(403, "You can't ask yourself a question.");
      if (parentId) return json({ message: "Questions can't be replies." }, 422);
      if ((await mineCount(["visible", "answered", "skipped"])) >= 5) throw new HttpError(429, "You've asked the maximum number of questions.");
      kind = "question";
    } else if (m.type === "verdict") {
      if (m.status !== "active") throw new HttpError(409, "The discussion is closed.");
      if (!(await hasVoted(supabase, m.id, userId))) throw new HttpError(403, "Vote first to join the discussion.");
      kind = "comment";
    } else if (m.type === "one_question") {
      if (m.status !== "active") throw new HttpError(409, "This question is closed.");
      if (parentId) return json({ message: "Responses can't be replies." }, 422);
      if ((await mineCount(["visible"])) >= 5) throw new HttpError(429, "You've given the maximum number of answers.");
      kind = "response";
    } else if (m.type === "confession_drop") {
      if (parentId) {
        if (!["closed", "completed"].includes(m.status)) throw new HttpError(409, "Discussion opens with the reveal.");
        const { data: p } = await supabase.from("moment_entries").select("id, kind, status, reveal_at, parent_id").eq("id", parentId).eq("moment_id", m.id).maybeSingle();
        if (!p || p.kind !== "confession" || !revealed(p)) throw new HttpError(404, "That confession isn't available.");
        kind = "comment";
      } else {
        if (m.status !== "active") throw new HttpError(409, "Submissions are closed.");
        if ((await mineCount(["pending", "approved"])) >= (cfg?.max_per_user ?? 3)) throw new HttpError(429, "You've reached the submission limit for this drop.");
        kind = "confession";
        status = "pending";
      }
    } else throw new HttpError(422, "Unsupported Moment.");
    if (parentId && kind !== "comment") return json({ message: "Invalid reply target." }, 422);
    if (kind === "comment" && parentId && m.type !== "confession_drop") {
      const { data: p } = await supabase.from("moment_entries").select("id, moment_id, parent_id, status").eq("id", parentId).maybeSingle();
      if (!p || p.moment_id !== m.id || p.parent_id !== null || p.status !== "visible") throw new HttpError(404, "That post isn't available.");
    }
    if (kind === "comment" && !parentId && m.type !== "verdict") return json({ message: "Reply to a confession." }, 422);

    const body = clean(b?.body, LIMIT[kind], true);
    if (!body) return json({ message: "Write something first." }, 422);
    const sc = scan(body);
    if (sc.block) return json({ message: sc.block }, 422);

    const anon = m.type === "confession_drop" ? true : b?.anonymous === true;
    if (anon && !m.allow_anonymous_entries) throw new HttpError(422, "Anonymous posting is turned off here.");

    const [mi, hr, dup] = await Promise.all([
      supabase.from("moment_entries").select("id", { count: "exact", head: true }).eq("moment_id", m.id).eq("author_id", userId).gte("created_at", new Date(Date.now() - 60_000).toISOString()),
      supabase.from("moment_entries").select("id", { count: "exact", head: true }).eq("moment_id", m.id).eq("author_id", userId).gte("created_at", new Date(Date.now() - 3_600_000).toISOString()),
      supabase.from("moment_entries").select("id").eq("moment_id", m.id).eq("author_id", userId).eq("body", body).gte("created_at", new Date(Date.now() - 600_000).toISOString()).limit(1),
    ]);
    if ((mi.count ?? 0) >= 4) throw new HttpError(429, "Slow down a little.");
    if ((hr.count ?? 0) >= 40) throw new HttpError(429, "You've posted a lot here. Try again later.");
    if ((dup.data ?? []).length) throw new HttpError(409, "You already posted that.");

    let alias: number | null = null;
    if (anon) {
      const r = await supabase.rpc("moment_alias", { p_moment: m.id, p_user: userId });
      if (r.error) throw r.error;
      alias = r.data as number;
    }
    const { data: ins, error } = await supabase.from("moment_entries").insert({
      moment_id: m.id, parent_id: parentId, kind, author_id: userId, is_anonymous: anon, alias_no: alias, body, status, flags: sc.flags, client_key: clientKey,
    }).select(E).single();
    if (error) {
      if ((error as { code?: string }).code === "23505" && clientKey) {
        const { data: ex } = await supabase.from("moment_entries").select(E).eq("moment_id", m.id).eq("author_id", userId).eq("client_key", clientKey).maybeSingle();
        if (ex) return json({ entry: (await formatEntries(supabase, [ex], userId))[0], duplicate: true });
      }
      throw error;
    }
    await supabase.rpc("moment_touch", { p_moment: m.id, p_user: userId, p_side: null });
    await ping(m, status === "pending" ? "queue" : "entry");
    return json({ entry: (await formatEntries(supabase, [ins], userId))[0], pending: status === "pending" }, 201);
  });

  app.post("/react/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.member || st.blocked) throw new HttpError(403, "Join the community to react.");
    const b = await c.req.json().catch(() => ({}));
    const entryId = int(b?.entry_id);
    if (!entryId) return json({ message: "entry_id is required." }, 422);
    const { data: e } = await supabase.from("moment_entries").select("id, kind, status, reveal_at").eq("id", entryId).eq("moment_id", m.id).maybeSingle();
    if (!e) throw new HttpError(404, "Entry not found.");
    const open =
      (m.type === "hot_seat" && e.kind === "question" && e.status === "visible" && m.status === "active") ||
      (m.type === "one_question" && e.kind === "response" && e.status === "visible" && m.status === "active") ||
      (m.type === "verdict" && e.kind === "comment" && e.status === "visible" && m.status === "active") ||
      (m.type === "confession_drop" && ["closed", "completed"].includes(m.status) && ((e.kind === "confession" && revealed(e)) || (e.kind === "comment" && e.status === "visible")));
    if (!open) throw new HttpError(409, "Reactions aren't open for this.");
    const kind = m.type === "hot_seat" ? "upvote" : REACTIONS.includes(b?.kind) ? b.kind : "like";
    const { data: ex } = await supabase.from("moment_reactions").select("kind").eq("entry_id", entryId).eq("user_id", userId).maybeSingle();
    let mine: string | null = kind;
    if (ex && ex.kind === kind) {
      await supabase.from("moment_reactions").delete().eq("entry_id", entryId).eq("user_id", userId);
      mine = null;
    } else {
      const { error } = await supabase.from("moment_reactions").upsert({ entry_id: entryId, user_id: userId, kind }, { onConflict: "entry_id,user_id" });
      if (error) throw error;
      await supabase.rpc("moment_touch", { p_moment: m.id, p_user: userId, p_side: null });
    }
    const { data: f } = await supabase.from("moment_entries").select("upvotes_count, reactions_count").eq("id", entryId).maybeSingle();
    await ping(m, "react");
    return json({ count: m.type === "hot_seat" ? (f?.upvotes_count ?? 0) : (f?.reactions_count ?? 0), my_reaction: mine });
  });

  // Community Verdict. One vote per account is the table's primary key; this just reports it cleanly.
  app.post("/vote/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "verdict") throw new HttpError(422, "This Moment has no vote.");
    const st = await standing(supabase, m, userId);
    if (!st.member) throw new HttpError(403, "Join the community to vote.");
    if (st.blocked) throw new HttpError(403, "You can't take part in this Moment.");
    if (m.status !== "active") throw new HttpError(409, "Voting has closed.");
    const idx = Number((await c.req.json().catch(() => ({})))?.option_idx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 9) return json({ message: "Choose an option." }, 422);
    const { error } = await supabase.from("moment_votes").insert({ moment_id: m.id, user_id: userId, option_idx: idx });
    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") throw new HttpError(409, "You already voted.");
      if (code === "23503") throw new HttpError(422, "Invalid option.");
      throw error;
    }
    await supabase.rpc("moment_touch", { p_moment: m.id, p_user: userId, p_side: null });
    await ping(m, "vote");
    return json({ config: await configView(supabase, m, cfg, st, userId) });
  });

  // Hot Seat: only the host answers, skips or dismisses.
  app.post("/answer/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "hot_seat") throw new HttpError(422, "This Moment has no questions.");
    const st = await standing(supabase, m, userId);
    if (!st.host) throw new HttpError(403, "Only the host can answer.");
    if (!["active", "closed"].includes(m.status)) throw new HttpError(409, "The Hot Seat has ended.");
    const b = await c.req.json().catch(() => ({}));
    const entryId = int(b?.entry_id);
    const action = String(b?.action ?? "");
    if (!entryId || !["answer", "skip", "dismiss", "reopen"].includes(action)) return json({ message: "entry_id and action are required." }, 422);
    const text = clean(b?.answer, 1500, true);
    if (action === "answer" && !text) return json({ message: "Write an answer first." }, 422);
    const { data: e } = await supabase.from("moment_entries").select("id, author_id, status").eq("id", entryId).eq("moment_id", m.id).eq("kind", "question").maybeSingle();
    if (!e) throw new HttpError(404, "Question not found.");
    const rule: Record<string, [string[], Record<string, unknown>]> = {
      answer: [["visible", "skipped"], { answer: text, answered_at: new Date().toISOString(), status: "answered" }],
      skip: [["visible"], { status: "skipped" }],
      dismiss: [["visible", "skipped"], { status: "dismissed" }],
      reopen: [["skipped"], { status: "visible" }],
    };
    const [from, patch] = rule[action];
    const { data: row } = await supabase.from("moment_entries").update(patch).eq("id", entryId).in("status", from).select(E).maybeSingle();
    if (!row) throw new HttpError(409, "That question just changed. Refresh and try again.");
    if (action === "answer" && e.author_id !== userId) {
      later(notify(supabase, {
        recipient: e.author_id, actor: null, kind: "moment_answer", groupKey: `moment_answer:${e.id}`, dedupe: `moment_answer:${e.id}`,
        community: m.community_id, payload: { community: st.a.community.name, slug: st.a.community.slug, code: m.code, type: m.type, title: m.title },
      }));
    }
    await ping(m, "answer");
    return json({ entry: (await formatEntries(supabase, [row], userId))[0] });
  });

  // ── moderation ────────────────────────────────────────────────────────────────────────────────────────────────────────
  app.get("/queue/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can see the queue.");
    const { data, error } = await supabase.from("moment_entries").select("id, body, flags, created_at").eq("moment_id", m.id).eq("status", "pending").order("id", { ascending: true }).limit(100);
    if (error) throw error;
    return json({ entries: (data ?? []).map((e: any) => ({ ...e, can_approve: e.flags.length === 0 || st.staff })) });
  });

  app.post("/moderate/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can do that.");
    const b = await c.req.json().catch(() => ({}));
    const entryId = int(b?.entry_id);
    const action = String(b?.action ?? "");
    if (!entryId || !["remove", "approve", "reject"].includes(action)) return json({ message: "entry_id and action are required." }, 422);
    const reason = clean(b?.reason, 200) || null;
    if (action === "remove") {
      await removeEntry(supabase, m, userId, entryId, reason, b?.block === true);
      return json({ ok: true });
    }
    if (m.type !== "confession_drop") throw new HttpError(409, "Nothing to approve here.");
    if (!["active", "closed"].includes(m.status)) throw new HttpError(409, "This drop has ended.");
    const { data: e } = await supabase.from("moment_entries").select("id, flags, status").eq("id", entryId).eq("moment_id", m.id).eq("kind", "confession").maybeSingle();
    if (!e) throw new HttpError(404, "Entry not found.");
    if (e.status !== "pending") throw new HttpError(409, "That one was already handled.");
    if (action === "approve" && e.flags.length && !st.staff) throw new HttpError(403, "Flagged confessions need a community moderator.");
    const patch: Record<string, unknown> = { status: action === "approve" ? "approved" : "rejected", moderated_by: userId, moderated_at: new Date().toISOString(), moderation_note: reason };
    // approved after the reveal began: it appears right away (manual drops wait for the host)
    if (action === "approve" && m.status === "closed" && cfg && Date.parse(cfg.reveal_at) <= Date.now() && cfg.reveal_mode !== "manual") patch.reveal_at = new Date().toISOString();
    const { data: row } = await supabase.from("moment_entries").update(patch).eq("id", entryId).eq("status", "pending").select("id").maybeSingle();
    if (!row) throw new HttpError(409, "That one was already handled.");
    await modLog(supabase, m, userId, `${action}_confession`, { kind: "moment_entry", id: entryId }, reason ?? undefined);
    await ping(m, "queue");
    return json({ ok: true });
  });

  // Manual drops: the host (or a moderator) reveals confessions one at a time, or all at once.
  app.post("/reveal/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can reveal.");
    if (m.type !== "confession_drop" || cfg?.reveal_mode !== "manual") throw new HttpError(409, "This drop reveals automatically.");
    if (m.status !== "closed" || Date.parse(cfg.reveal_at) > Date.now()) throw new HttpError(409, "The reveal hasn't started.");
    const b = await c.req.json().catch(() => ({}));
    const n = b?.all === true ? 500 : clampInt(b?.count, 1, 25, 1);
    const { data } = await supabase.from("moment_entries").select("id").eq("moment_id", m.id).eq("kind", "confession").eq("status", "approved").is("reveal_at", null).order("id", { ascending: true }).limit(n);
    const ids = (data ?? []).map((r: any) => r.id);
    if (ids.length) await supabase.from("moment_entries").update({ reveal_at: new Date().toISOString() }).in("id", ids).is("reveal_at", null);
    await ping(m, "reveal");
    return json({ revealed: ids.length });
  });

  app.post("/report/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.canView) throw new HttpError(404, "Nothing to report.");
    const b = await c.req.json().catch(() => ({}));
    if (!REASONS.includes(b?.reason)) return json({ message: "A reason is required." }, 422);
    const entryId = b?.entry_id == null ? null : int(b.entry_id);
    if (b?.entry_id != null && !entryId) return json({ message: "Invalid entry." }, 422);
    if (entryId) {
      const { data: e } = await supabase.from("moment_entries").select("id, author_id, status").eq("id", entryId).eq("moment_id", m.id).maybeSingle();
      if (!e || !["visible", "approved", "answered"].includes(e.status)) throw new HttpError(404, "Nothing to report.");
      if (e.author_id === userId) throw new HttpError(422, "You can't report your own entry.");
    } else if (st.host) throw new HttpError(422, "You can't report your own Moment.");
    const { count } = await supabase.from("moment_reports").select("id", { count: "exact", head: true }).eq("reporter_id", userId).gte("created_at", new Date(Date.now() - 3_600_000).toISOString());
    if ((count ?? 0) >= 20) throw new HttpError(429, "You've sent a lot of reports. Please try again later.");
    const { error } = await supabase.from("moment_reports").insert({ moment_id: m.id, entry_id: entryId, reporter_id: userId, reason: b.reason, details: clean(b?.details, 500) || null });
    if (error && (error as { code?: string }).code !== "23505") throw error;
    return json({ ok: true, already_reported: !!error }, error ? 200 : 201);
  });

  // Entry reports go to the host and moderators; reports about the Moment itself go to moderators only.
  app.get("/reports/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can see reports.");
    const status = ["open", "actioned", "dismissed"].includes(c.req.query("status") ?? "") ? c.req.query("status")! : "open";
    let q = supabase.from("moment_reports").select("id, entry_id, reason, details, status, created_at").eq("moment_id", m.id).eq("status", status);
    if (!st.staff) q = q.not("entry_id", "is", null);
    const { data: reps, error } = await q.order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    const ids = (reps ?? []).filter((r: any) => r.entry_id).map((r: any) => r.entry_id);
    const { data: es } = ids.length ? await supabase.from("moment_entries").select("id, kind, body, is_anonymous, alias_no, status").in("id", ids) : { data: [] as any[] };
    const by = new Map((es ?? []).map((e: any) => [e.id, e]));
    return json({
      data: (reps ?? []).map((r: any) => {
        const e: any = r.entry_id ? by.get(r.entry_id) : null;
        return { ...r, preview: e ? { kind: e.kind, body: e.body, alias: e.is_anonymous ? `Anon ${e.alias_no}` : null, removed: e.status === "removed" } : null };
      }),
    });
  });

  app.post("/report-handle/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can handle reports.");
    const b = await c.req.json().catch(() => ({}));
    const reportId = int(b?.report_id);
    if (!reportId || !["dismiss", "remove"].includes(b?.action)) return json({ message: "report_id and action are required." }, 422);
    const { data: r } = await supabase.from("moment_reports").select("id, entry_id, status").eq("id", reportId).eq("moment_id", m.id).maybeSingle();
    if (!r) throw new HttpError(404, "Report not found.");
    if (r.status !== "open") throw new HttpError(409, "This report was already handled.");
    const now = new Date().toISOString();
    if (b.action === "dismiss") {
      let q = supabase.from("moment_reports").update({ status: "dismissed", handled_by: userId, handled_at: now }).eq("moment_id", m.id).eq("status", "open");
      q = r.entry_id ? q.eq("entry_id", r.entry_id) : q.is("entry_id", null);
      await q;
      return json({ status: "dismissed" });
    }
    if (r.entry_id) await removeEntry(supabase, m, userId, r.entry_id, "Reported content", b?.block === true);
    else {
      if (!st.staff) throw new HttpError(403, "Only a community moderator can act on a report about the Moment itself.");
      await supabase.from("moments").update({ status: "cancelled", cancel_reason: "Removed by a moderator after a report.", ended_at: now, ended_by: userId, updated_at: now }).eq("id", m.id).not("status", "in", "(completed,cancelled)");
      await supabase.from("moment_reports").update({ status: "actioned", handled_by: userId, handled_at: now }).eq("moment_id", m.id).is("entry_id", null).eq("status", "open");
      await modLog(supabase, m, userId, "remove_moment_after_report");
      await ping(m, "status");
    }
    return json({ status: "actioned" });
  });
}
