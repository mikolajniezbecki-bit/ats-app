// Blob endpoints from the storage configuration (tech-stack.md §8), without
// the Azure SDK, so proxy.ts can compute the CSP `frame-src` cheaply on every
// request. Pure: tested without Azurite.
import type { AppConfig } from "../../config";

export type StorageConfig = AppConfig["storage"];

/** Azurite's documented development account (`UseDevelopmentStorage=true`). */
const DEVELOPMENT_BLOB_ENDPOINT = "http://127.0.0.1:10000/devstoreaccount1";

/** `Key=Value;` pairs of a connection string; values may contain `=` (account keys). */
export function parseConnectionString(connectionString: string): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const pair of connectionString.split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) parts[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return parts;
}

/** The Blob endpoint the app itself talks to, without a trailing slash. */
export function connectionStringBlobEndpoint(connectionString: string): string {
  const parts = parseConnectionString(connectionString);
  if (parts.UseDevelopmentStorage === "true") return DEVELOPMENT_BLOB_ENDPOINT;
  if (parts.BlobEndpoint) return withoutTrailingSlash(parts.BlobEndpoint);
  if (parts.AccountName) {
    const protocol = parts.DefaultEndpointsProtocol ?? "https";
    return `${protocol}://${parts.AccountName}.blob.${parts.EndpointSuffix ?? "core.windows.net"}`;
  }
  throw new Error("AZURE_STORAGE_CONNECTION_STRING has no Blob endpoint");
}

/**
 * The Blob endpoint signed links point at, without a trailing slash: the
 * browser-facing AZURE_STORAGE_PUBLIC_URL when set (Compose), else the
 * endpoint the app uses; in Azure the account URL.
 */
export function browserBlobEndpoint(storage: StorageConfig): string {
  if (storage.mode === "managedIdentity") return withoutTrailingSlash(storage.accountUrl);
  return storage.publicUrl
    ? withoutTrailingSlash(storage.publicUrl)
    : connectionStringBlobEndpoint(storage.connectionString);
}

/**
 * The CSP `frame-src` source: the origin only (scheme, host, port), because a
 * source with a path would match only that exact path (§8).
 */
export function blobOrigin(storage: StorageConfig): string {
  return new URL(browserBlobEndpoint(storage)).origin;
}

function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
