import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { reconstruct } from '../scripts/staged-release.mjs';
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => crypto.createHash(algorithm).update(bytes).digest(encoding);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novelist-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'incoming'), output = path.join(root, 'reconstructed');
  fs.mkdirSync(path.join(input, 'parts'), { recursive: true });
  const version = '2.1.3', sourceCommit = 'a'.repeat(40), name = `TheNovelist-Setup-${version}.exe`;
  const installer = Buffer.alloc(512);
  installer.write('MZ'); installer.writeUInt32LE(128, 0x3c); installer.write('PE\0\0', 128); installer.writeUInt16LE(0x14c, 132);
  const installerHash = hash(installer), blockmap = Buffer.from('blockmap fixture');
  const yaml = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${hash(installer, 'sha512', 'base64')}\n    size: ${installer.length}\npath: ${name}\nsha512: ${hash(installer, 'sha512', 'base64')}\nreleaseDate: '2026-11-16T00:00:00.000Z'\n`;
  const evidence = { version, sourceCommit, windowsInstallerSmoke: { passed: true, version, sourceCommit, installerSha256: installerHash, payloadFilesVerified: 20 },
    windowsPackage: { mode: 'nsis', installer: { sha256: installerHash }, checkedSourceFiles: 3, checkedResourceFiles: 5, checkedPeFiles: 4,
      nativeAddons: [{ machine: 'x64', sha256: 'a'.repeat(64) }, { machine: 'x64', sha256: 'b'.repeat(64) }] },
    assets: { installer: { sha256: installerHash }, blockmap: { sha256: hash(blockmap) } } };
  const files = { 'latest.yml': yaml, [name + '.blockmap']: blockmap, 'windows-release-validation.json': JSON.stringify(evidence), 'release-notes.md': '# Release 2.1.3\n' };
  for (const [filename, bytes] of Object.entries(files)) fs.writeFileSync(path.join(input, filename), bytes);
  fs.writeFileSync(path.join(input, 'parts', 'part-001.bin'), installer);
  const metadata = Object.keys(files).map(filename => { const bytes = fs.readFileSync(path.join(input, filename)); return { name: filename, size: bytes.length, sha256: hash(bytes) }; });
  const manifest = { version, sourceCommit, sourceRunId: '123', sourceRunUrl: 'https://github.com/owner/private/actions/runs/123',
    installer: { name, size: installer.length, sha256: installerHash }, parts: [{ name: 'part-001.bin', size: installer.length, sha256: installerHash }], metadata };
  const writeManifest = () => fs.writeFileSync(path.join(input, 'parts-manifest.json'), JSON.stringify(manifest));
  const updateMetadata = (filename, bytes) => { fs.writeFileSync(path.join(input, filename), bytes); Object.assign(metadata.find(item => item.name === filename), { size: Buffer.byteLength(bytes), sha256: hash(bytes) }); writeManifest(); };
  writeManifest();
  return { input, output, manifest, installer, name, evidence, writeManifest, updateMetadata };
}
test('reconstructs only checksum-verified Windows-tested release bytes', t => {
  const f = fixture(t), result = reconstruct(f.input, f.output, { expectedVersion: '2.1.3', expectedSource: 'a'.repeat(40) });
  assert.equal(result.version, '2.1.3');
  assert.deepEqual(fs.readFileSync(path.join(f.output, f.name)), f.installer);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.output, 'release-manifest.json'))), f.manifest);
});
test('rejects altered part bytes', t => { const f = fixture(t); fs.writeFileSync(path.join(f.input, 'parts', 'part-001.bin'), Buffer.alloc(512)); assert.throws(() => reconstruct(f.input, f.output), /SHA-256/); });
test('rejects reordered or unsafe part names', t => { const f = fixture(t); f.manifest.parts[0].name = '../part-001.bin'; f.writeManifest(); assert.throws(() => reconstruct(f.input, f.output), /order/); });
test('rejects altered metadata before reconstruction', t => { const f = fixture(t); fs.appendFileSync(path.join(f.input, 'latest.yml'), 'extra'); assert.throws(() => reconstruct(f.input, f.output), /Size mismatch/); });
test('rejects non-Windows installer even with updated manifest hash', t => { const f = fixture(t); const binary = Buffer.alloc(512); binary.write('\x7fELF'); fs.writeFileSync(path.join(f.input, 'parts', 'part-001.bin'), binary); f.manifest.parts[0].sha256 = f.manifest.installer.sha256 = hash(binary); f.writeManifest(); assert.throws(() => reconstruct(f.input, f.output), /Windows executable/); });
test('rejects changed source provenance', t => { const f = fixture(t); assert.throws(() => reconstruct(f.input, f.output, { expectedSource: 'b'.repeat(40) }), /Source commit/); });
test('rejects another release version', t => { const f = fixture(t); assert.throws(() => reconstruct(f.input, f.output, { expectedVersion: '2.1.4' }), /version/); });
test('requires successful installer smoke for these exact bytes', t => { const f = fixture(t); f.evidence.windowsInstallerSmoke.passed = false; f.updateMetadata('windows-release-validation.json', JSON.stringify(f.evidence)); assert.throws(() => reconstruct(f.input, f.output), /smoke evidence/); });
test('rejects native module or resource validation omissions', t => { const f = fixture(t); f.evidence.windowsPackage.nativeAddons[0].machine = 'x86'; f.updateMetadata('windows-release-validation.json', JSON.stringify(f.evidence)); assert.throws(() => reconstruct(f.input, f.output), /native modules/); });
test('requires the installer to carry an actual PE header', t => { const f = fixture(t); f.installer.fill(0, 128, 132); fs.writeFileSync(path.join(f.input, 'parts', 'part-001.bin'), f.installer); f.manifest.parts[0].sha256 = f.manifest.installer.sha256 = hash(f.installer); f.writeManifest(); assert.throws(() => reconstruct(f.input, f.output), /PE header/); });
test('rejects stale reconstruction output', t => { const f = fixture(t); fs.mkdirSync(f.output); assert.throws(() => reconstruct(f.input, f.output), /fresh/); });
