/** Check updater metadata and Windows smoke evidence before staging/promotion. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const yaml=require('js-yaml');
const digest=(data,algorithm,encoding='hex')=>crypto.createHash(algorithm).update(data).digest(encoding);
export function verifyWindowsRelease(directory,version,{installerPath}={}) {
  if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))throw new Error('Invalid release version');
  const metadata=yaml.load(fs.readFileSync(path.join(directory,'latest.yml'),'utf8'),{schema:yaml.JSON_SCHEMA});
  if(metadata?.version!==version||!Array.isArray(metadata.files)||metadata.files.length!==1)throw new Error('Updater version/files do not match the single Windows x64 release');
  const item=metadata.files[0];
  if(typeof item.url!=='string'||path.basename(item.url)!==item.url||!/^[A-Za-z0-9 _().-]+\.exe$/.test(item.url))throw new Error('Unsafe updater installer filename');
  if(metadata.path && metadata.path!==item.url)throw new Error('Updater path and file URL disagree');
  const installer=fs.readFileSync(installerPath||path.join(directory,item.url));
  if(installer.length<64||installer.toString('ascii',0,2)!=='MZ')throw new Error('Release installer is not a Windows executable');
  if(item.size!==installer.length||item.sha512!==digest(installer,'sha512','base64')||(metadata.sha512&&metadata.sha512!==item.sha512))throw new Error('Updater installer checksum or size mismatch');
  const blockmap=fs.readFileSync((installerPath||path.join(directory,item.url))+'.blockmap');
  if(!blockmap.length)throw new Error('Installer blockmap is empty');
  const attestationPath=path.join(directory,'windows-release-validation.json');
  let attestation;
  if(fs.existsSync(attestationPath)) {
    attestation=JSON.parse(fs.readFileSync(attestationPath,'utf8'));
    if(attestation.version!==version||attestation.windowsInstallerSmoke?.passed!==true||attestation.windowsInstallerSmoke?.version!==version)throw new Error('Release is missing successful Windows installer smoke evidence');
    if(attestation.windowsPackage?.mode!=='nsis'||attestation.windowsPackage?.installer?.sha256!==digest(installer,'sha256')
      ||attestation.windowsInstallerSmoke?.installerSha256!==digest(installer,'sha256')||!(attestation.windowsInstallerSmoke?.payloadFilesVerified>0))throw new Error('Release smoke/package evidence belongs to an incomplete or different installer');
    if(typeof attestation.sourceCommit!=='string'||!/^[a-f0-9]{40,64}$/i.test(attestation.sourceCommit)||attestation.windowsInstallerSmoke.sourceCommit!==attestation.sourceCommit)throw new Error('Release source commit evidence is missing or inconsistent');
    if(attestation.assets?.installer?.sha256!==digest(installer,'sha256')||attestation.assets?.blockmap?.sha256!==digest(blockmap,'sha256'))throw new Error('Release attestation checksum mismatch');
  }
  return {version,installer:item.url,installerSize:installer.length,installerSha256:digest(installer,'sha256'),blockmapSha256:digest(blockmap,'sha256'),metadata,attestation};
}
