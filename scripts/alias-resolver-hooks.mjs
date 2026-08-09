import { statSync } from "node:fs";
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
 * Alias imports here come in three shapes and all of them are in active use:
 * extensionless pointing at a file ("@/lib/dietary" -> src/lib/dietary.ts),
 * extensionless pointing at a directory index ("@/db" -> src/db/index.ts),
 * and -- the dominant style under src/app -- written with the extension
 * already on ("@/lib/auth.ts"). The third used to fall through to
 * "src/lib/auth.ts/index.ts" and fail, which stayed hidden only because
 * nothing `node --test` loaded had ever imported that way. It does now, so
 * the candidates are tried in order rather than assumed.
 */
const SRC_ROOT = new URL("../src/", import.meta.url);

function isFile(url) {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
}

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
    const candidates = [rel, `${rel}.ts`, `${rel}.tsx`, `${rel}/index.ts`].map(
      (path) => new URL(path, SRC_ROOT),
    );
    // isFile(), not exists(): "@/db" names a real *directory*, and resolving
    // an ES import to a directory is an error rather than an index lookup.
    // Last candidate is the fallback, so a genuinely missing module produces
    // Node's own "cannot find module" naming a real path.
    const target = candidates.find(isFile) ?? candidates.at(-1);
    return nextResolve(target.href, context);
  }
  return nextResolve(specifier, context);
}
