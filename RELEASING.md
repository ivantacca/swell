# Releasing

Alpha releases are **unsigned** macOS builds made by hand. Beta releases will be signed and
notarized (the same script does it when the Apple credentials are set).

## Making a build

From the Firefox checkout (see the README):

```sh
export MOZCONFIG=$PWD/swell/mozconfig
swell/tools/package.sh                 # build, stage, sign (ad hoc), make the disk image
```

It prints `obj-swell/dist/release/Swell-<version>-<arch>.dmg` and a `.sha256` next to it. For a
signed build set `SWELL_SIGN_IDENTITY` ("Developer ID Application: ...") and
`SWELL_NOTARY_PROFILE` (a `notarytool` keychain profile) first.

On Linux the same script makes `obj-swell/dist/release/Swell-<version>-<arch>.tar.xz` (and a
`.sha256`) with `MOZCONFIG` defaulting to `swell/mozconfig.linux`, after `./mach bootstrap`.
The build then compiles against the Debian sysroot that bootstrap downloads, not the libraries
of the machine, so any distribution can make it: the binaries need glibc 2.17, like Firefox's
(`libonnxruntime.so`, loaded only for on-device machine learning, needs 2.34). The tarball holds
the application, `install.sh` (adds Swell to the user's menu, `--uninstall` removes it) and the
icons. There is no Flatpak yet.

Check the build before publishing: copy the app to Applications, open it (right-click, Open),
and run through the manual checks in `docs/` (camera, downloads, print, restart).

## First publication

Settings that live on GitHub, not in the repository, and that the docs rely on:

1. Create the repository as `ivantacca/swell` (the name is used in the README, `site/`, the
   About dialog and `swell.update.repository`).
2. Settings > Code security: turn on **Private vulnerability reporting** (`SECURITY.md`).
3. Settings > Pages > Source: **GitHub Actions** (`.github/workflows/pages.yml`).
4. Push `main`, check that the `ci` workflow is green (the `lint` job has not run on GitHub
   before and may need a setup fix), then publish the first pre-release as described below.

## Publishing

1. Make sure the working tree is committed, then run `tools/release.sh`. It bumps
   `app/config/version.txt` from the conventional commits since the last tag, commits it and
   tags `v<version>-alpha` (only the tag says alpha; the app and the disk image carry the plain
   version). Build the disk image afterwards with `tools/package.sh`.
2. Push the commit and the tag: `git push origin main v<version>-alpha`.
3. Create the release as a **pre-release** and attach the disk image and its checksum:

   ```sh
   gh release create v<version>-alpha --prerelease --title "Swell <version> (alpha)" \
     --notes-file RELEASE_NOTES.md obj-swell/dist/release/Swell-<version>-arm64.dmg* \
     obj-swell/dist/release/Swell-<version>-x86_64.tar.xz*
   ```
4. The download page (`site/`, published by GitHub Pages) links to the latest release. The
   in-app "Check for updates" reads the latest release from GitHub, so a release is also how
   users learn of a new version.

## Release notes

Say what is new, what is known broken, and that the alpha is unsigned (with the Open steps).
