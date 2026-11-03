/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const BASE = "https://example.com/browser/swell/tests/app/browser/";

ChromeUtils.defineESModuleGetters(this, {
  Icon: "moz-src:///swell/app/modules/Core.sys.mjs",
  Transition: "moz-src:///swell/app/modules/Core.sys.mjs",
});

// Lit, which toolkit widgets such as the autocomplete popup load, leaves this
// on the window; the harness reports leftover globals.
registerCleanupFunction(() => {
  delete window.litPropertyMetadata;
});

// The core and the bridge of the Swell window under test.
async function swellApp() {
  return window.SwellApp.ready;
}

// Opens `url` in `space` through the bridge and waits until it has loaded.
async function openInSpace(bridge, space, url) {
  const liveTab = await bridge.openUrl(url, space);
  const tab = await TestUtils.waitForCondition(
    () => bridge.tab(liveTab),
    `tab ${liveTab} appears`
  );
  await tab.ready;
  await TestUtils.waitForCondition(
    () =>
      tab.browser.currentURI?.spec == url &&
      !tab.loading &&
      tab.browser.browsingContext?.currentWindowGlobal,
    `${url} loads`
  );
  return tab;
}

async function newSpace(core, title) {
  const id = await core.createSpace(title, new Icon.Symbol({ name: "circle" }));
  return (await core.listSpaces()).find(space => space.id == id);
}

// Closes every tab, so the next test starts from an empty window.
async function closeAllTabs(bridge) {
  for (const tab of bridge.tabs()) {
    await bridge.closeTab(tab.liveTab);
  }
}

// A new space, made the active one, with its tree loaded.
async function freshSpace(app, title) {
  const space = await newSpace(app.core, title);
  await app.switchSpace(space.id);
  await TestUtils.waitForCondition(
    () => app.activeSpaceId == space.id && app.space?.id == space.id,
    `${title} becomes the active space`
  );
  return space;
}

// A saved tab under `parent`, with no tab open on it.
async function savedTab(core, space, parent, url, title) {
  const { liveTab, node } = await core.onTabOpened("main", space.id, url);
  await core.onNavigation(liveTab, url, title, Transition.TYPED);
  await core.moveNode(
    node,
    parent,
    (await core.spaceTree(space.id)).children.find(c => c.parent == parent).ids
      .length
  );
  await core.onTabClosed(liveTab);
  return node;
}

// The titles of the rows in a sidebar list, in order, indented by depth.
function rowTitles(listId) {
  return [...document.querySelectorAll(`#${listId} .row`)].map(row => {
    const depth = Math.round(
      (parseInt(row.style.paddingInlineStart, 10) - 6) / 14
    );
    return `${"-".repeat(depth)}${(row.querySelector(".title") ?? row.querySelector(".rename")).textContent}`;
  });
}

function rowFor(id) {
  return document.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
}

// `maxTries` of `interval` ms; the default is 5 s, which a loaded machine (right after a
// build, for one) can exceed for things that start processes or read a keychain.
async function rendered(condition, message, interval = 100, maxTries = 50) {
  return TestUtils.waitForCondition(condition, message, interval, maxTries);
}
