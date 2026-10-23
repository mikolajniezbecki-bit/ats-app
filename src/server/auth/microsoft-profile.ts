// Entra ID profile mapping (tech-stack.md AU3). Pure, with no framework
// imports, so it is unit-tested on its own; auth.ts plugs it into Better
// Auth's Microsoft provider.

/** The ID-token claims the mapping reads; Entra sends many more. */
export type MicrosoftProfile = {
  email?: string | null;
  preferred_username?: string | null;
};

export type MappedMicrosoftUser = { email: string; image: null };

/** Thrown for a profile with neither `email` nor `preferred_username`; refused like an unknown user (AU2). */
export class MissingIdentityError extends Error {
  override name = "MissingIdentityError";
  constructor() {
    super("The Entra profile has neither an email nor a preferred_username claim.");
  }
}

/**
 * AU3: the email comes from the `email` claim, or the user principal name
 * (`preferred_username`) for users without a mailbox, trimmed and lower-cased
 * to match `users.email`. `image` is always null: Microsoft photos are large
 * base64 strings and the ATS doesn't show them. Name and role are never taken
 * from the profile; the Admin maintains them.
 */
export function mapProfileToUser(profile: MicrosoftProfile): MappedMicrosoftUser {
  const email = (nonBlank(profile.email) ?? nonBlank(profile.preferred_username))?.toLowerCase();
  if (!email) throw new MissingIdentityError();
  return { email, image: null };
}

function nonBlank(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? undefined : trimmed;
}
