// The browser-facing Blob endpoint and the CSP frame-src origin
// (tech-stack.md §8, ats-project-scope.md F5), for every configuration shape.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { blobOrigin, browserBlobEndpoint, connectionStringBlobEndpoint } from "@/server/adapters/storage/endpoints";
import { type AppConfig, loadConfig } from "@/server/config";

type Storage = AppConfig["storage"];

const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const composeEnv = (parse(readFileSync("docker-compose.yml", "utf8")) as {
  services: { app: { environment: Record<string, string> } };
}).services.app.environment;

const compose = loadConfig(composeEnv).storage;
const devServer: Storage = {
  mode: "connectionString",
  connectionString: `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=${AZURITE_KEY};BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;`,
  publicUrl: undefined,
};
const azure: Storage = { mode: "managedIdentity", accountUrl: "https://atsdemo.blob.core.windows.net/", clientId: "client-id" };

describe("Blob endpoints", () => {
  it("F5: frame-src is http://localhost:10000 for the Compose configuration", () => {
    expect(blobOrigin(compose)).toBe("http://localhost:10000");
  });

  it("F5: frame-src is http://127.0.0.1:10000 for pnpm dev (no public URL)", () => {
    expect(blobOrigin(devServer)).toBe("http://127.0.0.1:10000");
  });

  it("F5: frame-src is the account origin in Azure", () => {
    expect(blobOrigin(azure)).toBe("https://atsdemo.blob.core.windows.net");
  });

  it("F5: frame-src is never * and never the Compose-internal azurite host", () => {
    for (const storage of [compose, devServer, azure]) {
      expect(blobOrigin(storage)).not.toBe("*");
      expect(blobOrigin(storage)).not.toContain("azurite");
      expect(blobOrigin(storage)).toMatch(/^https?:\/\/[^/]+$/);
    }
  });

  it("signed links use the public URL with its trailing slash normalized, else the connection-string endpoint", () => {
    expect(browserBlobEndpoint(compose)).toBe("http://localhost:10000/devstoreaccount1");
    expect(browserBlobEndpoint({ ...devServer, publicUrl: "http://localhost:10000/devstoreaccount1//" })).toBe(
      "http://localhost:10000/devstoreaccount1",
    );
    expect(browserBlobEndpoint(devServer)).toBe("http://127.0.0.1:10000/devstoreaccount1");
    expect(browserBlobEndpoint(azure)).toBe("https://atsdemo.blob.core.windows.net");
  });

  it("reads the endpoint from the connection string forms", () => {
    expect(connectionStringBlobEndpoint("UseDevelopmentStorage=true")).toBe("http://127.0.0.1:10000/devstoreaccount1");
    expect(connectionStringBlobEndpoint(composeEnv.AZURE_STORAGE_CONNECTION_STRING)).toBe("http://azurite:10000/devstoreaccount1");
    expect(
      connectionStringBlobEndpoint(`DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${AZURITE_KEY};EndpointSuffix=core.windows.net`),
    ).toBe("https://acct.blob.core.windows.net");
    expect(() => connectionStringBlobEndpoint("AccountKey=abc")).toThrow("no Blob endpoint");
  });
});
