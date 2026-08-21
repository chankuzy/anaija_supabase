#!/usr/bin/env bash
set -euo pipefail

BASE_URL="https://eqwcndxdbfljsjxsduid.supabase.co/functions/v1"
EMAIL="viewer@anaija.dev"

echo "── Inspecting dev-login source to confirm expected request shape ──"
cat ~/anaija/anaija_supabase/supabase/functions/dev-login/index.ts
echo ""
echo "─────────────────────────────────────────────────────────────────"
echo ""

try_login() {
  local password="$1"
  curl -s -X POST "$BASE_URL/dev-login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$password\"}"
}

echo "── Attempt 1: password ──────────────────────────────────"
RESP=$(try_login "TestPass123!")
echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"

if echo "$RESP" | grep -qi '"token"\|"access_token"\|"jwt"'; then
  LOGIN_RESPONSE="$RESP"
else
  echo ""
  echo "── Attempt 2: TestPass123! ───────────────────────────────"
  RESP=$(true && echo "skipped")
  echo "$RESP" | python3 -m json.tool 2>/dev/null || echo "$RESP"
  LOGIN_RESPONSE="$RESP"
fi

TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "
import sys, json
def find_token(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ('token', 'access_token', 'accessToken', 'jwt') and isinstance(v, str):
                return v
            found = find_token(v)
            if found:
                return found
    elif isinstance(obj, list):
        for item in obj:
            found = find_token(item)
            if found:
                return found
    return None
try:
    data = json.load(sys.stdin)
    tok = find_token(data)
    print(tok if tok else '')
except Exception:
    print('')
")

if [ -z "$TOKEN" ]; then
  echo ""
  echo "!!! Neither password nor TestPass123! worked."
  echo "!!! The dev-login source printed above shows exactly what field(s)"
  echo "!!! it actually expects (it may not even want a password at all —"
  echo "!!! many dev-login endpoints just take a user_id or username)."
  echo "!!! Paste that source back and I'll give you the exact working"
  echo "!!! curl command or the correct SQL to create a matching user."
  exit 1
fi

echo ""
echo "── Token acquired (first 20 chars): ${TOKEN:0:20}... ─────"
echo ""
echo "── BASELINE (current deployed feedService.ts) ──────────"
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "  attempt $i: %{time_total}s (http %{http_code})\n" \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL/feed"
done

echo ""
echo "── Deploying updated functions ──────────────────────────"
cd ~/anaija/anaija_supabase
npx supabase functions deploy feed --use-api --use-api
npx supabase functions deploy marketplace-index --use-api --use-api
npx supabase functions deploy stories-index --use-api --use-api

echo ""
echo "── AFTER (public-URL feedService.ts) ────────────────────"
for i in 1 2 3 4; do
  curl -s -o /dev/null -w "  attempt $i: %{time_total}s (http %{http_code})\n" \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE_URL/feed"
done
