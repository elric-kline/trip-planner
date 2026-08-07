import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Teaches plain `node --test` how to resolve the "@/*" -> "./src/*" alias
 * that tsconfig.json's "paths" declares and Next.js's bundler honors for
 * free. Without this, any test that imports a module which itself imports
 * "@/db" or "@/db/schema" (i.e. anything that touches the database) fails
 * to resolve at all -- this is the actual reason every DB-touching lib
 * module (items.ts, scope.ts, auth.ts, ...) had zero automated tests
 * before this file existed; it was never a choice to skip them, just a
 * resolver gap. Registered by register-alias-resolver.mjs via
 * module.register(), which is what `npm test` passes to `node --import`.
 *
 * Alias imports in this codebase are always extensionless and point either
 * at a file ("@/lib/dietary" -> src/lib/dietary.ts) or, for exactly one
 * case, a directory with an index ("@/db" -> src/db/index.ts) -- so this
 * only needs to try those two shapes, not a general resolution algorithm.
 */
const SRC_ROOT = new URL("../src/", import.meta.url);

// Test-only substitutions for framework APIs plain `node --test` can't
// reach on its own. See fake-next-headers.mjs for why and its limits.
const FAKES = {
  "next/headers": new URL("./fake-next-headers.mjs", import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (FAKES[specifier]) {
    return nextResolve(FAKES[specifier], context);
  }
  if (specifier.startsWith("@/")) {
    const rel = specifier.slice(2);
    const asFile = new URL(`${rel}.ts`, SRC_ROOT);
    const asIndex = new URL(`${rel}/index.ts`, SRC_ROOT);
    const target = existsSync(fileURLToPath(asFile)) ? asFile : asIndex;
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
