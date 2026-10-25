#!/usr/bin/env python3
"""Discover contract walk. Usage: TOKEN=<bearer> [ME_ID=<your user id>] [FILTER=for_you|marketplace] python3 scripts/discover_walk.py
Exit 1 on any violation: duplicates, own posts, adjacent same author, listing pacing, unstable replay."""
import json, os, sys, urllib.parse, urllib.request

BASE = os.environ.get("BASE", "https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1")
TOKEN = os.environ["TOKEN"]
FILTER = os.environ.get("FILTER", "for_you")
ME = int(os.environ["ME_ID"]) if os.environ.get("ME_ID") else None

def get(cursor=None, refresh=False):
    q = {"filter": FILTER}
    if cursor: q["cursor"] = cursor
    if refresh: q["refresh"] = "1"
    req = urllib.request.Request(f"{BASE}/discover?" + urllib.parse.urlencode(q),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

bad, pages, cursor, seen, first_cursor_by_page = [], [], None, set(), []
for n in range(8):
    first_cursor_by_page.append(cursor)
    d = get(cursor)
    items = d["items"]
    pages.append(items)
    ids = [i["data"]["id"] for i in items]
    for pid in ids:
        if pid in seen: bad.append(f"duplicate post {pid} on page {n + 1}")
        seen.add(pid)
    for i in items:
        if ME is not None and i["data"]["author"]["id"] == ME: bad.append(f"own post {i['data']['id']}")
        if i["type"] != ("listing" if i["data"].get("type") == "listing" else "post"): bad.append("type/data mismatch")
    print(f"page {n + 1}: {len(items)} items, has_more={d['has_more']}, caught_up={d.get('caught_up')}, inventory={d.get('inventory')}")
    cursor = d["next_cursor"]
    if not d["has_more"]: break

flat = [i for p in pages for i in p]
au = [i["data"]["author"]["id"] for i in flat]
for k in range(1, len(au)):
    if au[k] == au[k - 1]: bad.append(f"adjacent same author at slot {k} (author {au[k]})")
if FILTER == "for_you":
    if sum(1 for i in flat[:9] if i["type"] == "listing") > 1: bad.append("more than 1 listing in first screen")
    for p in pages:
        if sum(1 for i in p if i["type"] == "listing") > 4: bad.append("more than 4 listings on a page")
else:
    if any(i["type"] != "listing" for i in flat): bad.append("non-listing in marketplace filter")

if len(pages) > 1 and first_cursor_by_page[1]:
    replay = get(first_cursor_by_page[1])
    if [i["data"]["id"] for i in replay["items"]] != [i["data"]["id"] for i in pages[1]]:
        bad.append("retrying a cursor returned a different page (replay not stable)")

r = get(refresh=True)
overlap = {i["data"]["id"] for i in r["items"]} & {i["data"]["id"] for i in pages[0]}
print(f"refresh: {len(r['items'])} items, {len(overlap)} repeated from the previous first page "
      f"(expected ~0 unless inventory is below one page)")
print(f"total unique posts walked: {len(seen)}")
if bad:
    print("FAIL"); [print(" -", b) for b in bad]; sys.exit(1)
print("PASS")
