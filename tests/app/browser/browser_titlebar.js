/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const isMac = Services.appinfo.OS == "Darwin";

add_task(async function test_the_titlebar_is_ours_on_every_platform() {
  await swellApp();
  const root = document.documentElement;
  const titlebar = document.getElementById("titlebar");
  Assert.ok(
    root.hasAttribute("customtitlebar"),
    "the native titlebar is hidden from the start"
  );
  Assert.notEqual(getComputedStyle(titlebar).display, "none");
  const css = await (await fetch("chrome://swell/content/window.css")).text();
  Assert.ok(
    /:root\[customtitlebar\] #titlebar \{[^}]*-moz-window-dragging: drag/s.test(
      css
    ),
    "the strip is a drag region"
  );
});

add_task(async function test_macos_leaves_room_for_the_system_buttons() {
  if (!isMac) {
    return;
  }
  await swellApp();
  Assert.greaterOrEqual(
    parseInt(
      getComputedStyle(document.getElementById("sidebar")).paddingTop,
      10
    ),
    38,
    "the sidebar leaves room for the window controls"
  );
  Assert.equal(
    getComputedStyle(document.getElementById("window-controls")).display,
    "none",
    "the system draws the window buttons"
  );
});

add_task(async function test_other_platforms_draw_window_buttons() {
  if (isMac) {
    return;
  }
  await swellApp();
  const controls = document.getElementById("window-controls");
  Assert.ok(!controls.hidden);
  const shown = id =>
    getComputedStyle(document.getElementById(id)).display != "none";
  Assert.ok(shown("window-close"), "close");
  Assert.ok(shown("window-minimize"), "minimize");
  Assert.notEqual(
    shown("window-maximize"),
    shown("window-restore"),
    "one of maximize and restore"
  );
  const css = await (await fetch("chrome://swell/content/window.css")).text();
  Assert.ok(
    /#window-controls \{[^}]*-moz-window-dragging: no-drag/s.test(css),
    "the buttons are not part of the drag region"
  );
  // The strip is fixed over the top of #app, whose padding keeps its content below.
  const app = document.getElementById("app");
  Assert.greaterOrEqual(
    app.getBoundingClientRect().top +
      parseFloat(getComputedStyle(app).paddingTop),
    document.getElementById("titlebar").getBoundingClientRect().height - 1,
    "the app starts under the strip"
  );
});

add_task(async function test_window_buttons_follow_the_window_state() {
  if (isMac) {
    return;
  }
  await swellApp();
  const root = document.documentElement;
  window.maximize();
  await TestUtils.waitForCondition(
    () => root.hasAttribute("maximized"),
    "maximized is set"
  );
  Assert.equal(
    getComputedStyle(document.getElementById("window-maximize")).display,
    "none"
  );
  window.restore();
  await TestUtils.waitForCondition(
    () => !root.hasAttribute("maximized"),
    "maximized is gone"
  );
  Assert.equal(
    getComputedStyle(document.getElementById("window-restore")).display,
    "none"
  );
});
