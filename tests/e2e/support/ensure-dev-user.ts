// Runs ensureDevUser() (src/server/auth/dev-users.ts) in a Node process with
// the react-server condition, which server modules need. Reads the user as
// JSON on stdin (so the password never appears in a process list) and prints
// the user ID. Started by tests/e2e/support/users.ts.
import { ensureDevUser } from "@/server/auth/dev-users";
import { closeDb } from "@/server/db";

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const id = await ensureDevUser(JSON.parse(input));
  process.stdout.write(id);
  await closeDb();
}

void main();
