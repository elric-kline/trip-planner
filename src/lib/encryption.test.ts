import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptBytes, decryptBytes, encryptText, decryptText, isEncryptionConfigured } from "./encryption.ts";

const VALID_KEY = Buffer.alloc(32, 7).toString("base64");

function withKey(key: string | undefined, fn: () => void) {
  const prior = process.env.PASSPORT_ENCRYPTION_KEY;
  if (key === undefined) delete process.env.PASSPORT_ENCRYPTION_KEY;
  else process.env.PASSPORT_ENCRYPTION_KEY = key;
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.PASSPORT_ENCRYPTION_KEY;
    else process.env.PASSPORT_ENCRYPTION_KEY = prior;
  }
}

test("isEncryptionConfigured is false with no key, false with a malformed key, true with a real 32-byte base64 key", () => {
  withKey(undefined, () => assert.equal(isEncryptionConfigured(), false));
  withKey("not-base64-length-32-bytes", () => assert.equal(isEncryptionConfigured(), false));
  withKey(Buffer.alloc(16).toString("base64"), () => assert.equal(isEncryptionConfigured(), false)); // wrong length (AES-128-sized)
  withKey(VALID_KEY, () => assert.equal(isEncryptionConfigured(), true));
});

test("encryptText/decryptText round-trips exactly", () => {
  withKey(VALID_KEY, () => {
    const plaintext = "P1234567 · Jane Q. Traveler · issued 2022-01-01";
    const stored = encryptText(plaintext);
    assert.notEqual(stored, plaintext, "never stores the plaintext verbatim");
    assert.equal(decryptText(stored), plaintext);
  });
});

test("encryptBytes/decryptBytes round-trips arbitrary binary data (e.g. an image)", () => {
  withKey(VALID_KEY, () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 254, 253]);
    const stored = encryptBytes(bytes);
    assert.deepEqual(decryptBytes(stored), bytes);
  });
});

test("the same plaintext encrypts to a different value every time -- a fresh random IV each call", () => {
  withKey(VALID_KEY, () => {
    const a = encryptText("P1234567");
    const b = encryptText("P1234567");
    assert.notEqual(a, b);
    assert.equal(decryptText(a), "P1234567");
    assert.equal(decryptText(b), "P1234567");
  });
});

test("encrypting without a configured key throws a clear error instead of silently storing plaintext", () => {
  withKey(undefined, () => {
    assert.throws(() => encryptText("P1234567"), /PASSPORT_ENCRYPTION_KEY/);
  });
});

test("decrypting a tampered ciphertext throws rather than returning corrupted/garbage plaintext -- GCM's authentication catches it", () => {
  withKey(VALID_KEY, () => {
    const stored = encryptText("P1234567");
    const [iv, tag, ciphertext] = stored.split(":");
    const tamperedCiphertextByte = Buffer.from(ciphertext, "base64");
    tamperedCiphertextByte[0] ^= 0xff;
    const tampered = [iv, tag, tamperedCiphertextByte.toString("base64")].join(":");
    assert.throws(() => decryptText(tampered));
  });
});

test("decrypting a malformed (non-envelope-shaped) stored value throws instead of crashing unpredictably", () => {
  withKey(VALID_KEY, () => {
    assert.throws(() => decryptText("not-the-right-shape"), /Malformed encrypted value/);
  });
});
