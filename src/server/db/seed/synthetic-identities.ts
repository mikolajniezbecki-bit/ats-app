// Synthetic candidates for the demo data (ats-project-scope.md C3; task 42
// Q5): fixed first names, last names that are obviously not real, RFC 2606
// email domains and `+00` phone numbers (no real country code, valid for
// §7). Pure, so a unit test checks every identity the seed can create.

export const SYNTHETIC_FIRST_NAMES = ["Ada", "Bruno", "Celina", "Dawid", "Ewa", "Filip", "Greta", "Henryk", "Iga", "Jonas", "Kira", "Leon"] as const;
export const SYNTHETIC_LAST_NAMES = ["Sample", "Example", "Placeholder", "Testcase", "Demo"] as const;
export const SYNTHETIC_EMAIL_DOMAINS = ["example.com", "example.org", "example.net"] as const;

export type SyntheticCandidate = { firstName: string; lastName: string; email: string; phone: string };

/** Candidate `n` (0-based): deterministic, so reruns on a fresh database look the same. */
export function syntheticCandidate(n: number): SyntheticCandidate {
  const firstName = SYNTHETIC_FIRST_NAMES[n % SYNTHETIC_FIRST_NAMES.length];
  const lastName = SYNTHETIC_LAST_NAMES[n % SYNTHETIC_LAST_NAMES.length];
  const domain = SYNTHETIC_EMAIL_DOMAINS[n % SYNTHETIC_EMAIL_DOMAINS.length];
  const nn = String(n + 1).padStart(2, "0");
  return {
    firstName,
    lastName,
    email: `${firstName}.${lastName}.${nn}@${domain}`.toLowerCase(),
    phone: `+00 000 000 0${nn}`,
  };
}

/** The text every generated PDF carries on its first page. */
export const SYNTHETIC_PDF_NOTICE = "Synthetic demo data, not a real person";
