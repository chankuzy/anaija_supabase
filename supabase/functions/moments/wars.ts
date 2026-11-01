/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, verifyTokenOptional } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { rank } from "../_shared/services/communityAccess.ts";
import {
  HttpError, clampInt, clean, configViewers, creators, int, isStaff, later, loadAccess, loadMoment, modLog, momentSettings,
  ping, scan, standing, type SupabaseClient,
} from "./core.ts";
import { formatEntries } from "./entries.ts";

// Department Wars. Sides are communities; individuals stay anonymous unless they choose otherwise.
// Correct answers are read only here, server-side, and returned only once the war is completed.
const CHALLENGES = ["trivia", "riddle", "campus_knowledge", "creative", "voting"];
const QUIZ = new Set(["trivia", "riddle", "campus_knowledge"]);
const REP_KINDS = ["class_rep", "course_rep", "dept_exec"];
const COLS = "id, parent_id, kind, author_id, is_anonymous, alias_no, body, answer, answered_at, status, upvotes_count, reactions_count, replies_count, reveal_at, created_at";

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Authorised to commit a whole community to an official competition (per the community's dept_war_official setting). */
async function isRep(supabase: SupabaseClient, communityId: number, userId: number): Promise<boolean> {
  const a = await loadAccess(supabase, communityId, userId);
  if (!a || !a.role || a.banned || a.community.status !== "active") return false;
  const need = momentSettings(a).dept_war_official;
  if (need === "admin") return rank(a.role) >= rank("admin");
  if (need === "moderator") return isStaff(a);
  return isStaff(a) || a.designations.some((d) => REP_KINDS.includes(d.kind));
}

async function repIds(supabase: SupabaseClient, communityId: number): Promise<number[]> {
  const [m, d] = await Promise.all([
    supabase.from("community_members").select("user_id").eq("community_id", communityId).in("role", ["owner", "admin", "moderator"]).limit(20),
    supabase.from("community_designations").select("user_id").eq("community_id", communityId).in("kind", REP_KINDS).is("revoked_at", null).limit(20),
  ]);
  return [...new Set([...(m.data ?? []), ...(d.data ?? [])].map((r: any) => r.user_id as number))];
}
async function notifyReps(supabase: SupabaseClient, momentId: number, communityId: number, kind: string) {
  const ids = await repIds(supabase, communityId);
  if (ids.length) await supabase.rpc("moments_notify", { p_moment: momentId, p_kind: kind, p_recipients: ids });
}

async function mySide(supabase: SupabaseClient, momentId: number, userId: number): Promise<number | null> {
  const { data } = await supabase.from("moment_participants").select("side_community_id").eq("moment_id", momentId).eq("user_id", userId).maybeSingle();
  return data?.side_community_id ?? null;
}

function parseItems(raw: unknown, ctype: string, errors: Record<string, string>) {
  const list = Array.isArray(raw) ? raw.slice(0, 30) : [];
  const min = ctype === "riddle" ? 1 : 3;
  if (list.length < min) { errors.items = `Add at least ${min} ${min === 1 ? "riddle" : "questions"}.`; return []; }
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < list.length; i++) {
    const r: any = list[i];
    const prompt = clean(r?.prompt, 300);
    if (!prompt) { errors.items = `Question ${i + 1} is empty.`; return []; }
    if (ctype === "riddle" || r?.kind === "text") {
      const accepted = (Array.isArray(r?.accepted) ? r.accepted : []).map((x: unknown) => clean(x, 80)).filter(Boolean).slice(0, 8);
      if (!accepted.length) { errors.items = `Question ${i + 1} needs an accepted answer.`; return []; }
      out.push({ idx: i, kind: "text", prompt, accepted });
    } else {
      const choices = (Array.isArray(r?.choices) ? r.choices : []).slice(0, 6).map((x: unknown) => clean(x, 80));
      const ci = Number(r?.correct_idx);
      if (choices.length < 2 || choices.some((x: string) => !x) || !Number.isInteger(ci) || ci < 0 || ci >= choices.length) {
        errors.items = `Question ${i + 1} needs 2 to 6 filled options and one correct answer.`; return [];
      }
      out.push({ idx: i, kind: "choice", prompt, choices, correct_idx: ci });
    }
  }
  return out;
}

// ── creation: a war is a draft until both communities' representatives accept ──────────────────────────────────────
creators.set("dept_war", ({ b, a, userId, errors }) => {
  const ctype = CHALLENGES.includes(b?.challenge_type) ? (b.challenge_type as string) : null;
  if (!ctype) errors.challenge_type = "Choose a challenge type.";
  const items = ctype && QUIZ.has(ctype) ? parseItems(b?.items, ctype, errors) : [];
  const target = typeof b?.challenged === "string" || typeof b?.challenged === "number" ? String(b.challenged).trim().toLowerCase() : "";
  if (!target) errors.challenged = "Choose a community to challenge.";
  const duration = clampInt(b?.duration_minutes, 15, 10080, 1440);
  const message = clean(b?.message, 300) || null;
  return {
    fields: { status: "draft", starts_at: null, ends_at: null, anonymous: true },
    after: async (supabase, id) => {
      const t = await loadAccess(supabase, target, userId);
      if (!t) throw new HttpError(404, "That community wasn't found.");
      if (t.community.id === a.community.id) throw new HttpError(422, "You can't challenge your own community.");
      if (momentSettings(t).dept_war === "off") throw new HttpError(422, "That community isn't accepting challenges.");
      const { data: theirs } = await supabase.from("moment_war_sides").select("moment_id").eq("community_id", t.community.id).in("status", ["pending", "accepted"]);
      const ids = (theirs ?? []).map((x: any) => x.moment_id as number).filter((x: number) => x !== id);
      if (ids.length) {
        const { count } = await supabase.from("moments").select("id", { count: "exact", head: true })
          .eq("community_id", a.community.id).eq("type", "dept_war").in("status", ["draft", "active"]).in("id", ids);
        if ((count ?? 0) > 0) throw new HttpError(409, "You already have an open challenge with that community.");
      }
      const rep = await isRep(supabase, a.community.id, userId);
      const now = new Date().toISOString();
      const c1 = await supabase.from("moment_war_config").insert({
        moment_id: id, challenge_type: String(ctype), points_per_item: clampInt(b?.points_per_item, 1, 100, 10),
        min_participants: clampInt(b?.min_participants, 1, 50, 3), invite_expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        message, duration_minutes: duration,
      });
      if (c1.error) throw c1.error;
      const c2 = await supabase.from("moment_war_sides").insert([
        { moment_id: id, community_id: a.community.id, side: "challenger", status: rep ? "accepted" : "pending", proposed_by: userId, decided_by: rep ? userId : null, decided_at: rep ? now : null },
        { moment_id: id, community_id: t.community.id, side: "challenged", status: "pending", proposed_by: userId },
      ]);
      if (c2.error) throw c2.error;
      if (items.length) {
        const c3 = await supabase.from("moment_war_items").insert(items.map((i) => ({ moment_id: id, ...i })));
        if (c3.error) throw c3.error;
      }
      if (rep) {
        await supabase.from("moments").update({ is_official: true }).eq("id", id);
        await notifyReps(supabase, id, t.community.id, "moment_challenge");
      }
    },
  };
});

// ── the war's section of GET /show/:code ──────────────────────────────────────────────────────────────────────────────
configViewers.set("dept_war", async (supabase, m, cfg, _st, viewer) => {
  const live = m.status === "active" || m.status === "completed";
  const done = m.status === "completed";
  const { data: sideRows } = await supabase.from("moment_war_sides").select("community_id, side, status").eq("moment_id", m.id);
  const sides: any[] = sideRows ?? [];
  const ids = sides.map((s) => s.community_id as number);
  const [cs, stand, its, mine, mem] = await Promise.all([
    supabase.from("communities").select("id, name, slug, avatar_key, members_count").in("id", ids),
    live ? supabase.rpc("moment_war_standings", { p_moment: m.id }) : Promise.resolve({ data: [] as any[] }),
    live ? supabase.from("moment_war_items").select("id, idx, kind, prompt, choices, correct_idx, accepted").eq("moment_id", m.id).order("idx") : Promise.resolve({ data: [] as any[] }),
    viewer ? supabase.from("moment_participants").select("side_community_id").eq("moment_id", m.id).eq("user_id", viewer).maybeSingle() : Promise.resolve({ data: null as any }),
    viewer ? supabase.from("community_members").select("community_id").eq("user_id", viewer).in("community_id", ids) : Promise.resolve({ data: [] as any[] }),
  ]);
  const comm = new Map<number, any>((cs.data ?? []).map((c: any) => [c.id, c]));
  const score = new Map<number, any>(((stand.data ?? []) as any[]).map((r) => [r.cid, r]));
  const memberOf = new Set<number>(((mem.data ?? []) as any[]).map((r) => r.community_id));
  const side: number | null = mine.data?.side_community_id ?? null;

  const itemRows: any[] = its.data ?? [];
  const answers = new Map<number, any>();
  if (viewer && itemRows.length) {
    const { data } = await supabase.from("moment_war_answers").select("item_id, choice_idx, answer_text, correct").eq("user_id", viewer).in("item_id", itemRows.map((i) => i.id));
    for (const r of data ?? []) answers.set(r.item_id, r);
  }

  const canRespond: number[] = [];
  if (viewer && m.status === "draft") {
    const ch = sides.find((s) => s.side === "challenger");
    for (const s of sides) {
      if (s.status !== "pending") continue;
      if (s.side === "challenged" && ch?.status !== "accepted") continue;
      if (await isRep(supabase, s.community_id, viewer)) canRespond.push(s.community_id);
    }
  }
  const accepted = sides.filter((s) => s.status === "accepted").map((s) => s.community_id as number);
  const canJoin = m.status === "active" && !side ? accepted.filter((id) => memberOf.has(id)) : [];

  return {
    challenge_type: cfg?.challenge_type ?? null, points_per_item: cfg?.points_per_item ?? null, min_participants: cfg?.min_participants ?? null,
    duration_minutes: cfg?.duration_minutes ?? null, invite_expires_at: m.status === "draft" ? (cfg?.invite_expires_at ?? null) : null, message: cfg?.message ?? null,
    winner_community_id: done ? (cfg?.winner_community_id ?? null) : null, results: done ? (cfg?.results ?? null) : null,
    sides: sides.map((s) => {
      const c = comm.get(s.community_id);
      const sc = score.get(s.community_id);
      return {
        side: s.side, status: s.status,
        community: c ? { id: c.id, name: c.name, slug: c.slug, avatar: resolveAvatarUrl(c.avatar_key), members_count: c.members_count } : { id: s.community_id },
        participants: sc?.n_participants ?? 0, score: live ? (sc?.score ?? 0) : null, eligible: sc?.eligible ?? null,
      };
    }),
    items: itemRows.map((i) => {
      const mineA = answers.get(i.id);
      return {
        idx: i.idx, kind: i.kind, prompt: i.prompt, choices: i.choices ?? null, answered: !!mineA,
        ...(done ? { correct_idx: i.correct_idx ?? null, accepted: i.accepted ?? null, my_correct: mineA ? mineA.correct : null } : {}),
      };
    }),
    my_side: side, can_join: canJoin, can_respond: canRespond, can_play: m.status === "active" && !!side,
  };
});

export function registerWars(app: Hono<any, any, any>) {
  // A rep accepts or declines. Order: challenger endorses first, then the challenged side can respond.
  app.post("/war/respond/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war") throw new HttpError(422, "This isn't a Department War.");
    if (m.status !== "draft") throw new HttpError(409, "This challenge was already settled.");
    if (cfg?.invite_expires_at && Date.parse(cfg.invite_expires_at) <= Date.now()) throw new HttpError(409, "This challenge expired.");
    const b = await c.req.json().catch(() => ({}));
    const action = b?.action === "decline" ? "decline" : b?.action === "accept" ? "accept" : null;
    if (!action) return json({ message: "action must be accept or decline." }, 422);

    const { data: sides } = await supabase.from("moment_war_sides").select("community_id, side, status").eq("moment_id", m.id);
    const ch = (sides ?? []).find((s: any) => s.side === "challenger");
    const cd = (sides ?? []).find((s: any) => s.side === "challenged");
    if (!ch || !cd) throw new HttpError(404, "Challenge not found.");
    let target: any = null;
    if (ch.status === "pending" && (await isRep(supabase, ch.community_id, userId))) target = ch;
    else if (cd.status === "pending" && ch.status === "accepted" && (await isRep(supabase, cd.community_id, userId))) target = cd;
    if (!target) throw new HttpError(403, "Only an authorised representative can respond to this.");

    const now = new Date().toISOString();
    const { data: row } = await supabase.from("moment_war_sides")
      .update({ status: action === "accept" ? "accepted" : "declined", decided_by: userId, decided_at: now })
      .eq("moment_id", m.id).eq("community_id", target.community_id).eq("status", "pending").select("community_id").maybeSingle();
    if (!row) throw new HttpError(409, "That was just decided. Refresh.");

    if (action === "decline") {
      await supabase.from("moments").update({
        status: "cancelled", ended_at: now, ended_by: userId, updated_at: now,
        cancel_reason: target.side === "challenger" ? "The challenge wasn't approved by its community." : "The challenge was declined.",
      }).eq("id", m.id).eq("status", "draft");
      await ping(m, "status");
      return json({ status: "cancelled" });
    }
    if (target.side === "challenger") {
      later(notifyReps(supabase, m.id, cd.community_id, "moment_challenge"));
      await ping(m, "status");
      return json({ status: "invited" });
    }
    const dur = cfg?.duration_minutes ?? 1440;
    const { data: live } = await supabase.from("moments").update({
      status: "active", starts_at: now, ends_at: new Date(Date.now() + dur * 60_000).toISOString(), updated_at: now,
    }).eq("id", m.id).eq("status", "draft").select("id").maybeSingle();
    if (live) later(Promise.all([notifyReps(supabase, m.id, ch.community_id, "moment_live"), notifyReps(supabase, m.id, cd.community_id, "moment_live")]));
    await ping(m, "status");
    return json({ status: live ? "active" : "draft" });
  });

  // Fight for a side you belong to. The side is fixed once chosen.
  app.post("/war/join/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war") throw new HttpError(422, "This isn't a Department War.");
    if (m.status !== "active") throw new HttpError(409, "This challenge isn't open.");
    const b = await c.req.json().catch(() => ({}));
    const cid = int(b?.community_id);
    if (!cid) return json({ message: "Choose a side." }, 422);
    const { data: side } = await supabase.from("moment_war_sides").select("community_id").eq("moment_id", m.id).eq("community_id", cid).eq("status", "accepted").maybeSingle();
    if (!side) throw new HttpError(404, "That side isn't in this challenge.");
    const a = await loadAccess(supabase, cid, userId);
    if (!a?.role || a.banned) throw new HttpError(403, "Only members of that community can fight for it.");
    const { data: blk } = await supabase.from("moment_blocks").select("user_id").eq("moment_id", m.id).eq("user_id", userId).maybeSingle();
    if (blk) throw new HttpError(403, "You can't take part in this Moment.");
    const cur = await mySide(supabase, m.id, userId);
    if (cur && cur !== cid) throw new HttpError(409, "You've already picked a side.");
    if (!cur) {
      await supabase.rpc("moment_touch", { p_moment: m.id, p_user: userId, p_side: cid });
      await supabase.from("moment_participants").update({ side_community_id: cid }).eq("moment_id", m.id).eq("user_id", userId).is("side_community_id", null);
    }
    const now = await mySide(supabase, m.id, userId);
    if (now !== cid) throw new HttpError(409, "You've already picked a side.");
    await ping(m, "join");
    return json({ side: now });
  });

  // Trivia / riddle / campus knowledge. One answer per item per account (primary key). Correctness is not returned.
  app.post("/war/answer/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war") throw new HttpError(422, "This isn't a Department War.");
    if (m.status !== "active") throw new HttpError(409, "This challenge isn't open.");
    const side = await mySide(supabase, m.id, userId);
    if (!side) throw new HttpError(403, "Pick your side first.");
    const [blk, mu] = await Promise.all([
      supabase.from("moment_blocks").select("user_id").eq("moment_id", m.id).eq("user_id", userId).maybeSingle(),
      supabase.from("community_members").select("muted_until").eq("community_id", side).eq("user_id", userId).maybeSingle(),
    ]);
    if (blk.data) throw new HttpError(403, "You can't take part in this Moment.");
    if (mu.data?.muted_until && new Date(mu.data.muted_until) > new Date()) throw new HttpError(403, "You're muted in this community right now.");
    const b = await c.req.json().catch(() => ({}));
    const idx = Number(b?.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 29) return json({ message: "Invalid question." }, 422);
    const { data: it } = await supabase.from("moment_war_items").select("id, kind, choices, correct_idx, accepted").eq("moment_id", m.id).eq("idx", idx).maybeSingle();
    if (!it) throw new HttpError(404, "Question not found.");
    let correct = false, choice: number | null = null, text: string | null = null;
    if (it.kind === "choice") {
      choice = Number(b?.choice_idx);
      if (!Number.isInteger(choice) || choice < 0 || choice >= (it.choices ?? []).length) return json({ message: "Choose an option." }, 422);
      correct = choice === it.correct_idx;
    } else {
      text = clean(b?.text, 120);
      if (!text) return json({ message: "Type your answer." }, 422);
      correct = (it.accepted ?? []).map(norm).includes(norm(text));
    }
    const { error } = await supabase.from("moment_war_answers").insert({ item_id: it.id, user_id: userId, community_id: side, choice_idx: choice, answer_text: text, correct });
    if (error) {
      if ((error as { code?: string }).code === "23505") throw new HttpError(409, "You already answered that.");
      throw error;
    }
    await ping(m, "answer");
    return json({ saved: true });
  });

  // Creative response / voting competition: one submission per account, attributed to the side, anonymous by default.
  app.post("/war/submit/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war" || QUIZ.has(cfg?.challenge_type)) throw new HttpError(422, "This challenge has no submissions.");
    if (m.status !== "active") throw new HttpError(409, "This challenge isn't open.");
    const side = await mySide(supabase, m.id, userId);
    if (!side) throw new HttpError(403, "Pick your side first.");
    const { data: blk } = await supabase.from("moment_blocks").select("user_id").eq("moment_id", m.id).eq("user_id", userId).maybeSingle();
    if (blk) throw new HttpError(403, "You can't take part in this Moment.");
    const b = await c.req.json().catch(() => ({}));
    const body = clean(b?.body, 600, true);
    if (!body) return json({ message: "Write your entry first." }, 422);
    const sc = scan(body);
    if (sc.block) return json({ message: sc.block }, 422);
    const { count } = await supabase.from("moment_entries").select("id", { count: "exact", head: true }).eq("moment_id", m.id).eq("author_id", userId).eq("kind", "submission").neq("status", "removed");
    if ((count ?? 0) >= 1) throw new HttpError(429, "You've already entered.");
    const anon = b?.anonymous !== false && m.allow_anonymous_entries;
    let alias: number | null = null;
    if (anon) {
      const r = await supabase.rpc("moment_alias", { p_moment: m.id, p_user: userId });
      if (r.error) throw r.error;
      alias = r.data as number;
    }
    const { data: row, error } = await supabase.from("moment_entries").insert({
      moment_id: m.id, kind: "submission", author_id: userId, side_community_id: side, is_anonymous: anon, alias_no: alias,
      body, status: "visible", flags: sc.flags, client_key: clean(b?.client_key, 64) || null,
    }).select(COLS).single();
    if (error) throw error;
    await ping(m, "entry");
    return json({ entry: { ...(await formatEntries(supabase, [row], userId))[0], side_community_id: side } }, 201);
  });

  app.get("/war/entries/:code", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war") throw new HttpError(422, "This isn't a Department War.");
    const st = await standing(supabase, m, viewer);
    if (!st.canView) throw new HttpError(403, "Join a community in this challenge to see it.");
    const cursor = int(c.req.query("cursor"));
    let q = supabase.from("moment_entries").select(`${COLS}, side_community_id`).eq("moment_id", m.id).eq("kind", "submission").eq("status", "visible");
    if (cursor) q = q.lt("id", cursor);
    const { data, error } = await q.order("id", { ascending: false }).limit(31);
    if (error) throw error;
    const rows: any[] = data ?? [];
    const page = rows.slice(0, 30);
    const by = new Map<number, number | null>(page.map((r) => [r.id, r.side_community_id]));
    const formatted = await formatEntries(supabase, page, viewer);
    return json({
      entries: formatted.map((e) => ({ ...e, side_community_id: by.get(e.id) ?? null })),
      next_cursor: rows.length > 30 ? String(page[page.length - 1].id) : null, has_more: rows.length > 30,
    });
  });

  // Only the OTHER side votes on a side's submissions.
  app.post("/war/vote/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war") throw new HttpError(422, "This isn't a Department War.");
    if (m.status !== "active") throw new HttpError(409, "Voting isn't open.");
    const side = await mySide(supabase, m.id, userId);
    if (!side) throw new HttpError(403, "Pick your side first.");
    const b = await c.req.json().catch(() => ({}));
    const entryId = int(b?.entry_id);
    if (!entryId) return json({ message: "entry_id is required." }, 422);
    const { data: e } = await supabase.from("moment_entries").select("id, side_community_id").eq("id", entryId).eq("moment_id", m.id).eq("kind", "submission").eq("status", "visible").maybeSingle();
    if (!e) throw new HttpError(404, "Entry not found.");
    if (e.side_community_id === side) throw new HttpError(403, "Vote on the other side's entries.");
    const { data: ex } = await supabase.from("moment_reactions").select("kind").eq("entry_id", entryId).eq("user_id", userId).maybeSingle();
    let mine: string | null = "upvote";
    if (ex) {
      await supabase.from("moment_reactions").delete().eq("entry_id", entryId).eq("user_id", userId);
      mine = null;
    } else {
      const { error } = await supabase.from("moment_reactions").insert({ entry_id: entryId, user_id: userId, kind: "upvote" });
      if (error && (error as { code?: string }).code !== "23505") throw error;
    }
    const { data: f } = await supabase.from("moment_entries").select("upvotes_count").eq("id", entryId).maybeSingle();
    await ping(m, "vote");
    return json({ count: f?.upvotes_count ?? 0, my_reaction: mine });
  });

  // Staff of EITHER community can remove a submission; the log carries no author.
  app.post("/war/remove/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    if (m.type !== "dept_war") throw new HttpError(422, "This isn't a Department War.");
    const b = await c.req.json().catch(() => ({}));
    const entryId = int(b?.entry_id);
    if (!entryId) return json({ message: "entry_id is required." }, 422);
    const { data: sides } = await supabase.from("moment_war_sides").select("community_id").eq("moment_id", m.id);
    let ok = false;
    for (const s of sides ?? []) {
      const a = await loadAccess(supabase, s.community_id, userId);
      if (a && isStaff(a)) { ok = true; break; }
    }
    if (!ok) throw new HttpError(403, "Only a moderator of either community can remove entries.");
    const reason = clean(b?.reason, 200) || null;
    const { data: row } = await supabase.from("moment_entries")
      .update({ status: "removed", moderated_by: userId, moderated_at: new Date().toISOString(), moderation_note: reason })
      .eq("id", entryId).eq("moment_id", m.id).eq("kind", "submission").neq("status", "removed").select("id").maybeSingle();
    if (!row) throw new HttpError(404, "Entry not found.");
    await modLog(supabase, m, userId, "remove_war_submission", { kind: "moment_entry", id: entryId }, reason ?? undefined);
    await ping(m, "removed");
    return json({ ok: true });
  });
}
