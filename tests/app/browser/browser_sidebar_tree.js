/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

add_task(async function test_the_tree_renders_and_folders_collapse() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Tree");
  const folder = await core.createFolder(space.pinnedRoot, "Work", 0);
  await savedTab(core, space, folder, "https://a.test/", "Alpha");
  await savedTab(core, space, space.pinnedRoot, "https://b.test/", "Beta");

  await rendered(() => rowTitles("pinned").length == 3, "three pinned rows");
  Assert.deepEqual(rowTitles("pinned"), ["Work", "-Alpha", "Beta"]);

  rowFor(folder).click();
  await rendered(() => rowTitles("pinned").length == 2, "the folder collapses");
  Assert.deepEqual(rowTitles("pinned"), ["Work", "Beta"]);
  rowFor(folder).click();
  await rendered(() => rowTitles("pinned").length == 3, "the folder expands");
});

add_task(async function test_the_space_name_folds_the_pinned_list_away() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Fold");
  await savedTab(core, space, space.pinnedRoot, "https://a.test/", "Alpha");
  await rendered(() => rowTitles("pinned").length == 1, "a pinned row");

  const header = document.getElementById("pinned-header");
  Assert.equal(
    document.getElementById("pinned-name").textContent,
    "Fold",
    "the space's name"
  );
  Assert.ok(!document.getElementById("pinned").hidden, "the list is shown");

  header.click();
  await rendered(
    () => document.getElementById("pinned").hidden,
    "the list is folded away"
  );
  Assert.ok(app.space.pinnedCollapsed, "the core has it");
  Assert.equal(header.getAttribute("aria-expanded"), "false");

  header.click();
  await rendered(
    () => !document.getElementById("pinned").hidden,
    "the list is shown again"
  );
  Assert.ok(!app.space.pinnedCollapsed);
});

add_task(
  async function test_clicking_a_saved_tab_opens_it_in_the_spaces_container() {
    const { core, bridge, app } = await swellApp();
    const space = await freshSpace(app, "Click");
    const node = await savedTab(
      core,
      space,
      space.pinnedRoot,
      `${BASE}file_blank.html`,
      "Blank"
    );
    await rendered(() => rowFor(node), "the saved tab is drawn");
    Assert.ok(!rowFor(node).classList.contains("open"));

    rowFor(node).click();
    await rendered(
      () => bridge.selectedTab?.node === node,
      "the tab opens and is selected"
    );
    const tab = bridge.selectedTab;
    Assert.equal(tab.userContextId, space.userContextId);
    await rendered(
      () => rowFor(node).classList.contains("selected"),
      "the row shows it is selected"
    );
    Assert.ok(
      rowFor(node).querySelector(".close"),
      "an open tab has a close button"
    );

    rowFor(node).querySelector(".close").click();
    await rendered(() => !bridge.tab(tab.liveTab), "the tab closes");
    await rendered(
      () => !rowFor(node).classList.contains("open"),
      "the row is no longer open"
    );
    Assert.ok(
      rowFor(node),
      "a pinned tab keeps its row after its page is closed"
    );
  }
);

add_task(async function test_a_row_can_be_renamed_in_place() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Rename");
  const node = await savedTab(
    core,
    space,
    space.pinnedRoot,
    "https://a.test/",
    "Alpha"
  );
  await rendered(() => rowFor(node), "drawn");

  app.sidebar.startRename(node);
  const input = rowFor(node).querySelector(".rename");
  Assert.ok(input, "an input replaces the title");
  input.value = "Gamma";
  input.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
  );
  await rendered(
    () => rowTitles("pinned")[0] == "Gamma",
    "the new title is shown"
  );
});

add_task(async function test_the_context_menu_pins_unpins_and_deletes() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Menu");
  const node = await savedTab(
    core,
    space,
    space.pinnedRoot,
    "https://a.test/",
    "Alpha"
  );
  await rendered(() => rowFor(node), "drawn");
  const menu = document.getElementById("menu");
  const choose = async label => {
    rowFor(node).dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 40,
        clientY: 40,
      })
    );
    Assert.ok(!menu.hidden, "the menu opens");
    const labels = [...menu.querySelectorAll("button")].map(b => b.textContent);
    Assert.ok(labels.includes(label), `${label} is in the menu: ${labels}`);
    [...menu.querySelectorAll("button")]
      .find(b => b.textContent == label)
      ?.click();
  };

  await choose("Unpin");
  await rendered(
    () =>
      rowTitles("today").includes("Alpha") &&
      !rowTitles("pinned").includes("Alpha"),
    "unpinned to Today"
  );
  await choose("Pin");
  await rendered(() => rowTitles("pinned").includes("Alpha"), "pinned again");
  await choose("Delete");
  await rendered(() => !rowFor(node), "the row is deleted");
});

add_task(async function test_space_buttons_switch_what_is_shown() {
  const { core, app } = await swellApp();
  const a = await freshSpace(app, "One");
  await savedTab(core, a, a.pinnedRoot, "https://a.test/", "In one");
  const b = await freshSpace(app, "Two");
  await savedTab(core, b, b.pinnedRoot, "https://b.test/", "In two");
  await rendered(
    () => rowTitles("pinned").includes("In two"),
    "space Two is shown"
  );
  Assert.ok(!rowTitles("pinned").includes("In one"));

  document
    .querySelector(`#spaces .space[data-id="${CSS.escape(a.id)}"]`)
    .click();
  await rendered(
    () => rowTitles("pinned").includes("In one"),
    "space One is shown"
  );
  Assert.ok(
    !rowTitles("pinned").includes("In two"),
    "another space's tabs are not drawn"
  );
  Assert.ok(
    document
      .querySelector(`#spaces .space[data-id="${CSS.escape(a.id)}"]`)
      .classList.contains("active")
  );
});

function dragEvent(type, target, where = 0.5) {
  const { left, top, width, height } = target.getBoundingClientRect();
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: left + width / 2,
    clientY: top + height * where,
    dataTransfer: dragEvent.transfer,
  });
}

async function drag(sourceId, target, where) {
  dragEvent.transfer = new DataTransfer();
  const source = rowFor(sourceId);
  source.dispatchEvent(dragEvent("dragstart", source));
  target.dispatchEvent(dragEvent("dragover", target, where));
  target.dispatchEvent(dragEvent("drop", target, where));
  source.dispatchEvent(dragEvent("dragend", source));
}

add_task(async function test_dragging_reorders_pins_and_nests() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Drag");
  const folder = await core.createFolder(space.pinnedRoot, "Folder", 0);
  const a = await savedTab(
    core,
    space,
    space.pinnedRoot,
    "https://a.test/",
    "A"
  );
  const b = await savedTab(
    core,
    space,
    space.pinnedRoot,
    "https://b.test/",
    "B"
  );
  const { liveTab, node: today } = await core.onTabOpened(
    "main",
    space.id,
    "https://t.test/"
  );
  await core.onNavigation(liveTab, "https://t.test/", "T", Transition.TYPED);
  await rendered(
    () => rowTitles("today").length == 1 && rowTitles("pinned").length == 3,
    "drawn"
  );
  Assert.deepEqual(rowTitles("pinned"), ["Folder", "A", "B"]);

  await drag(b, rowFor(a), 0.1);
  await rendered(
    () => rowTitles("pinned").join() == "Folder,B,A",
    "B moved before A"
  );

  await drag(a, rowFor(folder), 0.5);
  await rendered(
    () => rowTitles("pinned").join() == "Folder,-A,B",
    "A moved into the folder"
  );

  await drag(today, rowFor(b), 0.9);
  await rendered(
    () =>
      rowTitles("pinned").join() == "Folder,-A,B,T" &&
      !rowTitles("today").length,
    "a Today tab is pinned by dragging"
  );

  const folderTodayDrop = document.getElementById("today");
  await drag(folder, folderTodayDrop, 0.5);
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 100));
  Assert.deepEqual(
    rowTitles("pinned"),
    ["Folder", "-A", "B", "T"],
    "Today refuses folders"
  );
  await core.onTabClosed(liveTab);
});

function clickRow(id, { shift = false, accel = false } = {}) {
  const mac = Services.appinfo.OS == "Darwin";
  rowFor(id).dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      shiftKey: shift,
      metaKey: accel && mac,
      ctrlKey: accel && !mac,
    })
  );
}

function selectedRows() {
  return [...document.querySelectorAll(".row.multi-selected")].map(
    row => row.dataset.id
  );
}

async function dragSelection(sourceId, target, where) {
  dragEvent.transfer = new DataTransfer();
  const source = rowFor(sourceId);
  source.dispatchEvent(dragEvent("dragstart", source));
  target.dispatchEvent(dragEvent("dragover", target, where));
  target.dispatchEvent(dragEvent("drop", target, where));
  source.dispatchEvent(dragEvent("dragend", source));
}

async function savedTabs(core, space, names) {
  const nodes = [];
  for (const name of names) {
    nodes.push(
      await savedTab(
        core,
        space,
        space.pinnedRoot,
        `https://${name.toLowerCase()}.test/`,
        name
      )
    );
  }
  return nodes;
}

add_task(async function test_selecting_several_rows_and_making_a_folder() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Select");
  const [a, b, c, d] = await savedTabs(core, space, ["A", "B", "C", "D"]);
  await rendered(() => rowFor(a) && rowFor(d), "the four tabs are drawn");

  clickRow(a, { accel: true });
  clickRow(c, { accel: true });
  Assert.deepEqual(selectedRows(), [a, c], "accel toggles single rows");
  Assert.ok(!rowFor(a).classList.contains("open"), "nothing was opened");

  clickRow(c, { accel: true });
  Assert.deepEqual(selectedRows(), [a], "accel again deselects");

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  Assert.deepEqual(selectedRows(), [], "Escape clears the selection");

  clickRow(a, { accel: true });
  clickRow(d, { shift: true });
  Assert.deepEqual(
    selectedRows(),
    [a, b, c, d],
    "shift selects from the anchor to the row"
  );

  clickRow(b, { accel: true });
  Assert.deepEqual(selectedRows(), [a, c, d]);

  rowFor(c).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
  );
  const item = document.querySelector("#menu button");
  Assert.equal(item.textContent, "Create folder with 3 items");
  item.click();
  await rendered(() => rowTitles("pinned").length == 5, "the folder is made");
  Assert.deepEqual(
    rowTitles("pinned").filter(title => title.startsWith("-")),
    ["-A", "-C", "-D"],
    "the selected rows are in the folder, in order"
  );
  Assert.ok(rowTitles("pinned").includes("B"), "B stayed out");
  Assert.deepEqual(selectedRows(), [], "the selection is gone");
});

add_task(async function test_dragging_a_selection_moves_all_of_it() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "MultiDrag");
  const folder = await core.createFolder(space.pinnedRoot, "Folder", 0);
  const [a, b, c] = await savedTabs(core, space, ["A", "B", "C"]);
  await rendered(() => rowFor(a) && rowFor(c), "the three tabs are drawn");

  clickRow(a, { accel: true });
  clickRow(c, { accel: true });
  await dragSelection(a, rowFor(folder), 0.5);
  await rendered(
    () => rowTitles("pinned").join() == "Folder,-A,-C,B",
    "both selected tabs went into the folder"
  );

  await dragSelection(b, rowFor(folder), 0.5);
  await rendered(
    () => rowTitles("pinned").join() == "Folder,-A,-C,-B",
    "a row outside the selection drags alone"
  );
  Assert.deepEqual(selectedRows(), [], "dragging it cleared the selection");
});

add_task(async function test_a_collapsed_folder_keeps_its_open_pages() {
  const { core, bridge, app } = await swellApp();
  const space = await freshSpace(app, "Collapsed");
  const folder = await core.createFolder(space.pinnedRoot, "Work", 0);
  const open = await savedTab(
    core,
    space,
    folder,
    `${BASE}file_blank.html`,
    "Open"
  );
  await savedTab(core, space, folder, "https://closed.test/", "Closed");
  await rendered(
    () => rowTitles("pinned").join() == "Work,-Open,-Closed",
    "the folder is drawn"
  );

  rowFor(open).click();
  await rendered(() => bridge.selectedTab?.node === open, "the page opens");

  rowFor(folder).click();
  await rendered(
    () => rowTitles("pinned").join() == "Work,-blank",
    "the folder collapses but keeps the open page"
  );

  app.closeNodeTab(open);
  await rendered(
    () => rowTitles("pinned").join() == "Work",
    "closing the page drops its row"
  );

  rowFor(folder).click();
  await rendered(
    () => rowTitles("pinned").join() == "Work,-blank,-Closed",
    "expanding shows every page again"
  );
});

function favoriteIds() {
  return [...document.querySelectorAll("#favorites .favorite")].map(
    tile => tile.dataset.id ?? "placeholder"
  );
}

function dragAt(type, target, fraction, relatedTarget = null) {
  const { left, top, width, height } = target.getBoundingClientRect();
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: left + width * fraction,
    clientY: top + height / 2,
    relatedTarget,
    dataTransfer: dragAt.transfer,
  });
}

async function slidesDone() {
  await Promise.allSettled(document.getAnimations().map(a => a.finished));
}

function tileFor(id) {
  return document.querySelector(`#favorites .favorite[data-id="${id}"]`);
}

add_task(async function test_favorites_move_while_a_tile_is_dragged() {
  const { core, app } = await swellApp();
  const space = await freshSpace(app, "Favorites");
  const [a, b, c] = await savedTabs(core, space, ["A", "B", "C"]);
  for (const [index, id] of [a, b, c].entries()) {
    await core.moveNode(id, space.favoritesRoot, index);
  }
  await rendered(() => favoriteIds().join() == [a, b, c].join(), "drawn");

  dragAt.transfer = new DataTransfer();
  const source = tileFor(a);
  source.dispatchEvent(dragAt("dragstart", source, 0.5));
  const favorites = document.getElementById("favorites");

  tileFor(c).dispatchEvent(dragAt("dragover", tileFor(c), 0.9));
  await slidesDone();
  Assert.deepEqual(favoriteIds(), [b, c, a], "A is shown after C");
  Assert.ok(tileFor(a).isConnected, "the tile being dragged stays in the page");

  tileFor(b).dispatchEvent(dragAt("dragover", tileFor(b), 0.1));
  await slidesDone();
  Assert.deepEqual(favoriteIds(), [a, b, c], "back where it was: no change");

  tileFor(c).dispatchEvent(dragAt("dragover", tileFor(c), 0.1));
  await slidesDone();
  Assert.deepEqual(favoriteIds(), [b, a, c], "A is shown before C");

  tileFor(b).dispatchEvent(dragAt("dragover", tileFor(b), 0.9));
  await slidesDone();
  favorites.dispatchEvent(dragAt("dragleave", favorites, 0.5));
  Assert.deepEqual(favoriteIds(), [a, b, c], "leaving puts the tiles back");

  tileFor(c).dispatchEvent(dragAt("dragover", tileFor(c), 0.9));
  await slidesDone();
  tileFor(c).dispatchEvent(dragAt("drop", tileFor(c), 0.9));
  source.dispatchEvent(dragAt("dragend", source, 0.5));
  await rendered(
    () => app.state.childrenOf(space.favoritesRoot).join() == [b, c, a].join(),
    "the drop makes the order shown"
  );
  Assert.deepEqual(favoriteIds(), [b, c, a]);
});

add_task(
  async function test_a_placeholder_shows_where_a_tab_will_be_favorited() {
    const { core, app } = await swellApp();
    const space = await freshSpace(app, "Placeholder");
    const [a, b] = await savedTabs(core, space, ["A", "B"]);
    const extra = await savedTab(
      core,
      space,
      space.pinnedRoot,
      "https://x.test/",
      "X"
    );
    for (const [index, id] of [a, b].entries()) {
      await core.moveNode(id, space.favoritesRoot, index);
    }
    await rendered(
      () => favoriteIds().join() == [a, b].join() && rowFor(extra),
      "drawn"
    );

    dragAt.transfer = new DataTransfer();
    const source = rowFor(extra);
    source.dispatchEvent(dragAt("dragstart", source, 0.5));
    tileFor(b).dispatchEvent(dragAt("dragover", tileFor(b), 0.1));
    await slidesDone();
    Assert.deepEqual(favoriteIds(), [a, "placeholder", b], "room is made");
    tileFor(a).dispatchEvent(dragAt("dragover", tileFor(a), 0.1));
    await slidesDone();
    Assert.deepEqual(favoriteIds(), ["placeholder", a, b], "and it follows");

    tileFor(b).dispatchEvent(dragAt("dragover", tileFor(b), 0.9));
    await slidesDone();
    tileFor(b).dispatchEvent(dragAt("drop", tileFor(b), 0.9));
    source.dispatchEvent(dragAt("dragend", source, 0.5));
    await rendered(
      () =>
        app.state.childrenOf(space.favoritesRoot).join() ==
        [a, b, extra].join(),
      "the tab becomes the last favorite"
    );
    await rendered(
      () => !document.querySelector("#favorites .placeholder"),
      "the placeholder is gone"
    );
  }
);
