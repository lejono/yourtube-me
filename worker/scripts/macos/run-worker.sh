#!/bin/bash
# The entry point launchd uses for the YourTube worker on macOS.
#
#   run-worker.sh yourtube-worker
#
# Why a wrapper at all: plists in /Library/LaunchDaemons are world-readable,
# so YOURTUBE_WORKER_KEY and the Claude OAuth token cannot be put in
# <EnvironmentVariables>. They live in mode-600 files under the runtime
# config dir and are loaded here, after launchd has already dropped to the
# service account.
set -euo pipefail

RUNTIME=${YOURTUBE_RUNTIME_DIR:-/Users/ytworker/team/yourtube}

# launchd's job_postfork_become_user() should set HOME from the passwd
# record, but nothing here depends on whether it does so before or after
# applying <EnvironmentVariables>. Cheap insurance for ~/.claude and the
# npm cache.
export HOME="${HOME:-/Users/ytworker}"

# daemon.env — secrets (CLAUDE_CODE_OAUTH_TOKEN, YOURTUBE_WORKER_KEY).
# .env       — any non-secret runtime overrides.
#
# Loaded by hand rather than with `set -a; . file`, for three reasons:
#
#  1. Precedence. A shell assignment is unconditional, so sourcing would let
#     .env override the plist's <EnvironmentVariables>. Here a variable
#     already present in the environment is never touched.
#  2. Literal values. `.` evaluates the right-hand side, so a secret
#     containing $(...) or backticks is silently mangled (or executed).
#     Values here are taken exactly as written, with at most one layer of
#     surrounding quotes stripped.
#  3. Loud failure. `.` on a line that is not a plain KEY=VALUE dies with a
#     confusing "command not found" and launchd crash-loops on it forever.
#     Here it aborts with the file and line number.
load_env_file() {
  local file=$1 lineno=0 line key value
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno + 1))
    case "$line" in
      ''|'#'*) continue ;;
    esac
    # Tolerate `export KEY=VALUE`, which people write out of habit.
    case "$line" in
      'export '*) line=${line#export } ;;
    esac
    if ! printf '%s' "$line" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*='; then
      echo "$(basename "$0"): $file line $lineno is not KEY=VALUE — refusing to start" >&2
      echo "  (comments start with #; do not quote the key; no spaces around =)" >&2
      exit 78   # EX_CONFIG
    fi
    key=${line%%=*}
    value=${line#*=}
    # Strip one layer of matching surrounding quotes; everything else is
    # literal — no expansion, no command substitution.
    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac
    # Only when unset: launchd's <EnvironmentVariables> stay authoritative.
    # printenv rather than ${!key+x} indirection — /bin/bash on macOS is 3.2,
    # and printenv asks the question we actually mean with no version risk.
    if ! printenv "$key" >/dev/null 2>&1; then
      export "$key=$value"
    fi
  done < "$file"
}

for f in daemon.env .env; do
  [ -f "$RUNTIME/config/$f" ] && load_env_file "$RUNTIME/config/$f"
done

case "${1:-}" in
  yourtube-worker)
    # Absolute path to the entry point: worker.js gates its main loop on
    # process.argv[1] matching its own resolved URL, and a relative
    # invocation that mis-resolves would exit 0 silently — which
    # KeepAlive{SuccessfulExit:false} would then never restart.
    exec /opt/homebrew/bin/node /Users/ytworker/src/yourtube/worker/worker.js
    ;;
  *)
    echo "usage: $(basename "$0") yourtube-worker" >&2
    exit 64
    ;;
esac
