import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Application-level encryption for genuinely sensitive fields (right now:
 * passport data, see lib/passport.ts) -- on top of, not instead of,
 * whatever encryption-at-rest the database itself provides. The point is
 * that a database backup, a stray read-replica, or a compromised DB
 * credential still can't recover a passport number or photo without also
 * having PASSPORT_ENCRYPTION_KEY, which lives only in the app's own
 * environment.
 *
 * AES-256-GCM via Node's built-in crypto -- same "no SDK, no extra
 * dependency" posture as lib/password.ts's scrypt use. GCM is
 * authenticated: decrypt fails loudly (rather than silently returning
 * garbage) if the ciphertext, IV, or tag were tampered with or corrupted.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // NIST-recommended for GCM
const KEY_LENGTH = 32; // AES-256

/**
 * Doesn't throw -- lets a caller check up front whether to even show the
 * passport feature at all (same "unset just means this feature is quietly
 * unavailable" posture as every other optional integration in this app,
 * see .env.example), rather than only discovering it's misconfigured the
 * moment someone tries to save something sensitive.
 */
export function isEncryptionConfigured(): boolean {
  return readKey() !== null;
}

function readKey(): Buffer | null {
  const raw = process.env.PASSPORT_ENCRYPTION_KEY;
  if (!raw) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.length === KEY_LENGTH ? key : null;
}

function requireKey(): Buffer {
  const key = readKey();
  if (!key) {
    throw new Error(
      "PASSPORT_ENCRYPTION_KEY isn't configured (must be a base64-encoded 32-byte key) -- refusing to handle sensitive data without it.",
    );
  }
  return key;
}

/**
 * `iv:authTag:ciphertext`, each base64 -- one self-contained string per
 * encrypted value, safe to store directly in a text column. A fresh random
 * IV every call (required for GCM's security guarantees; reusing an IV
 * with the same key breaks confidentiality) is why encrypting the same
 * plaintext twice never produces the same output.
 */
export function encryptBytes(plaintext: Buffer): string {
  const key = requireKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(":");
}

export function decryptBytes(stored: string): Buffer {
  const key = requireKey();
  const [ivB64, tagB64, ciphertextB64] = stored.split(":");
  if (!ivB64 || !tagB64 || !ciphertextB64) throw new Error("Malformed encrypted value -- expected iv:authTag:ciphertext.");

  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptText(plaintext: string): string {
  return encryptBytes(Buffer.from(plaintext, "utf8"));
}

export function decryptText(stored: string): string {
  return decryptBytes(stored).toString("utf8");
}
