// Stores a PDF through storePdf() (src/server/files/store-pdf.ts) in a Node
// process with the react-server condition, which server modules need. Reads
// the file path on stdin and prints the new files row's ID. Started by
// tests/e2e/support/files.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { closeDb, withTransaction } from "@/server/db";
import { storePdf } from "@/server/files/store-pdf";

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { path } = JSON.parse(input) as { path: string };
  const row = await withTransaction((tx) =>
    storePdf(tx, {
      ownerType: "APPLICATION",
      ownerId: randomUUID(),
      kind: "CV",
      originalName: "Synthetic CV.pdf",
      bytes: new Uint8Array(readFileSync(path)),
    }),
  );
  process.stdout.write(row.id);
  await closeDb();
}

void main();
