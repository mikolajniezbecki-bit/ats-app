#!/usr/bin/env bash
# Deploy smoke test (main.yml deploy job; tech-stack.md §12, M5; task 45).
#
#   RESOURCE_GROUP=rg-ats-demo bash infra/smoke-test.sh <web app name> <app URL> <image>
#
# 1. GET <app URL>/api/health must return 200 with status, database and
#    storage all "ok". It retries for up to 5 minutes, because the first
#    request also wakes a scaled-to-zero app (M5).
# 2. Then ARM must show exactly one active revision, with 100 % of the
#    traffic, running <image>. /api/health doesn't report a version, so this
#    is what shows the new image is the one serving.
set -euo pipefail

name="${1:?Usage: smoke-test.sh <web app name> <app URL> <image>}"
app_url="${2:?Usage: smoke-test.sh <web app name> <app URL> <image>}"
image="${3:?Usage: smoke-test.sh <web app name> <app URL> <image>}"
attempts="${SMOKE_TEST_ATTEMPTS:-30}"
wait_seconds="${SMOKE_TEST_WAIT_SECONDS:-10}"
api="api-version=2024-03-01"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

health="${app_url%/}/api/health"
healthy=false
for attempt in $(seq 1 "$attempts"); do
  code="$(curl -s -o "$tmp/health.json" -w '%{http_code}' --max-time 10 "$health" || true)"
  if [ "$code" = "200" ] && jq -e '.status == "ok" and .database == "ok" and .storage == "ok"' "$tmp/health.json" > /dev/null 2>&1; then
    echo "GET $health: 200 $(jq -c . "$tmp/health.json")"
    healthy=true
    break
  fi
  echo "Attempt $attempt: GET $health returned ${code:-no response}"
  [ "$attempt" -eq "$attempts" ] || sleep "$wait_seconds"
done
if [ "$healthy" != true ]; then
  echo "::error::$health did not return 200 with everything ok within $((attempts * wait_seconds)) s."
  exit 1
fi

id="$(az resource show -g "$RESOURCE_GROUP" --resource-type Microsoft.App/containerApps -n "$name" --query id -o tsv)"
# The revisions list is paged (nextLink), and az rest returns one page at a time.
next="https://management.azure.com${id}/revisions?${api}"
echo "[]" > "$tmp/active.json"
while [ -n "$next" ]; do
  az rest --method get --url "$next" > "$tmp/page.json"
  jq -s '.[0] + [.[1].value[] | select(.properties.active == true)
    | {name, traffic: (.properties.trafficWeight // 0), image: .properties.template.containers[0].image}]' \
    "$tmp/active.json" "$tmp/page.json" > "$tmp/merged.json"
  mv "$tmp/merged.json" "$tmp/active.json"
  next="$(jq -r '.nextLink // ""' "$tmp/page.json")"
done

count="$(jq 'length' "$tmp/active.json")"
if [ "$count" != "1" ]; then
  echo "::error::$name has $count active revisions; expected exactly one: $(jq -c '[.[] | {name, traffic}]' "$tmp/active.json")"
  exit 1
fi
revision="$(jq -r '.[0].name' "$tmp/active.json")"
traffic="$(jq -r '.[0].traffic' "$tmp/active.json")"
running="$(jq -r '.[0].image' "$tmp/active.json")"
if [ "$traffic" != "100" ] || [ "$running" != "$image" ]; then
  echo "::error::The active revision $revision has ${traffic} % of the traffic and runs $running; expected 100 % and $image."
  exit 1
fi
echo "Active revision $revision: 100 % of the traffic, $image."
