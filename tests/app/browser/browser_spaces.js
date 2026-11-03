/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ExtensionTestCommon: "resource://testing-common/ExtensionTestCommon.sys.mjs",
  FormHistory: "resource://gre/modules/FormHistory.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  copiesOf: "moz-src:///swell/app/modules/ExtensionInstaller.sys.mjs",
  installCopy: "moz-src:///swell/app/modules/ExtensionInstaller.sys.mjs",
});

// Editing, ordering and deleting spaces, and the emoji picker of the dialog.

const spaceButton = id =>
  document.querySelector(`#spaces .space[data-id="${id}"]`);

const spaceIds = () =>
  [...document.querySelectorAll("#spaces .space[data-id]")].map(
    b => b.dataset.id
  );

async function spaceNamed(core, title) {
  return (await core.listSpaces()).find(space => space.title == title);
}

add_task(async function test_the_dialog_creates_a_space_with_a_picked_emoji() {
  const { app } = await swellApp();
  const before = (await app.core.listSpaces()).length;
  app.spaceEditor.create();
  const dialog = document.getElementById("space-dialog");
  Assert.ok(dialog.open, "the dialog opens");
  Assert.equal(
    document.getElementById("space-dialog-title").textContent,
    "New space"
  );
  document.getElementById("space-title").value = "Picker space";
  document.getElementById("space-title").dispatchEvent(new Event("input"));
  Assert.equal(
    document.getElementById("space-emoji-button").textContent,
    "P",
    "without an emoji the button shows the first letter, like the sidebar"
  );
  Assert.ok(
    document.getElementById("space-emoji-button").classList.contains("space"),
    "in the same square as the space buttons"
  );
  const picker = document.getElementById("emoji-picker");
  Assert.ok(picker.hidden, "the picker starts closed");
  document.getElementById("space-emoji-button").click();
  Assert.ok(!picker.hidden, "the button opens it");
  await TestUtils.waitForCondition(
    () => document.querySelectorAll("#emoji-grid .emoji").length > 100,
    "a category fills the grid"
  );

  const search = document.getElementById("emoji-search");
  search.value = "rocket";
  search.dispatchEvent(new Event("input"));
  const found = [...document.querySelectorAll("#emoji-grid .emoji")];
  Assert.ok(
    found.some(button => button.textContent == "\u{1F680}"),
    "a search matches the words of an emoji across categories"
  );
  search.value = "zzzz";
  search.dispatchEvent(new Event("input"));
  Assert.ok(
    document.getElementById("emoji-grid").classList.contains("none"),
    "and says when nothing matches"
  );
  search.value = "rocket";
  search.dispatchEvent(new Event("input"));
  [...document.querySelectorAll("#emoji-grid .emoji")]
    .find(button => button.textContent == "\u{1F680}")
    .click();
  Assert.ok(picker.hidden, "choosing closes the picker");
  Assert.equal(
    document.getElementById("space-emoji-button").textContent,
    "\u{1F680}"
  );

  document.getElementById("space-save").click();
  const space = await rendered(
    async () => (await spaceNamed(app.core, "Picker space")) ?? false,
    "the space is made"
  );
  Assert.equal(space.icon.glyph, "\u{1F680}");
  Assert.equal((await app.core.listSpaces()).length, before + 1);
  await rendered(
    () => spaceButton(space.id)?.textContent == "\u{1F680}",
    "the sidebar shows the emoji"
  );
});

add_task(async function test_the_dialog_creates_a_space_with_a_symbol() {
  const { app } = await swellApp();
  app.spaceEditor.create();
  document.getElementById("space-title").value = "Symbol space";
  document.getElementById("space-title").dispatchEvent(new Event("input"));
  document.getElementById("space-emoji-button").click();
  document.querySelector('#picker-mode [data-mode="symbols"]').click();
  await TestUtils.waitForCondition(
    () => document.querySelectorAll("#emoji-grid .symbol-choice").length > 10,
    "a category of symbols fills the grid"
  );
  Assert.ok(
    document.getElementById("emoji-tones").hidden,
    "skin tones are for emoji only"
  );
  for (const name of ["arrow-left", "nav-arrow-right", "check", "plus"]) {
    Assert.ok(
      ![...document.querySelectorAll("#emoji-grid .symbol-choice")].some(
        button => button.title == name
      ),
      `${name}, an interface icon, is not offered`
    );
  }

  const search = document.getElementById("emoji-search");
  search.value = "rocket";
  search.dispatchEvent(new Event("input"));
  const found = [...document.querySelectorAll("#emoji-grid .symbol-choice")];
  Assert.equal(found.length, 1, "a search finds the symbol across categories");
  found[0].click();
  Assert.ok(
    document.getElementById("emoji-picker").hidden,
    "choosing closes the picker"
  );
  Assert.ok(
    document.querySelector("#space-emoji-button svg"),
    "the button shows the symbol"
  );

  document.getElementById("space-save").click();
  const space = await rendered(
    async () => (await spaceNamed(app.core, "Symbol space")) ?? false,
    "the space is made"
  );
  Assert.equal(space.icon.name, "rocket", "the symbol is the icon of the space");
  await rendered(
    () => spaceButton(space.id)?.querySelector("svg.symbol"),
    "the sidebar draws the symbol"
  );

  // Editing it opens the picker on the symbols, and the first letter comes back.
  app.spaceEditor.edit(space);
  Assert.ok(
    document.querySelector("#space-emoji-button svg"),
    "the dialog shows the symbol"
  );
  document.getElementById("emoji-clear").click();
  document.getElementById("space-save").click();
  await rendered(
    async () => (await spaceNamed(app.core, "Symbol space")).icon.name == "circle",
    "the space is stored without an icon"
  );
  await rendered(
    () => spaceButton(space.id)?.textContent == "S",
    "the sidebar shows the first letter"
  );
});

add_task(async function test_escape_closes_the_picker_before_the_dialog() {
  const { app } = await swellApp();
  app.spaceEditor.create();
  document.getElementById("space-emoji-button").click();
  const dialog = document.getElementById("space-dialog");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(
    () => document.getElementById("emoji-picker").hidden,
    "the picker closes"
  );
  Assert.ok(dialog.open, "the dialog stays");
  EventUtils.synthesizeKey("KEY_Escape", {}, window);
  await TestUtils.waitForCondition(
    () => !dialog.open,
    "then the dialog closes"
  );
});

add_task(async function test_a_space_is_edited_from_its_context_menu() {
  const { app } = await swellApp();
  const space = await freshSpace(app, "Edit me");
  await rendered(() => spaceButton(space.id), "its button shows");

  spaceButton(space.id).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })
  );
  const labels = [...document.querySelectorAll("#menu button")].map(
    b => b.textContent
  );
  Assert.deepEqual(labels, ["Edit space…", "Delete space…"]);
  [...document.querySelectorAll("#menu button")][0].click();

  const dialog = document.getElementById("space-dialog");
  Assert.ok(dialog.open);
  Assert.equal(
    document.getElementById("space-dialog-title").textContent,
    "Edit space"
  );
  Assert.equal(document.getElementById("space-title").value, "Edit me");
  document.getElementById("space-title").value = "Edited";
  document.getElementById("emoji-clear").click();
  document.getElementById("space-emoji-button").click();
  await TestUtils.waitForCondition(
    () => document.querySelectorAll("#emoji-grid .emoji").length > 100,
    "the emoji load"
  );
  const search = document.getElementById("emoji-search");
  search.value = "tree";
  search.dispatchEvent(new Event("input"));
  document.querySelector("#emoji-grid .emoji").click();
  const glyph = document.getElementById("space-emoji-button").textContent;
  document.getElementById("space-save").click();

  const edited = await rendered(
    async () => (await spaceNamed(app.core, "Edited")) ?? false,
    "the name changes"
  );
  Assert.equal(edited.id, space.id, "it is the same space");
  Assert.equal(edited.userContextId, space.userContextId, "and container");
  Assert.equal(edited.icon.glyph, glyph);
  await rendered(
    () => spaceButton(space.id)?.title == "Edited",
    "the sidebar follows"
  );
});

add_task(async function test_spaces_are_reordered_by_dragging() {
  const { app } = await swellApp();
  const a = await freshSpace(app, "Order A");
  const b = await freshSpace(app, "Order B");
  const c = await freshSpace(app, "Order C");
  await rendered(() => spaceButton(c.id), "buttons show");
  const own = () => spaceIds().filter(id => [a.id, b.id, c.id].includes(id));
  Assert.deepEqual(own(), [a.id, b.id, c.id]);

  const drag = (from, to, side) => {
    const dataTransfer = new DataTransfer();
    spaceButton(from).dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer })
    );
    const target = spaceButton(to);
    const rect = target.getBoundingClientRect();
    const clientX = side == "before" ? rect.left + 2 : rect.right - 2;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(
      new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX,
        clientY,
      })
    );
    target.dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX,
        clientY,
      })
    );
    spaceButton(from)?.dispatchEvent(
      new DragEvent("dragend", { bubbles: true, dataTransfer })
    );
  };

  drag(c.id, a.id, "before");
  await rendered(
    () => own().join() == [c.id, a.id, b.id].join(),
    "dropped before another"
  );
  drag(c.id, b.id, "after");
  await rendered(
    () => own().join() == [a.id, b.id, c.id].join(),
    "dropped after another"
  );
  drag(a.id, b.id, "after");
  await rendered(
    () => own().join() == [b.id, a.id, c.id].join(),
    "the middle of the list"
  );
  const saved = (await app.core.listSpaces()).map(space => space.id);
  Assert.deepEqual(
    saved.filter(id => [a.id, b.id, c.id].includes(id)),
    [b.id, a.id, c.id],
    "the core has the order"
  );
});

add_task(
  async function test_deleting_a_space_forgets_everything_of_its_container() {
    const { app, bridge } = await swellApp();
    const keep = await freshSpace(app, "Keep");
    const doomed = await freshSpace(app, "Doomed");
    const ucid = doomed.userContextId;
    const kept = keep.userContextId;
    const origin = "https://example.com";

    // Things in the doomed container, and the same kinds in the one that stays.
    for (const userContextId of [ucid, kept]) {
      const tab = await openInSpace(
        bridge,
        userContextId == ucid ? doomed.id : keep.id,
        `${BASE}file_blank.html`
      );
      await SpecialPowers.spawn(tab.browser, [userContextId], id => {
        content.document.cookie = `swell=value-${id}; path=/`;
      });
      const principal = Services.scriptSecurityManager.createContentPrincipal(
        Services.io.newURI(origin),
        { userContextId }
      );
      Services.perms.addFromPrincipal(
        principal,
        "geo",
        Services.perms.ALLOW_ACTION
      );
      await FormHistory.update({
        op: "add",
        fieldname: "q",
        value: `typed-${userContextId}`,
        userContextId,
      });
      await PlacesUtils.history.insert({
        url: `https://history.example/${userContextId}`,
        title: `visited ${userContextId}`,
        visits: [{ date: new Date(), userContextId }],
      });
      await IOUtils.writeJSON(
        PathUtils.join(
          PathUtils.profileDir,
          `autofill-profiles-${userContextId}.json`
        ),
        { version: 1, addresses: [], creditCards: [] }
      );
    }
    const xpi = await ExtensionTestCommon.generateXPI({
      manifest: {
        name: "Doomed copy",
        version: "1.0",
        browser_specific_settings: { gecko: { id: "doomed@swell.test" } },
      },
    });
    const addon = await installCopy(xpi, ucid, { allowUnsigned: true });
    registerCleanupFunction(() => Services.cookies.removeAll());

    const cookieOf = userContextId =>
      Services.cookies
        .getCookiesFromHost("example.com", { userContextId })
        .find(cookie => cookie.name == "swell");
    const hasPermission = userContextId =>
      Services.perms
        .getAllWithTypePrefix("geo")
        .some(
          permission =>
            permission.principal.originAttributes.userContextId == userContextId
        );
    const formEntries = async userContextId =>
      (await FormHistory.search(["value"], { fieldname: "q", userContextId }))
        .length;
    const visited = async userContextId =>
      !!(await PlacesUtils.history.fetch(
        `https://history.example/${userContextId}`
      ));
    const fileExists = userContextId =>
      IOUtils.exists(
        PathUtils.join(
          PathUtils.profileDir,
          `autofill-profiles-${userContextId}.json`
        )
      );
    Assert.ok(
      cookieOf(ucid) && hasPermission(ucid),
      "set up: cookie, permission"
    );
    Assert.equal(await formEntries(ucid), 1, "set up: form history");
    Assert.ok(await visited(ucid), "set up: history");
    Assert.ok(await fileExists(ucid), "set up: autofill file");
    Assert.equal((await copiesOf(ucid)).length, 1, "set up: add-on");

    // Say yes to the question.
    const dialog = document.getElementById("delete-space-dialog");
    const deleting = app.deleteSpace(doomed.id);
    await TestUtils.waitForCondition(() => dialog.open, "it asks first");
    document.getElementById("delete-space-cancel").click();
    await deleting;
    Assert.ok(await spaceNamed(app.core, "Doomed"), "a no keeps the space");

    const confirmed = app.deleteSpace(doomed.id);
    await TestUtils.waitForCondition(() => dialog.open, "it asks again");
    document.getElementById("delete-space-confirm").click();
    await confirmed;

    Assert.ok(!(await spaceNamed(app.core, "Doomed")), "the space is gone");
    await rendered(() => !spaceButton(doomed.id), "and its button");
    Assert.ok(!cookieOf(ucid), "cookies are gone");
    Assert.ok(!hasPermission(ucid), "permissions are gone");
    Assert.equal(await formEntries(ucid), 0, "form history is gone");
    Assert.ok(!(await visited(ucid)), "history is gone");
    Assert.ok(!(await fileExists(ucid)), "the autofill file is gone");
    Assert.equal((await copiesOf(ucid)).length, 0, "the add-on is gone");
    Assert.ok(!(await AddonManager.getAddonByID(addon.id)), "uninstalled");

    Assert.ok(cookieOf(kept), "another space keeps its cookie");
    Assert.ok(hasPermission(kept), "its permission");
    Assert.equal(await formEntries(kept), 1, "its form history");
    Assert.ok(await visited(kept), "its history");
    Assert.ok(await fileExists(kept), "its autofill file");

    const next = await newSpace(app.core, "After");
    Assert.greater(
      next.userContextId,
      ucid,
      "the container of a deleted space is not used again"
    );
    await IOUtils.remove(
      PathUtils.join(PathUtils.profileDir, `autofill-profiles-${kept}.json`),
      { ignoreAbsent: true }
    );
    Services.perms.removeFromPrincipal(
      Services.scriptSecurityManager.createContentPrincipal(
        Services.io.newURI(origin),
        { userContextId: kept }
      ),
      "geo"
    );
    await FormHistory.update({ op: "remove", userContextId: kept });
    await PlacesUtils.history.remove(`https://history.example/${kept}`);
    await closeAllTabs(bridge);
  }
);

add_task(async function test_the_last_space_cannot_be_deleted() {
  const { app } = await swellApp();
  const spaces = await app.core.listSpaces();
  const last = spaces.at(-1);
  for (const space of spaces.slice(0, -1)) {
    await app.core.deleteSpace(space.id);
  }
  await rendered(() => app.spaces.length == 1, "one space is left");
  spaceButton(last.id).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })
  );
  const remove = [...document.querySelectorAll("#menu button")].find(b =>
    b.textContent.startsWith("Delete")
  );
  Assert.ok(remove.disabled, "the menu does not offer it");
  app.menu.hide();
  await Assert.rejects(
    app.core.deleteSpace(last.id),
    /last space/,
    "and the core refuses"
  );
});

add_task(async function test_the_editor_has_no_colour_chooser() {
  const { app } = await swellApp();
  const space = await freshSpace(app, "Plain");
  app.spaceEditor.edit(space);
  Assert.ok(
    !document.getElementById("space-tints"),
    "there is nothing to choose a colour with"
  );
  document.getElementById("space-cancel").click();

  // A colour the core still holds from an earlier version is not shown either.
  await app.core.setSpaceTint(space.id, "#22c55e");
  await app.switchSpace(space.id);
  await rendered(() => app.space?.tint == "#22c55e", "the core has the colour");
  const root = document.documentElement;
  Assert.ok(!root.hasAttribute("tinted"), "the window is not tinted");
  Assert.equal(
    root.style.getPropertyValue("--space-tint"),
    "",
    "no colour is set"
  );
  await app.core.setSpaceTint(space.id, null);
});

add_task(
  async function test_the_window_asks_for_the_translucent_sidebar_material() {
    if (Services.appinfo.OS != "Darwin") {
      return;
    }
    await swellApp();
    Assert.equal(
      getComputedStyle(document.documentElement).appearance,
      "none",
      "the root does not paint the opaque window background"
    );
    Assert.ok(
      !document.documentElement.hasAttribute("macostranslucent"),
      "the window is only made transparent when asked to"
    );
    Assert.equal(
      getComputedStyle(document.body).backgroundColor,
      "rgba(0, 0, 0, 0)",
      "and nothing opaque is drawn over it"
    );
  }
);

add_task(
  async function test_the_picker_has_the_whole_emoji_set_with_skin_tones() {
    const { app } = await swellApp();
    const data = await (
      await fetch("chrome://swell/content/emoji-data.json")
    ).json();
    const all = data.flatMap(category => category.emoji);
    Assert.greater(all.length, 1800, "all of the emoji of the data set");
    Assert.deepEqual(
      data.map(category => category.name),
      [
        "Smileys & emotion",
        "People & body",
        "Animals & nature",
        "Food & drink",
        "Travel & places",
        "Activities",
        "Objects",
        "Symbols",
        "Flags",
      ],
      "in the groups of Unicode"
    );
    Assert.greater(
      all.filter(entry => entry[2]).length,
      250,
      "many have skin tones"
    );

    app.spaceEditor.create();
    document.getElementById("space-emoji-button").click();
    const grid = document.getElementById("emoji-grid");
    const search = document.getElementById("emoji-search");
    await TestUtils.waitForCondition(
      () => grid.querySelectorAll(".emoji").length > 100,
      "the emoji load"
    );
    const find = (word, glyph) => {
      search.value = word;
      search.dispatchEvent(new Event("input"));
      return [...grid.querySelectorAll(".emoji")].find(
        b => b.textContent == glyph
      );
    };
    Assert.ok(find("italy", "\u{1F1EE}\u{1F1F9}"), "flags are there");
    Assert.ok(find("wave", "\u{1F44B}"), "a waving hand, by default");

    const tones = [...document.querySelectorAll("#emoji-tones .emoji-tone")];
    Assert.equal(tones.length, 6, "no tone and the five tones");
    tones[3].click();
    const medium = find("wave", "\u{1F44B}\u{1F3FD}");
    Assert.ok(medium, "the chosen skin tone shows on the emoji that have one");
    Assert.ok(!find("wave", "\u{1F44B}"), "instead of the default");
    Assert.ok(
      find("rocket", "\u{1F680}"),
      "and an emoji without tones does not change"
    );
    find("wave", "\u{1F44B}\u{1F3FD}").click();
    Assert.equal(
      document.getElementById("space-emoji-button").textContent,
      "\u{1F44B}\u{1F3FD}",
      "it is the emoji of the space"
    );
    document.getElementById("space-cancel").click();

    // Leave the tone as it was found.
    app.spaceEditor.create();
    document.getElementById("space-emoji-button").click();
    await TestUtils.waitForCondition(
      () => document.querySelectorAll("#emoji-tones .emoji-tone").length == 6,
      "the tones show"
    );
    document.querySelectorAll("#emoji-tones .emoji-tone")[0].click();
    document.getElementById("space-cancel").click();
  }
);
