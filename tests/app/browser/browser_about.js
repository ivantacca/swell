/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { compareVersions, checkForUpdate, pickAsset, buildDate } =
  ChromeUtils.importESModule("chrome://swell/content/about.mjs");

const release = (tag, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/example/swell/releases/tag/${tag}`,
  body: `Notes of ${tag}`,
  draft: false,
  prerelease: false,
  ...extra,
});

add_task(function test_versions_compare_numbers_not_text() {
  Assert.less(compareVersions("0.9.0", "0.10.0"), 0, "0.9 is older than 0.10");
  Assert.less(compareVersions("v0.49.6", "0.50.0"), 0, "the v is ignored");
  Assert.equal(compareVersions("1.0", "1.0.0"), 0, "missing parts are zero");
  Assert.greater(
    compareVersions("1.2.3", "1.2.2-alpha"),
    0,
    "a suffix is ignored"
  );
});

add_task(function test_the_build_date_is_readable() {
  Assert.equal(buildDate("20261026103845"), "2026-10-26 10:38");
});

add_task(
  async function test_the_check_finds_a_newer_release_and_nothing_else() {
    const asked = [];
    const fetchJson = list => async url => {
      asked.push(url);
      return list;
    };
    const base = { repository: "example/swell", prereleases: true };

    let result = await checkForUpdate({
      ...base,
      current: "0.49.6",
      fetchJson: fetchJson([
        release("v0.49.5", { prerelease: true }),
        release("v0.50.1", { prerelease: true }),
        release("v0.50.0", { prerelease: true }),
        release("v9.0.0", { draft: true }),
      ]),
    });
    Assert.ok(result.available, "a newer pre-release is found");
    Assert.equal(result.version, "0.50.1", "the newest, not the first listed");
    Assert.ok(result.url.endsWith("/v0.50.1"), "with its page");
    Assert.equal(result.notes, "Notes of v0.50.1");
    Assert.equal(
      asked[0],
      "https://api.github.com/repos/example/swell/releases?per_page=20",
      "one request, to the releases of the project"
    );

    result = await checkForUpdate({
      ...base,
      current: "0.50.1",
      fetchJson: fetchJson([release("v0.50.1", { prerelease: true })]),
    });
    Assert.ok(!result.available, "the same version is not an update");

    result = await checkForUpdate({
      ...base,
      prereleases: false,
      current: "0.49.6",
      fetchJson: fetchJson([release("v0.50.1", { prerelease: true })]),
    });
    Assert.ok(!result.available, "the stable channel leaves pre-releases out");

    result = await checkForUpdate({
      ...base,
      current: "0.49.6",
      fetchJson: fetchJson([]),
    });
    Assert.ok(!result.available, "no releases, no update");
  }
);

add_task(function test_the_file_for_this_system_is_picked() {
  const asset = name => ({
    name,
    browser_download_url: `https://example.com/${name}`,
  });
  const assets = [
    asset("Swell-0.52.0-arm64.dmg"),
    asset("Swell-0.52.0-arm64.dmg.sha256"),
    asset("Swell-0.52.0-x86_64.dmg"),
    asset("Swell-0.52.0-x86_64.tar.xz"),
    asset("Swell-0.52.0-aarch64.tar.xz"),
    asset("Swell-0.52.0-aarch64.tar.xz.sha256"),
  ];
  const url = name => `https://example.com/${name}`;

  Assert.equal(
    pickAsset(assets, "macosx", "arm64"),
    url("Swell-0.52.0-arm64.dmg")
  );
  Assert.equal(
    pickAsset(assets, "macosx", "aarch64"),
    url("Swell-0.52.0-arm64.dmg"),
    "aarch64 is arm64"
  );
  Assert.equal(
    pickAsset(assets, "macosx", "x86_64"),
    url("Swell-0.52.0-x86_64.dmg")
  );
  Assert.equal(
    pickAsset(assets, "linux", "x86_64"),
    url("Swell-0.52.0-x86_64.tar.xz")
  );
  Assert.equal(
    pickAsset(assets, "linux", "x86-64"),
    url("Swell-0.52.0-x86_64.tar.xz"),
    "Gecko's x86-64 is x86_64"
  );
  Assert.equal(
    pickAsset(assets, "linux", "aarch64"),
    url("Swell-0.52.0-aarch64.tar.xz")
  );
  Assert.equal(
    pickAsset(assets, "linux", "arm64"),
    url("Swell-0.52.0-aarch64.tar.xz"),
    "the name is normalized too"
  );
  Assert.equal(pickAsset(assets, "win", "x86_64"), null, "no Windows file");
  Assert.equal(pickAsset([], "macosx", "arm64"), null, "no assets");
  Assert.equal(pickAsset(undefined, "macosx", "arm64"), null, "no list");
  Assert.equal(pickAsset(assets, "macosx", undefined), null, "unknown CPU");
});

add_task(async function test_the_check_links_the_file_when_there_is_one() {
  const assets = [
    {
      name: "Swell-0.52.0-arm64.dmg",
      browser_download_url: "https://example.com/Swell-0.52.0-arm64.dmg",
    },
  ];
  const fetchJson = async () => [
    release("v0.52.0", { prerelease: true, assets }),
  ];
  const base = {
    repository: "example/swell",
    prereleases: true,
    current: "0.51.0",
    fetchJson,
  };

  let result = await checkForUpdate({
    ...base,
    platform: "macosx",
    arch: "arm64",
  });
  Assert.equal(result.downloadUrl, assets[0].browser_download_url);
  Assert.ok(result.url.endsWith("/v0.52.0"), "the release page stays");

  result = await checkForUpdate({ ...base, platform: "linux", arch: "x86_64" });
  Assert.ok(result.available, "still an update");
  Assert.equal(result.downloadUrl, null, "no file for this system");

  result = await checkForUpdate(base);
  Assert.equal(result.downloadUrl, null, "no platform given, no file");
});

add_task(async function test_about_shows_the_version_and_build() {
  const { app } = await swellApp();
  app.about.show();
  const dialog = document.getElementById("about-dialog");
  Assert.ok(dialog.open, "About opens");
  Assert.equal(
    document.getElementById("about-version").textContent,
    `Version ${AppConstants.MOZ_APP_VERSION_DISPLAY}`,
    "with the version of the application"
  );
  const build = document.getElementById("about-build").textContent;
  Assert.ok(
    build.includes(buildDate(Services.appinfo.appBuildID)),
    `and the build date: ${build}`
  );
  Assert.ok(
    build.includes(`Gecko ${Services.appinfo.platformVersion}`),
    "and the engine"
  );
  Assert.ok(
    document.getElementById("about-download").hidden,
    "no download yet"
  );
  Assert.ok(
    !!document.querySelector('#main-menubar [data-action="about"]'),
    "the menu has About Swell"
  );
  document.getElementById("about-close").click();
  Assert.ok(!dialog.open, "Close closes it");
});
