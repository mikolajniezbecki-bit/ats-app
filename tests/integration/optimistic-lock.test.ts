// Optimistic locking helper (tech-stack.md D7). These tests commit their
// rows, because the stale-version cases need two transactions on separate
// connections; every row is new, so tests don't see each other's data.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, withTransaction } from "@/server/db";
import {
  RecordNotFoundError,
  STALE_RECORD_MESSAGE,
  StaleRecordError,
  type VersionedChanges,
  updateWithVersion,
} from "@/server/db/optimistic-lock";
import { applications, offers, requisitions } from "@/server/db/schema";
import { insertApplication, insertRequisition, offerValues } from "./fixtures";
import { rolledBack } from "./helpers";

const newApplication = () => withTransaction((tx) => insertApplication(tx));
const newRequisition = () => withTransaction((tx) => insertRequisition(tx));

async function readApplication(id: string) {
  const [row] = await getDb().select().from(applications).where(eq(applications.id, id));
  return row;
}

/**
 * Starts a transaction that reads the row's version, then waits until
 * `proceed` resolves before updating with that version. Returns the
 * transaction's result and a promise that resolves once the read is done.
 */
function readThenUpdateLater(id: string, proceed: Promise<void>) {
  let markRead!: () => void;
  const read = new Promise<void>((resolve) => (markRead = resolve));
  const result = withTransaction(async (tx) => {
    const [row] = await tx.select({ version: applications.version }).from(applications).where(eq(applications.id, id));
    markRead();
    await proceed;
    return updateWithVersion(tx, applications, id, row.version, { status: "REJECTED", reasonCode: "OTHER" });
  });
  return { read, result };
}

describe("updateWithVersion", () => {
  it("D7: an update with the current version succeeds and increments version by 1", async () => {
    const application = await newApplication();

    const updated = await withTransaction((tx) =>
      updateWithVersion(tx, applications, application.id, 1, { status: "SCREENING" }),
    );

    expect(updated).toMatchObject({ id: application.id, status: "SCREENING", version: 2 });
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(application.updatedAt.getTime());
    expect(await readApplication(application.id)).toEqual(updated);
  });

  it("D7: an update with a stale version fails with the reload message and changes nothing", async () => {
    const application = await newApplication();
    await withTransaction((tx) => updateWithVersion(tx, applications, application.id, 1, { status: "SCREENING" }));
    const before = await readApplication(application.id);

    const outcome = withTransaction((tx) =>
      updateWithVersion(tx, applications, application.id, 1, { status: "INTERVIEW" }),
    );

    await expect(outcome).rejects.toThrow(new StaleRecordError());
    await expect(outcome).rejects.toThrow("This record was changed by someone else. Reload and try again.");
    expect(STALE_RECORD_MESSAGE).toBe("This record was changed by someone else. Reload and try again.");
    expect(await readApplication(application.id)).toEqual(before);
  });

  it("D7: of two transactions that read version 1, the second to update fails after the first commits", async () => {
    const application = await newApplication();
    let firstCommitted!: () => void;
    const second = readThenUpdateLater(application.id, new Promise<void>((resolve) => (firstCommitted = resolve)));
    await second.read;

    const first = await withTransaction((tx) =>
      updateWithVersion(tx, applications, application.id, 1, { status: "SCREENING" }),
    );
    firstCommitted();

    await expect(second.result).rejects.toThrow(STALE_RECORD_MESSAGE);
    expect(first.version).toBe(2);
    expect(await readApplication(application.id)).toMatchObject({ status: "SCREENING", reasonCode: null, version: 2 });
  });

  it("D7: requisitions use the same locking", async () => {
    const requisition = await newRequisition();

    const updated = await withTransaction((tx) =>
      updateWithVersion(tx, requisitions, requisition.id, 1, { title: "Senior Backend Engineer" }),
    );
    expect(updated).toMatchObject({ title: "Senior Backend Engineer", version: 2 });

    await expect(
      withTransaction((tx) => updateWithVersion(tx, requisitions, requisition.id, 1, { title: "Stale title" })),
    ).rejects.toThrow(STALE_RECORD_MESSAGE);
    const [row] = await getDb().select().from(requisitions).where(eq(requisitions.id, requisition.id));
    expect(row).toEqual(updated);
  });

  it("D7: offers use the same locking", async () => {
    const offer = await withTransaction(async (tx) => (await tx.insert(offers).values(await offerValues(tx)).returning())[0]);

    const updated = await withTransaction((tx) => updateWithVersion(tx, offers, offer.id, 1, { salary: "12000.00" }));
    expect(updated).toMatchObject({ salary: "12000.00", version: 2 });
    await expect(
      withTransaction((tx) => updateWithVersion(tx, offers, offer.id, 1, { salary: "9000.00" })),
    ).rejects.toThrow(STALE_RECORD_MESSAGE);
  });

  it("D7: an update in a rolled-back transaction leaves version unchanged", async () => {
    const application = await newApplication();

    await rolledBack(async (tx) => {
      const updated = await updateWithVersion(tx, applications, application.id, 1, { status: "SCREENING" });
      expect(updated.version).toBe(2);
    });

    expect(await readApplication(application.id)).toEqual(application);
  });

  it("throws a not-found error, not the stale-record message, for an unknown id", async () => {
    const outcome = withTransaction((tx) =>
      updateWithVersion(tx, applications, crypto.randomUUID(), 1, { status: "SCREENING" }),
    );

    await expect(outcome).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(outcome).rejects.not.toThrow(STALE_RECORD_MESSAGE);
  });

  it("refuses changes that set version or the other managed columns", async () => {
    // @ts-expect-error callers can't set version; the helper increments it.
    const typed: VersionedChanges<typeof applications> = { version: 7 };
    const application = await newApplication();

    for (const changes of [typed, { id: crypto.randomUUID() }, { updatedAt: new Date() }]) {
      await expect(
        withTransaction((tx) => updateWithVersion(tx, applications, application.id, 1, changes as never)),
      ).rejects.toThrow(/sets .* itself/);
    }
    expect(await readApplication(application.id)).toEqual(application);
  });
});
