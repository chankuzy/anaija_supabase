#!/usr/bin/env python3
"""Walk /feed-public as a guest and check the always-alive contract. Exit 1 on violation.
Ids ending in L are listings."""
import collections, json, sys, urllib.error, urllib.parse, urllib.request

BASE = "https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1/feed-public"
MAX_PAGES = 10


def fetch(cursor):
    url = BASE + ("?cursor=" + urllib.parse.quote(cursor) if cursor else "")
    return json.load(urllib.request.urlopen(url, timeout=20))


def main():
    cursor, seen, dups, ended = None, set(), 0, False
    srcs, kinds, authors = collections.Counter(), collections.Counter(), collections.Counter()
    sizes = []
    for page in range(1, MAX_PAGES + 1):
        try:
            d = fetch(cursor)
        except urllib.error.HTTPError as e:
            print(f"page {page}: HTTP {e.code} {e.read()[:200]!r}")
            return 1
        row = []
        for it in d.get("items", []):
            if it.get("type") != "post" or not isinstance(it.get("post"), dict):
                kinds["unit:" + str(it.get("type"))] += 1
                continue
            p = it["post"]
            pid = p.get("id")
            kind = p.get("type") or p.get("kind") or "?"
            row.append(f"{pid}{'L' if kind == 'listing' else ''}")
            dups += pid in seen
            seen.add(pid)
            srcs[(it.get("meta") or {}).get("src")] += 1
            kinds[kind] += 1
            authors[p.get("user_id") or (p.get("author") or {}).get("id")] += 1
        sizes.append(len(row))
        print(f"page {page}: n={len(row)} caught_up={d.get('caught_up')} inventory={d.get('inventory')} "
              f"has_more={d.get('has_more')} actions={d.get('next_actions')}\n   ids={row}")
        cursor = d.get("next_cursor")
        if not d.get("has_more") or not cursor:
            ended = bool(d.get("caught_up"))
            break
    print(f"\nunique={len(seen)} dups={dups} sizes={sizes}")
    print("sources:", dict(srcs))
    print("kinds:", dict(kinds))
    print("top authors:", authors.most_common(4))
    fails = []
    if not sizes or sizes[0] == 0:
        fails.append("first page empty")
    if dups:
        fails.append("duplicates across pages")
    if not ended:
        fails.append("never reached caught_up")
    tiny = [n for n in sizes[:-1] if n < 5]
    if tiny:
        fails.append(f"{len(tiny)} tiny non-final page(s)")
    print("FAIL: " + "; ".join(fails) if fails else "PASS")
    return 1 if fails else 0


sys.exit(main())
