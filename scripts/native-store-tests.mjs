import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

if (process.platform !== 'darwin') {
  throw new Error('Native Store regression checks require macOS and Xcode command line tools.');
}
const directory = await mkdtemp(join(tmpdir(), 'asset-native-store-'));
try {
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
    outfile: join(directory, 'CalculationEngine.js'),
    minify: true,
  });
  const executable = join(directory, 'asset-native-store-tests');
  const compile = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-swift-version',
      '5',
      resolve('ios/Asset/Store.swift'),
      resolve('tests/NativeStoreTests.swift'),
      '-o',
      executable,
    ],
    { stdio: 'inherit' },
  );
  if (compile.error) throw compile.error;
  if (compile.status !== 0) throw new Error('Native Store regression harness did not compile.');
  const result = spawnSync(executable, ['-mode', ''], { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
