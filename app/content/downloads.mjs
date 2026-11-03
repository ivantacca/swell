/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const fileName = download =>
  PathUtils.filename(download.target.path ?? "") || "file";

function reveal(download) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(download.target.path);
  file.reveal();
}

const sizeFormat = bytes => {
  if (!(bytes >= 0)) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (bytes >= 1000 && i < units.length - 1) {
    bytes /= 1000;
    i++;
  }
  return `${bytes.toFixed(i && bytes < 10 ? 1 : 0)} ${units[i]}`;
};

const hostOf = download => {
  try {
    return new URL(download.source.url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const ago = date => {
  const seconds = Math.round((Date.now() - date) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
};

/** The state of a download as a short phrase for its subline. */
function stateOf(download) {
  if (download.error) {
    return "Failed";
  }
  if (download.canceled) {
    return download.hasPartialData ? "Paused" : "Canceled";
  }
  if (download.succeeded) {
    return "";
  }
  const total = download.hasProgress ? download.totalBytes : 0;
  return total
    ? `${sizeFormat(download.currentBytes)} of ${sizeFormat(total)}`
    : download.currentBytes
      ? sizeFormat(download.currentBytes)
      : "Starting";
}

const dayOf = download => {
  const start = new Date(download.startTime);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (start >= today) {
    return "Today";
  }
  return start >= today - 86400000 ? "Yesterday" : "Earlier";
};

/**
 * Tells when a download of the active space starts and finishes, and lists
 * that space's downloads. Each download remembers the container it came from
 * (`source.userContextId`); a space never sees another space's downloads,
 * not even their names in a toast.
 */
export class DownloadsPanel {
  #app;
  #list = null;
  #panel;
  #sidebar;
  #rows;
  #clear;
  #toasts = new WeakMap();

  constructor(app) {
    this.#app = app;
    const doc = app.document;
    this.#panel = doc.getElementById("downloads-panel");
    this.#sidebar = doc.getElementById("sidebar");
    this.#rows = doc.getElementById("downloads-list");
    this.#clear = doc.getElementById("downloads-clear");
    this.#clear.addEventListener("click", async () => {
      for (const download of await this.forActiveSpace()) {
        if (download.stopped && !download.hasPartialData) {
          this.#list.remove(download);
        }
      }
    });
  }

  /** Whether the list is showing in the sidebar. */
  get visible() {
    return !this.#panel.hidden;
  }

  async init() {
    this.#list = await this.#app.Downloads.getList(this.#app.Downloads.ALL);
    await this.#list.addView({
      onDownloadAdded: download => {
        if (!download.stopped && this.#inActiveSpace(download)) {
          this.#toasts.set(
            download,
            this.#app.toasts.show({
              text: `Downloading ${fileName(download)}`,
              timeout: 0,
            })
          );
        }
        this.#refresh();
      },
      onDownloadChanged: download => {
        this.#refresh();
        const toast = this.#toasts.get(download);
        if (!toast) {
          return;
        }
        if (download.succeeded) {
          toast.dismiss();
          this.#toasts.delete(download);
          this.#app.toasts.show({
            text: `Downloaded ${fileName(download)}`,
            actions: [{ label: "Show in folder", run: () => reveal(download) }],
          });
        } else if (download.error) {
          toast.dismiss();
          this.#toasts.delete(download);
          this.#app.toasts.show({
            text: `Download of ${fileName(download)} failed`,
          });
        }
      },
      onDownloadRemoved: () => this.#refresh(),
    });
  }

  #inActiveSpace(download) {
    const space = this.#app.space;
    return (
      !!space && (download.source.userContextId ?? 0) == space.userContextId
    );
  }

  /** The downloads of the active space, newest first. */
  async forActiveSpace() {
    const all = await this.#list.getAll();
    return all.filter(d => this.#inActiveSpace(d)).reverse();
  }

  async show() {
    this.#panel.hidden = false;
    this.#sidebar.dataset.view = "downloads";
    await this.#refresh();
  }

  hide() {
    this.#panel.hidden = true;
    delete this.#sidebar.dataset.view;
  }

  toggle() {
    return this.visible ? this.hide() : this.show();
  }

  async #refresh() {
    const doc = this.#app.document;
    const downloads = await this.forActiveSpace();
    this.#clear.hidden = !downloads.some(d => d.stopped);
    if (!downloads.length) {
      const empty = doc.createElement("div");
      empty.className = "downloads-empty";
      const text = doc.createElement("p");
      text.textContent = "No downloads in this space";
      empty.append(text);
      this.#rows.replaceChildren(empty);
      return;
    }
    const nodes = [];
    let day = null;
    for (const download of downloads) {
      if (dayOf(download) != day) {
        day = dayOf(download);
        const heading = doc.createElement("h3");
        heading.className = "downloads-day";
        heading.textContent = day;
        nodes.push(heading);
      }
      nodes.push(this.#row(download));
    }
    this.#rows.replaceChildren(...nodes);
  }

  #button(download, className, title, run) {
    const button = this.#app.document.createElement("button");
    button.className = `download-button ${className}`;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", event => {
      event.stopPropagation();
      run();
    });
    return button;
  }

  #row(download) {
    const doc = this.#app.document;
    const running = !download.stopped;
    const row = doc.createElement("div");
    row.className = "download-row";
    row.dataset.state = download.succeeded
      ? "done"
      : download.error
        ? "failed"
        : running
          ? "running"
          : "stopped";

    const icon = doc.createElement("span");
    icon.className = "download-icon";

    const name = doc.createElement("span");
    name.className = "download-name";
    name.textContent = fileName(download);
    name.title = fileName(download);

    const state = doc.createElement("span");
    state.className = "download-state";
    const parts = [];
    if (download.succeeded) {
      parts.push(sizeFormat(download.target.size));
    } else {
      parts.push(stateOf(download));
    }
    parts.push(hostOf(download));
    if (download.stopped && download.startTime) {
      parts.push(ago(new Date(download.startTime)));
    }
    state.textContent = parts.filter(Boolean).join(" · ");

    const actions = doc.createElement("div");
    actions.className = "download-actions";
    if (download.succeeded) {
      actions.append(
        this.#button(download, "show", "Show in folder", () => reveal(download))
      );
    } else if (running) {
      if (download.hasPartialData || download.hasProgress) {
        actions.append(
          this.#button(download, "pause", "Pause", () => download.cancel())
        );
      }
      actions.append(
        this.#button(download, "cancel", "Cancel", async () => {
          await download.cancel();
          await download.removePartialData();
          this.#list.remove(download);
        })
      );
    } else {
      actions.append(
        this.#button(
          download,
          download.hasPartialData ? "resume" : "retry",
          download.hasPartialData ? "Resume" : "Retry",
          () => download.start().catch(() => {})
        )
      );
    }
    if (!running) {
      actions.append(
        this.#button(download, "remove", "Remove from list", () =>
          this.#list.remove(download)
        )
      );
    }

    row.append(icon, name, state, actions);
    if (running) {
      const bar = doc.createElement("div");
      bar.className = "download-progress";
      const fill = doc.createElement("div");
      fill.className = "download-progress-fill";
      if (download.hasProgress) {
        fill.style.width = `${download.progress}%`;
      } else {
        bar.dataset.indeterminate = "";
      }
      bar.append(fill);
      row.append(bar);
    }
    if (download.succeeded) {
      row.tabIndex = 0;
      row.addEventListener("click", () => download.launch().catch(() => {}));
      row.addEventListener("keydown", event => {
        if (event.key == "Enter") {
          download.launch().catch(() => {});
        }
      });
    }
    return row;
  }
}
