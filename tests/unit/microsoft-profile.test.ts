// AU3: Entra profile mapping (tech-stack.md §4).
import { describe, expect, it } from "vitest";
import { MissingIdentityError, mapProfileToUser } from "@/server/auth/microsoft-profile";

describe("mapProfileToUser", () => {
  it("AU3: uses the email claim when present", () => {
    expect(mapProfileToUser({ email: "ada@example.com", preferred_username: "upn@tenant.onmicrosoft.com" }).email).toBe(
      "ada@example.com",
    );
  });

  it("AU3: falls back to preferred_username without an email claim", () => {
    expect(mapProfileToUser({ preferred_username: "upn@tenant.onmicrosoft.com" }).email).toBe("upn@tenant.onmicrosoft.com");
    expect(mapProfileToUser({ email: "  ", preferred_username: "upn@tenant.onmicrosoft.com" }).email).toBe(
      "upn@tenant.onmicrosoft.com",
    );
  });

  it("AU3: trims and lower-cases the email", () => {
    expect(mapProfileToUser({ preferred_username: " Admin@Tenant.OnMicrosoft.com " }).email).toBe(
      "admin@tenant.onmicrosoft.com",
    );
  });

  it("AU3: image is always null", () => {
    expect(mapProfileToUser({ email: "ada@example.com" })).toEqual({ email: "ada@example.com", image: null });
  });

  it("AU3: a profile with neither claim throws MissingIdentityError", () => {
    expect(() => mapProfileToUser({})).toThrow(MissingIdentityError);
    expect(() => mapProfileToUser({ email: null, preferred_username: "" })).toThrow(MissingIdentityError);
  });
});
