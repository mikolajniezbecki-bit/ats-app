#!/usr/bin/env bash
# Starts a Container Apps job in $RESOURCE_GROUP and waits for that execution
# to finish (infra.yml: the db-migrate job after a full deployment). Uses the
# ARM API through `az rest`, so no Azure CLI extension is needed.
#
#   RESOURCE_GROUP=rg-ats-demo bash infra/run-job.sh <job name> [timeout seconds]
#
# A status read that fails with a server error (5xx) is retried, up to
# RUN_JOB_MAX_POLL_ERRORS in a row: infra run #26 failed on one transient
# InternalServerError while db-migrate was running. The start itself is not
# retried, because a start that did go through would then run the job twice.
set -euo pipefail

job="${1:?Usage: run-job.sh <job name> [timeout seconds]}"
timeout="${2:-900}"
api="api-version=2024-03-01"
poll_seconds="${RUN_JOB_POLL_SECONDS:-15}"
max_poll_errors="${RUN_JOB_MAX_POLL_ERRORS:-8}"
# How az rest reports a 5xx: the HTTP reason phrase, the ARM error code, or the status.
server_error='Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|InternalServerError|BadGateway|ServiceUnavailable|GatewayTimeout|ServerTimeout|\(5[0-9]{2}\)'

err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT

job_id="$(az resource show -g "$RESOURCE_GROUP" --resource-type Microsoft.App/jobs -n "$job" --query id -o tsv)"
execution="$(az rest --method post --url "https://management.azure.com${job_id}/start?${api}" --query name -o tsv)"
echo "Started $job, execution $execution."

deadline=$((SECONDS + timeout))
poll_errors=0
while true; do
  if ! status="$(az rest --method get --url "https://management.azure.com${job_id}/executions/${execution}?${api}" \
    --query properties.status -o tsv 2> "$err_file")"; then
    poll_errors=$((poll_errors + 1))
    cat "$err_file" >&2
    if ! grep -qE "$server_error" "$err_file"; then
      echo "::error::Couldn't read the status of $job execution $execution."
      exit 1
    fi
    if [ "$poll_errors" -ge "$max_poll_errors" ]; then
      echo "::error::Reading the status of $job execution $execution failed with a server error $poll_errors times in a row."
      exit 1
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::error::$job execution $execution: no status after ${timeout} s."
      exit 1
    fi
    echo "::warning::Azure server error while reading the status of $execution ($poll_errors of $max_poll_errors in a row); retrying."
    sleep "$poll_seconds"
    continue
  fi
  poll_errors=0
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
  sleep "$poll_seconds"
done
