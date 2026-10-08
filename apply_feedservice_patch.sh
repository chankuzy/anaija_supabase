#!/usr/bin/env bash
# Run from anaija_supabase/. Replaces getStoriesForUser (the LAST function in
# feedService.ts) with the version that returns likes_count / is_liked.
set -euo pipefail
cd supabase/functions/_shared/services
n=$(grep -n "^export async function getStoriesForUser" feedService.ts | cut -d: -f1)
[ -n "$n" ] || { echo "getStoriesForUser not found"; exit 1; }
cp feedService.ts feedService.ts.bak
head -n $((n-1)) feedService.ts.bak > feedService.ts
cat getStoriesForUser.new.ts >> feedService.ts
rm getStoriesForUser.new.ts
echo "patched feedService.ts (backup: feedService.ts.bak)"