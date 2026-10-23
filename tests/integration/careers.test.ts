// Public career queries against the database (ats-project-scope.md §5.2
// Postings, §5.3 Job board, Accepting applications). The worker database is
// shared by this file's tests, so assertions look at the rows each test made.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Tx } from "@/server/db";
import { masterData } from "@/server/db/schema";
import { boardFilterOptions, findExternalJob, findPrivateJob, listPublicJobs, sitemapJobIds } from "@/server/careers";
import { insertRequisition } from "./fixtures";
import { rolledBack } from "./helpers";

const word = () => `w${randomUUID().replaceAll("-", "").slice(0, 10)}`;
const live = { state: "APPROVED" as const, approvedAt: new Date(), isPublished: true };
const ids = async (tx: Tx, q: string, extra: { location?: string; department?: string } = {}) =>
  (await listPublicJobs({ q, page: 1, ...extra }, tx)).jobs.map((job) => job.id);

async function location(tx: Tx, isActive = true) {
  const [row] = await tx.insert(masterData).values({ type: "LOCATION", code: `L-${randomUUID()}`.toUpperCase(), label: "Gdańsk", isActive }).returning();
  return row;
}

describe("job board", () => {
  it("lists only external published requisitions, including one in re-approval", async () => {
    await rolledBack(async (tx) => {
      const tag = word();
      const external = await insertRequisition(tx, { ...live, title: `Engineer ${tag}` });
      const unpublished = await insertRequisition(tx, { ...live, isPublished: false, state: "ON_HOLD", title: `Engineer ${tag}` });
      const privatePosting = await insertRequisition(tx, { ...live, postingType: "PRIVATE", privateSlug: randomUUID().replaceAll("-", ""), title: `Engineer ${tag}` });
      const draft = await insertRequisition(tx, { title: `Engineer ${tag}` });
      const reapproval = await insertRequisition(tx, { ...live, state: "PENDING_APPROVAL", title: `Engineer ${tag}` });
      const listed = await ids(tx, tag);
      expect(listed.sort()).toEqual([external.id, reapproval.id].sort());
      expect(listed).not.toContain(unpublished.id);
      expect(listed).not.toContain(privatePosting.id);
      expect(listed).not.toContain(draft.id);
      const sitemap = await sitemapJobIds(tx);
      expect(sitemap).toContain(external.id);
      expect(sitemap).not.toContain(privatePosting.id);
    });
  });

  it("every keyword must match the title or the description text, case-insensitively", async () => {
    await rolledBack(async (tx) => {
      const tag = word();
      const inDescription = await insertRequisition(tx, { ...live, title: "Data Analyst", descriptionHtml: `<p>Work with <strong>${tag}</strong> pipelines.</p>` });
      const inTitle = await insertRequisition(tx, { ...live, title: `Senior ${tag.toUpperCase()} lead`, descriptionHtml: "<p>Nothing</p>" });
      expect((await ids(tx, tag)).sort()).toEqual([inDescription.id, inTitle.id].sort());
      expect(await ids(tx, `${tag} pipelines`)).toEqual([inDescription.id]);
      expect(await ids(tx, `${tag} missingword${word()}`)).toEqual([]);
      // Tags are stripped: an attribute or tag name doesn't match.
      expect(await ids(tx, `strong ${tag}`)).toEqual([]);
    });
  });

  it("% and _ in the search match literally", async () => {
    await rolledBack(async (tx) => {
      const tag = word();
      const percent = await insertRequisition(tx, { ...live, title: `${tag} 50% remote` });
      await insertRequisition(tx, { ...live, title: `${tag} 500 remote` });
      expect(await ids(tx, `${tag} 50%`)).toEqual([percent.id]);
      expect(await ids(tx, `${tag} 5_0`)).toEqual([]);
    });
  });

  it("the location filter narrows the list; a deactivated location still in use is offered and works", async () => {
    await rolledBack(async (tx) => {
      const tag = word();
      const gone = await location(tx, false);
      const there = await insertRequisition(tx, { ...live, title: tag, locationId: gone.id });
      const elsewhere = await insertRequisition(tx, { ...live, title: tag });
      expect((await ids(tx, tag)).sort()).toEqual([there.id, elsewhere.id].sort());
      expect(await ids(tx, tag, { location: gone.code })).toEqual([there.id]);
      expect((await boardFilterOptions(tx)).locations).toContainEqual({ code: gone.code, label: "Gdańsk" });
      expect(await ids(tx, tag, { location: "UNKNOWN_CODE" })).toEqual([]);
      expect(await ids(tx, tag, { department: "UNKNOWN_CODE" })).toEqual([]);
    });
  });

  it("a location used only by unlisted requisitions isn't offered", async () => {
    await rolledBack(async (tx) => {
      const hidden = await location(tx);
      await insertRequisition(tx, { title: word(), locationId: hidden.id });
      expect((await boardFilterOptions(tx)).locations.map((option) => option.code)).not.toContain(hidden.code);
    });
  });
});

describe("job pages", () => {
  it("/jobs/{id} serves External requisitions approved at least once; others are not found", async () => {
    await rolledBack(async (tx) => {
      const published = await insertRequisition(tx, live);
      const onHold = await insertRequisition(tx, { ...live, state: "ON_HOLD", isPublished: false });
      const draft = await insertRequisition(tx);
      const firstApproval = await insertRequisition(tx, { state: "PENDING_APPROVAL" });
      const privatePosting = await insertRequisition(tx, { ...live, postingType: "PRIVATE", privateSlug: randomUUID().replaceAll("-", "") });
      expect(await findExternalJob(published.id, tx)).toMatchObject({ id: published.id, isPublished: true });
      expect(await findExternalJob(onHold.id, tx)).toMatchObject({ isPublished: false });
      for (const id of [draft.id, firstApproval.id, privatePosting.id, randomUUID(), "not-a-uuid"]) {
        expect(await findExternalJob(id, tx), id).toBeUndefined();
      }
    });
  });

  it("/jobs/p/{slug} serves Private requisitions only; a slug kept after switching to External is not found", async () => {
    await rolledBack(async (tx) => {
      const slug = randomUUID().replaceAll("-", "");
      const privatePosting = await insertRequisition(tx, { ...live, postingType: "PRIVATE", privateSlug: slug });
      expect(await findPrivateJob(slug, tx)).toMatchObject({ id: privatePosting.id });
      const switched = randomUUID().replaceAll("-", "");
      await insertRequisition(tx, { ...live, postingType: "EXTERNAL", privateSlug: switched });
      expect(await findPrivateJob(switched, tx)).toBeUndefined();
      expect(await findPrivateJob("not-a-slug", tx)).toBeUndefined();
    });
  });

  it("the public row holds public fields only", async () => {
    await rolledBack(async (tx) => {
      const published = await insertRequisition(tx, live);
      expect(Object.keys((await findExternalJob(published.id, tx))!).sort()).toEqual(["department", "descriptionHtml", "id", "isPublished", "location", "title"]);
    });
  });
});
