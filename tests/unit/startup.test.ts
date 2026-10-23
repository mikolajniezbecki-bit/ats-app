// Web-process start-up (W1) with the configuration, job queue and worker
// mocked: no database, so it runs in `pnpm verify`.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  startJobQueue: vi.fn(),
  ensureJobQueues: vi.fn(),
  workQueues: vi.fn(),
  ensureContainer: vi.fn(),
}));

vi.mock("@/server/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/config")>()),
  getConfig: mocks.getConfig,
}));

vi.mock("@/server/adapters/job-queue", () => ({
  startJobQueue: mocks.startJobQueue,
  ensureJobQueues: mocks.ensureJobQueues,
  workQueues: mocks.workQueues,
  stopJobQueue: vi.fn(),
}));

vi.mock("@/server/adapters/storage", () => ({
  getStorage: () => ({ ensureContainer: mocks.ensureContainer }),
}));

const { register } = await import("@/instrumentation");
const { ensureFilesContainer, startWebProcess } = await import("@/worker/startup");

function config(workerEnabled: boolean) {
  return { workerEnabled };
}

describe("web process start-up", () => {
  beforeEach(() => {
    mocks.getConfig.mockReturnValue(config(true));
    mocks.startJobQueue.mockResolvedValue(undefined);
    mocks.ensureJobQueues.mockResolvedValue(undefined);
    mocks.workQueues.mockImplementation(async (handlers: object) => Object.keys(handlers));
    mocks.ensureContainer.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("W1: does nothing on the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    await register();
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.startJobQueue).not.toHaveBeenCalled();
  });

  it("W1: does not read the configuration during the production build", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    expect(mocks.getConfig).not.toHaveBeenCalled();
    expect(mocks.startJobQueue).not.toHaveBeenCalled();
  });

  it("W1: with WORKER_ENABLED=false ensures the queues and registers no handler", async () => {
    mocks.getConfig.mockReturnValue(config(false));
    await startWebProcess();
    expect(mocks.startJobQueue).toHaveBeenCalledWith({ supervise: false });
    expect(mocks.ensureJobQueues).toHaveBeenCalledOnce();
    expect(mocks.workQueues).not.toHaveBeenCalled();
  });

  it("W1: with WORKER_ENABLED=true registers the handlers and runs maintenance", async () => {
    await startWebProcess();
    expect(mocks.startJobQueue).toHaveBeenCalledWith({ supervise: true });
    expect(mocks.ensureJobQueues).toHaveBeenCalledOnce();
    expect(mocks.workQueues).toHaveBeenCalledOnce();
    expect(mocks.ensureJobQueues.mock.invocationCallOrder[0]).toBeLessThan(mocks.workQueues.mock.invocationCallOrder[0]);
  });

  it("W1: fails when getConfig() throws, before pg-boss starts", async () => {
    const { ConfigError } = await import("@/server/config");
    mocks.getConfig.mockImplementation(() => {
      throw new ConfigError("Invalid configuration: missing DATABASE_URL.");
    });
    await expect(startWebProcess()).rejects.toThrow("DATABASE_URL");
    expect(mocks.startJobQueue).not.toHaveBeenCalled();
    expect(mocks.ensureJobQueues).not.toHaveBeenCalled();
  });

  it("W1: register() starts once per process and exits 1 when start-up fails", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    mocks.ensureJobQueues.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const global = globalThis as { __atsStartup?: Promise<void> };
    try {
      await register();
      await register();
      expect(mocks.getConfig).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      delete global.__atsStartup;
    }
  });

  it("ensures the files container at start-up", async () => {
    await startWebProcess();
    expect(mocks.ensureContainer).toHaveBeenCalledOnce();
  });

  it("retries the files container and then gives up without failing start-up", async () => {
    mocks.ensureContainer.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    await expect(ensureFilesContainer(3, 1)).resolves.toBeUndefined();
    expect(mocks.ensureContainer).toHaveBeenCalledTimes(3);
  });
});
