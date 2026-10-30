#!/usr/bin/env bash
# Starts a Container Apps job in $RESOURCE_GROUP and waits for that execution
# to finish (infra.yml: the db-migrate job after a full deployment). Uses the
# ARM API through `az rest`, so no Azure CLI extension is needed.
#
#   RESOURCE_GROUP=rg-ats-demo bash infra/run-job.sh <job name> [timeout seconds]
set -euo pipefail

job="${1:?Usage: run-job.sh <job name> [timeout seconds]}"
timeout="${2:-900}"
api="api-version=2024-03-01"

job_id="$(az resource show -g "$RESOURCE_GROUP" --resource-type Microsoft.App/jobs -n "$job" --query id -o tsv)"
execution="$(az rest --method post --url "https://management.azure.com${job_id}/start?${api}" --query name -o tsv)"
echo "Started $job, execution $execution."

deadline=$((SECONDS + timeout))
while true; do
  status="$(az rest --method get --url "https://management.azure.com${job_id}/executions/${execution}?${api}" \
    --query properties.status -o tsv)"
  case "$status" in
    Succeeded)
      echo "$execution: Succeeded."
      exit 0
      ;;
    Failed | Stopped | Degraded)
      echo "::error::$job execution $execution ended with status $status. Its logs are in Log Analytics (ContainerAppConsoleLogs_CL)."
      exit 1
      ;;
  esac
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "::error::$job execution $execution still $status after ${timeout} s."
    exit 1
  fi
  echo "$execution: ${status:-unknown}, waiting."
  sleep 15
done
