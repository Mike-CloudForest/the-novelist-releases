# The Novelist — Releases

Download the latest version of **The Novelist** from the
[Releases page](https://github.com/Mike-CloudForest/the-novelist-releases/releases/latest).

This repository hosts installers and auto-update metadata only.

The release workflow reconstructs the installer from checksum-verified pieces,
checks the updater metadata and Windows installation evidence, uploads a draft,
downloads and compares every uploaded asset, then publishes that exact release.
Application source remains in its private repository.

For maintainers, after the private Windows build and installation smoke test
are green, fetch its temporary `release-artifacts/<version>` branch into an
isolated checkout. That orphan branch contains only `release-transfer/` with
compiled payloads and their validation metadata.

```sh
git switch -c release-staging/v2.1.3
npm ci --ignore-scripts
npm test
node scripts/stage-transfer.mjs /path/to/relay/release-transfer <tested-source-commit>
git add .github .gitignore package.json package-lock.json scripts test README.md incoming/v2.1.3
git diff --cached --stat
```

Review the staged file list and installer hash before committing and pushing
the versioned staging branch. Its push publishes the verified stable release
using this repository's own Actions token. A published version is immutable;
failed runs may resume only an existing draft whose assets are identical.
Keep the stable release and its updater assets available. The temporary
private relay branch and public staging payload branch can be removed after
the published assets have been downloaded and independently verified.
