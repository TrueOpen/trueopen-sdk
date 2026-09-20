import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entry: ESM + CJS + d.ts, runtime-agnostic.
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
  },
  // CLI entry: a single executable CJS bundle with a shebang (package.json bin -> dist/cli.cjs). Node only.
  {
    entry: { cli: 'src/cli/index.ts' },
    format: ['cjs'],
    sourcemap: true,
    clean: false,
    target: 'es2022',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
