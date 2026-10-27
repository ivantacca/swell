#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Starts Swell on a fresh profile, leaves it idle, and lists every host it contacts.

Run from the firefox/ directory:
    MOZCONFIG=$PWD/swell/mozconfig ./mach python swell/tests/e2e/network_silence.py [--seconds N] [--report]

Fails if anything but localhost was contacted by the browser itself. No web page
is loaded, so every request in the log comes from the application: telemetry,
connectivity checks, update and settings services, and so on. --report prints
the hosts and the log lines that name them without failing. The automatic update
check (api.github.com, about 30 s after start) is allowed, and must happen, in a
run of at least 40 s; --no-autocheck turns it off and then allows no GitHub at all.
SWELL_APP names another binary to run, for example the staged package.
"""

import argparse
import os
import re
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

# Remote Settings is allowed on purpose (a decision of the M2 milestone): read-only
# downloads of the add-on blocklist and certificate revocation data, from the
# service itself, its attachment CDN and the CDN of the signature chains that
# verify what it sends.
ALLOWED = {
    "firefox.settings.services.mozilla.com",
    "firefox-settings-attachments.cdn.mozilla.net",
    "content-signature-2.cdn.mozilla.net",
}
UPDATE_CHECK = "api.github.com"
UPDATE_CHECK_WAIT = 40
LOCAL = {"localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"}

HOST = re.compile(r"(?:https?|wss?)://([A-Za-z0-9._\-\[\]:]+?)(?::\d+)?(?:/|\s|$|\")")


def launch(profile, log):
    env = dict(
        os.environ,
        MOZ_CRASHREPORTER_DISABLE="1",
        MOZ_REMOTE_ALLOW_SYSTEM_ACCESS="1",
        MOZ_HEADLESS="1",
        MOZ_LOG="nsHttp:3,nsHostResolver:5,timestamp,sync",
        MOZ_LOG_FILE=log,
    )
    proc = subprocess.Popen(
        [APP, "-marionette", "-remote-allow-system-access", "-profile", profile]
        + ["-no-remote"],
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


def hosts_in(log_dir):
    found = {}
    for name in os.listdir(log_dir):
        with open(os.path.join(log_dir, name), errors="replace") as f:
            for line in f:
                if "MaybeSetPrivateURI" in line:
                    continue  # the DoH server is configured, not contacted
                if "nsHostResolver" in line and "host=" in line:
                    m = re.search(r"host=([A-Za-z0-9._\-]+)", line)
                    if m:
                        found.setdefault(m.group(1), line.strip())
                for m in HOST.finditer(line):
                    found.setdefault(m.group(1), line.strip())
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=int, default=90)
    parser.add_argument("--report", action="store_true")
    parser.add_argument(
        "--no-autocheck",
        action="store_true",
        help="run with swell.update.autocheck off: no request to GitHub is allowed",
    )
    parser.add_argument(
        "--control",
        action="store_true",
        help="make one request from chrome to prove the capture sees requests",
    )
    args = parser.parse_args()
    profile = tempfile.mkdtemp(prefix="swell-net-")
    logs = tempfile.mkdtemp(prefix="swell-netlog-")
    with open(os.path.join(profile, "user.js"), "w") as f:
        # Marionette would otherwise switch off telemetry, safe browsing, region
        # and connectivity checks and so on, and hide what Swell does by itself.
        f.write('user_pref("remote.prefs.recommended", false);\n')
        if args.no_autocheck:
            f.write('user_pref("swell.update.autocheck", false);\n')
    allowed = ALLOWED if args.no_autocheck else ALLOWED | {UPDATE_CHECK}
    try:
        proc, client = launch(profile, os.path.join(logs, "http.log"))
        client.execute_async_script(
            "arguments[arguments.length - 1](window.SwellApp.ready.then(() => 1));"
        )
        if args.control:
            client.execute_async_script(
                "const d = arguments[arguments.length - 1];"
                "fetch('https://example.org/').then(() => d(1), () => d(0));"
            )
        time.sleep(args.seconds)
        try:
            client.execute_script(
                "Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);"
            )
        except Exception:
            pass
        proc.wait(timeout=60)
        found = hosts_in(logs)
        sizes = {n: os.path.getsize(os.path.join(logs, n)) for n in os.listdir(logs)}
        print("log files:", sizes)
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(logs, ignore_errors=True)
    external = {
        h: line
        for h, line in found.items()
        if h.lower() not in LOCAL and h.lower() not in allowed
    }
    print(f"hosts seen: {sorted(found)}")
    if args.report:
        for host, line in sorted(external.items()):
            print(f"  {host}\n    {line[:200]}")
        return 0
    if not args.no_autocheck and args.seconds >= UPDATE_CHECK_WAIT:
        if UPDATE_CHECK not in found:
            print(f"FAIL: the automatic update check never contacted {UPDATE_CHECK}")
            return 1
    if external:
        print("FAIL: Swell contacted hosts it should not have:")
        for host, line in sorted(external.items()):
            print(f"  {host}\n    {line[:200]}")
        return 1
    print(f"OK: nothing but localhost and {sorted(allowed)} in {args.seconds}s idle")
    return 0


if __name__ == "__main__":
    sys.exit(main())
