/** Release operations only. This repository contains no application source. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyWindowsRelease } from './windows-release-assets.mjs';

const repository = 'Mike-CloudForest/the-novelist-releases';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(message); };
function safeFile(directory, name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9 _().-]+$/.test(name) || name === '.' || name === '..') fail('Unsafe payload filename');
  const target = path.join(directory, name);
  if (!fs.lstatSync(target).isFile() || fs.lstatSync(target).isSymbolicLink()) fail('Payload must be a regular file');
  return target;
}
function readChecked(directory, item) {
  if (!item || !Number.isSafeInteger(item.size) || item.size <= 0 || !/^[a-f0-9]{64}$/.test(item.sha256)) fail('Invalid payload size/checksum');
  const filename = safeFile(directory, item.name);
  if (fs.statSync(filename).size !== item.size) fail(`Size mismatch: ${item.name}`);
  const bytes = fs.readFileSync(filename);
  if (sha256(bytes) !== item.sha256) fail(`SHA-256 mismatch: ${item.name}`);
  return bytes;
}
export function reconstruct(input, output, { expectedVersion, expectedSource } = {}) {
  input = path.resolve(input); output = path.resolve(output);
  if (fs.existsSync(output)) fail('Reconstruction output must be fresh');
  const manifest = JSON.parse(fs.readFileSync(safeFile(input, 'parts-manifest.json'), 'utf8'));
  const { version, sourceCommit, installer, parts, metadata } = manifest;
  if (!/^\d+\.\d+\.\d+$/.test(version) || (expectedVersion && expectedVersion !== version)) fail('Exact stable version mismatch');
  if (!/^[a-f0-9]{40}$/.test(sourceCommit) || (expectedSource && expectedSource !== sourceCommit)) fail('Source commit mismatch');
  if (!/^\d+$/.test(String(manifest.sourceRunId)) || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+$/.test(manifest.sourceRunUrl || '')
    || !manifest.sourceRunUrl.endsWith('/' + manifest.sourceRunId)) fail('Windows CI run provenance is missing');
  if (!installer || !/^[A-Za-z0-9 _().-]+-Setup-[0-9.]+\.exe$/.test(installer.name) || !installer.name.endsWith(`-Setup-${version}.exe`)
    || !Number.isSafeInteger(installer.size) || installer.size < 64 || !/^[a-f0-9]{64}$/.test(installer.sha256)) fail('Invalid installer manifest');
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 16) fail('Invalid installer parts');
  const required = ['latest.yml', installer.name + '.blockmap', 'windows-release-validation.json', 'release-notes.md'];
  if (!Array.isArray(metadata) || metadata.length !== required.length || new Set(metadata.map(item => item.name)).size !== required.length
    || required.some(name => !metadata.some(item => item.name === name))) fail('Expected exactly the release metadata and notes');
  const chunks = parts.map((part, index) => {
    if (part.name !== `part-${String(index + 1).padStart(3, '0')}.bin` || part.size > 24 * 1024 * 1024) fail('Invalid part order or size');
    return readChecked(path.join(input, 'parts'), part);
  });
  const installerBytes = Buffer.concat(chunks);
  if (installerBytes.length !== installer.size || sha256(installerBytes) !== installer.sha256) fail('Reconstructed installer checksum mismatch');
  if (installerBytes.toString('ascii', 0, 2) !== 'MZ') fail('Installer is not a Windows executable');
  const peOffset = installerBytes.readUInt32LE(0x3c);
  if (peOffset + 6 > installerBytes.length || installerBytes.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') fail('Installer PE header is missing');
  const checkedMetadata = metadata.map(item => [item.name, readChecked(input, item)]);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, installer.name), installerBytes);
  for (const [name, bytes] of checkedMetadata) fs.writeFileSync(path.join(output, name), bytes);
  const verified = verifyWindowsRelease(output, version);
  if (!verified.attestation || verified.attestation.sourceCommit !== sourceCommit) fail('Windows test evidence does not match this source');
  const evidence = verified.attestation.windowsPackage;
  if (!(evidence.checkedSourceFiles > 0) || !(evidence.checkedResourceFiles > 0) || !(evidence.checkedPeFiles > 0)
    || !Array.isArray(evidence.nativeAddons) || evidence.nativeAddons.length < 2
    || evidence.nativeAddons.some(item => item.machine !== 'x64' || !/^[a-f0-9]{64}$/.test(item.sha256))) fail('Packaged native modules/resources were not validated');
  fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { ...verified, manifest };
}
function gh(args, { allowMissing = false } = {}) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowMissing && /not found|HTTP 404/i.test(result.stderr || '')) return null;
    fail(`GitHub command failed: ${result.stderr || result.error?.message || result.status}`);
  }
  return result.stdout;
}
function currentContext() {
  if (process.env.GITHUB_REPOSITORY !== repository) fail('This workflow can publish only to the releases repository');
  const branch = process.env.GITHUB_REF_NAME || '';
  const match = /^release-staging\/v(\d+\.\d+\.\d+)$/.exec(branch);
  if (!match) fail('Publish only from an exact versioned staging branch');
  return { version: match[1], input: path.join(root, 'incoming', 'v' + match[1]), output: path.join(root, 'reconstructed') };
}
export function publish(directory, version) {
  if (!process.env.GH_TOKEN) fail('Repository release token is required');
  const verified = verifyWindowsRelease(directory, version);
  if (!verified.attestation) fail('Windows installer smoke evidence is required');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'));
  if (manifest.version !== version || manifest.sourceCommit !== verified.attestation.sourceCommit) fail('Release provenance mismatch');
  const tag = 'v' + version;
  const existingText = gh(['release', 'view', tag, '--repo', repository, '--json', 'isDraft,isPrerelease,assets'], { allowMissing: true });
  const existing = existingText ? JSON.parse(existingText) : null;
  if (existing && !existing.isDraft) fail('Refusing to overwrite a published version');
  const latestText = gh(['api', `repos/${repository}/releases/latest`], { allowMissing: true });
  if (latestText) {
    const latest = JSON.parse(latestText).tag_name?.replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(latest || '')) fail('Cannot compare current stable version');
    const before = latest.split('.').map(Number), after = version.split('.').map(Number);
    const first = after.findIndex((number, index) => number !== before[index]);
    if (first < 0 || after[first] < before[first]) fail('Release must advance the stable version');
  }
  const assets = [verified.installer, verified.installer + '.blockmap', 'latest.yml', 'windows-release-validation.json', 'release-manifest.json'];
  if (existing?.assets?.some(asset => !assets.includes(asset.name))) fail('Draft has unexpected assets; review it before publishing');
  if (!existing) gh(['release', 'create', tag, '--repo', repository, '--draft', '--title', `The Novelist ${version}`, '--notes-file', path.join(directory, 'release-notes.md')]);
  const downloaded = path.join(root, 'downloaded-release');
  if (fs.existsSync(downloaded)) fail('Download verification directory must be fresh');
  fs.mkdirSync(downloaded);
  for (const asset of assets) {
    if (existing?.assets?.some(item => item.name === asset)) {
      gh(['release', 'download', tag, '--repo', repository, '--pattern', asset, '--dir', downloaded]);
      if (!fs.readFileSync(path.join(directory, asset)).equals(fs.readFileSync(path.join(downloaded, asset)))) fail(`Existing draft asset differs: ${asset}`);
    } else gh(['release', 'upload', tag, path.join(directory, asset), '--repo', repository]);
  }
  gh(['release', 'download', tag, '--repo', repository, '--dir', downloaded, '--clobber']);
  for (const asset of assets) if (!fs.readFileSync(path.join(directory, asset)).equals(fs.readFileSync(path.join(downloaded, asset)))) fail(`Uploaded asset differs: ${asset}`);
  verifyWindowsRelease(downloaded, version);
  gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest']);
  const latest = JSON.parse(gh(['api', `repos/${repository}/releases/latest`]));
  if (latest.tag_name !== tag || latest.draft || latest.prerelease) fail('Stable release promotion did not match the verified draft');
  console.log(`Published verified stable release: https://github.com/${repository}/releases/tag/${tag}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { version, input, output } = currentContext();
    if (process.argv[2] === 'reconstruct') {
      const result = reconstruct(input, output, { expectedVersion: version });
      console.log(`Verified ${version}: ${result.installerSize} bytes, SHA-256 ${result.installerSha256}`);
    } else if (process.argv[2] === 'publish') publish(output, version);
    else fail('Usage: staged-release.mjs reconstruct|publish');
  } catch (error) { console.error(`Release stopped: ${error.message}`); process.exitCode = 1; }
}
