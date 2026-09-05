import { test } from "node:test";
import assert from "node:assert/strict";
import {
  installTestBackend,
  isStorageConfigured,
  resetBackend,
  StorageNotConfiguredError,
} from "./r2.ts";

/**
 * The env-and-backend contract. The real R2 client is exercised in
 * integration; here we're just proving the two flags line up: with nothing
 * configured, isStorageConfigured is false and the exposed operations
 * refuse to run, but a test backend installs cleanly.
 */

function clearEnv() {
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
  delete process.env.R2_PUBLIC_BASE_URL;
}

test("with nothing configured, isStorageConfigured is false", (t) => {
  clearEnv();
  resetBackend();
  t.after(resetBackend);

  assert.equal(isStorageConfigured(), false);
});

test("with all four env vars set, isStorageConfigured flips true", (t) => {
  clearEnv();
  resetBackend();
  t.after(() => {
    clearEnv();
    resetBackend();
  });

  process.env.R2_ACCOUNT_ID = "acc";
  process.env.R2_ACCESS_KEY_ID = "key";
  process.env.R2_SECRET_ACCESS_KEY = "secret";
  process.env.R2_BUCKET = "bucket";

  assert.equal(isStorageConfigured(), true);
});

test("a partial env config (missing one var) still reads as unconfigured", (t) => {
  clearEnv();
  resetBackend();
  t.after(() => {
    clearEnv();
    resetBackend();
  });

  process.env.R2_ACCOUNT_ID = "acc";
  process.env.R2_ACCESS_KEY_ID = "key";
  // R2_SECRET_ACCESS_KEY deliberately missing
  process.env.R2_BUCKET = "bucket";

  assert.equal(isStorageConfigured(), false);
});

test("a test backend installs cleanly and unregisters via resetBackend", (t) => {
  clearEnv();
  resetBackend();
  t.after(resetBackend);

  installTestBackend({
    async putObject() {},
    async deleteObject() {},
    async deleteObjects() {},
    async signedGetUrl(key) {
      return `stub://${key}`;
    },
  });

  assert.equal(isStorageConfigured(), true);

  resetBackend();
  assert.equal(isStorageConfigured(), false);
});

test("StorageNotConfiguredError carries a user-legible message", () => {
  const err = new StorageNotConfiguredError();
  assert.match(err.message, /R2_ACCOUNT_ID/);
  assert.match(err.message, /R2_BUCKET/);
});
