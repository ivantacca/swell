#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Starts Swell twice on one profile and checks that the core's state survives.

Run from the firefox/ directory:
    MOZCONFIG=$PWD/swell/mozconfig ./mach python swell/tests/e2e/restart_persistence.py [--shots DIR]

SWELL_APP names another binary to run, for example the staged package.

First launch: make a space, a pinned folder with a saved tab, and open a real
page. Second launch, same profile: the space, the pinned tree and the Today row
must be back, and the tab that was in front must be open again, alone. Needs
network access for the real page.
"""

import argparse
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import time

from marionette_driver.marionette import Marionette

DEFAULT_APP = (
    "obj-swell/dist/Swell.app/Contents/MacOS/swell"
    if sys.platform == "darwin"
    else "obj-swell/dist/bin/swell"
)
APP = os.environ.get("SWELL_APP", DEFAULT_APP)

BUILD = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const { Icon, Transition } = ChromeUtils.importESModule("moz-src:///swell/app/modules/Core.sys.mjs");
  const { core, bridge, app } = await window.SwellApp.ready;
  const [personal] = await core.listSpaces();
  const workId = await core.createSpace("Work", new Icon.Emoji({ glyph: "\u{1F4BC}" }));
  const folder = await core.createFolder(personal.pinnedRoot, "Reading", 0);
  const { liveTab, node } = await core.onTabOpened("main", personal.id, "https://example.org/");
  await core.onNavigation(liveTab, "https://example.org/", "Example Org", Transition.TYPED);
  await core.moveNode(node, folder, 0);
  await core.onTabClosed(liveTab);
  await app.switchSpace(personal.id);
  const live = await bridge.openUrl("https://example.com/", personal.id);
  for (let i = 0; i < 80 && !(bridge.tab(live)?.title); i++) {
    await new Promise(r => setTimeout(r, 250));
  }
  done({ workId, title: bridge.tab(live)?.title, url: bridge.tab(live)?.url });
})().catch(e => done("ERR " + e + " " + e.stack));
"""

INSPECT = r"""
const done = arguments[arguments.length - 1];
(async () => {
  const { core, bridge, app } = await window.SwellApp.ready;
  const spaces = await core.listSpaces();
  const personal = spaces[0];
  for (let i = 0; i < 80 && !bridge.selectedTab?.url; i++) {
    await new Promise(r => setTimeout(r, 250));
  }
  const tree = await core.spaceTree(personal.id);
  const titles = tree.nodes.map(n => n.kind.title ?? n.kind.url);
  done({
    spaces: spaces.map(s => s.title),
    titles,
    openTabs: bridge.tabs().length,
    frontUrl: bridge.selectedTab?.url ?? null,
    rows: [...document.querySelectorAll("#pinned .row, #today .row")].map(r => r.textContent.trim()),
  });
})().catch(e => done("ERR " + e + " " + e.stack));
"""


def launch(profile, headless=True):
    env = dict(
        os.environ, MOZ_CRASHREPORTER_DISABLE="1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1"
    )
    if headless:
        env["MOZ_HEADLESS"] = "1"
    proc = subprocess.Popen(
        [
            APP,
            "-marionette",
            "-remote-allow-system-access",
            "-profile",
            profile,
            "-no-remote",
        ],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    client = Marionette(host="127.0.0.1", port=2828)
    for _ in range(80):
        try:
            client.start_session()
            break
        except Exception:
            time.sleep(0.5)
    else:
        proc.kill()
        raise SystemExit("could not connect to Swell")
    client.set_context("chrome")
    client.timeout.script = 90
    return proc, client


def quit_app(client, proc):
    try:
        client.execute_script("Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);")
    except Exception:
        pass  # the connection closes as the application goes away
    proc.wait(timeout=60)


def shot(client, directory, name):
    if directory:
        with open(os.path.join(directory, name), "wb") as f:
            f.write(base64.b64decode(client.screenshot()))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--shots", help="directory for screenshots")
    args = parser.parse_args()
    profile = tempfile.mkdtemp(prefix="swell-restart-")
    failures = []
    try:
        proc, client = launch(profile)
        built = client.execute_async_script(BUILD)
        print("first launch:", built)
        if isinstance(built, str) or not built.get("title"):
            failures.append(f"the real page did not load: {built}")
        shot(client, args.shots, "first-launch.png")
        quit_app(client, proc)

        proc, client = launch(profile)
        state = client.execute_async_script(INSPECT)
        print("second launch:", state)
        shot(client, args.shots, "second-launch.png")
        if isinstance(state, str):
            failures.append(state)
        else:
            if "Work" not in state["spaces"]:
                failures.append("the Work space did not come back")
            for expected in ("Reading", "Example Org"):
                if expected not in state["titles"]:
                    failures.append(f"{expected!r} did not come back")
            if state["openTabs"] != 1:
                failures.append(
                    f"expected only the tab in front to be open, got {state['openTabs']}"
                )
            elif not (state["frontUrl"] or "").startswith("https://example.com"):
                failures.append(f"the tab in front is {state['frontUrl']!r}")
            if not any("Example Domain" in row for row in state["rows"]):
                failures.append("the Today row for the page did not come back")
        quit_app(client, proc)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
    if failures:
        print("FAIL:", *failures, sep="\n  ")
        return 1
    print(
        "OK: spaces, folders, saved tabs, Today rows and the tab in front survive a restart"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
