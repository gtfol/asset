import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('ios/Asset/Resources', { recursive: true });
await build({
  stdin: {
    contents:
      'export * from "./shared/core";export * from "./shared/demo";export * from "./shared/csv";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'iife',
  globalName: 'AssetCore',
  target: 'es2020',
  outfile: 'ios/Asset/Resources/CalculationEngine.js',
  minify: true,
});
console.log('Shared calculation and import engine bundled for JavaScriptCore.');
