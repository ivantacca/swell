/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  Downloads: "resource://gre/modules/Downloads.sys.mjs",
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
});

add_task(async function test_an_attachment_is_saved_without_asking() {
  const { bridge, app } = await swellApp();
  const space = await freshSpace(app, "Downloads");
  const dir = new FileUtils.File(
    await IOUtils.createUniqueDirectory(PathUtils.tempDir, "swell-downloads")
  );
  Services.prefs.setIntPref("browser.download.folderList", 2);
  Services.prefs.setComplexValue("browser.download.dir", Ci.nsIFile, dir);
  registerCleanupFunction(async () => {
    Services.prefs.clearUserPref("browser.download.folderList");
    Services.prefs.clearUserPref("browser.download.dir");
    await IOUtils.remove(dir.path, { recursive: true });
  });
  const list = await Downloads.getList(Downloads.ALL);
  const finished = new Promise(resolve => {
    list.addView({
      onDownloadChanged(download) {
        if (download.succeeded || download.error) {
          resolve(download);
        }
      },
    });
  });
  const liveTab = await bridge.openUrl(`${BASE}file_blank.html`, space.id);
  await rendered(
    () => bridge.tab(liveTab)?.url == `${BASE}file_blank.html`,
    "loaded"
  );
  await SpecialPowers.spawn(
    bridge.tab(liveTab).browser,
    [`${BASE}file_download.sjs`],
    url => {
      content.location.href = url;
    }
  );
  const download = await finished;
  Assert.ok(download.succeeded, `the download finished: ${download.error}`);
  Assert.ok(await IOUtils.exists(download.target.path), "the file exists");
  Assert.equal(
    new TextDecoder().decode(await IOUtils.read(download.target.path)),
    "swell download test"
  );
  Assert.equal(PathUtils.filename(download.target.path), "swell-test.bin");
  await rendered(
    () =>
      [...document.querySelectorAll("#toasts .toast-text")].some(
        t => t.textContent == "Downloaded swell-test.bin"
      ),
    "a toast says the download finished"
  );

  await app.downloads.show();
  const panel = document.getElementById("downloads-panel");
  Assert.ok(!panel.hidden, "the downloads open in the sidebar");
  Assert.greater(panel.getBoundingClientRect().height, 0, "and take room");
  Assert.deepEqual(
    [...panel.querySelectorAll(".download-name")].map(n => n.textContent),
    ["swell-test.bin"],
    "the panel lists this space's download"
  );
  const row = panel.querySelector(".download-row");
  Assert.equal(row.dataset.state, "done", "the row is finished");
  Assert.ok(
    row.querySelector(".download-state").textContent.includes("19 B"),
    "the row shows the size"
  );
  Assert.ok(
    row.querySelector(".download-button.show"),
    "and a show in folder action"
  );
  Assert.equal(
    document.getElementById("lists").getBoundingClientRect().height,
    0,
    "in place of the tabs"
  );
  app.switchSpaceBy(1);
  Assert.ok(panel.hidden, "going right closes it");
  Assert.greater(
    document.getElementById("lists").getBoundingClientRect().height,
    0,
    "and the tabs are back"
  );
  await app.switchSpace(app.spaces[0].id);
  await rendered(
    () => app.activeSpaceId == app.spaces[0].id,
    "in the first space"
  );
  app.switchSpaceBy(-1);
  Assert.ok(!panel.hidden, "going left of the first space opens it");
  document.getElementById("downloads-button").click();
  Assert.ok(panel.hidden, "the button closes it");
  await closeAllTabs(bridge);
});
