import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const nativeRoot = fileURLToPath(new URL('../', import.meta.url));

if (process.platform !== 'darwin') {
  throw new Error('Native Store regression checks require macOS and Xcode command line tools.');
}
const directory = await mkdtemp(join(tmpdir(), 'asset-native-store-'));
try {
  await copyFile(
    join(nativeRoot, 'Asset/Resources/CalculationEngine.js'),
    join(directory, 'CalculationEngine.js'),
  );
  const executable = join(directory, 'asset-native-store-tests');
  const compile = spawnSync(
    'xcrun',
    [
      'swiftc',
      '-O',
      '-swift-version',
      '5',
      join(nativeRoot, 'Asset/Persistence/Store.swift'),
      join(nativeRoot, 'Asset/Persistence/BackgroundSync.swift'),
      join(nativeRoot, 'AssetTests/NativeStoreTests.swift'),
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
