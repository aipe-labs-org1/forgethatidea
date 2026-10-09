// Vercel build entry for forge-server (Vercel runs `vercel-build` when the
// project has no build command). Production deploys apply pending drizzle
// migrations before compiling, so merged migrations can never again be left
// unapplied in production (0008/0009 were, and every analytics write failed).
// Preview and local builds have no production database and only compile.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';

// Through turbo, as Vercel's own Turborepo detection does, so @forge/shared
// is built before the server compiles against it.
const COMPILE = ['turbo', ['run', 'build', '--filter=@forge/server']];

export function planBuild(env) {
  if (env.VERCEL_ENV !== 'production') return [COMPILE];
  if (!env.DATABASE_URL) {
    throw new Error('Production build needs DATABASE_URL to apply migrations.');
  }
  return [['drizzle-kit', ['migrate']], COMPILE];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [command, args] of planBuild(process.env)) {
    console.log(`> ${command} ${args.join(' ')}`);
    execFileSync(command, args, { stdio: 'inherit' });
  }
}
