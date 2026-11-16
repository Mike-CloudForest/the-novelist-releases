/** Copy only verified compiled release files from the private relay checkout. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { reconstruct } from './staged-release.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || ''), expectedSource = process.argv[3];
if (!process.argv[2] || !/^[a-f0-9]{40}$/.test(expectedSource || '')) throw new Error('Usage: node scripts/stage-transfer.mjs <release-transfer-directory> <tested-source-commit>');
const manifest = JSON.parse(fs.readFileSync(path.join(source, 'metadata', 'parts-manifest.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid release version');
const target = path.join(root, 'incoming', 'v' + manifest.version);
if (fs.existsSync(target)) throw new Error('Staging directory already exists; do not mix releases');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'novelist-staging-'));
function copyFile(fromDirectory, toDirectory, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9 _().-]+$/.test(name) || name === '.' || name === '..') throw new Error('Unsafe transfer filename');
  const from = path.join(fromDirectory, name);
  if (!fs.lstatSync(from).isFile() || fs.lstatSync(from).isSymbolicLink()) throw new Error('Transfer payload must be a regular file');
  fs.copyFileSync(from, path.join(toDirectory, name));
}
try {
  const staged = path.join(temporary, 'input');
  fs.mkdirSync(path.join(staged, 'parts'), { recursive: true });
  copyFile(path.join(source, 'metadata'), staged, 'parts-manifest.json');
  for (const item of manifest.metadata || []) copyFile(path.join(source, 'metadata'), staged, item.name);
  for (const item of manifest.parts || []) copyFile(path.join(source, 'parts'), path.join(staged, 'parts'), item.name);
  const result = reconstruct(staged, path.join(temporary, 'verified'), { expectedVersion: manifest.version, expectedSource });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(staged, target, { recursive: true, errorOnExist: true, force: false });
  console.log(`Staged only verified compiled assets: ${target}`);
  console.log(`Source ${manifest.sourceCommit}; Windows run ${manifest.sourceRunId}`);
  console.log(`Installer ${result.installerSize} bytes; SHA-256 ${result.installerSha256}`);
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
