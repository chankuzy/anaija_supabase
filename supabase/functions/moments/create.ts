/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, verifyTokenOptional } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { canManage, canRead } from "../_shared/services/communityAccess.ts";
import {
  HttpError, MODES, TYPES, anyOverdue, canCreate, cfgOf, clampInt, clean, creators, int, isStaff, isoOrNull, later, loadAccess,
  loadMoment, modLog, momentSettings, momentView, newCode, notifyParticipants, ping, standing, tellCreator, tickNow,
} from "./core.ts";

const DAY = 86_400_000;

// ── per-type creation rules ─────────────────────────────────────────────────────────────────────────────────────────────
creators.set("hot_seat", ({ b, startMs }) => {
  const mins = clampInt(b?.duration_minutes, 5, 180, 30);
  const end = startMs + mins * 60_000;
  return {
    fields: { ends_at: new Date(end).toISOString() },
    after: async (supabase, id) => {
      const { error } = await supabase.from("moment_hot_seats").insert({ moment_id: id, answer_until: new Date(end + 12 * 3_600_000).toISOString() });
      if (error) throw error;
    },
  };
});

creators.set("verdict", ({ b, startMs, errors }) => {
  const labels = (Array.isArray(b?.options) ? b.options : []).map((o: any) => clean(typeof o === "string" ? o : o?.label, 80)).filter(Boolean) as string[];
  if (labels.length < 2 || labels.length > 6 || new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) errors.options = "Give 2 to 6 different options.";
  const hours = clampInt(b?.duration_hours, 1, 720, 24);
  return {
    fields: { ends_at: new Date(startMs + hours * 3_600_000).toISOString() },
    after: async (supabase, id) => {
      const { error } = await supabase.from("moment_options").insert(labels.map((label, idx) => ({ moment_id: id, idx, label })));
      if (error) throw error;
    },
  };
});

creators.set("one_question", ({ b, startMs }) => {
  const hours = b?.duration_hours ? clampInt(b.duration_hours, 1, 720, 24) : 0; // no deadline unless asked
  return { fields: { ends_at: hours ? new Date(startMs + hours * 3_600_000).toISOString() : null } };
});

creators.set("confession_drop", ({ b, startMs, errors }) => {
  const now = Date.now();
  const reveal = isoOrNull(b?.reveal_at);
  let revealMs = 0;
  if (typeof reveal !== "string") errors.reveal_at = "Choose when the reveal begins.";
  else {
    revealMs = Date.parse(reveal);
    if (revealMs < Math.max(startMs, now) + 5 * 60_000) errors.reveal_at = "The reveal must be at least 5 minutes after submissions open.";
    else if (revealMs > now + 30 * DAY) errors.reveal_at = "Reveal within 30 days.";
  }
  const endsRaw = isoOrNull(b?.ends_at);
  if (endsRaw === undefined) errors.ends_at = "Invalid closing time.";
  const ends = typeof endsRaw === "string" ? Date.parse(endsRaw) : revealMs;
  if (revealMs && (ends > revealMs || ends < startMs + 60_000)) errors.ends_at = "Submissions must close before the reveal.";
  const mode = ["all", "sequential", "manual"].includes(b?.reveal_mode) ? b.reveal_mode : "sequential";
  return {
    fields: { ends_at: ends ? new Date(ends).toISOString() : null, allow_anonymous_entries: true },
    after: async (supabase, id) => {
      const { error } = await supabase.from("moment_confession_drops").insert({
        moment_id: id, reveal_at: reveal, reveal_mode: mode,
        reveal_interval_secs: clampInt(b?.reveal_interval_secs, 5, 3600, 20), max_per_user: clampInt(b?.max_per_user, 1, 10, 3),
      });
      if (error) throw error;
    },
  };
});

const CARD = (m: any, show: boolean, reveal: string | null = null) => ({
  code: m.code, path: `/m/${m.code}`, type: m.type, status: m.status, title: show ? m.title : null, anonymous: m.anonymous,
  is_official: m.is_official, starts_at: m.starts_at, ends_at: m.ends_at, reveal_at: reveal, community_id: m.community_id,
  participants_count: show ? m.participants_count : 0, entries_count: show ? m.entries_count : 0, created_at: m.created_at,
});

export function registerManage(app: Hono<any, any, any>) {
  // Which Moment types may this viewer start here (the picker hides the rest)? Admins also get the raw settings.
  app.get("/settings/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, c.req.param("id"), userId);
    if (!a || a.banned) throw new HttpError(404, "Not found.");
    return json({ can: Object.fromEntries(TYPES.map((t) => [t, canCreate(a, t)])), settings: canManage(a) ? momentSettings(a) : null });
  });

  app.post("/settings/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, c.req.param("id"), userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!canManage(a)) throw new HttpError(403, "Only admins can change Moment settings.");
    const b = await c.req.json().catch(() => ({}));
    const next = { ...momentSettings(a) };
    const errors: Record<string, string> = {};
    for (const t of TYPES) {
      if (b?.[t] === undefined) continue;
      if (MODES.includes(b[t])) next[t] = b[t]; else errors[t] = "Invalid level.";
    }
    if (b?.dept_war_official !== undefined) {
      if (["representative", "moderator", "admin"].includes(b.dept_war_official)) next.dept_war_official = b.dept_war_official;
      else errors.dept_war_official = "Invalid level.";
    }
    if (Object.keys(errors).length) throw new HttpError(422, "Validation failed.", errors);
    const { error } = await supabase.from("communities").update({ moment_settings: next, updated_at: new Date().toISOString() }).eq("id", a.community.id);
    if (error) throw error;
    await supabase.from("community_mod_log").insert({ community_id: a.community.id, actor_id: userId, action: "update_moment_settings", note: Object.keys(b ?? {}).join(",").slice(0, 200) });
    return json({ settings: next });
  });

  app.post("/create/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, c.req.param("id"), userId);
    if (!a) throw new HttpError(404, "Not found.");
    const b = await c.req.json().catch(() => ({}));
    const type = String(b?.type ?? "");
    const creator = creators.get(type);
    if (!(TYPES as readonly string[]).includes(type) || !creator) return json({ message: "Unknown Moment type." }, 422);
    if (!canCreate(a, type)) throw new HttpError(403, a.role ? "Members can't start this kind of Moment here." : "Join this community first.");
    const { data: mem } = await supabase.from("community_members").select("muted_until").eq("community_id", a.community.id).eq("user_id", userId).maybeSingle();
    if (mem?.muted_until && new Date(mem.muted_until) > new Date()) throw new HttpError(403, "You're muted in this community right now.");

    const errors: Record<string, string> = {};
    const title = clean(b?.title, 200) || (type === "hot_seat" ? "Hot Seat" : "");
    if (!title) errors.title = type === "one_question" ? "Ask your question." : "Add a title.";
    const text = clean(b?.body, 600, true) || null;
    const startsAt = isoOrNull(b?.starts_at);
    if (startsAt === undefined) errors.starts_at = "Invalid start time.";
    const now = Date.now();
    if (typeof startsAt === "string" && Date.parse(startsAt) > now + 30 * DAY) errors.starts_at = "Start within 30 days.";
    const startMs = typeof startsAt === "string" ? Math.max(Date.parse(startsAt), now) : now;
    const spec = creator({ b, startMs, a, userId, errors });
    if (Object.keys(errors).length) throw new HttpError(422, "Validation failed.", errors);

    const [day, mine, open] = await Promise.all([
      supabase.from("moments").select("id", { count: "exact", head: true }).eq("creator_id", userId).gte("created_at", new Date(now - DAY).toISOString()),
      supabase.from("moments").select("id", { count: "exact", head: true }).eq("creator_id", userId).eq("community_id", a.community.id).in("status", ["scheduled", "active", "closed"]),
      supabase.from("moments").select("id", { count: "exact", head: true }).eq("community_id", a.community.id).in("status", ["scheduled", "active"]),
    ]);
    if ((day.count ?? 0) >= 12) throw new HttpError(429, "You've started a lot of Moments today.");
    if ((mine.count ?? 0) >= 3) throw new HttpError(422, "Wrap up one of your Moments before starting another.");
    if ((open.count ?? 0) >= 30) throw new HttpError(422, "This community has a lot going on right now. Try again soon.");

    const scheduled = typeof startsAt === "string" && Date.parse(startsAt) > now + 30_000;
    let created: any = null;
    for (let i = 0; i < 5 && !created; i++) {
      const { data, error } = await supabase.from("moments").insert({
        code: newCode(), community_id: a.community.id, creator_id: userId, type, status: scheduled ? "scheduled" : "active", title, body: text,
        anonymous: b?.anonymous === true, allow_anonymous_entries: b?.allow_anonymous_entries !== false, allow_preview: b?.allow_preview !== false,
        starts_at: startsAt, ...spec.fields,
      }).select("*").single();
      if (!error) created = data;
      else if ((error as { code?: string }).code !== "23505") throw error;
    }
    if (!created) throw new HttpError(409, "Couldn't create a link. Try again.");
    try {
      await spec.after?.(supabase, created.id);
    } catch (e) {
      await supabase.from("moments").delete().eq("id", created.id); // children cascade; never leave a half-built Moment
      throw e;
    }
    const st = await standing(supabase, created, userId);
    return json({ moment: await momentView(supabase, created, await cfgOf(supabase, created), st, userId) }, 201);
  });

  // Live / upcoming / recent for a community's Moments tab. Guests see only what the community previews.
  app.get("/community/:ref", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const a = await loadAccess(supabase, c.req.param("ref"), viewer);
    if (!a) throw new HttpError(404, "Not found.");
    if (a.banned) throw new HttpError(403, "You can't access this community.");
    const out = { live: [] as any[], upcoming: [] as any[], recent: [] as any[], invites: [] as any[] };
    if (!canRead(a)) return json(out);

    const { data: sides } = await supabase.from("moment_war_sides").select("moment_id").eq("community_id", a.community.id).in("status", ["pending", "accepted"]).limit(50);
    const sideIds = (sides ?? []).map((s: any) => s.moment_id);
    const read = async () => {
      let q = supabase.from("moments").select("*").neq("status", "cancelled");
      q = sideIds.length ? q.or(`community_id.eq.${a.community.id},id.in.(${sideIds.join(",")})`) : q.eq("community_id", a.community.id);
      const { data, error } = await q.order("id", { ascending: false }).limit(40);
      if (error) throw error;
      return data ?? [];
    };
    let rows = await read();
    if (await anyOverdue(supabase, rows)) { await tickNow(supabase); rows = await read(); }

    const cds = rows.filter((r: any) => r.type === "confession_drop").map((r: any) => r.id);
    const reveals = new Map<number, string>();
    if (cds.length) {
      const { data } = await supabase.from("moment_confession_drops").select("moment_id, reveal_at").in("moment_id", cds);
      for (const r of data ?? []) reveals.set(r.moment_id, r.reveal_at);
    }
    const now = Date.now();
    const rep = a.designations.length > 0 || isStaff(a);
    for (const m of rows as any[]) {
      const show = !!a.role || (m.allow_preview && a.community.read_policy === "public_preview");
      if (!show) continue;
      const reveal = reveals.get(m.id) ?? null;
      const card = CARD(m, true, reveal);
      if (m.status === "draft") { if (rep || m.creator_id === viewer) out.invites.push(card); }
      else if (m.status === "active") out.live.push(card);
      else if (m.status === "scheduled" || (m.type === "confession_drop" && m.status === "closed" && reveal && Date.parse(reveal) > now)) out.upcoming.push(card);
      else if (out.recent.length < 10) out.recent.push(card);
    }
    out.upcoming.sort((x, y) => Date.parse(x.starts_at ?? x.reveal_at ?? x.created_at) - Date.parse(y.starts_at ?? y.reveal_at ?? y.created_at));
    return json(out);
  });

  // Landing + header. Safe for guests: returns what the viewer may know, and what they would need to do to get in.
  app.get("/show/:code", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const { m, cfg } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, viewer);
    if (m.status === "draft" && !st.moderate) throw new HttpError(404, "Moment not found.");
    return json({ moment: await momentView(supabase, m, cfg, st, viewer) });
  });

  // Close what is open: stop questions / stop collecting / finish. Host or a moderator.
  app.post("/end/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can do that.");
    const now = new Date().toISOString();
    let patch: Record<string, unknown> | null = null;
    if (m.status === "scheduled" || m.status === "draft") throw new HttpError(409, "It hasn't started. Cancel it instead.");
    if (m.type === "hot_seat" || m.type === "confession_drop") {
      if (m.status === "active") patch = { status: "closed", ends_at: now };
      else if (m.status === "closed") patch = { status: "completed", ended_at: now, ended_by: userId };
    } else if (m.status === "active") patch = { status: "completed", ended_at: now, ended_by: userId };
    if (!patch) throw new HttpError(409, "This Moment has already ended.");
    const { data: row } = await supabase.from("moments").update({ ...patch, updated_at: now }).eq("id", m.id).eq("status", m.status).select("id").maybeSingle();
    if (!row) throw new HttpError(409, "This Moment just changed. Refresh and try again.");
    if (m.type === "hot_seat" && patch.status === "closed") {
      await supabase.from("moment_hot_seats").update({ submissions_closed_at: now, answer_until: new Date(Date.now() + 12 * 3_600_000).toISOString() }).eq("moment_id", m.id);
    }
    if (m.type === "dept_war" && patch.status === "completed") await supabase.rpc("moment_war_finalise", { p_moment: m.id });
    if (patch.status === "completed") later(notifyParticipants(supabase, m.id, "moment_ended"));
    if (!st.host) {
      await modLog(supabase, m, userId, "end_moment");
      later(tellCreator(supabase, m, st.a, "ended", null));
    }
    await ping(m, "status");
    return json({ status: patch.status });
  });

  // Terminate. The host may cancel their own Moment; moderators may remove any, with the action logged under their name.
  app.post("/cancel/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.moderate) throw new HttpError(403, "Only the host or a moderator can cancel this.");
    if (["completed", "cancelled"].includes(m.status)) throw new HttpError(409, "This Moment has already ended.");
    const b = await c.req.json().catch(() => ({}));
    const reason = clean(b?.reason, 200) || null;
    const { data: row } = await supabase.from("moments").update({ status: "cancelled", cancel_reason: reason, ended_at: new Date().toISOString(), ended_by: userId, updated_at: new Date().toISOString() })
      .eq("id", m.id).eq("status", m.status).select("id").maybeSingle();
    if (!row) throw new HttpError(409, "This Moment just changed. Refresh and try again.");
    if (!st.host) {
      await modLog(supabase, m, userId, "cancel_moment", {}, reason ?? undefined);
      later(tellCreator(supabase, m, st.a, "cancelled", reason));
    }
    await ping(m, "status");
    return json({ status: "cancelled" });
  });

  // "Remind me": the only broadcast-like notification. It reaches the people who asked, nobody else.
  app.post("/remind/:code", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { m } = await loadMoment(supabase, c.req.param("code"));
    const st = await standing(supabase, m, userId);
    if (!st.member || !st.canView) throw new HttpError(403, "Join the community first.");
    if (["completed", "cancelled"].includes(m.status)) throw new HttpError(409, "This Moment has ended.");
    if (st.reminder) {
      await supabase.from("moment_reminders").delete().eq("moment_id", m.id).eq("user_id", userId);
      return json({ reminder: false });
    }
    const { error } = await supabase.from("moment_reminders").upsert({ moment_id: m.id, user_id: userId }, { onConflict: "moment_id,user_id", ignoreDuplicates: true });
    if (error) throw error;
    return json({ reminder: true });
  });
}
