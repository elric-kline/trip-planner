import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export const MIN_PASSWORD_LENGTH = 8;

const SCRYPT_KEY_LENGTH = 64;
const scrypt = promisify(scryptCallback);

/** `salt:hash`, both hex. Node's own docs recommend scrypt for this exact shape. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEY_LENGTH)) as Buffer;
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPasswordHash(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;

  // Lengths can only differ if `stored` is malformed, but timingSafeEqual
  // throws on a length mismatch rather than returning false, so guard first.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
