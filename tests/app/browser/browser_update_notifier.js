/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { UpdateNotifier } = ChromeUtils.importESModule(
  "chrome://swell/content/update-notifier.mjs"
);

const PREFS = [
  "swell.update.autocheck",
  "swell.update.lastCheck",
  "swell.update.dismissed",
  "swell.update.repository",
];

const release = tag => ({
  tag_name: tag,
  html_url: `https://github.com/example/swell/releases/tag/${tag}`,
  body: "",
  draft: false,
  prerelease: true,
});

const row = () => document.getElementById("update-row");

async function notifier(releases, options = {}) {
  const { app } = await swellApp();
  const requests = [];
  const opened = [];
  const stub = {
    document: app.document,
    openUrlInActiveSpace: url => opened.push(url),
  };
  const instance = new UpdateNotifier(stub, {
    fetchJson: async url => {
      requests.push(url);
      return releases;
    },
    ...options,
  });
  return { instance, requests, opened };
}

add_setup(() => {
  registerCleanupFunction(() => {
    for (const pref of PREFS) {
      Services.prefs.clearUserPref(pref);
    }
    row().hidden = true;
  });
  Services.prefs.setStringPref("swell.update.repository", "example/swell");
});

add_task(async function test_a_newer_release_shows_the_badge_and_opens_it() {
  const { instance, requests, opened } = await notifier([release("v99.0.0")]);
  Assert.ok(row().hidden, "no badge before a check");
  await instance.check();
  Assert.deepEqual(
    requests,
    ["https://api.github.com/repos/example/swell/releases?per_page=20"],
    "one request"
  );
  Assert.ok(!row().hidden, "the badge shows");
  Assert.equal(
    document.getElementById("update-label").textContent,
    "Swell 99.0.0 is available"
  );
  Assert.greater(
    Services.prefs.getIntPref("swell.update.lastCheck", 0),
    0,
    "the time of the check is kept"
  );
  document.getElementById("update-badge").click();
  Assert.deepEqual(
    opened,
    [release("v99.0.0").html_url],
    "it opens the release"
  );
  row().hidden = true;
});

add_task(async function test_the_badge_opens_the_file_for_this_system() {
  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const extension = AppConstants.platform == "macosx" ? "dmg" : "tar.xz";
  // tools/package.sh names the file after `uname -m`, which says x86_64 for Gecko's x86-64.
  const arch = Services.sysinfo.getProperty("arch").replace("x86-64", "x86_64");
  const file = `https://example.com/Swell-99.0.0-${arch}.${extension}`;
  const { instance, opened } = await notifier([
    {
      ...release("v99.0.0"),
      assets: [
        {
          name: `Swell-99.0.0-${arch}.${extension}.sha256`,
          browser_download_url: `${file}.sha256`,
        },
        {
          name: `Swell-99.0.0-${arch}.${extension}`,
          browser_download_url: file,
        },
      ],
    },
  ]);
  await instance.check();
  Assert.equal(instance.update.downloadUrl, file);
  Assert.equal(document.getElementById("update-badge").title, "Download Swell");
  document.getElementById("update-badge").click();
  Assert.deepEqual(opened, [file], "it opens the file, not the page");
  row().hidden = true;
});

add_task(async function test_no_newer_release_shows_nothing() {
  const { instance } = await notifier([release("v0.0.1")]);
  await instance.check();
  Assert.ok(row().hidden, "an older release is not offered");
});

add_task(async function test_dismissing_hides_until_a_newer_release() {
  let { instance } = await notifier([release("v99.0.0")]);
  await instance.check();
  document.getElementById("update-dismiss").click();
  Assert.ok(row().hidden, "dismissed");
  Assert.equal(
    Services.prefs.getStringPref("swell.update.dismissed", ""),
    "99.0.0"
  );

  await instance.check();
  Assert.ok(row().hidden, "the same release stays hidden");

  ({ instance } = await notifier([release("v99.1.0")]));
  await instance.check();
  Assert.ok(!row().hidden, "a newer release shows again");
  row().hidden = true;

  ({ instance } = await notifier([release("v99.0.0")]));
  await instance.check({ manual: true });
  Assert.ok(!row().hidden, "a manual check shows a dismissed release again");
  row().hidden = true;
});

add_task(async function test_a_failed_check_is_silent_and_recorded() {
  Services.prefs.clearUserPref("swell.update.lastCheck");
  const { instance } = await notifier(null, {
    fetchJson: async () => {
      throw new Error("offline");
    },
  });
  await Assert.rejects(instance.check(), /offline/, "check() reports it");
  Assert.ok(row().hidden, "no badge");
});

add_task(async function test_start_follows_the_pref_and_the_interval() {
  const attempts = [];
  const fetchJson = async url => {
    attempts.push(url);
    return [];
  };
  const run = async () => {
    const { instance } = await notifier([], { fetchJson, delay: 10 });
    instance.start();
    // A negative check: nothing is expected to happen in this time.
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, 300));
  };

  Services.prefs.setBoolPref("swell.update.autocheck", false);
  Services.prefs.clearUserPref("swell.update.lastCheck");
  await run();
  Assert.equal(attempts.length, 0, "off: no request");

  Services.prefs.setBoolPref("swell.update.autocheck", true);
  Services.prefs.setIntPref(
    "swell.update.lastCheck",
    Math.floor(Date.now() / 1000)
  );
  await run();
  Assert.equal(attempts.length, 0, "checked a moment ago: no request");

  Services.prefs.clearUserPref("swell.update.lastCheck");
  await run();
  Assert.equal(attempts.length, 1, "due: one request");
  Services.prefs.setBoolPref("swell.update.autocheck", false);
});
