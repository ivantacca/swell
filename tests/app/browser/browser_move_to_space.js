/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

async function childrenOf(app, space, root) {
  const tree = await app.core.spaceTree(space.id);
  return tree.children.find(c => c.parent == root)?.ids ?? [];
}

add_task(async function test_a_saved_page_moves_to_another_space() {
  const { app } = await swellApp();
  const from = await freshSpace(app, "Move from");
  const to = await freshSpace(app, "Move to");
  await app.switchSpace(from.id);
  await rendered(() => app.space?.id == from.id, "source space");
  const node = await savedTab(
    app.core,
    from,
    from.pinnedRoot,
    "https://example.com/saved",
    "Saved"
  );
  await rendered(() => app.state.describe(node), "saved page in the tree");

  await app.moveToSpace(app.dragSnapshot([node]), to.id);

  Assert.deepEqual(await childrenOf(app, from, from.pinnedRoot), []);
  Assert.deepEqual(await childrenOf(app, to, to.pinnedRoot), [node]);
});

add_task(async function test_an_open_page_is_reopened_in_the_new_space() {
  const { app } = await swellApp();
  const from = await freshSpace(app, "Reopen from");
  const to = await freshSpace(app, "Reopen to");
  await app.switchSpace(from.id);
  await rendered(() => app.space?.id == from.id, "source space");
  await app.bridge.openUrl("https://example.com/open", from.id);
  await rendered(
    () => app.state.childrenOf(from.todayRoot).length == 1,
    "open page in Today"
  );
  const [node] = app.state.childrenOf(from.todayRoot);

  await app.moveToSpace(app.dragSnapshot([node]), to.id);

  Assert.deepEqual(await childrenOf(app, from, from.todayRoot), []);
  const moved = await childrenOf(app, to, to.todayRoot);
  Assert.equal(moved.length, 1, "one page in the new space");
  const tab = app.bridge.tabs(to.id).find(t => t.node == moved[0]);
  Assert.ok(tab, "it has a tab");
  Assert.equal(
    tab.userContextId,
    app.bridge.userContextOf(to.id),
    "the tab is in the new space's container"
  );
});
