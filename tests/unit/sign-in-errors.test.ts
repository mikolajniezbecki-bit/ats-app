// AU2: /sign-in?error=<code> maps to a fixed text, never the code itself.
import { describe, expect, it } from "vitest";
import { signInErrorKey } from "@/server/auth/sign-in-errors";

describe("signInErrorKey", () => {
  it("AU2: sign-up refused, the inactive-user hook and a missing identity show the access message", () => {
    for (const code of ["signup_disabled", "ACCESS_NOT_GRANTED", "email_not_found"]) {
      expect(signInErrorKey(code), code).toBe("accessNotGranted");
    }
  });

  it("any other value shows the generic failure", () => {
    for (const code of ["invalid_code", "<script>", "Signup_Disabled"]) expect(signInErrorKey(code), code).toBe("failed");
    expect(signInErrorKey(["signup_disabled", "x"])).toBe("failed");
  });

  it("no error shows nothing", () => {
    expect(signInErrorKey(undefined)).toBeNull();
    expect(signInErrorKey("")).toBeNull();
  });
});
