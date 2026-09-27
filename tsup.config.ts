import { defineConfig } from 'tsup';

export default defineConfig([
  // Library entries: ESM + CJS + d.ts. index is runtime-agnostic; node adds the Node-only manifest downloader.
  {
    entry: ['src/index.ts', 'src/node.ts'],
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
