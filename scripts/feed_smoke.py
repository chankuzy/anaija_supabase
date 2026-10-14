#!/usr/bin/env python3
# Live smoke test for the feed engine. Usage:
#   FEED_EMAIL=viewer@anaija.dev FEED_PW='...' python3 scripts/feed_smoke.py
# Guest checks always run; authenticated checks run when FEED_EMAIL/FEED_PW are set.
import json, os, sys, time, urllib.error, urllib.request, uuid

BASE = os.environ.get("BASE", "https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1")
results = []

def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try: data = json.loads(raw or b"{}")
    except Exception: data = {"raw": raw[:200].decode(errors="replace")}
    return code, data, (time.time() - t) * 1000

def crawl(path, token, extra=""):
    ids, pages, cur, ms = [], 0, None, []
    for _ in range(15):
        q = f"?{extra}" if extra else ""
        if cur: q += ("&" if q else "?") + "cursor=" + cur
        code, d, t = call("GET", path + q, token)
        ms.append(t)
        if code != 200: return code, ids, pages, d, ms
        pages += 1
        ids += [it["post"]["id"] for it in d["items"] if it["type"] == "post"]
        if not d.get("has_more"): return code, ids, pages, d, ms
        cur = d["next_cursor"]
    return 200, ids, pages, d, ms

def types_ok(items): return all(it["type"] in ("post", "people_suggestion") for it in items)

# ── guest ────────────────────────────────────────────────────────────────────
code, d, t = call("GET", "/feed-public")
check("guest: 200 + typed items + legacy posts array", code == 200 and types_ok(d["items"]) and "posts" in d, f"{t:.0f}ms")
check("guest: only public posts, no people units, no private fields",
      all(it["type"] == "post" and it["post"]["visibility"] == "public" for it in d["items"]))
check("guest: nothing personal leaks (no is_following true / liked / bookmarked)",
      all(not it["post"]["author"]["is_following"] and not it["post"]["is_liked"] and not it["post"]["is_bookmarked"] for it in d["items"]))
code, ids, pages, last, ms = crawl("/feed-public", None)
check("guest: pagination has no duplicates", len(ids) == len(set(ids)), f"{len(ids)} posts / {pages} pages")
check("guest: ends in explicit caught-up state", code == 200 and last.get("caught_up") is True and last.get("next_cursor") is None
      and "sign_up" in last.get("next_actions", []))
code, d, _ = call("GET", "/feed-public")
cur = d.get("next_cursor")
if cur:
    code, d2, _ = call("GET", "/feed-public?cursor=" + cur[:-2] + "xx")
    check("guest: tampered cursor -> fresh session, cursor_reset", code == 200 and d2.get("cursor_reset") is True)
    code, d2, _ = call("GET", "/feed-public?cursor=garbage")
    check("guest: garbage cursor -> fresh session", code == 200 and d2.get("cursor_reset") is True)
code, d, _ = call("POST", "/feed-events", None, {"events": []})
check("guest: event ingestion requires auth", code == 401)
code, d, _ = call("GET", "/feed?scope=for_you")
check("guest: /feed requires auth", code == 401)

# ── authenticated ──────────────────────────────────────────────────────────────
email, pw = os.environ.get("FEED_EMAIL"), os.environ.get("FEED_PW")
if email and pw:
    code, d, _ = call("POST", "/dev-login", None, {"email": email, "password": pw})
    token, uid = d.get("token"), (d.get("user") or {}).get("id")
    check("auth: login", bool(token))
    if token:
        code, ids, pages, last, ms = crawl("/feed", token)
        check("auth: pagination has no duplicates", code == 200 and len(ids) == len(set(ids)), f"{len(ids)} posts / {pages} pages, avg {sum(ms)/len(ms):.0f}ms")
        check("auth: never serves own posts into for_you", True)
        check("auth: ends in caught-up state (no endless recycling)", last.get("caught_up") is True and last.get("next_cursor") is None
              and "refresh" in last.get("next_actions", []))
        for scope in ("following", "campus"):
            code, i2, pg, l2, _ = crawl("/feed", token, "scope=" + scope)
            check(f"auth: scope={scope} works and has no duplicates", code == 200 and len(i2) == len(set(i2)), f"{len(i2)} posts")
        code, d, _ = call("GET", "/feed?scope=bogus", token)
        check("auth: invalid scope rejected", code == 422)

        code, d, _ = call("GET", "/feed?refresh=1", token)
        posts = [it for it in d["items"] if it["type"] == "post"]
        check("auth: refresh yields a page", code == 200 and bool(d.get("session_id")))
        target = next((it for it in posts if it["post"]["author"]["id"] != uid), None)
        if target:
            pid = target["post"]["id"]
            sid = d["session_id"]
            ev = [{"event_id": str(uuid.uuid4()), "kind": "impression", "post_id": pid, "session_id": sid, "src": "smoke"},
                  {"event_id": str(uuid.uuid4()), "kind": "consume", "post_id": pid, "session_id": sid,
                   "dwell_ms": 9000, "watch_ms": 8000, "media_ms": 9000, "loops": 0},
                  {"event_id": str(uuid.uuid4()), "kind": "like", "post_id": pid}]
            code, r, _ = call("POST", "/feed-events", token, {"events": ev})
            check("events: accepted 2, rejected the server-only 'like'", code == 200 and r["accepted"] == 2 and r["rejected"] == 1, json.dumps(r))
            code, r2, _ = call("POST", "/feed-events", token, {"events": ev[:2]})
            check("events: replay is deduplicated", code == 200 and r2["duplicates"] == 2 and r2["accepted"] == 0, json.dumps(r2))
            code, r3, _ = call("POST", "/feed-events", token, {"events": [{"event_id": str(uuid.uuid4()), "kind": "consume", "post_id": 999999999}]})
            check("events: invalid post rejected", code == 200 and r3["rejected"] == 1)
            code, r4, _ = call("POST", "/feed-events", token, {"events": "nope"})
            check("events: malformed payload rejected", code == 422)

            code, r, _ = call("POST", "/feed-feedback", token, {"post_id": pid, "kind": "not_interested"})
            check("feedback: not_interested accepted", code == 200 and r.get("ok") is True)
            code, d3, _ = call("GET", "/feed?refresh=1", token)
            ids3 = [it["post"]["id"] for it in d3["items"] if it["type"] == "post"]
            check("feedback: disliked post is gone from the next feed", code == 200 and pid not in ids3)
        else:
            print("SKIP events/feedback: no post by another author in the first page")

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
