import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--check')) {
  throw new Error('Usage: node scripts/native-resources.mjs [--check]');
}
const check = args.includes('--check');
const webRoot = fileURLToPath(new URL('../', import.meta.url));
const resources = fileURLToPath(new URL('../../ios/Asset/Resources/', import.meta.url));
const result = await build({
  absWorkingDir: webRoot,
  stdin: {
    contents:
      'export * from "./shared/core";export * from "./shared/demo";export * from "./shared/csv";export * from "./shared/copilot";',
    resolveDir: webRoot,
    sourcefile: 'native-engine-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'AssetCore',
  target: 'es2020',
  minify: true,
  write: false,
});
const files = [
  ['CalculationEngine.js', Buffer.from(result.outputFiles[0].contents)],
  ...await Promise.all(
    ['Lato-Regular.ttf', 'Lato-Medium.ttf', 'OFL.txt'].map(async (name) => [
      name, await readFile(join(webRoot, 'public/fonts', name)),
    ]),
  ),
  ['third-party-notices.txt', await readFile(join(webRoot, 'public/third-party-notices.txt'))],
];
const stale = [];
if (!check) await mkdir(resources, { recursive: true });
for (const [name, contents] of files) {
  const target = join(resources, name);
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!current?.equals(contents)) {
    stale.push(name);
    if (!check) await writeFile(target, contents);
  }
}
if (check && stale.length) {
  console.error(`Native resources are stale: ${stale.join(', ')}. Run npm run native:resources in apps/web.`);
  process.exitCode = 1;
} else {
  console.log(check
    ? 'Native calculation engine, fonts, and notices match their web sources.'
    : `Native resources synchronized (${stale.length} changed).`);
}
