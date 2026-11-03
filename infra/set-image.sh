#!/usr/bin/env bash
# Sets the image of one Container App or Container Apps job in $RESOURCE_GROUP
# and changes nothing else (main.yml deploy job; tech-stack.md §12, G2; task 45).
# Plain ARM through `az rest`, so no Azure CLI extension is needed.
#
#   RESOURCE_GROUP=rg-ats-demo bash infra/set-image.sh app|job <name> <image> [timeout seconds]
#
# - Sends a PATCH with the current template, only containers[0].image replaced.
#   The configuration (secrets, registries, ingress, the job trigger) is not
#   sent, so a tick schedule stopped for G10 stays stopped.
# - Compares the environment variable names, the secret names, the registry
#   settings and the job trigger before and after, and fails on any
#   difference. Only names are compared and printed, never values.
# - app: waits until the newest revision is the newest ready one and runs the
#   new image. In single revision mode the previous revision keeps serving
#   until then. The revision name goes to $GITHUB_OUTPUT as `revision`.
# - Running it again with the image already set changes nothing and only
#   checks the state, so a rerun after a transient failure is safe.
set -euo pipefail

kind="${1:?Usage: set-image.sh app|job <name> <image> [timeout seconds]}"
name="${2:?Usage: set-image.sh app|job <name> <image> [timeout seconds]}"
image="${3:?Usage: set-image.sh app|job <name> <image> [timeout seconds]}"
timeout="${4:-600}"
api="api-version=2024-03-01"
poll_seconds="${SET_IMAGE_POLL_SECONDS:-15}"
max_read_errors="${SET_IMAGE_MAX_READ_ERRORS:-8}"

case "$kind" in
  app) type="Microsoft.App/containerApps" ;;
  job) type="Microsoft.App/jobs" ;;
  *) echo "::error::set-image.sh: the kind must be app or job, not $kind." >&2; exit 2 ;;
esac

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Names only: secret values never appear in a GET, but env values are left
# out too, so nothing but names reaches the log.
settings='{
  env: [.properties.template.containers[] | {container: .name, names: [(.env // [])[].name]}],
  secrets: [(.properties.configuration.secrets // [])[].name],
  registries: (.properties.configuration.registries // []),
  trigger: (.properties.configuration | {triggerType, scheduleTriggerConfig, manualTriggerConfig})
}'

id="$(az resource show -g "$RESOURCE_GROUP" --resource-type "$type" -n "$name" --query id -o tsv)"
url="https://management.azure.com${id}?${api}"

az rest --method get --url "$url" > "$tmp/before.json"
containers="$(jq '.properties.template.containers | length' "$tmp/before.json")"
if [ "$containers" != "1" ]; then
  echo "::error::$name has $containers containers; set-image.sh expects exactly one."
  exit 1
fi
current="$(jq -r '.properties.template.containers[0].image' "$tmp/before.json")"
previous_revision="$(jq -r '.properties.latestRevisionName // ""' "$tmp/before.json")"

if [ "$current" = "$image" ]; then
  echo "$name already runs $image; checking its state only."
else
  echo "$name: $current -> $image"
  # revisionSuffix is dropped: reusing the current one would be refused.
  jq --arg image "$image" \
    '{properties: {template: (.properties.template | del(.revisionSuffix) | .containers[0].image = $image)}}' \
    "$tmp/before.json" > "$tmp/patch.json"
  az rest --method patch --url "$url" --body @"$tmp/patch.json" --output none
fi

deadline=$((SECONDS + timeout))
read_errors=0
latest=""
while true; do
  if ! az rest --method get --url "$url" > "$tmp/after.json" 2> "$tmp/err"; then
    read_errors=$((read_errors + 1))
    cat "$tmp/err" >&2
    if [ "$read_errors" -ge "$max_read_errors" ]; then
      echo "::error::Reading $name failed $read_errors times in a row."
      exit 1
    fi
  else
    read_errors=0
    state="$(jq -r '.properties.provisioningState // ""' "$tmp/after.json")"
    running="$(jq -r '.properties.template.containers[0].image' "$tmp/after.json")"
    case "$state" in
      Failed | Canceled)
        echo "::error::$name: provisioning $state while setting $image."
        [ "$kind" = app ] && echo "::error::The previous revision ${previous_revision:-?} keeps serving (single revision mode)."
        exit 1
        ;;
    esac
    if [ "$state" = "Succeeded" ] && [ "$running" = "$image" ]; then
      if [ "$kind" = job ]; then
        break
      fi
      latest="$(jq -r '.properties.latestRevisionName // ""' "$tmp/after.json")"
      ready="$(jq -r '.properties.latestReadyRevisionName // ""' "$tmp/after.json")"
      if [ -n "$latest" ] && [ "$latest" = "$ready" ]; then
        revision_image="$(az rest --method get --url "https://management.azure.com${id}/revisions/${latest}?${api}" \
          --query "properties.template.containers[0].image" -o tsv)"
        [ "$revision_image" = "$image" ] && break
      fi
    fi
    echo "$name: provisioning ${state:-unknown}${latest:+, newest revision $latest}, waiting."
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    if [ "$kind" = app ]; then
      echo "::error::$name: revision ${latest:-(none yet)} with $image isn't ready after ${timeout} s; the previous revision keeps serving (single revision mode)."
    else
      echo "::error::$name: $image not in place after ${timeout} s."
    fi
    exit 1
  fi
  sleep "$poll_seconds"
done

jq -S "$settings" "$tmp/before.json" > "$tmp/settings-before.json"
jq -S "$settings" "$tmp/after.json" > "$tmp/settings-after.json"
if ! diff -u "$tmp/settings-before.json" "$tmp/settings-after.json" > "$tmp/settings.diff"; then
  cat "$tmp/settings.diff"
  echo "::error::$name: the environment variable names, secret names, registries or trigger changed; only the image may change."
  exit 1
fi

if [ "$kind" = app ]; then
  echo "$name: revision $latest is ready and runs $image."
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "revision=$latest" >> "$GITHUB_OUTPUT"
else
  echo "$name: runs $image."
fi
