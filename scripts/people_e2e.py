#!/usr/bin/env python3
# End-to-end people-suggestion check against the live /feed.
# Usage: FEED_EMAIL=... FEED_PW=... python3 scripts/people_e2e.py   (or TOKEN=... to skip login)
import json, os, sys, time, urllib.error, urllib.request, uuid

BASE = os.environ.get("BASE", "https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1")
results = []
LABELS = {"same_campus": "Faces Around Your Campus", "mutual": "People Worth Knowing",
          "similar_interests": "You Might Love Their Content", "emerging": "Before Everyone Knows Them",
          "wide": "Beyond Your Circle"}
ALLOWED = {"id", "name", "username", "avatar", "is_verified", "campus_verified", "tagline", "reason", "label"}

def check(name, ok, detail=""):
    results.append(bool(ok))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))

def call(method, path, token=None, body=None):
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Content-Type", "application/json")
    if token: req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try: data = json.loads(raw or b"{}")
    except Exception: data = {"raw": raw[:200].decode(errors="replace")}
    return code, data

def login():
    if os.environ.get("TOKEN"): return os.environ["TOKEN"], None
    code, d = call("POST", "/dev-login", None, {"email": os.environ["FEED_EMAIL"], "password": os.environ["FEED_PW"]})
    if not d.get("token"):
        print("login failed:", code, json.dumps(d)[:300]); sys.exit(2)
    return d["token"], (d.get("user") or {}).get("id")

def units_of(d): return [it for it in d.get("items", []) if it["type"] == "people_suggestion"]

def run_session(token):
    code, d = call("GET", "/feed?refresh=1", token)
    posts = [it["post"]["id"] for it in d.get("items", []) if it["type"] == "post"]
    if code != 200 or len(posts) < 6 or not d.get("next_cursor"):
        return None, d, f"page 1 too small ({len(posts)} posts, has_more={d.get('has_more')})"
    sid = d["session_id"]
    ev = [{"event_id": str(uuid.uuid4()), "kind": "consume", "post_id": posts[i % len(posts)], "session_id": sid,
           "dwell_ms": 9000, "watch_ms": 8000, "media_ms": 9000, "loops": 0, "src": "e2e", "slot": i % 15}
          for i in range(20)]
    code, r = call("POST", "/feed-events", token, {"events": ev})
    print(f"   consume events: {json.dumps(r)}")
    code, d2 = call("GET", "/feed?cursor=" + d["next_cursor"], token)
    return sid, d2, ""

token, uid = login()
print(f"logged in, uid={uid}")

# ── round 1 ──
sid, d2, why = run_session(token)
if sid is None:
    print("SKIP: " + why); sys.exit(2)
us = units_of(d2)
check("round 1: a people_suggestion unit appears after ~20 consumed posts", len(us) == 1, f"units={len(us)}")
if not us:
    print("   no unit: viewer may have <2 candidates above people.min_score. Check feed_people_candidates for this user.")
    sys.exit(1)
u = us[0]
users = u["users"]
check("unit: has stable id, 2-3 users", str(u.get("id", "")).startswith("ps_") and 2 <= len(users) <= 3, f"{u['id']} n={len(users)}")
check("unit: no leaked internals (only display fields)", all(set(x) <= ALLOWED for x in users),
      str(sorted(set().union(*[set(x) for x in users]) - ALLOWED)))
check("unit: labels match proven reasons", all(x["label"] == LABELS.get(x["reason"]) for x in users),
      ", ".join(f"{x['username']}:{x['reason']}" for x in users))
check("unit: never suggests self", uid is None or all(x["id"] != uid for x in users))
check("unit: no duplicate people", len({x["id"] for x in users}) == len(users))
ids1 = [x["id"] for x in users]

imp = [{"event_id": str(uuid.uuid4()), "kind": "suggestion_impression", "target_user_id": i,
        "session_id": sid, "surface": "feed"} for i in ids1]
code, r = call("POST", "/feed-events", token, {"events": imp})
check("impressions accepted", code == 200 and r.get("accepted") == len(ids1), json.dumps(r))
dismissed = ids1[0]
code, r = call("POST", "/feed-events", token, {"events": [{"event_id": str(uuid.uuid4()), "kind": "suggestion_dismiss",
                                                             "target_user_id": dismissed, "session_id": sid, "surface": "feed"}]})
check("dismiss accepted", code == 200 and r.get("accepted") == 1, json.dumps(r))
code, r = call("POST", "/feed-events", token, {"events": [{"event_id": str(uuid.uuid4()), "kind": "suggestion_follow",
                                                             "target_user_id": ids1[-1], "session_id": sid}]})
check("suggestion_follow without a real follow is rejected", code == 200 and r.get("rejected") == 1, json.dumps(r))

# ── round 2: new session ──
sid2, d3, why = run_session(token)
if sid2 is None:
    print("SKIP round 2: " + why)
else:
    us2 = units_of(d3)
    ids2 = [x["id"] for un in us2 for x in un["users"]]
    check("round 2: dismissed person never resurfaces", dismissed not in ids2, f"unit2={ids2 or 'suppressed'}")
    check("round 2: recently shown people are on cooldown", not (set(ids1) & set(ids2)), f"unit2={ids2 or 'suppressed'}")
    print("   (an empty unit in round 2 is correct suppression when fewer than 2 fresh candidates remain)")

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
