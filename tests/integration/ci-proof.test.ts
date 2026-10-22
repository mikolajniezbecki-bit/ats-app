import { expect, it } from "vitest";

// Temporary: proves a failing integration test turns ci.yml red (#9). Reverted next.
it("deliberately fails", () => {
  expect(1).toBe(2);
});
