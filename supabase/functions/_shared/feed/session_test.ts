// Run: deno test -A --no-check
import { assert, assertEquals } from "jsr:@std/assert@1";
import { mergeRebuild, newCursorPayload, type SessionItem, signCursor, verifyCursor } from "./session.ts";

Deno.env.set("FEED_CURSOR_SECRET", "test-secret-test-secret-test-secret-123");
const P = (id: number): SessionItem => ({ t: "post", id, src: ["fresh"], score: 0.5, stage: "seed", why: [] });

Deno.test("cursor round-trips for the right user", async () => {
  const tok = await signCursor(newCursorPayload("11111111-1111-1111-1111-111111111111", 15, 42));
  const r = await verifyCursor(tok, 42);
  assert(r.ok);
  if (r.ok) { assertEquals(r.payload.p, 15); assertEquals(r.payload.u, 42); }
});

Deno.test("tampered cursors are rejected", async () => {
  const tok = await signCursor(newCursorPayload("s", 15, 42));
  const [body, sig] = tok.split(".");
  const bad = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A");
  assertEquals((await verifyCursor(`${bad}.${sig}`, 42)), { ok: false, reason: "bad_signature" });
  assertEquals((await verifyCursor(`${body}.${sig.slice(0, -2)}xx`, 42)).ok, false);
});

Deno.test("a cursor is bound to its user; guest cursors are bound to guests", async () => {
  const tok = await signCursor(newCursorPayload("s", 0, 5));
  assertEquals(await verifyCursor(tok, 6), { ok: false, reason: "wrong_user" });
  assertEquals(await verifyCursor(tok, null), { ok: false, reason: "wrong_user" });
  const g = await signCursor(newCursorPayload("s", 0, null));
  assert((await verifyCursor(g, null)).ok);
  assertEquals(await verifyCursor(g, 5), { ok: false, reason: "wrong_user" });
});

Deno.test("expired and malformed cursors", async () => {
  const old = await signCursor({ v: 1, s: "s", p: 0, u: 5, e: Date.now() - 1000 });
  assertEquals(await verifyCursor(old, 5), { ok: false, reason: "expired" });
  for (const junk of ["", "abc", "a.b.c", "....", "x".repeat(700)]) {
    const r = await verifyCursor(junk, 5);
    assert(!r.ok, `accepted: ${junk.slice(0, 10)}`);
  }
});

Deno.test("mergeRebuild never duplicates, keeps delivered items, respects the cap", () => {
  const existing = [P(1), P(2), P(3), P(4)];
  const fresh = [P(3), P(5), P(5), P(6)];
  assertEquals(mergeRebuild(existing, fresh).map((x) => (x.t === "post" ? x.id : -1)), [1, 2, 3, 4, 5, 6]);
  assertEquals(mergeRebuild(existing, fresh, 5).length, 5);
  const people: SessionItem = { t: "people", id: "ps:1", users: [{ id: 9, reason: "same_campus" }] };
  assertEquals(mergeRebuild([P(1), people], [people, P(2)]).length, 4);
});
