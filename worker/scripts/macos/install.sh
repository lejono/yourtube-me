#!/bin/bash
# Install the YourTube worker launchd daemon on macOS.
#
#   sudo bash install.sh
#
# INTENDED INVOCATION: from a ROOT-OWNED copy of worker/scripts/macos/.
# Root installs a system LaunchDaemon out of these files, so a source
# directory the service account can write is a source directory it can use
# to author what root installs. There is deliberately no override flag:
# copy the directory to a root-owned path and run it from there. The plist
# assertions below are a second line of defence, not a substitute.
#
# Idempotent: re-running reinstalls the wrapper, replaces the plist and
# re-bootstraps the daemon. Secrets are NOT this script's business — the env
# files under config/ are created and populated separately; touching them
# here would risk clobbering a live key.
set -euo pipefail

BOT=ytworker
BOTHOME=/Users/$BOT
RUNTIME=$BOTHOME/team/yourtube
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL=net.postquantum.yourtube-worker

[ "$(id -u)" -eq 0 ] || { echo "must run with sudo"; exit 1; }
id "$BOT" >/dev/null 2>&1 || { echo "no $BOT user — create the service account first"; exit 1; }

if [ -n "$(find "$HERE" -maxdepth 0 ! -user root 2>/dev/null)" ]; then
  echo "REFUSING: $HERE is not root-owned." >&2
  echo "  Copy worker/scripts/macos/ to a root-owned path and run it from there, e.g." >&2
  echo "    sudo rsync -a --chown=root:wheel $HERE/ /usr/local/ytworker-install/" >&2
  echo "    sudo bash /usr/local/ytworker-install/install.sh" >&2
  exit 1
fi

# Refuse to write anything through a symlink. Root's `install` calls below
# all land under $RUNTIME, a tree the service account owns and can rewrite
# between runs; `install -d -o ytworker -m 700 <symlink>` exits 0, leaves
# the link alone, and applies the ownership and mode to its *target*.
refuse_symlink() {
  if [ -L "$1" ]; then
    echo "$1 is a symlink — refusing to install through it (remove it and re-run)" >&2
    exit 1
  fi
}
for d in "$RUNTIME" "$RUNTIME/bin" "$RUNTIME/bin/run-worker.sh" \
         "$RUNTIME/logs" "$RUNTIME/run"; do
  refuse_symlink "$d"
done

echo "== 1. Wrapper and runtime dirs =="
# The daemon runs the wrapper out of the runtime tree, not out of this
# checkout: the runtime tree survives a re-clone of the repo, so re-cloning
# can never leave launchd pointing at a path that momentarily does not exist.
install -d -o "$BOT" -g staff -m 755 "$RUNTIME/bin"
install -o "$BOT" -g staff -m 755 "$HERE/run-worker.sh" "$RUNTIME/bin/run-worker.sh"
echo "installed $RUNTIME/bin/run-worker.sh"

# launchd will not spawn a job whose Standard{Out,Error}Path directory is
# missing, and it fails with a bare status 5 — cheaper to guarantee the
# dirs. logs/ is 700: the worker log names other families' kids, and this
# machine has other local accounts.
install -d -o "$BOT" -g staff -m 700 "$RUNTIME/logs"
install -d -o "$BOT" -g staff -m 755 "$RUNTIME/run"

for f in daemon.env .env; do
  [ -f "$RUNTIME/config/$f" ] || echo "warning: $RUNTIME/config/$f missing — daemon will start without it"
done

echo "== 2. Daemon =="
SRC=$HERE/$LABEL.plist
DEST=/Library/LaunchDaemons/$LABEL.plist
[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

# Do not trust the checkout: read back the keys that decide what root is
# about to install as a system daemon.
SRC_USER=$(plutil -extract UserName raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
if [ "$SRC_USER" != "$BOT" ]; then
  echo "REFUSING $SRC: UserName is '$SRC_USER', expected '$BOT'" >&2
  exit 1
fi
SRC_PROG=$(plutil -extract ProgramArguments.0 raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
if [ "$SRC_PROG" != "$RUNTIME/bin/run-worker.sh" ]; then
  echo "REFUSING $SRC: ProgramArguments[0] is '$SRC_PROG', expected '$RUNTIME/bin/run-worker.sh'" >&2
  exit 1
fi
# launchd prefers `Program` over ProgramArguments[0] as the executable, so a
# plist can satisfy the assertion above and still exec something else
# entirely. Our plist does not set it; require its absence (extract fails).
if plutil -extract Program raw -o - "$SRC" >/dev/null 2>&1; then
  echo "REFUSING $SRC: it sets Program, which launchd execs in preference to ProgramArguments[0]" >&2
  exit 1
fi
SRC_GROUP=$(plutil -extract GroupName raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
if [ "$SRC_GROUP" != "staff" ]; then
  echo "REFUSING $SRC: GroupName is '$SRC_GROUP', expected 'staff'" >&2
  exit 1
fi
# It is not established whether launchd opens these before or after dropping
# to UserName; if before, an arbitrary path here is a root-authored file
# creation anywhere on the disk. Pin them into the logs dir either way.
for k in StandardOutPath StandardErrorPath; do
  SRC_LOG=$(plutil -extract "$k" raw -o - "$SRC" 2>/dev/null || echo "<unreadable>")
  case "$SRC_LOG" in
    "$RUNTIME/logs/"*) ;;
    *) echo "REFUSING $SRC: $k is '$SRC_LOG', expected a path under $RUNTIME/logs/" >&2; exit 1 ;;
  esac
done

# Pre-flight the things launchd needs but reports only as a bare status.
WD=$(plutil -extract WorkingDirectory raw -o - "$SRC" 2>/dev/null || echo "")
[ -d "$WD" ] || echo "warning: WorkingDirectory $WD is missing — the job will crash-loop"
[ -f "$WD/worker.js" ] || echo "warning: $WD/worker.js not found — clone the full repo (the worker imports ../lib/) first"

install -o root -g wheel -m 644 "$SRC" "$DEST"

# bootstrap refuses a label that is already loaded, so unload first; the
# first ever run has nothing to unload, hence the ignored failure. bootout
# returns before the job has finished tearing down, so wait for the label to
# actually disappear — otherwise bootstrap intermittently fails with
# "37: Operation already in progress" or "5: Input/output error".
launchctl bootout "system/$LABEL" 2>/dev/null || true
for _ in $(seq 1 20); do
  launchctl print "system/$LABEL" >/dev/null 2>&1 || break
  sleep 0.5
done

# launchd keeps per-label disable state in its override database,
# independently of the plist: without this, a label disabled once during
# debugging stays disabled through every later install, silently.
launchctl enable "system/$LABEL" 2>/dev/null || true

if ! launchctl bootstrap system "$DEST" 2>/dev/null; then
  sleep 2
  launchctl bootstrap system "$DEST"
fi
echo "$LABEL: $(launchctl print "system/$LABEL" 2>/dev/null | grep -E '^[[:space:]]*state = ' | head -1)"

echo "== Done =="
echo "logs: $RUNTIME/logs/"
