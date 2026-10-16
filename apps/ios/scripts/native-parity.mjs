import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
const code = `const s=AssetCore.createDemo('2026-10-15');const r={dashboard:AssetCore.dashboard(s,'2026-10','2026-10-15'),cashflow:AssetCore.cashflow(s,'year','2026','2026-10-15'),worth:AssetCore.netWorth(s),investments:AssetCore.investmentOverview(s,'all','2026-10-15')};const changed=AssetCore.applyCommand(s,{type:'transaction.update',payload:{id:s.transactions[s.transactions.length-1].id,edits:{categoryId:'coffee',excluded:true},reviewed:true}});r.changed=AssetCore.dashboard(changed,'2026-10','2026-10-15');r.restored=AssetCore.dashboard(AssetCore.applyCommand(s,{type:'backup.restore',payload:{state:AssetCore.backup(changed).state}}),'2026-10','2026-10-15');const csv=AssetCore.previewCSV('date,name,amount\\n2026-10-01,Demo CSV,12.34',{mapping:{date:'date',name:'name',amount:'amount'},dateFormat:'YYYY-MM-DD',amountConvention:'outflow-positive',currency:'USD',accountId:'checking'},s);r.csv={total:csv.total,amount:csv.transactions[0].amount,date:csv.transactions[0].date,errors:csv.errors};JSON.stringify(r);`;
if (process.platform !== 'darwin') {
  throw new Error('Native parity checks require macOS and Xcode command line tools.');
}
const file = fileURLToPath(new URL('../Asset/Resources/CalculationEngine.js', import.meta.url));
const verifier = fileURLToPath(new URL('./verify-native.swift', import.meta.url));
const source = await readFile(file, 'utf8');
const expected = runInNewContext(source + '\n' + code, {
  Intl,
  Date,
  TextEncoder,
  TextDecoder,
  URL,
  console,
});
const dir = await mkdtemp(join(tmpdir(), 'asset-parity-'));
try {
  const script = join(dir, 'parity.js'),
    fixture = join(dir, 'expected.json');
  await writeFile(script, code);
  await writeFile(fixture, expected);
  const run = spawnSync('swift', [verifier, file, script, fixture], {
    stdio: 'inherit',
  });
  if (run.error) throw run.error;
  process.exitCode = run.status ?? 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
