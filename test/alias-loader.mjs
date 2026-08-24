// Resolves the "@/..." path alias from tsconfig so tests can import app
// modules the same way the app does.
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  // App code imports these extensionless (bundler-style resolution), which
  // Node's ESM resolver won't do on its own.
  const base = resolvePath(projectRoot, specifier.slice(2));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return nextResolve(pathToFileURL(candidate).href, context);
  }
  return nextResolve(pathToFileURL(base).href, context);
}
