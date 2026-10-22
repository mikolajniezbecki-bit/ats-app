// `pnpm worker`: the standalone worker entry point (W2). It always registers
// the handlers, whatever WORKER_ENABLED says (that flag applies only to the
// web process), runs pg-boss maintenance and doesn't start Next.js. Not
// deployed: the web process runs the worker (tech-stack.md §3 rule 8).
import { ensureJobQueues, startJobQueue } from "../server/adapters/job-queue";
import { getConfig } from "../server/config";
import { handlers } from "./handlers";
import { logStartupError, onShutdownSignal } from "./startup";
import { shutdown, startWorker } from "./worker";

async function main(): Promise<void> {
  try {
    getConfig();
    await startJobQueue({ supervise: true });
    await ensureJobQueues();
    await startWorker(handlers);
  } catch (err) {
    logStartupError(err);
    process.exit(1);
  }
  onShutdownSignal(() => shutdown());
}

void main();
