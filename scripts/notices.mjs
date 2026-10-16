import { readFile, readdir, writeFile } from 'node:fs/promises';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const blocks = ['Asset — third-party notices\nLicenses belong to their respective authors.'];
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path) continue;
  let files;
  try { files = await readdir(path); } catch { continue; }
  const licenses = files.filter((name) => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name));
  if (!licenses.length) continue;
  const content = [];
  for (const file of licenses) {
    try { content.push(await readFile(`${path}/${file}`, 'utf8')); } catch { /* directories are not notices */ }
  }
  if (content.length) blocks.push(`${path.replace(/^node_modules\//, '')} ${pkg.version} (${pkg.license})\n${content.join('\n')}`);
}
blocks.push(`Lato fonts\n${await readFile('public/fonts/OFL.txt', 'utf8')}`);
blocks.push(`Plaid iOS SPM wrapper\n${await readFile('docs/Plaid-SPM-LICENSE.txt', 'utf8')}`);
await writeFile('public/third-party-notices.txt', blocks.join('\n\n' + '='.repeat(72) + '\n\n'));
console.log('Third-party notices refreshed from installed dependencies.');
