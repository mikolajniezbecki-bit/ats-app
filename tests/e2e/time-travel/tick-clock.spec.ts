// Smoke test of the time-travel project (T2, T3): a tick with x-test-now on
// a date reserved for this spec. It asserts that the rows exist, not that
// this tick queued them, so a rerun against the same database passes.
import { expect, test } from "@playwright/test";
import { query } from "../support/db";
import { E2E_TICK_SECRET } from "../support/env";

const RESERVED_DATE = "2040-01-02";

test("T3: a tick with x-test-now runs the daily tasks for that date", async ({ request }) => {
  const response = await request.post("/api/internal/tick", {
    headers: { "x-tick-secret": E2E_TICK_SECRET, "x-test-now": `${RESERVED_DATE}T09:00:00Z` },
    timeout: 200_000,
  });
  expect(response.status()).toBe(200);

  const rows = await query<{ job_name: string }>(
    "SELECT job_name FROM job_runs WHERE run_date = $1 ORDER BY job_name",
    [RESERVED_DATE],
  );
  expect(rows.map((row) => row.job_name)).toEqual(["approvals.remind", "retention.purge"]);
});
