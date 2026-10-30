/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the menu bar of the system does. The menus are the `<menubar>` of
 * window.xhtml, which macOS shows as its own; an item names its action in
 * `data-action`. They hold what the sidebar has no room for: the places that
 * list what a space keeps (downloads, add-ons, passwords, addresses and
 * cards), importing from Arc, and the editing, find and window commands.
 */
export class MenuBar {
  #actions;

  constructor(app) {
    this.#actions = {
      about: () => app.about.show(),
      "new-tab": () => app.commandBar.open({ mode: "new" }),
      "new-space": () => app.spaceEditor.create(),
      "close-tab": () =>
        app.selectedTab?.liveTab &&
        app.run(() => app.bridge.closeTab(app.selectedTab.liveTab)),
      "toggle-sidebar": () => app.sidebarLayout.toggle(),
      reload: () => app.bridge.reload(),
      inspector: () => app.openDevTools("inspector"),
      console: () => app.openDevTools("webconsole"),
      downloads: () => app.downloads.show(),
      extensions: () => app.extensions.show(),
      passwords: () => app.passwords.show(),
      autofill: () => app.autofill.show(),
      "import-arc": () => app.chooseArcFile(),
      print: () => app.print(),
      find: () => app.bridge.openFind(),
      "find-next": () => app.bridge.findAgain(false),
      "find-previous": () => app.bridge.findAgain(true),
      quit: () => Services.startup.quit(Services.startup.eAttemptQuit),
      minimize: () => win.minimize(),
      "zoom-window": () =>
        win.windowState == win.STATE_MAXIMIZED ? win.restore() : win.maximize(),
    };
    const win = app.document.defaultView;
    app.document
      .getElementById("main-menubar")
      ?.addEventListener("command", event => {
        const action = event.target.dataset?.action;
        if (action?.startsWith("edit:")) {
          this.#edit(win, action.slice(5));
          return;
        }
        this.#actions[action]?.();
      });
  }

  // Runs an editing command on whatever has the focus, the page or a field of
  // the window, as the keyboard shortcuts do.
  #edit(win, command) {
    const controller =
      win.document.commandDispatcher.getControllerForCommand(command);
    if (controller?.isCommandEnabled(command)) {
      controller.doCommand(command);
    }
  }
}
