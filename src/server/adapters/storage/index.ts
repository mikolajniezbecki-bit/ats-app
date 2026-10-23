// File storage (tech-stack.md §8, ats-project-scope.md F4, F5, V11). The only
// code that imports the Azure SDK (§3 rule 4, enforced by ESLint). Blobs live
// in the private container `files` under random UUID keys; the original file
// name stays in the database. Signed URLs are never logged.
//
// Two modes, chosen by the configuration:
// - Azurite (AZURE_STORAGE_CONNECTION_STRING): account-key SAS, and the
//   container is created when missing.
// - Azure (AZURE_STORAGE_ACCOUNT_URL + AZURE_CLIENT_ID): managed identity,
//   links signed with a user delegation key; Bicep creates the container.
import { randomUUID } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  StorageSharedKeyCredential,
  type UserDelegationKey,
  generateBlobSASQueryParameters,
} from "@azure/storage-blob";
import { getConfig } from "../../config";
import { browserBlobEndpoint, type StorageConfig } from "./endpoints";

export { blobOrigin, browserBlobEndpoint, type StorageConfig } from "./endpoints";

export const FILES_CONTAINER = "files";
/** V11: signed links expire after 5 minutes. */
export const DEFAULT_LINK_TTL_SECONDS = 300;

export type SignedUrlOptions = {
  ttlSeconds?: number;
  /** Issue time; tests pass a past time to get an expired link without sleeping (T3, W9). */
  now?: Date;
};

export type SignedUrl = { url: string; expiresAt: Date };

export interface StorageService {
  /** Stores the bytes under a new random key and returns it. */
  upload(bytes: Uint8Array, contentType: string): Promise<{ key: string }>;
  /** The blob's bytes (email attachments, task 18). */
  download(key: string): Promise<Buffer>;
  /** Deletes the blob; a missing blob is not an error. */
  delete(key: string): Promise<void>;
  /** A read-only link to one blob that opens a PDF inline (F5, V11). */
  getSignedUrl(key: string, options?: SignedUrlOptions): Promise<SignedUrl>;
  /** Resolves when the `files` container is reachable; rejects otherwise (M5). */
  checkHealth(signal?: AbortSignal): Promise<void>;
  /** Azurite only: creates the private `files` container if it is missing. A no-op in Azure. */
  ensureContainer(): Promise<void>;
}

/** Refresh the user delegation key this long before it expires. */
const DELEGATION_KEY_MARGIN_MS = 5 * 60_000;
/** Lifetime requested for a user delegation key (the maximum is 7 days). */
const DELEGATION_KEY_LIFETIME_MS = 60 * 60_000;

/** Returns the SAS query string for one blob. */
type Signer = (key: string, expiresOn: Date) => Promise<string>;

type ClientDeps = { client: BlobServiceClient };

/**
 * Builds the service for a configuration. `deps.client` lets unit tests pass
 * a mocked client; otherwise the client is created from the configuration.
 */
export function createStorageService(storage: StorageConfig, deps?: ClientDeps): StorageService {
  const client = deps?.client ?? createClient(storage);
  const container = client.getContainerClient(FILES_CONTAINER);
  const linkBase = `${browserBlobEndpoint(storage)}/${FILES_CONTAINER}`;
  const sign = storage.mode === "connectionString" ? accountKeySigner(client) : delegationKeySigner(client);

  return {
    async upload(bytes, contentType) {
      const key = randomUUID();
      await container.getBlockBlobClient(key).uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
      return { key };
    },

    async download(key) {
      return container.getBlobClient(key).downloadToBuffer();
    },

    async delete(key) {
      await container.getBlobClient(key).deleteIfExists();
    },

    async getSignedUrl(key, options = {}) {
      const ttlSeconds = options.ttlSeconds ?? DEFAULT_LINK_TTL_SECONDS;
      const issuedAt = options.now ?? new Date();
      const expiresAt = new Date(issuedAt.getTime() + ttlSeconds * 1000);
      const sas = await sign(key, expiresAt);
      return { url: `${linkBase}/${encodeURIComponent(key)}?${sas}`, expiresAt };
    },

    async checkHealth(signal) {
      if (!(await container.exists({ abortSignal: signal }))) throw new Error("files container missing");
    },

    async ensureContainer() {
      if (storage.mode !== "connectionString") return;
      // No `access` option: the container is private (F4).
      await container.createIfNotExists();
    },
  };
}

function createClient(storage: StorageConfig): BlobServiceClient {
  if (storage.mode === "connectionString") return BlobServiceClient.fromConnectionString(storage.connectionString);
  return new BlobServiceClient(
    storage.accountUrl,
    new DefaultAzureCredential({ managedIdentityClientId: storage.clientId }),
  );
}

/**
 * The SAS shape (§8): one blob, read-only, no start time (clock skew), an
 * expiry, and response headers so the PDF opens inline (F5).
 */
function sasValues(key: string, expiresOn: Date, protocol?: SASProtocol) {
  return {
    containerName: FILES_CONTAINER,
    blobName: key,
    permissions: BlobSASPermissions.parse("r"),
    expiresOn,
    contentType: "application/pdf",
    contentDisposition: "inline",
    protocol,
  };
}

/** Azurite: account-key SAS from the connection string's credential. */
function accountKeySigner(client: BlobServiceClient): Signer {
  const credential = client.credential;
  if (!(credential instanceof StorageSharedKeyCredential)) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING must contain an account key");
  }
  return async (key, expiresOn) => generateBlobSASQueryParameters(sasValues(key, expiresOn), credential).toString();
}

/**
 * Azure: user delegation SAS, HTTPS only. The key is cached and reused until
 * five minutes before it expires, so links don't each cost a round trip.
 */
function delegationKeySigner(client: BlobServiceClient): Signer {
  let cached: { key: UserDelegationKey; expiresAt: number } | undefined;
  let pending: Promise<UserDelegationKey> | undefined;

  async function delegationKey(): Promise<UserDelegationKey> {
    if (cached && cached.expiresAt - DELEGATION_KEY_MARGIN_MS > Date.now()) return cached.key;
    pending ??= (async () => {
      try {
        const startsOn = new Date();
        const expiresOn = new Date(startsOn.getTime() + DELEGATION_KEY_LIFETIME_MS);
        const key = await client.getUserDelegationKey(startsOn, expiresOn);
        cached = { key, expiresAt: expiresOn.getTime() };
        return key;
      } finally {
        pending = undefined;
      }
    })();
    return pending;
  }

  return async (key, expiresOn) =>
    generateBlobSASQueryParameters(
      sasValues(key, expiresOn, SASProtocol.Https),
      await delegationKey(),
      client.accountName,
    ).toString();
}

// One instance per process, created on first use and never at import time (W1).
let instance: StorageService | undefined;

/** The process's storage service, for the configured mode. */
export function getStorage(): StorageService {
  instance ??= createStorageService(getConfig().storage);
  return instance;
}
