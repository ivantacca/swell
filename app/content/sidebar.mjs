/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { showSpaceIcon } from "chrome://swell/content/symbols.mjs";

const DRAG_TYPE = "application/x-swell-node";

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

// The one letter shown where a site icon would go.
function letterOf(info) {
  const source =
    (info.title && info.title != info.url ? info.title : hostOf(info.url)) ||
    "?";
  return source.trim().charAt(0).toUpperCase() || "?";
}

// Draws Favorites, the Pinned tree, Today and the space switcher from the
// app's state, and turns drags, clicks and edits into commands. It owns no
// state of its own beyond what is drawn.
/**
 *
 * @param pinned
 * @param current
 */
/**
 * Whether a pinned tab has gone elsewhere. Two addresses are the same page if
 * they only differ in "www.", a closing slash or the fragment, which are what a
 * redirect or the page itself change without the person having gone anywhere.
 *
 * @param {string} pinned The address the tab was pinned at.
 * @param {string} current The address it is at.
 * @returns {boolean}
 */
export function isAway(pinned, current) {
  const key = url => {
    try {
      const { host, pathname, search } = new URL(url);
      return `${host.replace(/^www\./, "")}${pathname.replace(/\/$/, "")}${search}`;
    } catch (e) {
      return url;
    }
  };
  return key(pinned) != key(current);
}

const SPACE_MIME = "application/x-swell-space";

// Sideways scrolling of this many pixels changes space; a gesture ends when
// no wheel event has come for this long.
const WHEEL_THRESHOLD = 60;
const WHEEL_IDLE_MS = 250;
// Inside a gesture's tail, this much faster than its slowest point is a new swipe.
const WHEEL_RESTART_GAIN = 15;
// Held over another space's button, dragged pages make that space the one in front.
const DRAG_SWITCH_MS = 600;

/**
 *
 */
export class Sidebar {
  #app;
  #doc;
  #dragged = [];
  #dragSnapshot = null;
  #dragSwitch = null;
  #draggedSpace = null;
  #selection = new Set();
  #anchor = null;
  #selectionSpace = null;
  #favoritesPreview = null;
  #favoritesDropped = false;
  #wheelDelta = 0;
  #wheelSpent = false;
  #wheelIdle = null;
  #wheelLast = 0;
  #wheelFloor = Infinity;

  constructor(app) {
    this.#app = app;
    this.#doc = app.document;
    const doc = this.#doc;
    doc
      .getElementById("new-tab")
      .addEventListener("click", () => app.commandBar.open({ mode: "new" }));
    doc
      .getElementById("downloads-button")
      .addEventListener("click", () => app.downloads.toggle());
    doc
      .getElementById("space-add")
      .addEventListener("click", () => app.spaceEditor.create());
    doc
      .getElementById("sidebar")
      .addEventListener("wheel", event => this.#onWheel(event), {
        passive: false,
      });
    doc.getElementById("pinned-header").addEventListener("click", () => {
      const space = app.space;
      if (space) {
        app.setPinnedCollapsed(space.id, !space.pinnedCollapsed);
      }
    });
    for (const id of ["pinned", "today", "favorites"]) {
      this.#installDropZone(doc.getElementById(id));
    }
    const mac = Services.appinfo.OS == "Darwin";
    doc.getElementById("new-tab-key").textContent = mac ? "⌘T" : "Ctrl+T";
    doc.getElementById("sidebar").addEventListener("click", event => {
      if (!event.target.closest(".row")) {
        this.#setSelection([]);
      }
    });
    doc.addEventListener("keydown", event => {
      if (event.key == "Escape" && this.#selection.size) {
        this.#setSelection([]);
      }
    });
  }

  /**
   * The lists of the sidebar slide in from the side the new space is on.
   *
   * @param {"next"|"prev"} direction
   */
  slide(direction) {
    const sidebar = this.#doc.getElementById("sidebar");
    sidebar.classList.remove("slide-next", "slide-prev");
    // Restarts the animation if one is running.
    sidebar.getBoundingClientRect();
    sidebar.classList.add(`slide-${direction}`);
    sidebar.addEventListener(
      "animationend",
      () => sidebar.classList.remove("slide-next", "slide-prev"),
      { once: true }
    );
  }

  render() {
    const app = this.#app;
    const space = app.space;
    if (!space) {
      return;
    }
    this.#renderPinnedHeader(space);
    this.#renderTree("pinned", space.pinnedRoot, true);
    this.#renderTree("today", space.todayRoot);
    this.#renderFavorites(space.favoritesRoot);
    this.#renderSpaces();
    if (this.#selectionSpace !== app.activeSpaceId) {
      this.#selection.clear();
      this.#anchor = null;
      this.#selectionSpace = app.activeSpaceId;
    }
    this.#paintSelection();
  }

  // The rows drawn, top to bottom.
  #rowIds() {
    return [...this.#doc.querySelectorAll(".row[data-id]")].map(
      row => row.dataset.id
    );
  }

  // The selected nodes in the order they are drawn, without those that sit in
  // a selected folder, which go along with it.
  #selectedNodes() {
    const state = this.#app.state;
    return this.#rowIds().filter(
      id =>
        this.#selection.has(id) &&
        ![...this.#selection].some(
          other => other !== id && state.isWithin(id, other)
        )
    );
  }

  #setSelection(ids, anchor = this.#anchor) {
    this.#selection = new Set(ids);
    this.#anchor = this.#selection.size ? anchor : null;
    this.#paintSelection();
  }

  // Marks the selected rows, forgetting those that are no longer drawn.
  #paintSelection() {
    const drawn = new Set(this.#rowIds());
    for (const id of this.#selection) {
      if (!drawn.has(id)) {
        this.#selection.delete(id);
      }
    }
    for (const row of this.#doc.querySelectorAll(".row[data-id]")) {
      row.classList.toggle(
        "multi-selected",
        this.#selection.has(row.dataset.id)
      );
    }
  }

  // A click on a row: with the accelerator it toggles the row, with shift it
  // selects everything from the anchor to the row, and neither opens anything.
  #click(event, id) {
    const mac = Services.appinfo.OS == "Darwin";
    if (event.shiftKey) {
      const order = this.#rowIds();
      const from = order.indexOf(this.#anchor ?? id);
      const to = order.indexOf(id);
      this.#setSelection(
        order.slice(Math.min(from, to), Math.max(from, to) + 1),
        order[from]
      );
    } else if (mac ? event.metaKey : event.ctrlKey) {
      const ids = new Set(this.#selection);
      if (!ids.delete(id)) {
        ids.add(id);
      }
      this.#setSelection(ids, id);
    } else {
      this.#setSelection([]);
      this.#activate(id);
    }
  }

  // The name of the space above its pinned list; clicking it folds the list.
  #renderPinnedHeader(space) {
    const doc = this.#doc;
    const header = doc.getElementById("pinned-header");
    header.classList.toggle("collapsed", space.pinnedCollapsed);
    header.setAttribute("aria-expanded", String(!space.pinnedCollapsed));
    header.title = space.pinnedCollapsed
      ? "Show pinned tabs"
      : "Hide pinned tabs";
    showSpaceIcon(doc.getElementById("pinned-icon"), space);
    doc.getElementById("pinned-name").textContent = space.title;
    doc.getElementById("pinned").hidden = space.pinnedCollapsed;
  }

  #renderTree(containerId, root, saved = false) {
    const container = this.#doc.getElementById(containerId);
    container.dataset.rootId = root;
    const rows = this.#app.state
      .rows(root, id => this.#app.openTabs.has(id))
      .map(({ id, depth }) => this.#row(id, depth, saved));
    container.replaceChildren(...rows.filter(Boolean));
  }

  #row(id, depth, saved = false) {
    const app = this.#app;
    const info = app.state.describe(id);
    if (!info) {
      return null;
    }
    const doc = this.#doc;
    const row = doc.createElement("div");
    row.className = `row ${info.kind}`;
    row.dataset.id = id;
    row.draggable = true;
    row.style.paddingInlineStart = `${6 + depth * 14}px`;
    const openTab = app.openTabs.get(id);
    row.classList.toggle("open", !!openTab);
    row.classList.toggle("selected", app.selectedNode === id);
    row.classList.toggle("sharing", !!openTab?.sharing);

    const avatar = this.#avatar(info, openTab);
    avatar.classList.toggle("loading", !!openTab?.loading);
    const title = doc.createElement("span");
    title.className = "title";
    title.textContent = info.title;
    // A pinned tab that has gone elsewhere shows where it is, and a button back
    // to the page it was pinned at; closed, it is the pinned page again.
    const away =
      saved && info.kind == "tab" && !!openTab && isAway(info.url, openTab.url);
    row.classList.toggle("away", away);
    if (away) {
      title.textContent = openTab.title || openTab.url;
      const divider = doc.createElement("span");
      divider.className = "divider";
      row.append(avatar, divider, title);
      const back = doc.createElement("button");
      back.className = "back-to-pin";
      back.title = "Back to the pinned page";
      back.setAttribute("aria-label", "Back to the pinned page");
      back.addEventListener("click", event => {
        event.stopPropagation();
        app.run(() => app.bridge.loadInTab(openTab.liveTab, info.url));
      });
      row.append(back);
    } else {
      row.append(avatar, title);
    }
    if (info.kind == "tab") {
      // The same cross on every tab: on a page that is open it closes the page
      // (a pinned one stays pinned), on one that is not it deletes the pin.
      const closeButton = doc.createElement("button");
      closeButton.className = "close";
      closeButton.classList.toggle("unpin-keep", saved && !!openTab);
      closeButton.title = openTab ? "Close tab" : "Delete";
      closeButton.setAttribute("aria-label", closeButton.title);
      closeButton.addEventListener("click", event => {
        event.stopPropagation();
        if (openTab) {
          app.closeNodeTab(id);
        } else {
          app.removeNode(id);
        }
      });
      row.append(closeButton);
    }
    row.addEventListener("click", event => this.#click(event, id));
    row.addEventListener("auxclick", event => {
      if (event.button == 1) {
        event.preventDefault();
        app.closeNodeTab(id);
      }
    });
    row.addEventListener("dblclick", event => {
      event.stopPropagation();
      this.startRename(id);
    });
    row.addEventListener("contextmenu", event => this.#showMenu(event, id));
    this.#installDragSource(row, id);
    return row;
  }

  // The site icon if one is known, else the first letter of its name.
  #avatar(info, openTab) {
    const doc = this.#doc;
    const icon = openTab?.icon ?? info.icon;
    if (info.kind == "tab" && icon?.startsWith("data:image/")) {
      const image = doc.createElement("img");
      image.className = "avatar icon";
      image.src = icon;
      image.draggable = false;
      image.addEventListener(
        "error",
        () => image.replaceWith(this.#avatar({ ...info, icon: null }, null)),
        {
          once: true,
        }
      );
      return image;
    }
    const avatar = doc.createElement("span");
    avatar.className = "avatar";
    if (info.kind == "folder") {
      avatar.classList.add("folder-icon");
    } else {
      avatar.textContent = letterOf(info);
    }
    return avatar;
  }

  #activate(id) {
    const info = this.#app.state.describe(id);
    if (info?.kind == "folder") {
      this.#app.setCollapsed(id, !info.collapsed);
    } else if (info) {
      this.#app.openNode(id);
    }
  }

  #renderFavorites(root) {
    const app = this.#app;
    const container = this.#doc.getElementById("favorites");
    container.dataset.rootId = root;
    container.replaceChildren(
      ...app.state.childrenOf(root).map(id => {
        const info = app.state.describe(id);
        const button = this.#doc.createElement("button");
        button.className = "favorite";
        button.dataset.id = id;
        button.draggable = true;
        button.title = info.title;
        button.classList.toggle("open", app.openTabs.has(id));
        button.classList.toggle("selected", app.selectedNode === id);
        button.append(this.#avatar(info, app.openTabs.get(id)));
        button.addEventListener("click", () => app.openNode(id));
        button.addEventListener("auxclick", event => {
          if (event.button == 1) {
            event.preventDefault();
            app.closeNodeTab(id);
          }
        });
        button.addEventListener("contextmenu", event =>
          this.#showMenu(event, id)
        );
        this.#installDragSource(button, id);
        return button;
      })
    );
  }

  // Sideways scrolling over the sidebar (a touchpad swipe, a horizontal wheel)
  // goes one space per gesture. A swipe sends many events, and its inertia
  // tail keeps coming for a second or more after the fingers are up, so deltas
  // add up to a threshold and the rest of the gesture is ignored. A gesture
  // ends when events stop for a while, or, since the next swipe can begin
  // inside the tail, when the scroll turns around or speeds up again.
  #onWheel(event) {
    const dx = event.deltaX;
    if (Math.abs(dx) <= Math.abs(event.deltaY)) {
      return;
    }
    event.preventDefault();
    clearTimeout(this.#wheelIdle);
    this.#wheelIdle = setTimeout(() => this.#endWheelGesture(), WHEEL_IDLE_MS);
    if (this.#wheelSpent) {
      const speed = Math.abs(dx);
      this.#wheelFloor = Math.min(this.#wheelFloor, speed);
      if (
        Math.sign(dx) != Math.sign(this.#wheelLast) ||
        (speed >= this.#wheelFloor + WHEEL_RESTART_GAIN &&
          speed > this.#wheelFloor * 2)
      ) {
        this.#endWheelGesture();
      }
    }
    this.#wheelLast = dx;
    if (this.#wheelSpent) {
      return;
    }
    this.#wheelDelta += dx;
    if (Math.abs(this.#wheelDelta) >= WHEEL_THRESHOLD) {
      this.#wheelSpent = true;
      this.#wheelFloor = Math.abs(dx);
      this.#app.switchSpaceBy(Math.sign(this.#wheelDelta));
    }
  }

  #endWheelGesture() {
    this.#wheelSpent = false;
    this.#wheelDelta = 0;
    this.#wheelFloor = Infinity;
  }

  #renderSpaces() {
    const app = this.#app;
    const nav = this.#doc.getElementById("spaces");
    const buttons = app.spaces.map(space => {
      const button = this.#doc.createElement("button");
      button.className = "space";
      button.classList.toggle("active", space.id == app.activeSpaceId);
      button.title = space.title;
      button.dataset.id = space.id;
      button.draggable = true;
      showSpaceIcon(button, space);
      button.addEventListener("click", () => app.switchSpace(space.id));
      button.addEventListener("contextmenu", event => {
        event.preventDefault();
        app.menu.show(event.clientX, event.clientY, [
          {
            label: "Edit space\u2026",
            action: () => app.spaceEditor.edit(space),
          },
          {
            label: "Delete space\u2026",
            danger: true,
            disabled: app.spaces.length < 2,
            action: () => app.deleteSpace(space.id),
          },
        ]);
      });
      this.#installSpaceDrag(button, space.id);
      return button;
    });
    nav.replaceChildren(...buttons);
  }

  // Spaces are dragged by their buttons; dropping on the left half of another
  // one puts the space before it, on the right half after it.
  #installSpaceDrag(button, id) {
    const clear = () =>
      button.classList.remove("drop-before", "drop-after", "drop-into");
    button.addEventListener("dragstart", event => {
      this.#dragged = [];
      this.#dragSnapshot = null;
      this.#draggedSpace = id;
      event.dataTransfer.setData(SPACE_MIME, id);
      event.dataTransfer.effectAllowed = "move";
      button.classList.add("dragging");
    });
    button.addEventListener("dragend", () => {
      this.#draggedSpace = null;
      button.classList.remove("dragging");
      for (const other of this.#doc.querySelectorAll(".space")) {
        other.classList.remove("drop-before", "drop-after");
      }
    });
    // Pages dragged onto a space's button go there; held over it, they show it.
    const forPages = () => !this.#draggedSpace && this.#dragSnapshot;
    button.addEventListener("dragenter", () => {
      if (forPages() && id != this.#app.activeSpaceId) {
        clearTimeout(this.#dragSwitch);
        this.#dragSwitch = setTimeout(
          () => this.#app.switchSpace(id),
          DRAG_SWITCH_MS
        );
      }
    });
    button.addEventListener("dragover", event => {
      if (forPages()) {
        if (id != this.#app.activeSpaceId) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          button.classList.add("drop-into");
        }
        return;
      }
      if (!this.#draggedSpace || this.#draggedSpace == id) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const rect = button.getBoundingClientRect();
      const before = event.clientX < rect.left + rect.width / 2;
      button.classList.toggle("drop-before", before);
      button.classList.toggle("drop-after", !before);
    });
    button.addEventListener("dragleave", () => {
      clear();
      clearTimeout(this.#dragSwitch);
    });
    button.addEventListener("drop", event => {
      if (forPages()) {
        event.preventDefault();
        const snapshot = this.#dragSnapshot;
        this.#endNodeDrag();
        clear();
        if (id != this.#app.activeSpaceId) {
          this.#app.moveToSpace(snapshot, id);
        }
        return;
      }
      const dragged = this.#draggedSpace;
      if (!dragged || dragged == id) {
        return;
      }
      event.preventDefault();
      const after = button.classList.contains("drop-after");
      clear();
      const order = this.#app.spaces.map(space => space.id);
      let target = order.indexOf(id) + (after ? 1 : 0);
      if (order.indexOf(dragged) < target) {
        target--;
      }
      this.#app.moveSpace(dragged, target);
    });
  }

  // Replaces a row's title with an input; Enter or leaving it saves.
  startRename(id) {
    const row = this.#doc.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    const info = this.#app.state.describe(id);
    if (!row || !info) {
      return;
    }
    const titleEl = row.querySelector(".title");
    const input = this.#doc.createElement("input");
    input.className = "rename";
    input.value = info.title;
    row.draggable = false;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = save => {
      if (done) {
        return;
      }
      done = true;
      row.draggable = true;
      const value = input.value.trim();
      if (save && value && value != info.title) {
        this.#app.renameNode(id, value);
      } else {
        this.#app.scheduleRender();
      }
    };
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (event.key == "Enter") {
        finish(true);
      } else if (event.key == "Escape") {
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", event => event.stopPropagation());
  }

  #showMenu(event, id) {
    event.preventDefault();
    const app = this.#app;
    if (this.#selection.has(id) && this.#selection.size > 1) {
      const nodes = this.#selectedNodes();
      app.menu.show(event.clientX, event.clientY, [
        {
          label: `Create folder with ${nodes.length} items`,
          action: () => {
            this.#setSelection([]);
            app.newFolderWith(nodes);
          },
        },
      ]);
      return;
    }
    this.#setSelection([]);
    const info = app.state.describe(id);
    const space = app.space;
    const parentId = app.state.parent(id);
    const inToday = parentId === space.todayRoot;
    const items = [];
    if (info.kind == "folder") {
      items.push({ label: "New subfolder", action: () => app.newFolder(id) });
    } else {
      items.push({ label: "Open", action: () => app.openNode(id) });
      const inFavorites = parentId === space.favoritesRoot;
      if (inToday) {
        items.push({ label: "Pin", action: () => app.pin(id) });
      } else if (!inFavorites) {
        items.push({ label: "Unpin", action: () => app.unpin(id) });
      }
      if (inFavorites) {
        items.push({
          label: "Remove from favorites",
          action: () => app.unpin(id),
        });
      } else {
        items.push({
          label: "Add to favorites",
          action: () => app.favorite(id),
        });
      }
      if (app.openTabs.has(id)) {
        items.push({ label: "Close tab", action: () => app.closeNodeTab(id) });
      }
    }
    items.push({ label: "Rename", action: () => this.startRename(id) });
    items.push({
      label: info.kind == "folder" ? "Delete folder" : "Delete",
      danger: true,
      action: () => app.removeNode(id),
    });
    app.menu.show(event.clientX, event.clientY, items);
  }

  #installDragSource(element, id) {
    element.addEventListener("dragstart", event => {
      if (!this.#selection.has(id)) {
        this.#setSelection([]);
      }
      this.#dragged = this.#selection.has(id) ? this.#selectedNodes() : [id];
      this.#dragSnapshot = this.#app.dragSnapshot(this.#dragged);
      this.#favoritesPreview = null;
      this.#favoritesDropped = false;
      event.dataTransfer.setData(DRAG_TYPE, id);
      event.dataTransfer.effectAllowed = "move";
      for (const dragged of this.#dragged) {
        this.#doc
          .querySelector(`[data-id="${CSS.escape(dragged)}"]`)
          ?.classList.add("dragging");
      }
      this.#doc.getElementById("sidebar").classList.add("tab-dragging");
    });
    element.addEventListener("dragend", () => {
      this.#endNodeDrag();
      if (!this.#favoritesDropped) {
        this.#restoreFavorites();
      }
    });
  }

  // The drag is over, dropped or not. If showing another space replaced the
  // dragged row, the browser never says so, and the drop does.
  #endNodeDrag() {
    clearTimeout(this.#dragSwitch);
    this.#dragged = [];
    this.#dragSnapshot = null;
    for (const dragging of this.#doc.querySelectorAll(
      ".row.dragging, .favorite.dragging"
    )) {
      dragging.classList.remove("dragging");
    }
    this.#doc.getElementById("sidebar").classList.remove("tab-dragging");
    this.#clearDropMarks();
  }

  // Whether the nodes being dragged belong to another space than the one shown.
  get #dragIsForeign() {
    return (
      !!this.#dragSnapshot &&
      this.#dragSnapshot.space != this.#app.activeSpaceId
    );
  }

  #installDropZone(container) {
    container.addEventListener("dragover", event => {
      const drop = this.#dropFor(container, event);
      this.#clearDropMarks();
      if (container.id == "favorites" && !drop?.foreign) {
        if (drop) {
          this.#arrangeFavorites(drop.choice);
        } else {
          this.#restoreFavorites();
        }
      }
      if (!drop) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      drop.element?.classList.add(`drop-${drop.where}`);
    });
    container.addEventListener("dragleave", event => {
      if (!container.contains(event.relatedTarget)) {
        this.#clearDropMarks();
        if (container.id == "favorites") {
          this.#restoreFavorites();
        }
      }
    });
    container.addEventListener("drop", event => {
      const drop = this.#dropFor(container, event);
      this.#clearDropMarks();
      if (drop?.foreign) {
        event.preventDefault();
        const snapshot = this.#dragSnapshot;
        this.#endNodeDrag();
        this.#app.moveToSpace(snapshot, this.#app.activeSpaceId, container.id);
      } else if (drop) {
        event.preventDefault();
        this.#favoritesDropped ||= container.id == "favorites";
        this.#app.moveNodes(drop.plan);
      }
    });
  }

  // Resolves a pointer position to a row (or an empty list) and a place
  // relative to it, then asks the tree whether that drop is allowed.
  #dropFor(container, event) {
    const dragged = this.#dragged;
    if (!dragged.length) {
      return null;
    }
    if (this.#dragIsForeign) {
      return { foreign: true, where: "inside", element: container };
    }
    const state = this.#app.state;
    if (container.id == "favorites") {
      const choice = this.#favoritesChoice(container, event);
      const plan =
        choice &&
        state.planMoves({
          dragged,
          target: choice.target,
          where: choice.where,
          tabsOnly: this.#app.tabsOnlyRoots,
        });
      if (!plan) {
        return null;
      }
      this.#favoritesPreview = choice;
      return { plan, where: choice.where, element: choice.element, choice };
    }
    const row = event.target.closest?.("[data-id]");
    let targetId;
    let where;
    let element;
    if (row && container.contains(row)) {
      targetId = row.dataset.id;
      element = row;
      const { top: rowTop, height } = row.getBoundingClientRect();
      const offset = (event.clientY - rowTop) / height;
      if (state.isFolder(targetId) && offset > 0.25 && offset < 0.75) {
        where = "inside";
      } else {
        where = offset < 0.5 ? "before" : "after";
      }
    } else {
      targetId = container.dataset.rootId;
      where = "inside";
      element = container;
    }
    const plan = state.planMoves({
      dragged,
      target: targetId,
      where,
      tabsOnly: this.#app.tabsOnlyRoots,
    });
    return plan ? { plan, where, element } : null;
  }

  // Where a drag over the favorites would land: before or after the tile
  // nearest to the pointer, by its horizontal half. Over the tile being moved,
  // or the placeholder, nothing changes from the last preview. Tiles are
  // measured where the layout puts them, not where a slide has them for now.
  #favoritesChoice(container, event) {
    const tiles = [...container.querySelectorAll(".favorite")];
    if (!tiles.some(tile => !tile.classList.contains("placeholder"))) {
      return {
        target: container.dataset.rootId,
        where: "inside",
        element: container,
      };
    }
    const area = container.getBoundingClientRect();
    const layout = tile => {
      const left = area.left + tile.offsetLeft - container.offsetLeft;
      const upper = area.top + tile.offsetTop - container.offsetTop;
      return {
        left,
        top: upper,
        right: left + tile.offsetWidth,
        bottom: upper + tile.offsetHeight,
      };
    };
    const { clientX: x, clientY: y } = event;
    const distance = rect =>
      Math.hypot(
        Math.max(rect.left - x, 0, x - rect.right),
        Math.max(rect.top - y, 0, y - rect.bottom)
      );
    let nearest = tiles[0];
    for (const tile of tiles) {
      nearest =
        distance(layout(tile)) < distance(layout(nearest)) ? tile : nearest;
    }
    if (nearest.matches(".placeholder, .dragging")) {
      return this.#favoritesPreview;
    }
    const { left, right } = layout(nearest);
    return {
      target: nearest.dataset.id,
      where: x < (left + right) / 2 ? "before" : "after",
      element: null,
    };
  }

  // Shows the favorites as they will be once the drag is dropped: the tile
  // being moved, or a placeholder for one coming from elsewhere, goes where the
  // pointer says and the others make room.
  #arrangeFavorites({ target, where }) {
    const container = this.#doc.getElementById("favorites");
    if (where == "inside") {
      return;
    }
    const moving =
      container.querySelector(".favorite.dragging") ??
      container.querySelector(".placeholder") ??
      this.#placeholder();
    const tiles = this.#favoriteTiles(container);
    const order = this.#app.state
      .childrenOf(container.dataset.rootId)
      .filter(id => !this.#dragged.includes(id))
      .map(id => tiles.get(id))
      .filter(Boolean);
    order.splice(
      order.indexOf(tiles.get(target)) + (where == "after" ? 1 : 0),
      0,
      moving
    );
    this.#applyFavoritesOrder(container, order, moving);
  }

  // Puts the favorites back as the tree has them.
  #restoreFavorites() {
    const container = this.#doc.getElementById("favorites");
    this.#favoritesPreview = null;
    container.querySelector(".placeholder")?.remove();
    const tiles = this.#favoriteTiles(container);
    const order = this.#app.state
      .childrenOf(container.dataset.rootId)
      .map(id => tiles.get(id))
      .filter(Boolean);
    this.#applyFavoritesOrder(container, order);
  }

  #favoriteTiles(container) {
    return new Map(
      [...container.querySelectorAll(".favorite:not(.placeholder)")].map(
        tile => [tile.dataset.id, tile]
      )
    );
  }

  #placeholder() {
    const placeholder = this.#doc.createElement("div");
    placeholder.className = "favorite placeholder";
    placeholder.setAttribute("aria-hidden", "true");
    return placeholder;
  }

  // Reorders the tiles and slides them from where they were. The tile being
  // dragged stays in the page, as the drag would end if it left it; the others
  // move around it.
  #applyFavoritesOrder(container, order, moving = null) {
    const current = [...container.children];
    if (
      order.length == current.length &&
      order.every((tile, i) => tile === current[i])
    ) {
      return;
    }
    const before = new Map(
      current.map(tile => [tile, tile.getBoundingClientRect()])
    );
    for (const tile of current) {
      for (const slide of tile.getAnimations()) {
        slide.cancel();
      }
    }
    const pivot = container.querySelector(".favorite.dragging");
    if (pivot && order.includes(pivot)) {
      const at = order.indexOf(pivot);
      for (const tile of order.slice(0, at)) {
        pivot.before(tile);
      }
      for (const tile of order.slice(at + 1).reverse()) {
        pivot.after(tile);
      }
    } else {
      container.replaceChildren(...order);
    }
    const win = this.#doc.defaultView;
    if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    for (const [tile, from] of before) {
      const to = tile.getBoundingClientRect();
      if (tile !== moving && (from.left != to.left || from.top != to.top)) {
        tile.animate(
          [
            {
              transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)`,
            },
            { transform: "none" },
          ],
          { duration: 150, easing: "ease-out" }
        );
      }
    }
  }

  #clearDropMarks() {
    for (const element of this.#doc.querySelectorAll(
      ".drop-before, .drop-after, .drop-inside"
    )) {
      element.classList.remove("drop-before", "drop-after", "drop-inside");
    }
  }
}
// /* This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
