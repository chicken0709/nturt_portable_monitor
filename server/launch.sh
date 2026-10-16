#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PORT="${NTURT_WEB_PORT:-8888}"
URL="http://127.0.0.1:${PORT}/"
CHROMIUM_PROFILE="${XDG_CACHE_HOME:-${HOME}/.cache}/nturt-can-monitor/chromium"

if [[ -x "${APP_DIR}/.venv/bin/python" ]]; then
    PYTHON="${APP_DIR}/.venv/bin/python"
else
    PYTHON="${PYTHON:-python3}"
fi

if command -v chromium >/dev/null 2>&1; then
    BROWSER="$(command -v chromium)"
elif command -v chromium-browser >/dev/null 2>&1; then
    BROWSER="$(command -v chromium-browser)"
else
    echo "Chromium was not found. Install it on the Raspberry Pi, then run this launcher again." >&2
    exit 1
fi

cd "${APP_DIR}"
NTURT_LAUNCHER_PID="$$" "${PYTHON}" server_remote.py &
SERVER_PID=$!
BROWSER_PID=""

cleanup() {
    if [[ -n "${BROWSER_PID}" ]] && kill -0 "${BROWSER_PID}" 2>/dev/null; then
        kill "${BROWSER_PID}" 2>/dev/null || true
        wait "${BROWSER_PID}" 2>/dev/null || true
    fi
    if kill -0 "${SERVER_PID}" 2>/dev/null; then
        kill "${SERVER_PID}" 2>/dev/null || true
        wait "${SERVER_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

echo "Starting NTURT CAN Monitor..."
READY=0
for _ in $(seq 1 60); do
    if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
        echo "The monitor server exited before the dashboard became available." >&2
        wait "${SERVER_PID}" || true
        exit 1
    fi
    if "${PYTHON}" -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=1)' "${URL}" >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 0.5
done

if [[ "${READY}" -ne 1 ]]; then
    echo "Dashboard did not become available at ${URL} within 30 seconds." >&2
    exit 1
fi

mkdir -p "${CHROMIUM_PROFILE}"
if [[ "${NTURT_KIOSK:-1}" == "0" ]]; then
    echo "Opening ${URL} in a Chromium app window. Close the window to stop the monitor."
    "${BROWSER}" --user-data-dir="${CHROMIUM_PROFILE}" --no-first-run --app="${URL}" &
else
    echo "Opening ${URL} in Chromium kiosk mode. Press Alt+F4 to close and stop the monitor."
    "${BROWSER}" --user-data-dir="${CHROMIUM_PROFILE}" --no-first-run --disable-infobars --kiosk "${URL}" &
fi
BROWSER_PID=$!
wait "${BROWSER_PID}"
