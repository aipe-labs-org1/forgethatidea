import { describe, it, expect } from 'vitest';
import { planBuild } from './vercel-build.mjs';

describe('vercel-build migration plan', () => {
  it('migrates before compiling on a production deploy', () => {
    expect(planBuild({ VERCEL_ENV: 'production', DATABASE_URL: 'postgres://x' })).toEqual([
      ['drizzle-kit', ['migrate']],
      ['turbo', ['run', 'build', '--filter=@forge/server']],
    ]);
  });

  it('refuses a production deploy with no DATABASE_URL rather than shipping against an unmigrated database', () => {
    expect(() => planBuild({ VERCEL_ENV: 'production' })).toThrow(/DATABASE_URL/);
  });

  it('only compiles on preview and local builds, which have no production database', () => {
    expect(planBuild({ VERCEL_ENV: 'preview' })).toEqual([
      ['turbo', ['run', 'build', '--filter=@forge/server']],
    ]);
    expect(planBuild({})).toEqual([['turbo', ['run', 'build', '--filter=@forge/server']]]);
  });
});
