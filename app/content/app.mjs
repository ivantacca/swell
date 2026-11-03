/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Sidebar, isAway } from "chrome://swell/content/sidebar.mjs";
import { CommandBar } from "chrome://swell/content/commandbar.mjs";
import { ContextMenu } from "chrome://swell/content/menu.mjs";
import { Toasts } from "chrome://swell/content/toasts.mjs";
import { PermissionBar } from "chrome://swell/content/permissions.mjs";
import { AboutDialog } from "chrome://swell/content/about.mjs";
import { UpdateNotifier } from "chrome://swell/content/update-notifier.mjs";
import { DownloadsPanel } from "chrome://swell/content/downloads.mjs";
import { AutofillUI } from "chrome://swell/content/autofill.mjs";
import { PasswordsUI } from "chrome://swell/content/passwords.mjs";
import { ExtensionsUI } from "chrome://swell/content/extensions.mjs";
import { MediaUI } from "chrome://swell/content/media.mjs";
import { SidebarLayout } from "chrome://swell/content/sidebar-layout.mjs";
import { NavBar } from "chrome://swell/content/navbar.mjs";
import { MenuBar } from "chrome://swell/content/menubar.mjs";
import { SpaceEditor } from "chrome://swell/content/space-editor.mjs";
import { ExtensionActionsUI } from "chrome://swell/content/extension-actions.mjs";

const { DevTools } = ChromeUtils.importESModule(
  "moz-src:///swell/app/modules/DevTools.sys.mjs"
);
const { SwellExtensionUI } = ChromeUtils.importESModule(
  "moz-src:///swell/app/modules/SwellExtensionUI.sys.mjs"
);

const IS_MAC = Services.appinfo.OS == "Darwin";

// Whether keys typed at `target` are text going into a field of the window.
function isEditable(target) {
  return !!target?.closest?.("input, textarea, select, [contenteditable]");
}

// The window: holds what the core says about the active space, keeps track of
// which saved tabs are open, and turns clicks and keys into core and bridge
// commands. It never decides anything about state itself.
/**
 *
 */
export class App {
  // Takes the window's document as `doc`, the core client, the engine bridge,
  // the tree state, the UniFFI `Icon` enum (for creating spaces) and the
  // toolkit downloads API.
  constructor({ doc, core, bridge, state, Icon, Downloads }) {
    this.document = doc;
    this.core = core;
    this.bridge = bridge;
    this.state = state;
    this.Icon = Icon;
    this.Downloads = Downloads;
    this.toasts = new Toasts(doc);
    this.spaces = [];
    this.activeSpaceId = null;
    this.openTabs = new Map();
    this.selectedNode = null;
    this.selectedTab = null;
    this.menu = new ContextMenu(this);
    this.sidebar = new Sidebar(this);
    this.commandBar = new CommandBar(this);
    this.permissions = new PermissionBar(this);
    this.downloads = new DownloadsPanel(this);
    this.updates = new UpdateNotifier(this);
    this.about = new AboutDialog(this);
    this.autofill = new AutofillUI(this);
    this.passwords = new PasswordsUI(this);
    this.extensions = new ExtensionsUI(this);
    this.extensionActions = new ExtensionActionsUI(this);
    this.media = new MediaUI(this);
    this.spaceEditor = new SpaceEditor(this);
    this.navBar = new NavBar(this);
    this.sidebarLayout = new SidebarLayout(this);
    this.menuBar = new MenuBar(this);
    this.#renderQueued = false;
  }

  #renderQueued;
  #overSidebar = false;

  get space() {
    return this.spaces.find(space => space.id == this.activeSpaceId) ?? null;
  }

  // Roots that hold tabs only, where folders may not be dropped.
  get tabsOnlyRoots() {
    const space = this.space;
    return new Set(space ? [space.todayRoot, space.favoritesRoot] : []);
  }

  async init() {
    this.spaces = await this.core.listSpaces();
    this.activeSpaceId = this.bridge.activeSpace ?? this.spaces[0]?.id ?? null;
    await this.#loadTree();
    this.core.on("treeChanged", diff => {
      this.state.apply(diff);
      this.scheduleRender();
    });
    this.core.on("spacesChanged", spaces => {
      this.spaces = spaces;
      this.scheduleRender();
    });
    this.core.on("activeSpaceChanged", ({ window: windowId, space }) => {
      if (windowId == this.bridge.windowId) {
        const from = this.spaces.findIndex(s => s.id == this.activeSpaceId);
        const to = this.spaces.findIndex(s => s.id == space);
        this.activeSpaceId = space;
        this.#loadTree().then(() => {
          this.scheduleRender();
          if (from >= 0 && to >= 0 && from != to) {
            this.sidebar.slide(to > from ? "next" : "prev");
          }
        });
      }
    });
    this.bridge.on("tabopened", tab => this.#tabChanged(tab));
    this.bridge.on("tabstate", tab => this.#tabChanged(tab));
    this.bridge.on("tabclosed", ({ node }) => {
      this.openTabs.delete(node);
      this.scheduleRender();
    });
    this.bridge.on("selected", tab => {
      this.selectedTab = tab;
      this.selectedNode = tab?.node ?? null;
      this.#windowChanged();
      this.scheduleRender();
    });
    this.#installShortcuts();
    this.#installAppCommands();
    this.#windowChanged();
    this.render();
    this.downloads.init();
    this.updates.start();
  }

  // Opens an address in a new tab of the active space.
  openUrlInActiveSpace(url) {
    return this.run(() => this.bridge.openUrl(url, this.activeSpaceId));
  }

  // Opens the print dialog over the page in front.
  print() {
    const browser = this.selectedTab && this.bridge.selectedTab?.browser;
    if (browser) {
      this.document.defaultView.PrintUtils.startPrintWindow(
        browser.browsingContext
      );
    }
  }

  // Asks for an Arc StorableSidebar.json and imports it.
  async chooseArcFile() {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      this.document.defaultView.browsingContext,
      "Choose Arc's StorableSidebar.json",
      Ci.nsIFilePicker.modeOpen
    );
    picker.appendFilter("JSON", "*.json");
    try {
      const arc = Services.dirsvc.get("Home", Ci.nsIFile);
      arc.append("Library");
      arc.append("Application Support");
      arc.append("Arc");
      if (arc.exists()) {
        picker.displayDirectory = arc;
      }
    } catch (e) {
      // No Arc folder here; the picker opens where it likes.
    }
    const result = await new Promise(resolve => picker.open(resolve));
    if (result == Ci.nsIFilePicker.returnOK) {
      await this.importArcFile(picker.file.path);
    }
  }

  // Imports an Arc sidebar file and says what came across.
  async importArcFile(path) {
    try {
      const report = await this.core.importArc(path);
      const warnings = report.warnings.length
        ? `, ${report.warnings.length} skipped`
        : "";
      this.toasts.show({
        text: `Imported ${report.spaces} spaces and ${report.tabs + report.favorites} tabs from Arc${warnings}`,
      });
      return report;
    } catch (e) {
      console.error("Swell: the Arc import failed", e);
      this.toasts.show({
        text: `Could not import that file: ${e.reason ?? e.message ?? e}`,
      });
      return null;
    }
  }

  // A link opened from a page (middle- or accel-click) becomes a tab of that page's space.
  setTabIcon(browser, icon) {
    const tab = this.bridge.tabForBrowser(browser);
    if (tab) {
      this.bridge.setIcon(tab, icon);
    }
  }

  openLinkFrom(browser, url, { background }) {
    const tab = this.bridge.tabForBrowser(browser);
    return this.run(() =>
      this.bridge.openUrl(url, tab?.space ?? this.activeSpaceId, { background })
    );
  }

  // The menu for a right-click in a page, from what the page reported.
  showPageMenu({
    browser,
    actor,
    clientX,
    clientY,
    screenX: pointerX,
    screenY: pointerY,
    linkURL,
    linkText,
    imageURL,
    mediaURL,
    mediaType,
    password,
    selection,
    editable,
    spelling,
    contentDomReference,
  }) {
    const tab = this.bridge.tabForBrowser(browser);
    const space = tab?.space ?? this.activeSpaceId;
    const copy = text =>
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
    const command = commandName => () =>
      actor.sendAsyncMessage("Swell:Command", { command: commandName });
    const items = [];
    if (linkURL) {
      items.push(
        {
          label: "Open link in new tab",
          action: () => this.run(() => this.bridge.openUrl(linkURL, space)),
        },
        { label: "Copy link", action: () => copy(linkURL) }
      );
    }
    if (imageURL) {
      items.push(
        {
          label: "Open image in new tab",
          action: () => this.run(() => this.bridge.openUrl(imageURL, space)),
        },
        { label: "Copy image address", action: () => copy(imageURL) }
      );
    }
    if (spelling) {
      for (const suggestion of spelling.suggestions) {
        items.push({
          label: suggestion,
          action: () =>
            actor.sendAsyncMessage("Swell:ReplaceMisspelling", { suggestion }),
        });
      }
      if (!spelling.suggestions.length) {
        items.push({ label: "No suggestions", disabled: true });
      }
      items.push({ separator: true });
    }
    if (editable) {
      items.push(
        { label: "Cut", action: command("cmd_cut") },
        { label: "Copy", action: command("cmd_copy") },
        { label: "Paste", action: command("cmd_paste") },
        { label: "Select all", action: command("cmd_selectAll") }
      );
    } else if (selection) {
      items.push({ label: "Copy", action: command("cmd_copy") });
      const shown =
        selection.length > 24 ? `${selection.slice(0, 24)}\u2026` : selection;
      items.push({
        label: `Search for \u201C${shown}\u201D`,
        action: () =>
          this.run(() =>
            this.bridge.openUrl(
              `https://www.google.com/search?q=${encodeURIComponent(selection)}`,
              space
            )
          ),
      });
    }
    if (!linkURL && !imageURL && !editable && !selection) {
      items.push(
        { label: "Back", action: () => this.bridge.goBack() },
        { label: "Forward", action: () => this.bridge.goForward() },
        { label: "Reload", action: () => this.bridge.reload() }
      );
    }
    if (tab) {
      items.push(
        ...SwellExtensionUI.menuItemsFor({
          nativeTab: tab,
          pageUrl: browser.currentURI.spec,
          onLink: !!linkURL,
          linkUrl: linkURL,
          linkText,
          onImage: !!imageURL,
          onVideo: mediaType == "video",
          onAudio: mediaType == "audio",
          srcUrl: imageURL ?? mediaURL,
          onEditable: editable,
          onPassword: password,
          isTextSelected: !!selection,
          selectionText: selection,
        })
      );
    }
    if (tab && contentDomReference) {
      items.push(
        { separator: true },
        {
          label: "Inspect",
          action: () =>
            this.run(() => DevTools.inspectNode(tab, contentDomReference)),
        }
      );
    }
    // Frames report their own client coordinates, so the screen ones place the menu.
    const win = this.document.defaultView;
    const rect = browser.getBoundingClientRect();
    const x =
      pointerX == null ? rect.left + clientX : pointerX - win.mozInnerScreenX;
    const y =
      pointerY == null ? rect.top + clientY : pointerY - win.mozInnerScreenY;
    this.menu.show(x, y, items, {
      onHide: () => SwellExtensionUI.menuHidden(),
    });
  }

  async #loadTree() {
    if (this.activeSpaceId) {
      this.state.load(await this.core.spaceTree(this.activeSpaceId));
    }
  }

  #tabChanged(tab) {
    if (tab.node) {
      this.openTabs.set(tab.node, tab);
    }
    if (tab.selected) {
      this.selectedTab = tab;
      this.#windowChanged();
    }
    this.scheduleRender();
  }

  #windowChanged() {
    const tab = this.selectedTab;
    this.document.title = tab?.title ? `${tab.title} - Swell` : "Swell";
    this.document.getElementById("empty").hidden = !!tab;
  }

  scheduleRender() {
    if (this.#renderQueued) {
      return;
    }
    this.#renderQueued = true;
    this.document.defaultView.requestAnimationFrame(() => {
      this.#renderQueued = false;
      this.render();
    });
  }

  render() {
    this.sidebar.render();
    this.extensionActions.render();
    this.navBar.render();
  }

  // Reports a failed command instead of leaving the window silently stale.
  async run(command) {
    try {
      return await command();
    } catch (e) {
      console.error("Swell command failed", e);
      return null;
    }
  }

  // The space `delta` places along the list, if there is one.
  // The downloads are one place before the first space: going left from there opens
  // them, and going right closes them.
  switchSpaceBy(delta) {
    if (this.downloads.visible) {
      if (delta > 0) {
        this.downloads.hide();
        this.sidebar.slide("next");
      }
      return null;
    }
    const index = this.spaces.findIndex(s => s.id == this.activeSpaceId);
    const next = this.spaces[index + delta];
    if (!next && index == 0 && delta < 0) {
      this.downloads.show();
      this.sidebar.slide("prev");
      return null;
    }
    return next ? this.switchSpace(next.id) : null;
  }

  // Opens the developer tools for the tab in front, on one tool.
  openDevTools(toolId = "inspector") {
    const tab = this.bridge.selectedTab;
    return tab ? this.run(() => DevTools.openToolbox(tab, toolId)) : null;
  }

  // Pins the tab in front. If it is pinned and has gone to another page, the
  // page it is on becomes the one it is pinned at; if it is on its pinned page,
  // it is unpinned.
  async togglePin() {
    const id = this.selectedNode;
    if (!id || !this.space) {
      return null;
    }
    if (this.state.parent(id) === this.space.todayRoot) {
      return this.pin(id);
    }
    const tab = this.openTabs.get(id);
    const info = this.state.describe(id);
    if (tab && info && isAway(info.url, tab.url)) {
      const done = await this.run(() =>
        this.core.repinTab(tab.liveTab, tab.url, tab.title || tab.url)
      );
      this.toasts.show({ text: "Pinned page updated" });
      return done;
    }
    return this.unpin(id);
  }

  switchSpace(id) {
    this.downloads.hide();
    return this.run(() => this.core.switchSpace(this.bridge.windowId, id));
  }

  openNode(id) {
    return this.run(() => this.bridge.openNode(id));
  }

  closeNodeTab(id) {
    const tab = this.openTabs.get(id);
    return tab ? this.run(() => this.bridge.closeTab(tab.liveTab)) : null;
  }

  moveNode(id, parentId, index) {
    return this.run(() => this.core.moveNode(id, parentId, index));
  }

  // Runs the moves of TreeState.planMoves one after the other.
  async moveNodes(plan) {
    for (const { id, parent: parentId, index } of plan) {
      await this.moveNode(id, parentId, index);
    }
  }

  // Puts nodes, in the order given, in a new folder where the first one is. Today
  // and the favorites hold tabs only, so from there the folder goes to the end of
  // Pinned.
  async newFolderWith(ids) {
    let parentId = this.state.parent(ids[0]);
    let index = this.state.childrenOf(parentId).indexOf(ids[0]);
    if (this.tabsOnlyRoots.has(parentId)) {
      parentId = this.space.pinnedRoot;
      index = this.state.childrenOf(parentId).length;
    }
    const folder = await this.run(() =>
      this.core.createFolder(parentId, "New folder", index)
    );
    if (!folder) {
      return;
    }
    for (const [position, id] of ids.entries()) {
      await this.moveNode(id, folder, position);
    }
    this.sidebar.startRename(folder);
  }

  async newFolder(parentId = this.space.pinnedRoot) {
    const count = this.state.childrenOf(parentId).length;
    const id = await this.run(() =>
      this.core.createFolder(parentId, "New folder", count)
    );
    if (id) {
      this.sidebar.startRename(id);
    }
  }

  // Removes a row and offers to put it back.
  async removeNode(id) {
    const info = this.state.describe(id);
    await this.run(() => this.core.removeNode(id));
    if (info) {
      const label = info.title || info.url;
      this.toasts.show({
        text: `Removed ${label.length > 32 ? `${label.slice(0, 32)}\u2026` : label}`,
        actions: [{ label: "Undo", run: () => this.undoRemove() }],
      });
    }
  }

  // Puts back the row removed last.
  undoRemove() {
    return this.run(() => this.core.undoRemove());
  }

  renameNode(id, title) {
    return this.run(() => this.core.renameNode(id, title));
  }

  setCollapsed(id, collapsed) {
    return this.run(() => this.core.setCollapsed(id, collapsed));
  }

  setPinnedCollapsed(spaceId, collapsed) {
    return this.run(() => this.core.setPinnedCollapsed(spaceId, collapsed));
  }

  // Moves a tab into Pinned, at the end.
  pin(id) {
    const space = this.space;
    return this.moveNode(
      id,
      space.pinnedRoot,
      this.state.childrenOf(space.pinnedRoot).length
    );
  }

  // Moves a saved tab to the favorites at the top of the sidebar.
  favorite(id) {
    const count = this.state.childrenOf(this.space.favoritesRoot).length;
    return this.run(() =>
      this.core.moveNode(id, this.space.favoritesRoot, count)
    );
  }

  // Moves a pinned or favorite tab to the end of Today.
  unpin(id) {
    return this.run(() => this.core.unpinNode(id, this.activeSpaceId));
  }

  async createSpace(title, emoji) {
    const icon = emoji
      ? new this.Icon.Emoji({ glyph: emoji })
      : new this.Icon.Symbol({ name: "circle" });
    const id = await this.run(() =>
      this.core.createSpace(title || "New space", icon)
    );
    if (id) {
      await this.switchSpace(id);
    }
  }

  async updateSpace(id, title, emoji) {
    const icon = emoji
      ? new this.Icon.Emoji({ glyph: emoji })
      : new this.Icon.Symbol({ name: "circle" });
    await this.run(() => this.core.updateSpace(id, title, icon));
  }

  moveSpace(id, index) {
    return this.run(() => this.core.moveSpace(id, index));
  }

  // Asks, then deletes the space and what the engine keeps for its container.
  async deleteSpace(id) {
    const space = this.spaces.find(s => s.id == id);
    if (
      !space ||
      this.spaces.length < 2 ||
      !(await this.spaceEditor.confirmDelete(space))
    ) {
      return;
    }
    const deleted = await this.run(() => this.core.deleteSpace(id));
    if (!deleted?.identityRemoved) {
      return;
    }
    const { forgetContainer } = ChromeUtils.importESModule(
      "moz-src:///swell/app/modules/SpaceCleanup.sys.mjs"
    );
    const failures = await forgetContainer(deleted.userContextId);
    this.toasts.show({
      text: failures.length
        ? `Deleted ${space.title}, but could not remove: ${failures.join("; ")}`
        : `Deleted ${space.title}`,
    });
  }

  // Back and forward, from the buttons of a mouse (which reach the window as an
  // AppCommand, without saying where the pointer is) or from the keyboard (the
  // shortcuts a mouse driver can send). Over the sidebar they change the
  // space, anywhere else they move through the history of the tab in front.
  #installAppCommands() {
    const win = this.document.defaultView;
    for (const id of ["sidebar", "titlebar-left"]) {
      const area = this.document.getElementById(id);
      area.addEventListener("mouseenter", () => (this.#overSidebar = true));
      area.addEventListener("mouseleave", () => (this.#overSidebar = false));
    }
    win.addEventListener(
      "AppCommand",
      event => {
        const delta = { Back: -1, Forward: 1 }[event.command];
        if (!delta) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.navigate(delta);
      },
      true
    );
  }

  /**
   * @param {number} delta -1 for back, 1 for forward.
   */
  navigate(delta) {
    if (this.#overSidebar) {
      return this.switchSpaceBy(delta);
    }
    return delta < 0 ? this.bridge.goBack() : this.bridge.goForward();
  }

  #installShortcuts() {
    const win = this.document.defaultView;
    win.addEventListener("keydown", event => {
      const accel = IS_MAC
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && !event.metaKey;
      if (event.key == "Escape" && this.commandBar.isOpen) {
        this.commandBar.close();
        event.preventDefault();
        return;
      }
      if (this.#devToolsShortcut(event, accel)) {
        event.preventDefault();
        return;
      }
      if (!accel || event.altKey) {
        return;
      }
      const handled = this.#shortcut(event);
      if (handled) {
        event.preventDefault();
      }
    });
  }

  // The keys of the developer tools, as in Firefox: the inspector is accel+alt+C
  // (and accel+shift+C on macOS), the toolbox accel+alt+I (and F12), the
  // console accel+alt+K, the debugger accel+alt+Z.
  #devToolsShortcut(event, accel) {
    const tools = {
      KeyC: "inspector",
      KeyI: "inspector",
      KeyK: "webconsole",
      KeyZ: "jsdebugger",
    };
    if (event.code == "F12" && !event.metaKey && !event.ctrlKey) {
      this.openDevTools();
      return true;
    }
    if (accel && event.altKey && !event.shiftKey && tools[event.code]) {
      this.openDevTools(tools[event.code]);
      return true;
    }
    if (
      IS_MAC &&
      accel &&
      event.shiftKey &&
      !event.altKey &&
      event.code == "KeyC"
    ) {
      this.openDevTools("inspector");
      return true;
    }
    return false;
  }

  #shortcut(event) {
    // The brackets are not on the same key in every layout (on an Italian one
    // they are behind Option), but a mouse or a keyboard shortcut means the
    // physical keys, so those are matched by their code.
    // What was typed wins for the zoom keys: on an Italian layout "+" is on the key
    // that is "]" on a US one.
    const key = ["+", "="].includes(event.key)
      ? "+"
      : ({ BracketLeft: "[", BracketRight: "]" }[event.code] ??
        event.key.toLowerCase());
    switch (key) {
      case "t":
        this.commandBar.open({ mode: "new" });
        return true;
      case "l":
        this.commandBar.open({ mode: "current" });
        return true;
      case "w":
        if (this.selectedTab?.liveTab) {
          this.run(() => this.bridge.closeTab(this.selectedTab.liveTab));
        }
        return true;
      case "z":
        // In a field or a page, undoing is theirs.
        if (
          event.shiftKey ||
          isEditable(event.target) ||
          this.document.activeElement?.localName == "browser"
        ) {
          return false;
        }
        this.undoRemove();
        return true;
      case "r":
        this.bridge.reload();
        return true;
      case "p":
        this.print();
        return true;
      case "s":
        this.sidebarLayout.shortcutDown(event);
        return true;
      case "d":
        this.togglePin();
        return true;
      case "f":
        this.bridge.openFind();
        return true;
      case "=":
      case "+":
        this.bridge.zoom(1);
        return true;
      case "-":
        this.bridge.zoom(-1);
        return true;
      case "0":
        this.bridge.zoom(0);
        return true;
      case "[":
        this.navigate(-1);
        return true;
      case "]":
        this.navigate(1);
        return true;
      // What a mouse driver sends for its back and forward buttons, if the
      // person asked for the arrows. In a text field they move the caret.
      case "arrowleft":
      case "arrowright":
        if (event.shiftKey || isEditable(event.target)) {
          return false;
        }
        this.navigate(key == "arrowleft" ? -1 : 1);
        return true;
      default:
        break;
    }
    const digit = Number(event.key);
    if (digit >= 1 && digit <= 9 && !event.shiftKey) {
      const space = this.spaces[digit - 1];
      if (space) {
        this.switchSpace(space.id);
      }
      return true;
    }
    return false;
  }
}
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
