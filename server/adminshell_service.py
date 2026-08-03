from __future__ import annotations

import asyncio
import codecs
import json
import locale
import os
import platform
import re
import shlex
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from fastapi import WebSocket

try:
    import paramiko
except ImportError:
    paramiko = None


MAX_COMMAND_CHARS = 12000
STREAM_CHUNK_SIZE = 4096
MAX_COMPLETION_MATCHES = 120
TERMINAL_MIN_COLS = 20
TERMINAL_MAX_COLS = 240
TERMINAL_MIN_ROWS = 6
TERMINAL_MAX_ROWS = 80


@dataclass
class CommandTarget:
    mode: str
    host: str = ""
    port: int = 22
    user: str = ""
    password: str = ""


@dataclass
class ShellSessionState:
    local_cwd: Path
    ssh_cwds: dict[str, str]


class CancelHandle:
    def __init__(self) -> None:
        self.cancelled = False
        self._callback: Callable[[], None] | None = None
        self._lock = threading.Lock()

    def set_callback(self, callback: Callable[[], None]) -> None:
        with self._lock:
            self._callback = callback
            should_cancel = self.cancelled
        if should_cancel:
            self.cancel()

    def cancel(self) -> None:
        with self._lock:
            self.cancelled = True
            callback = self._callback
        if callback:
            try:
                callback()
            except Exception:
                pass


class InteractiveSshSession:
    def __init__(
        self,
        loop: asyncio.AbstractEventLoop,
        send_packet: Callable[[dict[str, Any]], Any],
        target: CommandTarget,
        cols: int,
        rows: int,
    ) -> None:
        self.loop = loop
        self.send_packet = send_packet
        self.target = target
        self.cols = cols
        self.rows = rows
        self.client = paramiko.SSHClient()
        self.channel = None
        self.closed = False
        self._lock = threading.Lock()
        self._reader_thread: threading.Thread | None = None

    def start(self) -> None:
        self.client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        self.client.connect(
            hostname=self.target.host,
            port=self.target.port,
            username=self.target.user,
            password=self.target.password,
            timeout=15,
            banner_timeout=15,
            auth_timeout=15,
            look_for_keys=False,
            allow_agent=False,
        )
        transport = self.client.get_transport()
        if not transport:
            raise RuntimeError("SSH transport was not created.")
        channel = transport.open_session()
        channel.get_pty(term="xterm-256color", width=self.cols, height=self.rows)
        channel.invoke_shell()
        self.channel = channel
        self._reader_thread = threading.Thread(target=self._reader_loop, name="adminshell-ssh-terminal", daemon=True)
        self._reader_thread.start()

    def send_input(self, data: str) -> None:
        with self._lock:
            channel = self.channel
            if self.closed or not channel:
                return
            channel.sendall(data)

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            self.cols = cols
            self.rows = rows
            channel = self.channel
            if self.closed or not channel:
                return
            try:
                channel.resize_pty(width=cols, height=rows)
            except Exception:
                pass

    def close(self) -> None:
        with self._lock:
            if self.closed:
                return
            self.closed = True
            channel = self.channel
        try:
            if channel:
                channel.close()
        except Exception:
            pass
        try:
            self.client.close()
        except Exception:
            pass

    def _reader_loop(self) -> None:
        stdout_decoder = _new_decoder("utf-8")
        try:
            while True:
                with self._lock:
                    channel = self.channel
                    should_stop = self.closed or channel is None
                if should_stop:
                    break
                if channel.recv_ready():
                    data = channel.recv(STREAM_CHUNK_SIZE)
                    if not data:
                        break
                    self._send_from_thread({"type": "output", "data": _decode_chunk(stdout_decoder, data)})
                    continue
                if channel.exit_status_ready() or channel.closed:
                    break
                time.sleep(0.02)

            remaining = _flush_decoder(stdout_decoder)
            if remaining:
                self._send_from_thread({"type": "output", "data": remaining})
        except Exception as exc:
            self._send_from_thread({"type": "error", "message": str(exc)})
        finally:
            self.close()
            self._send_from_thread({"type": "status", "state": "closed"})

    def _send_from_thread(self, packet: dict[str, Any]) -> None:
        future = asyncio.run_coroutine_threadsafe(self.send_packet(packet), self.loop)
        try:
            future.result(timeout=10)
        except Exception:
            pass


def _json_packet(packet: dict[str, Any]) -> str:
    return json.dumps(packet, ensure_ascii=False)


def _local_output_encoding() -> str:
    if sys.platform == "win32":
        return "utf-8"
    return locale.getpreferredencoding(False) or "utf-8"


def _new_decoder(encoding: str):
    return codecs.getincrementaldecoder(encoding)(errors="replace")


def _decode_chunk(decoder: Any, chunk: bytes) -> str:
    return decoder.decode(chunk)


def _flush_decoder(decoder: Any) -> str:
    return decoder.decode(b"", final=True)


def _powershell_command(command: str) -> str:
    return (
        "[Console]::InputEncoding=[Console]::OutputEncoding="
        "[System.Text.UTF8Encoding]::new($false); "
        "$OutputEncoding=[Console]::OutputEncoding; "
        f"{command}"
    )


def _quote_powershell_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def _strip_balanced_quotes(value: str) -> str:
    clean_value = value.strip()
    if len(clean_value) >= 2 and clean_value[0] == clean_value[-1] and clean_value[0] in {"'", '"'}:
        return clean_value[1:-1]
    return clean_value


def _powershell_in_cwd(command: str, cwd: Path) -> str:
    return f"Set-Location -LiteralPath {_quote_powershell_literal(str(cwd))}; {command}"


def _parse_local_cd(command: str) -> str | None:
    match = re.fullmatch(r"\s*(?:cd|chdir|sl|set-location)(?:\s+(.+?))?\s*", command, flags=re.IGNORECASE)
    if not match:
        return None
    target = (match.group(1) or "~").strip()
    return target or "~"


def _parse_ssh_cd(command: str) -> str | None:
    try:
        parts = shlex.split(command)
    except ValueError:
        return None
    if not parts or parts[0] != "cd" or len(parts) > 2:
        return None
    return parts[1] if len(parts) == 2 else "~"


def _ssh_key(target: CommandTarget) -> str:
    return f"{target.user}@{target.host}:{target.port}"


def _ssh_command_in_cwd(command: str, cwd: str | None) -> str:
    if not cwd:
        return command
    if cwd == "~":
        return f"cd ~ && {command}"
    return f"cd {shlex.quote(cwd)} && {command}"


def _ssh_cd_command(target: str) -> str:
    clean_target = target.strip() or "~"
    if clean_target == "~":
        return "cd ~"
    return f"cd {shlex.quote(clean_target)}"


def _clean_command(raw: Any) -> str:
    command = str(raw or "").strip()
    if not command:
        raise ValueError("Command is required.")
    if len(command) > MAX_COMMAND_CHARS:
        raise ValueError(f"Command is too long. Limit is {MAX_COMMAND_CHARS} characters.")
    return command


def _clean_completion_line(raw: Any) -> str:
    line = str(raw or "")
    if len(line) > MAX_COMMAND_CHARS:
        raise ValueError(f"Command is too long. Limit is {MAX_COMMAND_CHARS} characters.")
    return line


def _target_from_payload(payload: dict[str, Any]) -> CommandTarget:
    mode = str(payload.get("mode") or "local").strip().lower()
    if mode not in {"local", "ssh"}:
        raise ValueError(f"Unknown shell mode: {mode}")
    ssh = payload.get("ssh") if isinstance(payload.get("ssh"), dict) else {}
    try:
        port = int(ssh.get("port") or 22)
    except (TypeError, ValueError):
        port = 22
    return CommandTarget(
        mode=mode,
        host=str(ssh.get("host") or "").strip(),
        port=max(1, min(port, 65535)),
        user=str(ssh.get("user") or "").strip(),
        password=str(ssh.get("password") or ""),
    )


def _terminal_size(payload: dict[str, Any]) -> tuple[int, int]:
    try:
        cols = int(payload.get("cols") or 80)
    except (TypeError, ValueError):
        cols = 80
    try:
        rows = int(payload.get("rows") or 24)
    except (TypeError, ValueError):
        rows = 24
    return (
        max(TERMINAL_MIN_COLS, min(cols, TERMINAL_MAX_COLS)),
        max(TERMINAL_MIN_ROWS, min(rows, TERMINAL_MAX_ROWS)),
    )


async def handle_adminshell_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    send_lock = asyncio.Lock()
    active_task: asyncio.Task | None = None
    active_cancel: CancelHandle | None = None
    session_state = ShellSessionState(local_cwd=Path.cwd(), ssh_cwds={})

    async def send_packet(packet: dict[str, Any]) -> None:
        async with send_lock:
            await websocket.send_text(_json_packet(packet))

    def clear_active(done_task: asyncio.Task) -> None:
        nonlocal active_task, active_cancel
        active_task = None
        active_cancel = None
        try:
            done_task.result()
        except asyncio.CancelledError:
            pass
        except Exception as exc:
            asyncio.create_task(send_packet({"type": "error", "message": str(exc)}))

    await send_packet(
        {
            "type": "hello",
            "platform": platform.platform(),
            "shell": "local",
            "cwd": str(session_state.local_cwd),
        }
    )

    try:
        while True:
            raw_message = await websocket.receive_text()
            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await send_packet({"type": "error", "message": "Invalid JSON message."})
                continue

            message_type = str(payload.get("type") or "run")
            if message_type == "cancel":
                if active_cancel:
                    active_cancel.cancel()
                    await send_packet({"type": "status", "state": "canceling"})
                else:
                    await send_packet({"type": "status", "state": "idle"})
                continue

            if message_type == "complete":
                request_id = payload.get("request_id")
                try:
                    line = _clean_completion_line(payload.get("command"))
                    cursor = int(payload.get("cursor") if payload.get("cursor") is not None else len(line))
                    target = _target_from_payload(payload)
                    _validate_target(target)
                    if active_task and not active_task.done():
                        completion = _empty_completion(request_id, line, cursor, "A command is already running.")
                    else:
                        completion = await _complete_command(line, cursor, target, session_state, request_id)
                    await send_packet(completion)
                except Exception as exc:
                    await send_packet(
                        {
                            "type": "completion",
                            "request_id": request_id,
                            "replacement_start": 0,
                            "replacement_end": 0,
                            "replacement": "",
                            "candidates": [],
                            "error": str(exc),
                        }
                    )
                continue

            if message_type != "run":
                await send_packet({"type": "error", "message": f"Unknown message type: {message_type}"})
                continue

            if active_task and not active_task.done():
                await send_packet({"type": "error", "message": "A command is already running."})
                continue

            try:
                command = _clean_command(payload.get("command"))
                target = _target_from_payload(payload)
                _validate_target(target)
            except Exception as exc:
                await send_packet({"type": "error", "message": str(exc)})
                continue

            active_cancel = CancelHandle()
            active_task = asyncio.create_task(_run_command(websocket, send_packet, command, target, session_state, active_cancel))
            active_task.add_done_callback(clear_active)
    finally:
        if active_cancel:
            active_cancel.cancel()
        if active_task and not active_task.done():
            active_task.cancel()


async def handle_adminshell_terminal_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    loop = asyncio.get_running_loop()
    send_lock = asyncio.Lock()
    active_terminal: InteractiveSshSession | None = None

    async def send_packet(packet: dict[str, Any]) -> None:
        async with send_lock:
            await websocket.send_text(_json_packet(packet))

    await send_packet({"type": "hello", "terminal": "ssh"})

    try:
        while True:
            raw_message = await websocket.receive_text()
            try:
                payload = json.loads(raw_message)
            except json.JSONDecodeError:
                await send_packet({"type": "error", "message": "Invalid JSON message."})
                continue

            message_type = str(payload.get("type") or "")
            if message_type == "start":
                if active_terminal:
                    active_terminal.close()
                    active_terminal = None
                try:
                    target = _target_from_payload({"mode": "ssh", "ssh": payload.get("ssh")})
                    _validate_target(target)
                    cols, rows = _terminal_size(payload)
                    active_terminal = InteractiveSshSession(loop, send_packet, target, cols, rows)
                    await send_packet({"type": "status", "state": "connecting"})
                    await asyncio.to_thread(active_terminal.start)
                    await send_packet({"type": "status", "state": "connected"})
                except Exception as exc:
                    if active_terminal:
                        active_terminal.close()
                        active_terminal = None
                    await send_packet({"type": "error", "message": str(exc)})
                continue

            if message_type == "input":
                if active_terminal:
                    active_terminal.send_input(str(payload.get("data") or ""))
                continue

            if message_type == "resize":
                if active_terminal:
                    cols, rows = _terminal_size(payload)
                    active_terminal.resize(cols, rows)
                continue

            if message_type == "stop":
                if active_terminal:
                    active_terminal.close()
                    active_terminal = None
                await send_packet({"type": "status", "state": "closed"})
                continue

            await send_packet({"type": "error", "message": f"Unknown terminal message type: {message_type}"})
    finally:
        if active_terminal:
            active_terminal.close()


def _validate_target(target: CommandTarget) -> None:
    if target.mode != "ssh":
        return
    if paramiko is None:
        raise RuntimeError("SSH mode requires paramiko. Run: pip install -r server/requirements.txt")
    if not target.host:
        raise ValueError("RPI IP / host is required for SSH mode.")
    if not target.user:
        raise ValueError("SSH user is required.")
    if not target.password:
        raise ValueError("SSH password is required.")


def _clamp_cursor(line: str, cursor: int) -> int:
    return max(0, min(cursor, len(line)))


def _completion_token_bounds(line: str, cursor: int) -> tuple[int, int]:
    clean_cursor = _clamp_cursor(line, cursor)
    start = clean_cursor
    while start > 0:
        char = line[start - 1]
        if char.isspace() or char in ";&|()":
            break
        start -= 1
    return start, clean_cursor


def _is_command_position(line: str, start: int) -> bool:
    prefix = line[:start].strip()
    if not prefix:
        return True
    return prefix.endswith(";") or prefix.endswith("|") or prefix.endswith("&")


def _dedupe_completion_candidates(candidates: list[str]) -> list[str]:
    seen: set[str] = set()
    clean_candidates: list[str] = []
    for raw_candidate in candidates:
        candidate = str(raw_candidate or "").replace("\r", "").replace("\n", "")
        if not candidate:
            continue
        key = candidate.lower() if sys.platform == "win32" else candidate
        if key in seen:
            continue
        seen.add(key)
        clean_candidates.append(candidate)
        if len(clean_candidates) >= MAX_COMPLETION_MATCHES:
            break
    return sorted(clean_candidates, key=str.lower)


def _completion_packet(
    request_id: Any,
    replacement_start: int,
    replacement_end: int,
    candidates: list[str],
    error: str = "",
) -> dict[str, Any]:
    clean_candidates = _dedupe_completion_candidates(candidates)
    replacement = ""
    if len(clean_candidates) == 1:
        replacement = clean_candidates[0]
    elif clean_candidates:
        replacement = os.path.commonprefix(clean_candidates)
    return {
        "type": "completion",
        "request_id": request_id,
        "replacement_start": replacement_start,
        "replacement_end": replacement_end,
        "replacement": replacement,
        "candidates": clean_candidates,
        "error": error,
    }


def _empty_completion(request_id: Any, line: str, cursor: int, error: str = "") -> dict[str, Any]:
    start, end = _completion_token_bounds(line, cursor)
    return _completion_packet(request_id, start, end, [], error)


async def _complete_command(
    line: str,
    cursor: int,
    target: CommandTarget,
    session_state: ShellSessionState,
    request_id: Any,
) -> dict[str, Any]:
    clean_cursor = _clamp_cursor(line, cursor)
    if target.mode == "ssh":
        return await _complete_ssh_command(line, clean_cursor, target, session_state, request_id)
    if sys.platform == "win32":
        return await _complete_windows_powershell(line, clean_cursor, session_state.local_cwd, request_id)
    return _complete_local_basic(line, clean_cursor, session_state.local_cwd, request_id)


async def _complete_windows_powershell(
    line: str,
    cursor: int,
    cwd: Path,
    request_id: Any,
) -> dict[str, Any]:
    start, end = _completion_token_bounds(line, cursor)
    completion_script = (
        "$ErrorActionPreference='Stop'; "
        f"$line={_quote_powershell_literal(line)}; "
        f"$cursor={cursor}; "
        "$completion=TabExpansion2 -inputScript $line -cursorColumn $cursor; "
        "$matches=@($completion.CompletionMatches | ForEach-Object { "
        "[pscustomobject]@{ CompletionText=$_.CompletionText; ListItemText=$_.ListItemText } "
        "}); "
        "[pscustomobject]@{ "
        "ReplacementIndex=$completion.ReplacementIndex; "
        "ReplacementLength=$completion.ReplacementLength; "
        "Matches=$matches "
        "} | ConvertTo-Json -Depth 4 -Compress"
    )
    process = await asyncio.create_subprocess_exec(
        "powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        _powershell_command(_powershell_in_cwd(completion_script, cwd)),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await process.communicate()
    stderr_text = stderr.decode(_local_output_encoding(), errors="replace").strip()
    stdout_text = stdout.decode(_local_output_encoding(), errors="replace").strip()
    if process.returncode or not stdout_text:
        return _completion_packet(request_id, start, end, [], stderr_text)

    try:
        payload = json.loads(stdout_text)
    except json.JSONDecodeError:
        return _completion_packet(request_id, start, end, [], "Unable to parse completion response.")

    replacement_start = int(payload.get("ReplacementIndex") if payload.get("ReplacementIndex") is not None else start)
    replacement_length = int(payload.get("ReplacementLength") if payload.get("ReplacementLength") is not None else end - start)
    matches = payload.get("Matches") or []
    if isinstance(matches, dict):
        matches = [matches]
    candidates = [
        str(match.get("CompletionText") or match.get("ListItemText") or "")
        for match in matches
        if isinstance(match, dict)
    ]
    return _completion_packet(request_id, replacement_start, replacement_start + replacement_length, candidates)


def _complete_local_basic(line: str, cursor: int, cwd: Path, request_id: Any) -> dict[str, Any]:
    start, end = _completion_token_bounds(line, cursor)
    fragment = _strip_balanced_quotes(line[start:end])
    candidates = _local_path_candidates(fragment, cwd)
    if _is_command_position(line, start):
        candidates.extend(_local_command_candidates(fragment))
    return _completion_packet(request_id, start, end, candidates)


def _local_path_candidates(fragment: str, cwd: Path) -> list[str]:
    clean_fragment = fragment or ""
    expanded = Path(clean_fragment).expanduser()
    if expanded.is_absolute():
        search_dir = expanded.parent
        base = expanded.name
        search_dir_text = str(search_dir)
        prefix = search_dir_text if search_dir_text.endswith(("/", "\\")) else search_dir_text + os.sep
    else:
        search_dir = (cwd / expanded).parent
        base = expanded.name
        parent_text = str(Path(clean_fragment).parent)
        prefix = "" if parent_text == "." else parent_text.replace("\\", "/").rstrip("/") + "/"

    try:
        entries = list(search_dir.iterdir())
    except OSError:
        return []

    candidates: list[str] = []
    for entry in entries:
        if not entry.name.lower().startswith(base.lower()):
            continue
        suffix = "/" if entry.is_dir() else ""
        candidates.append(f"{prefix}{entry.name}{suffix}")
    return candidates


def _local_command_candidates(fragment: str) -> list[str]:
    candidates: list[str] = []
    executable_exts = [""]
    if sys.platform == "win32":
        executable_exts.extend(os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD;.PS1").lower().split(";"))
    for path_dir in os.environ.get("PATH", "").split(os.pathsep):
        if not path_dir:
            continue
        try:
            entries = list(Path(path_dir).iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.name.lower().startswith(fragment.lower()):
                continue
            if sys.platform == "win32":
                if entry.suffix.lower() not in executable_exts:
                    continue
            elif not os.access(entry, os.X_OK):
                continue
            candidates.append(entry.stem if sys.platform == "win32" and entry.suffix else entry.name)
    return candidates


async def _complete_ssh_command(
    line: str,
    cursor: int,
    target: CommandTarget,
    session_state: ShellSessionState,
    request_id: Any,
) -> dict[str, Any]:
    start, end = _completion_token_bounds(line, cursor)
    fragment = _strip_balanced_quotes(line[start:end])
    current_cwd = session_state.ssh_cwds.get(_ssh_key(target), "~")
    kind = "command" if _is_command_position(line, start) else "file"
    command = _ssh_command_in_cwd(_ssh_completion_command(fragment, kind), current_cwd)
    exit_code, stdout_text, stderr_text = await asyncio.to_thread(_ssh_capture_sync, command, target)
    if exit_code != 0:
        return _completion_packet(request_id, start, end, [], stderr_text.strip())
    candidates = [row.strip() for row in stdout_text.splitlines() if row.strip()]
    return _completion_packet(request_id, start, end, candidates)


def _ssh_completion_command(fragment: str, kind: str) -> str:
    script = r"""
prefix=$1
kind=$2
dirpart=${prefix%/*}
base=${prefix##*/}
if [ "$dirpart" = "$prefix" ]; then
    searchdir="."
    displayprefix=""
else
    searchdir="$dirpart"
    displayprefix="$dirpart/"
fi
case "$searchdir" in
    "~")
        searchdir="$HOME"
        displayprefix="~/"
        ;;
    "~/"*)
        searchdir="$HOME/${searchdir#~/}"
        displayprefix="$dirpart/"
        ;;
esac
if [ -d "$searchdir" ]; then
    find "$searchdir" -maxdepth 1 -mindepth 1 -name "$base*" 2>/dev/null | while IFS= read -r path; do
        name="$displayprefix${path##*/}"
        if [ -d "$path" ]; then
            name="$name/"
        fi
        printf '%s\n' "$name"
    done
fi
if [ "$kind" = "command" ]; then
    compgen -c -- "$base" 2>/dev/null
fi
"""
    return f"bash -lc {shlex.quote(script)} -- {shlex.quote(fragment)} {shlex.quote(kind)}"


def _ssh_capture_sync(command: str, target: CommandTarget) -> tuple[int | None, str, str]:
    client = paramiko.SSHClient()
    try:
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=target.host,
            port=target.port,
            username=target.user,
            password=target.password,
            timeout=10,
            banner_timeout=10,
            auth_timeout=10,
            look_for_keys=False,
            allow_agent=False,
        )
        _, stdout, stderr = client.exec_command(command, timeout=10)
        stdout_text = stdout.read().decode("utf-8", errors="replace")
        stderr_text = stderr.read().decode("utf-8", errors="replace")
        return stdout.channel.recv_exit_status(), stdout_text, stderr_text
    finally:
        client.close()


async def _run_command(
    websocket: WebSocket,
    send_packet: Callable[[dict[str, Any]], Any],
    command: str,
    target: CommandTarget,
    session_state: ShellSessionState,
    cancel_handle: CancelHandle,
) -> None:
    started = time.monotonic()
    cwd = session_state.ssh_cwds.get(_ssh_key(target), "~") if target.mode == "ssh" else str(session_state.local_cwd)
    await send_packet(
        {
            "type": "status",
            "state": "running",
            "mode": target.mode,
            "target": target.host if target.mode == "ssh" else platform.node(),
            "command": command,
            "cwd": cwd,
        }
    )
    if target.mode == "ssh":
        exit_code, cwd = await _run_ssh_command(send_packet, command, target, session_state, cancel_handle)
    else:
        exit_code, cwd = await _run_local_command(send_packet, command, session_state, cancel_handle)
    await send_packet(
        {
            "type": "complete",
            "mode": target.mode,
            "exit_code": exit_code,
            "duration": round(time.monotonic() - started, 2),
            "canceled": cancel_handle.cancelled,
            "cwd": cwd,
        }
    )


async def _run_local_command(
    send_packet: Callable[[dict[str, Any]], Any],
    command: str,
    session_state: ShellSessionState,
    cancel_handle: CancelHandle,
) -> tuple[int | None, str]:
    cd_target = _parse_local_cd(command)
    if cd_target is not None:
        exit_code, new_cwd = await _change_local_cwd(send_packet, cd_target, session_state.local_cwd)
        if exit_code == 0 and new_cwd:
            session_state.local_cwd = Path(new_cwd)
            await send_packet({"type": "chunk", "stream": "stdout", "data": f"[cwd] {session_state.local_cwd}\n"})
        return exit_code, str(session_state.local_cwd)

    local_cwd = session_state.local_cwd
    if sys.platform == "win32":
        process = await asyncio.create_subprocess_exec(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            _powershell_command(_powershell_in_cwd(command, local_cwd)),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    else:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(local_cwd),
        )

    def cancel_process() -> None:
        if process.returncode is not None:
            return
        try:
            process.terminate()
        except ProcessLookupError:
            pass

    cancel_handle.set_callback(cancel_process)

    async def stream_reader(reader: asyncio.StreamReader | None, stream_name: str) -> None:
        if reader is None:
            return
        decoder = _new_decoder(_local_output_encoding())
        while True:
            chunk = await reader.read(STREAM_CHUNK_SIZE)
            if not chunk:
                break
            await send_packet({"type": "chunk", "stream": stream_name, "data": _decode_chunk(decoder, chunk)})
        remaining = _flush_decoder(decoder)
        if remaining:
            await send_packet({"type": "chunk", "stream": stream_name, "data": remaining})

    try:
        await asyncio.gather(
            stream_reader(process.stdout, "stdout"),
            stream_reader(process.stderr, "stderr"),
        )
        return await process.wait(), str(session_state.local_cwd)
    finally:
        if process.returncode is None:
            cancel_process()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass


async def _change_local_cwd(
    send_packet: Callable[[dict[str, Any]], Any],
    cd_target: str,
    current_cwd: Path,
) -> tuple[int, str | None]:
    if sys.platform == "win32":
        clean_target = _strip_balanced_quotes(cd_target)
        process = await asyncio.create_subprocess_exec(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            _powershell_command(
                _powershell_in_cwd(
                    "$ErrorActionPreference='Stop'; "
                    f"$target={_quote_powershell_literal(clean_target)}; "
                    "Set-Location -Path $target; "
                    "[Console]::Out.Write((Get-Location).ProviderPath)",
                    current_cwd,
                )
            ),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        stdout_text = stdout.decode(_local_output_encoding(), errors="replace").strip()
        stderr_text = stderr.decode(_local_output_encoding(), errors="replace")
        if stderr_text:
            await send_packet({"type": "chunk", "stream": "stderr", "data": stderr_text})
        return int(process.returncode or 0), stdout_text or None

    target_path = Path(_strip_balanced_quotes(cd_target)).expanduser()
    if not target_path.is_absolute():
        target_path = current_cwd / target_path
    try:
        resolved = target_path.resolve(strict=True)
    except OSError as exc:
        await send_packet({"type": "chunk", "stream": "stderr", "data": f"{exc}\n"})
        return 1, None
    if not resolved.is_dir():
        await send_packet({"type": "chunk", "stream": "stderr", "data": f"Not a directory: {resolved}\n"})
        return 1, None
    return 0, str(resolved)


async def _run_ssh_command(
    send_packet: Callable[[dict[str, Any]], Any],
    command: str,
    target: CommandTarget,
    session_state: ShellSessionState,
    cancel_handle: CancelHandle,
) -> tuple[int | None, str]:
    loop = asyncio.get_running_loop()
    ssh_key = _ssh_key(target)
    current_cwd = session_state.ssh_cwds.get(ssh_key, "~")
    cd_target = _parse_ssh_cd(command)
    capture_stdout = cd_target is not None
    command_to_run = (
        _ssh_command_in_cwd(f"{_ssh_cd_command(cd_target or '~')} && pwd", current_cwd)
        if cd_target is not None
        else _ssh_command_in_cwd(command, current_cwd)
    )
    exit_code, stdout_text = await asyncio.to_thread(
        _run_ssh_command_sync,
        loop,
        send_packet,
        command_to_run,
        target,
        cancel_handle,
        capture_stdout,
    )
    if capture_stdout and exit_code == 0:
        rows = [row.strip() for row in stdout_text.splitlines() if row.strip()]
        if rows:
            session_state.ssh_cwds[ssh_key] = rows[-1]
    return exit_code, session_state.ssh_cwds.get(ssh_key, current_cwd)


def _run_ssh_command_sync(
    loop: asyncio.AbstractEventLoop,
    send_packet: Callable[[dict[str, Any]], Any],
    command: str,
    target: CommandTarget,
    cancel_handle: CancelHandle,
    capture_stdout: bool = False,
) -> tuple[int | None, str]:
    client = paramiko.SSHClient()
    channel = None
    stdout_decoder = _new_decoder("utf-8")
    stderr_decoder = _new_decoder("utf-8")
    stdout_parts: list[str] = []

    def send_from_thread(packet: dict[str, Any]) -> None:
        future = asyncio.run_coroutine_threadsafe(send_packet(packet), loop)
        future.result(timeout=10)

    def cancel_ssh() -> None:
        try:
            if channel:
                channel.close()
        except Exception:
            pass
        try:
            client.close()
        except Exception:
            pass

    cancel_handle.set_callback(cancel_ssh)

    try:
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        client.connect(
            hostname=target.host,
            port=target.port,
            username=target.user,
            password=target.password,
            timeout=15,
            banner_timeout=15,
            auth_timeout=15,
            look_for_keys=False,
            allow_agent=False,
        )
        transport = client.get_transport()
        if not transport:
            raise RuntimeError("SSH transport was not created.")
        channel = transport.open_session()
        channel.exec_command(command)

        while True:
            if channel.recv_ready():
                data = channel.recv(STREAM_CHUNK_SIZE)
                if data:
                    text = _decode_chunk(stdout_decoder, data)
                    if capture_stdout:
                        stdout_parts.append(text)
                    send_from_thread({"type": "chunk", "stream": "stdout", "data": text})
            if channel.recv_stderr_ready():
                data = channel.recv_stderr(STREAM_CHUNK_SIZE)
                if data:
                    send_from_thread({"type": "chunk", "stream": "stderr", "data": _decode_chunk(stderr_decoder, data)})
            if channel.exit_status_ready():
                break
            if cancel_handle.cancelled:
                cancel_ssh()
                return None, "".join(stdout_parts)
            time.sleep(0.05)

        while channel.recv_ready():
            data = channel.recv(STREAM_CHUNK_SIZE)
            if data:
                text = _decode_chunk(stdout_decoder, data)
                if capture_stdout:
                    stdout_parts.append(text)
                send_from_thread({"type": "chunk", "stream": "stdout", "data": text})
        while channel.recv_stderr_ready():
            data = channel.recv_stderr(STREAM_CHUNK_SIZE)
            if data:
                send_from_thread({"type": "chunk", "stream": "stderr", "data": _decode_chunk(stderr_decoder, data)})
        remaining_stdout = _flush_decoder(stdout_decoder)
        if remaining_stdout:
            if capture_stdout:
                stdout_parts.append(remaining_stdout)
            send_from_thread({"type": "chunk", "stream": "stdout", "data": remaining_stdout})
        remaining_stderr = _flush_decoder(stderr_decoder)
        if remaining_stderr:
            send_from_thread({"type": "chunk", "stream": "stderr", "data": remaining_stderr})
        return channel.recv_exit_status(), "".join(stdout_parts)
    finally:
        cancel_ssh()
