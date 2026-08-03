from __future__ import annotations

import asyncio
import base64
import fnmatch
import json
import os
import posixpath
import shutil
import stat
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any, Awaitable, Callable

from candecoder_decoder import (
    decode_selected_signals,
    discover_dbc_info,
    discover_dbc_paths,
    discover_dbc_signals,
    load_signal_template_items,
    load_signal_template,
    load_signal_templates,
    safe_suffix,
    save_signal_template,
    signal_items_from_set,
)

try:
    import paramiko
except ImportError:
    paramiko = None


SERVER_DIR = Path(__file__).resolve().parent
WORKSPACE_DIR = SERVER_DIR / "candecoder_workspace"
CACHE_DIR = WORKSPACE_DIR / ".raw_cache"
STATE_FILE = WORKSPACE_DIR / "sync_state.json"
DEFAULT_PATTERN = "*.csv"
CHUNK_SIZE = 256 * 1024
DEFAULT_REMOTE_LOG_DIR = "/home/pi/Desktop/RPI_Desktop/LOGS"


class OperationCancelled(Exception):
    pass


@dataclass(frozen=True)
class SourceConfig:
    mode: str = "ssh"
    rpi_host: str = "100.115.118.99"
    rpi_user: str = "nturt"
    rpi_password: str = ""
    remote_log_dir: str = DEFAULT_REMOTE_LOG_DIR

    def public_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "rpi_host": self.rpi_host,
            "rpi_user": self.rpi_user,
            "remote_log_dir": self.remote_log_dir,
        }


@dataclass
class DownloadSession:
    request_id: str
    relative_path: str
    temp_path: Path
    final_path: Path
    expected_size: int
    mtime: float
    future: asyncio.Future
    received: int = 0
    last_emit: float = 0.0


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _safe_component(value: str) -> str:
    return safe_suffix(value) or "item"


def safe_local_relative_path(value: str) -> Path:
    raw = (value or "").replace("\\", "/")
    pure = PurePosixPath(raw)
    parts = [
        _safe_component(part)
        for part in pure.parts
        if part not in {"", ".", "/", ".."}
    ]
    if not parts:
        parts = [_safe_component(Path(raw).name or "log.csv")]
    return Path(*parts)


def format_bytes(value: int) -> str:
    amount = float(value or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if amount < 1024 or unit == "GB":
            return f"{amount:.1f} {unit}" if unit != "B" else f"{int(amount)} B"
        amount /= 1024
    return f"{amount:.1f} GB"


class CANDecoderSyncService:
    def __init__(
        self,
        send_vehicle_command: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
        broadcast: Callable[[dict[str, Any]], Awaitable[None]],
        has_vehicle_client: Callable[[], bool],
    ):
        self.send_vehicle_command = send_vehicle_command
        self.broadcast = broadcast
        self.has_vehicle_client = has_vehicle_client
        self.pending: dict[str, asyncio.Future] = {}
        self.downloads: dict[str, DownloadSession] = {}
        self.current_task: asyncio.Task | None = None
        self.active_download_context: dict[str, Any] = {}
        self.cancel_event = threading.Event()
        self.active_ssh_client: Any | None = None
        self.active_ssh_lock = threading.Lock()
        self.status = self._initial_status()

    def _initial_status(self) -> dict[str, Any]:
        return {
            "task_id": None,
            "operation": None,
            "state": "idle",
            "phase": "idle",
            "percent": 0.0,
            "message": "Ready",
            "template_name": None,
            "pattern": DEFAULT_PATTERN,
            "source": {"mode": "ssh"},
            "dbc_names": [],
            "started_at": None,
            "finished_at": None,
            "folders": {},
            "remote_files": [],
            "local_raw_files": [],
            "cancel_requested": False,
            "counts": {
                "remote_files": 0,
                "downloaded": 0,
                "download_skipped": 0,
                "decoded": 0,
                "decode_skipped": 0,
            },
            "progress": {},
            "events": [],
            "error": None,
        }

    def get_status(self) -> dict[str, Any]:
        return json.loads(json.dumps(self.status, default=str))

    def template_rows(self) -> list[dict[str, Any]]:
        templates = load_signal_templates()
        return [
            {
                "name": name,
                "signal_count": len(signals),
                "signals": signal_items_from_set(signals),
                "source": "export_signals" if name == "export_signals" else "export_templates",
            }
            for name, signals in sorted(templates.items(), key=lambda item: item[0].lower())
        ]

    def dbc_rows(self) -> list[dict[str, Any]]:
        return discover_dbc_info()

    def signal_rows(self, dbc_names: list[str] | None = None) -> list[dict[str, Any]]:
        clean_dbc_names = [str(name).strip() for name in (dbc_names or []) if str(name).strip()]
        return discover_dbc_signals(clean_dbc_names)

    def save_template(
        self,
        name: str,
        signals: list[dict[str, Any]] | list[Any],
        original_name: str | None = None,
    ) -> dict[str, Any]:
        saved = save_signal_template(name, signals, original_name)
        return {
            "saved": saved,
            "templates": self.template_rows(),
            "selected": load_signal_template_items(saved["name"]),
        }

    def _build_source(
        self,
        source_mode: str | None = None,
        rpi_host: str | None = None,
        rpi_user: str | None = None,
        rpi_password: str | None = None,
        remote_log_dir: str | None = None,
    ) -> SourceConfig:
        mode = (source_mode or "ssh").strip() or "ssh"
        if mode != "ssh":
            raise RuntimeError("CAN decoder source now supports SSH/SFTP by RPI IP only.")
        return SourceConfig(
            mode=mode,
            rpi_host=(rpi_host or "").strip(),
            rpi_user=(rpi_user or "pi").strip() or "pi",
            rpi_password=rpi_password or "",
            remote_log_dir=(remote_log_dir or DEFAULT_REMOTE_LOG_DIR).strip() or DEFAULT_REMOTE_LOG_DIR,
        )

    async def _queue_operation(
        self,
        operation: str,
        queued_message: str,
        runner: Callable[[str], Awaitable[None]],
        template_name: str | None = None,
        pattern: str | None = None,
        source: SourceConfig | None = None,
        dbc_names: list[str] | None = None,
    ) -> dict[str, Any]:
        if self.current_task and not self.current_task.done():
            return {"already_running": True, "status": self.get_status()}

        task_id = uuid.uuid4().hex[:12]
        clean_template = (template_name or "").strip() or None
        clean_pattern = (pattern or DEFAULT_PATTERN).strip() or DEFAULT_PATTERN
        clean_dbc_names = [str(name).strip() for name in (dbc_names or []) if str(name).strip()]
        self.cancel_event.clear()
        self.active_download_context = {}
        self.status = self._initial_status()
        await self._emit(
            "info",
            queued_message,
            task_id=task_id,
            operation=operation,
            state="running",
            phase="queued",
            percent=0.0,
            message="Queued",
            template_name=clean_template,
            pattern=clean_pattern,
            source=source.public_dict() if source else {"mode": "local"},
            dbc_names=clean_dbc_names,
            started_at=_now_iso(),
            finished_at=None,
            cancel_requested=False,
            error=None,
        )
        self.current_task = asyncio.create_task(runner(task_id))
        return {"already_running": False, "status": self.get_status()}

    async def start_list(
        self,
        pattern: str | None = None,
        source_mode: str | None = None,
        rpi_host: str | None = None,
        rpi_user: str | None = None,
        rpi_password: str | None = None,
        remote_log_dir: str | None = None,
    ) -> dict[str, Any]:
        clean_pattern = (pattern or DEFAULT_PATTERN).strip() or DEFAULT_PATTERN
        source = self._build_source(source_mode, rpi_host, rpi_user, rpi_password, remote_log_dir)
        return await self._queue_operation(
            "list",
            "Queued CAN log file listing",
            lambda task_id: self._run_list(task_id, clean_pattern, source),
            pattern=clean_pattern,
            source=source,
        )

    async def start_pull(
        self,
        pattern: str | None = None,
        source_mode: str | None = None,
        rpi_host: str | None = None,
        rpi_user: str | None = None,
        rpi_password: str | None = None,
        remote_log_dir: str | None = None,
        selected_relative_paths: list[str] | None = None,
    ) -> dict[str, Any]:
        clean_pattern = (pattern or DEFAULT_PATTERN).strip() or DEFAULT_PATTERN
        source = self._build_source(source_mode, rpi_host, rpi_user, rpi_password, remote_log_dir)
        clean_selected_paths = self._clean_selected_relative_paths(selected_relative_paths)
        return await self._queue_operation(
            "pull",
            "Queued CAN log pull",
            lambda task_id: self._run_pull(task_id, clean_pattern, source, clean_selected_paths),
            pattern=clean_pattern,
            source=source,
        )

    async def start_decode(
        self,
        template_name: str | None = None,
        dbc_names: list[str] | None = None,
        selected_relative_paths: list[str] | None = None,
        output_folder_name: str | None = None,
    ) -> dict[str, Any]:
        clean_template = (template_name or "").strip() or None
        clean_dbc_names = [str(name).strip() for name in (dbc_names or []) if str(name).strip()]
        clean_selected_paths = self._clean_selected_relative_paths(selected_relative_paths)
        clean_output_folder = self._clean_output_folder_name(output_folder_name)
        return await self._queue_operation(
            "decode",
            "Queued CAN log decode",
            lambda task_id: self._run_decode(task_id, clean_template, clean_dbc_names, clean_selected_paths, clean_output_folder),
            template_name=clean_template,
            dbc_names=clean_dbc_names,
        )

    async def start(
        self,
        template_name: str | None = None,
        pattern: str | None = None,
        source_mode: str | None = None,
        rpi_host: str | None = None,
        rpi_user: str | None = None,
        rpi_password: str | None = None,
        remote_log_dir: str | None = None,
        dbc_names: list[str] | None = None,
        selected_relative_paths: list[str] | None = None,
        output_folder_name: str | None = None,
    ) -> dict[str, Any]:
        clean_template = (template_name or "").strip() or None
        clean_pattern = (pattern or DEFAULT_PATTERN).strip() or DEFAULT_PATTERN
        source = self._build_source(source_mode, rpi_host, rpi_user, rpi_password, remote_log_dir)
        clean_dbc_names = [str(name).strip() for name in (dbc_names or []) if str(name).strip()]
        clean_selected_paths = self._clean_selected_relative_paths(selected_relative_paths)
        clean_output_folder = self._clean_output_folder_name(output_folder_name)
        return await self._queue_operation(
            "sync_decode",
            "Queued CAN log pull and decode",
            lambda task_id: self._run_sync_decode(
                task_id,
                clean_template,
                clean_pattern,
                source,
                clean_dbc_names,
                clean_selected_paths,
                clean_output_folder,
            ),
            template_name=clean_template,
            pattern=clean_pattern,
            source=source,
            dbc_names=clean_dbc_names,
        )

    async def cancel(self) -> dict[str, Any]:
        if not self.current_task or self.current_task.done():
            return {"canceled": False, "status": self.get_status()}

        self.cancel_event.set()
        await self._emit(
            "warning",
            "Cancel requested",
            state="canceling",
            message="Canceling",
            cancel_requested=True,
        )

        cancel_error = OperationCancelled("Operation canceled by user.")
        for request_id, future in list(self.pending.items()):
            self.pending.pop(request_id, None)
            if not future.done():
                future.set_exception(cancel_error)

        download_ids = list(self.downloads.keys())
        for request_id in download_ids:
            session = self.downloads.get(request_id)
            if session and not session.future.done():
                session.future.set_exception(cancel_error)
            await self._send_cancel_request(request_id)

        self._close_active_ssh_client()
        return {"canceled": True, "status": self.get_status()}

    async def handle_vehicle_message(self, data: dict[str, Any], client_id: str) -> bool:
        msg_type = data.get("type")
        request_id = str(data.get("request_id") or "")
        if msg_type == "candecoder_log_list":
            future = self.pending.pop(request_id, None)
            if future and not future.done():
                future.set_result(data)
            return True

        if msg_type == "candecoder_file_error":
            session = self.downloads.pop(request_id, None)
            message = str(data.get("message") or "Vehicle client failed to send file.")
            if session and not session.future.done():
                session.future.set_exception(RuntimeError(message))
            else:
                future = self.pending.pop(request_id, None)
                if future and not future.done():
                    future.set_exception(RuntimeError(message))
            return True

        if msg_type == "candecoder_file_chunk":
            await self._handle_file_chunk(request_id, data)
            return True

        if msg_type == "candecoder_file_complete":
            await self._handle_file_complete(request_id, data)
            return True

        return False

    def _validate_ssh_source(self, source: SourceConfig) -> None:
        if paramiko is None:
            raise RuntimeError("SSH/SFTP mode requires paramiko. Run: pip install -r server/requirements.txt")
        if not source.rpi_host:
            raise RuntimeError("RPI IP/host is required for SSH/SFTP mode.")
        if not source.rpi_user:
            raise RuntimeError("RPI username is required for SSH/SFTP mode.")
        if not source.rpi_password:
            raise RuntimeError("RPI password is required for SSH/SFTP mode.")
        if not source.remote_log_dir:
            raise RuntimeError("Remote LOGS directory is required for SSH/SFTP mode.")

    def _resolve_dbc_paths(self, dbc_names: list[str]) -> list[Path]:
        paths = discover_dbc_paths()
        if not dbc_names:
            return paths
        by_name = {path.name: path for path in paths}
        missing = [name for name in dbc_names if name not in by_name]
        if missing:
            raise RuntimeError(f"Unknown DBC selection: {', '.join(missing)}")
        return [by_name[name] for name in dbc_names]

    async def _run_operation(self, body: Callable[[], Awaitable[None]]) -> None:
        try:
            self._check_cancelled()
            await body()
        except OperationCancelled as exc:
            await self._emit(
                "warning",
                str(exc),
                state="canceled",
                phase="canceled",
                percent=self.status.get("percent", 0.0),
                message="Canceled",
                error=None,
                finished_at=_now_iso(),
            )
        except asyncio.CancelledError:
            self.cancel_event.set()
            await self._emit(
                "warning",
                "Operation canceled by user.",
                state="canceled",
                phase="canceled",
                percent=self.status.get("percent", 0.0),
                message="Canceled",
                error=None,
                finished_at=_now_iso(),
            )
        except Exception as exc:
            if self.cancel_event.is_set():
                await self._emit(
                    "warning",
                    "Operation canceled by user.",
                    state="canceled",
                    phase="canceled",
                    percent=self.status.get("percent", 0.0),
                    message="Canceled",
                    error=None,
                    finished_at=_now_iso(),
                )
                return
            await self._emit(
                "error",
                str(exc),
                state="failed",
                phase="error",
                message="Failed",
                error=str(exc),
                finished_at=_now_iso(),
            )
        finally:
            self.active_download_context = {}
            self._close_active_ssh_client()
            self.cancel_event.clear()

    async def _run_list(self, task_id: str, pattern: str, source: SourceConfig) -> None:
        async def body() -> None:
            self._validate_source_ready(source)
            remote_files = await self._list_remote_files(source, pattern, found_percent=95.0)
            manifest_path = self._write_manifest(
                "manifest_list.json",
                {
                    "task_id": task_id,
                    "operation": "list",
                    "created_at": _now_iso(),
                    "pattern": pattern,
                    "source": source.public_dict(),
                    "remote_files": remote_files,
                },
            )
            await self._emit(
                "success",
                f"Listed {len(remote_files)} remote CSV log file(s)",
                state="succeeded",
                phase="complete",
                percent=100.0,
                message="List complete",
                finished_at=_now_iso(),
                counts={**self.status["counts"], "remote_files": len(remote_files)},
                remote_files=remote_files,
                progress={"remote_files": len(remote_files), "manifest": str(manifest_path)},
            )

        await self._run_operation(body)

    async def _run_pull(
        self,
        task_id: str,
        pattern: str,
        source: SourceConfig,
        selected_relative_paths: list[str],
    ) -> None:
        async def body() -> None:
            self._validate_source_ready(source)
            raw_dir, decoded_dir, folders, _ = await self._prepare_folders(None)
            remote_files = await self._list_remote_files(source, pattern, found_percent=8.0)
            remote_files = await self._apply_pull_selection(remote_files, selected_relative_paths)
            if not remote_files:
                raise RuntimeError("No remote CSV files matched the selected files.")

            state = self._load_state()
            downloaded, skipped = await self._sync_raw_files(remote_files, raw_dir, state, source, percent_end=100.0)
            self._check_cancelled()
            self._write_state(state)

            manifest_path = self._write_manifest(
                "manifest_pull.json",
                {
                    "task_id": task_id,
                    "operation": "pull",
                    "created_at": _now_iso(),
                    "pattern": pattern,
                    "source": source.public_dict(),
                    "selected_relative_paths": selected_relative_paths,
                    "folders": folders,
                    "remote_files": remote_files,
                    "downloaded_files": downloaded,
                    "download_skipped": skipped,
                },
            )
            await self._emit(
                "success",
                "CAN log pull complete",
                state="succeeded",
                phase="complete",
                percent=100.0,
                message="Pull complete",
                finished_at=_now_iso(),
                counts={
                    **self.status["counts"],
                    "downloaded": len(downloaded),
                    "download_skipped": len(skipped),
                },
                folders=folders,
                remote_files=remote_files,
                local_raw_files=[str(self._raw_path(raw_dir, entry)) for entry in remote_files if self._raw_path(raw_dir, entry).exists()],
                progress={"manifest": str(manifest_path), "decoded_folder": str(decoded_dir)},
            )

        await self._run_operation(body)

    async def _run_decode(
        self,
        task_id: str,
        template_name: str | None,
        dbc_names: list[str],
        selected_relative_paths: list[str],
        output_folder_name: str | None,
    ) -> None:
        async def body() -> None:
            raw_dir, decoded_dir, folders, folder_suffix = await self._prepare_folders(template_name, output_folder_name)
            dbc_paths, selected = self._prepare_decode_inputs(template_name, dbc_names)
            raw_files = self._selected_raw_files(raw_dir, selected_relative_paths)
            await self._emit(
                "info",
                f"Selected {len(raw_files)} local raw CSV file(s)",
                phase="preparing",
                percent=5.0,
                message=f"Selected {len(raw_files)} local raw file(s)",
                folders=folders,
                local_raw_files=[str(path) for path in raw_files],
                progress={"local_raw_files": len(raw_files)},
            )
            if not raw_files:
                raise RuntimeError("Select at least one pulled CSV file before decoding.")

            decoded, decode_skipped = await self._decode_raw_files(
                raw_files=raw_files,
                raw_dir=raw_dir,
                decoded_dir=decoded_dir,
                dbc_paths=dbc_paths,
                selected=selected,
                percent_start=5.0,
                percent_end=100.0,
            )
            manifest_path = self._write_manifest(
                f"manifest_decode{folder_suffix}.json",
                {
                    "task_id": task_id,
                    "operation": "decode",
                    "created_at": _now_iso(),
                    "template_name": template_name,
                    "output_folder_name": output_folder_name,
                    "selected_relative_paths": selected_relative_paths,
                    "folders": folders,
                    "dbc_paths": [str(path) for path in dbc_paths],
                    "raw_files": [str(path) for path in raw_files],
                    "decoded_files": [row.get("output") for row in decoded],
                    "decode_skipped": decode_skipped,
                    "stats": decoded,
                },
            )
            await self._emit(
                "success",
                "CAN log decode complete",
                state="succeeded",
                phase="complete",
                percent=100.0,
                message="Decode complete",
                finished_at=_now_iso(),
                counts={**self.status["counts"], "decoded": len(decoded), "decode_skipped": decode_skipped},
                folders=folders,
                progress={"manifest": str(manifest_path)},
            )

        await self._run_operation(body)

    async def _run_sync_decode(
        self,
        task_id: str,
        template_name: str | None,
        pattern: str,
        source: SourceConfig,
        dbc_names: list[str],
        selected_relative_paths: list[str],
        output_folder_name: str | None,
    ) -> None:
        async def body() -> None:
            self._validate_source_ready(source)
            raw_dir, decoded_dir, folders, folder_suffix = await self._prepare_folders(template_name, output_folder_name)
            dbc_paths, selected = self._prepare_decode_inputs(template_name, dbc_names)

            remote_files = await self._list_remote_files(source, pattern, found_percent=8.0)
            remote_files = await self._apply_pull_selection(remote_files, selected_relative_paths)
            if not remote_files:
                raise RuntimeError("No remote CSV files matched the selected files.")

            state = self._load_state()
            downloaded, skipped = await self._sync_raw_files(remote_files, raw_dir, state, source, percent_end=55.0)
            self._check_cancelled()
            self._write_state(state)

            raw_files = [self._raw_path(raw_dir, entry) for entry in remote_files if self._raw_path(raw_dir, entry).exists()]
            decoded, decode_skipped = await self._decode_raw_files(
                raw_files=raw_files,
                raw_dir=raw_dir,
                decoded_dir=decoded_dir,
                dbc_paths=dbc_paths,
                selected=selected,
                percent_start=55.0,
                percent_end=100.0,
            )

            manifest_path = self._write_manifest(
                f"manifest{folder_suffix}.json",
                {
                    "task_id": task_id,
                    "operation": "sync_decode",
                    "created_at": _now_iso(),
                    "template_name": template_name,
                    "output_folder_name": output_folder_name,
                    "pattern": pattern,
                    "source": source.public_dict(),
                    "selected_relative_paths": selected_relative_paths,
                    "folders": folders,
                    "dbc_paths": [str(path) for path in dbc_paths],
                    "remote_files": remote_files,
                    "downloaded_files": downloaded,
                    "download_skipped": skipped,
                    "decoded_files": [row.get("output") for row in decoded],
                    "decode_skipped": decode_skipped,
                    "stats": decoded,
                },
            )
            await self._emit(
                "success",
                "CAN decoder pull and decode complete",
                state="succeeded",
                phase="complete",
                percent=100.0,
                message="Complete",
                finished_at=_now_iso(),
                counts={
                    **self.status["counts"],
                    "downloaded": len(downloaded),
                    "download_skipped": len(skipped),
                    "decoded": len(decoded),
                    "decode_skipped": decode_skipped,
                },
                folders=folders,
                remote_files=remote_files,
                progress={"manifest": str(manifest_path)},
            )

        await self._run_operation(body)

    def _check_cancelled(self) -> None:
        if self.cancel_event.is_set():
            raise OperationCancelled("Operation canceled by user.")

    def _set_active_ssh_client(self, client: Any | None) -> None:
        with self.active_ssh_lock:
            self.active_ssh_client = client

    def _close_active_ssh_client(self) -> None:
        with self.active_ssh_lock:
            client = self.active_ssh_client
            self.active_ssh_client = None
        if client:
            try:
                client.close()
            except Exception:
                pass

    async def _send_cancel_request(self, request_id: str) -> None:
        if not request_id:
            return
        try:
            await self._send_or_raise({"type": "candecoder_cancel_request", "request_id": request_id})
        except Exception:
            pass

    def _validate_source_ready(self, source: SourceConfig) -> None:
        self._check_cancelled()
        self._validate_ssh_source(source)

    def _clean_output_folder_name(self, value: str | None) -> str | None:
        text = str(value or "").strip()
        if not text:
            return None
        clean = safe_suffix(text)
        if not clean:
            raise RuntimeError("Decode output folder name contains no usable characters.")
        return clean

    async def _prepare_folders(
        self,
        template_name: str | None,
        output_folder_name: str | None = None,
    ) -> tuple[Path, Path, dict[str, str], str]:
        self._check_cancelled()
        suffix = self._clean_output_folder_name(output_folder_name) or safe_suffix(template_name)
        folder_suffix = f"_{suffix}" if suffix else ""
        raw_dir = WORKSPACE_DIR / "undecoded"
        decoded_dir = WORKSPACE_DIR / f"decoded{folder_suffix}"
        raw_dir.mkdir(parents=True, exist_ok=True)
        decoded_dir.mkdir(parents=True, exist_ok=True)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        folders = {
            "workspace": str(WORKSPACE_DIR),
            "undecoded": str(raw_dir),
            "decoded": str(decoded_dir),
            "cache": str(CACHE_DIR),
        }
        await self._emit(
            "info",
            "Prepared output folders",
            phase="preparing",
            percent=3.0,
            message="Preparing folders",
            folders=folders,
        )
        return raw_dir, decoded_dir, folders, folder_suffix

    def _prepare_decode_inputs(
        self,
        template_name: str | None,
        dbc_names: list[str],
    ) -> tuple[list[Path], set[tuple[int, str]]]:
        self._check_cancelled()
        dbc_paths = self._resolve_dbc_paths(dbc_names)
        if not dbc_paths:
            raise RuntimeError(f"No DBC files found in {SERVER_DIR / 'dbc'}.")

        selected: set[tuple[int, str]] = set()
        if template_name:
            selected = load_signal_template(template_name)
            if not selected:
                raise RuntimeError(f"Template '{template_name}' has no configured signals.")
        return dbc_paths, selected

    def _discover_raw_files(self, raw_dir: Path) -> list[Path]:
        self._check_cancelled()
        if not raw_dir.exists():
            return []
        return sorted(
            [
                path
                for path in raw_dir.rglob("*.csv")
                if path.is_file() and not path.name.lower().endswith("_decoded.csv")
            ],
            key=lambda path: str(path.relative_to(raw_dir)).lower(),
        )

    def _selected_raw_files(self, raw_dir: Path, selected_relative_paths: list[str]) -> list[Path]:
        self._check_cancelled()
        if not selected_relative_paths:
            return []
        raw_files: list[Path] = []
        missing: list[str] = []
        seen: set[str] = set()
        for relative_path in selected_relative_paths:
            self._check_cancelled()
            safe_path = safe_local_relative_path(relative_path)
            raw_path = raw_dir / safe_path
            key = str(safe_path).replace("\\", "/").lower()
            if key in seen:
                continue
            seen.add(key)
            if not raw_path.exists() or not raw_path.is_file():
                missing.append(relative_path)
                continue
            if not raw_path.name.lower().endswith(".csv") or raw_path.name.lower().endswith("_decoded.csv"):
                continue
            raw_files.append(raw_path)
        if missing:
            preview = ", ".join(missing[:5])
            suffix = "..." if len(missing) > 5 else ""
            raise RuntimeError(f"Selected file(s) have not been pulled yet: {preview}{suffix}")
        return sorted(raw_files, key=lambda path: str(path.relative_to(raw_dir)).lower())

    def _clean_selected_relative_paths(self, paths: list[str] | None) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw_path in paths or []:
            text = str(raw_path or "").replace("\\", "/").strip()
            if not text or text in seen:
                continue
            seen.add(text)
            cleaned.append(text)
        return cleaned

    async def _apply_pull_selection(
        self,
        remote_files: list[dict[str, Any]],
        selected_relative_paths: list[str],
    ) -> list[dict[str, Any]]:
        selected_set = set(selected_relative_paths)
        filtered = remote_files
        selection_note = "all listed files"

        if selected_set:
            filtered = [
                row
                for row in remote_files
                if str(row.get("relative_path") or row.get("name") or "").replace("\\", "/") in selected_set
            ]
            selection_note = f"{len(filtered)} selected file(s)"

        await self._emit(
            "info",
            f"Pull selection: {selection_note}",
            phase="selecting",
            percent=9.0,
            message="Selecting files",
            counts={**self.status["counts"], "remote_files": len(filtered)},
            remote_files=filtered,
            progress={"remote_files": len(filtered), "selection": selection_note},
        )
        return filtered

    def _write_manifest(self, filename: str, manifest: dict[str, Any]) -> Path:
        self._check_cancelled()
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
        manifest_path = WORKSPACE_DIR / filename
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        return manifest_path

    async def _list_remote_files(
        self,
        source: SourceConfig,
        pattern: str,
        found_percent: float,
    ) -> list[dict[str, Any]]:
        self._check_cancelled()
        remote_files = await self._request_ssh_remote_list(source, pattern)
        self._check_cancelled()
        remote_files = self._filter_remote_files(remote_files)
        await self._emit(
            "info",
            f"Found {len(remote_files)} remote CSV log file(s)",
            phase="listing",
            percent=found_percent,
            message=f"Found {len(remote_files)} remote file(s)",
            counts={**self.status["counts"], "remote_files": len(remote_files)},
            remote_files=remote_files,
            progress={"remote_files": len(remote_files)},
        )
        return remote_files

    async def _request_ssh_remote_list(self, source: SourceConfig, pattern: str) -> list[dict[str, Any]]:
        self._check_cancelled()
        await self._emit(
            "info",
            f"Connecting to RPI {source.rpi_host}",
            phase="listing",
            percent=4.0,
            message="Connecting by SSH/SFTP",
        )
        return await asyncio.to_thread(self._list_ssh_remote_files_sync, source, pattern)

    def _list_ssh_remote_files_sync(self, source: SourceConfig, pattern: str) -> list[dict[str, Any]]:
        self._validate_ssh_source(source)
        self._check_cancelled()
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        root = source.remote_log_dir.rstrip("/") or "."
        self._set_active_ssh_client(client)
        try:
            client.connect(
                hostname=source.rpi_host,
                username=source.rpi_user,
                password=source.rpi_password,
                timeout=20,
                banner_timeout=20,
                auth_timeout=20,
                look_for_keys=False,
                allow_agent=False,
            )
            with client.open_sftp() as sftp:
                entries: list[dict[str, Any]] = []

                def walk(remote_dir: str) -> None:
                    self._check_cancelled()
                    for attr in sftp.listdir_attr(remote_dir):
                        self._check_cancelled()
                        remote_path = posixpath.join(remote_dir.rstrip("/"), attr.filename)
                        if stat.S_ISDIR(attr.st_mode):
                            walk(remote_path)
                            continue
                        if not fnmatch.fnmatch(attr.filename, pattern):
                            continue
                        relative_path = posixpath.relpath(remote_path, root).replace("\\", "/")
                        entries.append(
                            {
                                "name": attr.filename,
                                "filename": attr.filename,
                                "path": remote_path,
                                "relative_path": relative_path,
                                "size": int(attr.st_size),
                                "mtime": float(attr.st_mtime),
                                "modified": datetime.fromtimestamp(attr.st_mtime).isoformat(timespec="seconds"),
                            }
                        )

                walk(root)
                entries.sort(key=lambda row: str(row["relative_path"]).lower())
                return entries
        finally:
            self._set_active_ssh_client(None)
            client.close()

    async def _request_remote_list(self, pattern: str) -> list[dict[str, Any]]:
        self._check_cancelled()
        request_id = uuid.uuid4().hex
        loop = asyncio.get_running_loop()
        future = loop.create_future()
        self.pending[request_id] = future
        await self._send_or_raise(
            {
                "type": "candecoder_request_log_list",
                "request_id": request_id,
                "pattern": pattern,
                "recursive": True,
            }
        )
        await self._emit("info", "Requested remote log list", phase="listing", percent=5.0, message="Listing remote logs")
        try:
            response = await asyncio.wait_for(future, timeout=90)
        finally:
            self.pending.pop(request_id, None)
        self._check_cancelled()
        files = response.get("files", [])
        return files if isinstance(files, list) else []

    async def _sync_raw_files(
        self,
        remote_files: list[dict[str, Any]],
        raw_dir: Path,
        state: dict[str, Any],
        source: SourceConfig,
        percent_end: float = 55.0,
    ) -> tuple[list[str], list[str]]:
        to_download: list[dict[str, Any]] = []
        skipped: list[str] = []
        for entry in remote_files:
            self._check_cancelled()
            if self._raw_is_current(entry, raw_dir):
                raw_path = self._raw_path(raw_dir, entry)
                self._ensure_cache_from_raw(entry, raw_path)
                self._record_synced_file(state, entry)
                skipped.append(str(entry["relative_path"]))
            elif self._cache_is_current(entry, state):
                self._copy_cache_to_raw(entry, raw_dir)
                self._record_synced_file(state, entry)
                skipped.append(str(entry["relative_path"]))
            else:
                to_download.append(entry)

        total_bytes = sum(int(entry.get("size") or 0) for entry in to_download)
        copied_before = 0
        downloaded: list[str] = []

        if not to_download:
            await self._emit(
                "info",
                "All remote logs already exist locally",
                phase="downloading",
                percent=percent_end,
                message="No new downloads",
                counts={**self.status["counts"], "download_skipped": len(skipped)},
                progress={"downloaded": 0, "skipped": len(skipped), "total_bytes": total_bytes},
            )
            return downloaded, skipped

        await self._emit(
            "info",
            f"Downloading {len(to_download)} changed or missing file(s)",
            phase="downloading",
            percent=10.0,
            message=f"Downloading 0/{len(to_download)}",
            counts={**self.status["counts"], "download_skipped": len(skipped)},
            progress={"total_files": len(to_download), "total_bytes": total_bytes},
        )

        for file_index, entry in enumerate(to_download, start=1):
            self.active_download_context = {
                "file_index": file_index,
                "total_files": len(to_download),
                "total_bytes": total_bytes,
                "bytes_before": copied_before,
                "percent_start": 10.0,
                "percent_end": percent_end,
            }
            self._check_cancelled()
            if source.mode == "ssh":
                cache_path = await self._download_ssh_file(entry, source)
            else:
                cache_path = await self._download_file(entry)
            self._check_cancelled()
            copied_before += cache_path.stat().st_size if cache_path.exists() else int(entry.get("size") or 0)
            self._record_synced_file(state, entry, cache_path)
            raw_path = self._copy_cache_to_raw(entry, raw_dir)
            downloaded.append(str(raw_path))
            await self._emit(
                "info",
                f"Downloaded {entry['name']}",
                phase="downloading",
                percent=self._download_percent(copied_before, total_bytes, 10.0, percent_end),
                message=f"Downloading {file_index}/{len(to_download)}",
                counts={**self.status["counts"], "downloaded": len(downloaded), "download_skipped": len(skipped)},
                progress={
                    "current_file": entry["name"],
                    "file_index": file_index,
                    "total_files": len(to_download),
                    "downloaded_bytes": copied_before,
                    "total_bytes": total_bytes,
                    "downloaded_label": format_bytes(copied_before),
                    "total_label": format_bytes(total_bytes),
                },
            )

        return downloaded, skipped

    async def _download_ssh_file(self, entry: dict[str, Any], source: SourceConfig) -> Path:
        self._check_cancelled()
        final_path = self._cache_path(entry)
        temp_path = final_path.with_name(f"{final_path.name}.{uuid.uuid4().hex}.part")
        final_path.parent.mkdir(parents=True, exist_ok=True)
        if temp_path.exists():
            temp_path.unlink()
        loop = asyncio.get_running_loop()
        try:
            return await asyncio.to_thread(self._download_ssh_file_sync, entry, source, temp_path, final_path, loop)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    def _download_ssh_file_sync(
        self,
        entry: dict[str, Any],
        source: SourceConfig,
        temp_path: Path,
        final_path: Path,
        loop: asyncio.AbstractEventLoop,
    ) -> Path:
        self._validate_ssh_source(source)
        self._check_cancelled()
        remote_path = str(entry.get("path") or "")
        expected_size = int(entry.get("size") or 0)
        remote_mtime = float(entry.get("mtime") or 0)
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        last_emit = {"at": 0.0, "bytes": -1}
        total_bytes = int(self.active_download_context.get("total_bytes") or 0)
        bytes_before = int(self.active_download_context.get("bytes_before") or 0)
        percent_start = float(self.active_download_context.get("percent_start") or 10.0)
        percent_end = float(self.active_download_context.get("percent_end") or 55.0)
        self._set_active_ssh_client(client)

        def on_progress(transferred: int, file_total: int) -> None:
            self._check_cancelled()
            now = time.monotonic()
            known_total = int(file_total or expected_size)
            if transferred != known_total and now - last_emit["at"] < 0.35:
                return
            if transferred == last_emit["bytes"]:
                return
            last_emit["at"] = now
            last_emit["bytes"] = transferred
            self._emit_from_thread(
                loop,
                "info",
                f"Downloading {entry['name']}",
                phase="downloading",
                percent=self._download_percent(bytes_before + transferred, total_bytes, percent_start, percent_end),
                message=f"Downloading {self.active_download_context.get('file_index', 0)}/{self.active_download_context.get('total_files', 0)}",
                progress={
                    "current_file": entry["name"],
                    "current_file_bytes": transferred,
                    "current_file_total_bytes": known_total,
                    "current_file_label": f"{format_bytes(transferred)} / {format_bytes(known_total)}",
                    "downloaded_bytes": bytes_before + transferred,
                    "total_bytes": total_bytes,
                },
            )

        try:
            client.connect(
                hostname=source.rpi_host,
                username=source.rpi_user,
                password=source.rpi_password,
                timeout=20,
                banner_timeout=20,
                auth_timeout=20,
                look_for_keys=False,
                allow_agent=False,
            )
            with client.open_sftp() as sftp:
                transferred = 0
                with sftp.open(remote_path, "rb") as remote_handle, temp_path.open("wb") as local_handle:
                    while True:
                        self._check_cancelled()
                        chunk = remote_handle.read(CHUNK_SIZE)
                        if not chunk:
                            break
                        local_handle.write(chunk)
                        transferred += len(chunk)
                        on_progress(transferred, expected_size)
            if expected_size and temp_path.stat().st_size != expected_size:
                raise RuntimeError(f"Incomplete transfer for {entry['name']}: {temp_path.stat().st_size}/{expected_size} bytes")
            if final_path.exists():
                final_path.unlink()
            temp_path.replace(final_path)
            if remote_mtime:
                os.utime(final_path, (remote_mtime, remote_mtime))
            return final_path
        finally:
            self._set_active_ssh_client(None)
            client.close()

    async def _download_file(self, entry: dict[str, Any]) -> Path:
        self._check_cancelled()
        request_id = uuid.uuid4().hex
        relative_path = str(entry["relative_path"])
        final_path = self._cache_path(entry)
        temp_path = final_path.with_name(f"{final_path.name}.{request_id}.part")
        final_path.parent.mkdir(parents=True, exist_ok=True)
        if temp_path.exists():
            temp_path.unlink()

        loop = asyncio.get_running_loop()
        future = loop.create_future()
        session = DownloadSession(
            request_id=request_id,
            relative_path=relative_path,
            temp_path=temp_path,
            final_path=final_path,
            expected_size=int(entry.get("size") or 0),
            mtime=float(entry.get("mtime") or 0),
            future=future,
        )
        self.downloads[request_id] = session
        await self._send_or_raise(
            {
                "type": "candecoder_get_file",
                "request_id": request_id,
                "relative_path": relative_path,
                "chunk_size": CHUNK_SIZE,
            }
        )
        timeout = max(300.0, session.expected_size / max(CHUNK_SIZE, 1) * 20.0)
        cleanup_temp = False
        try:
            result = await asyncio.wait_for(future, timeout=timeout)
            self._check_cancelled()
            return result
        except OperationCancelled:
            cleanup_temp = True
            await self._send_cancel_request(request_id)
            raise
        except Exception:
            cleanup_temp = True
            raise
        finally:
            self.downloads.pop(request_id, None)
            if cleanup_temp and temp_path.exists():
                temp_path.unlink(missing_ok=True)

    async def _handle_file_chunk(self, request_id: str, data: dict[str, Any]) -> None:
        session = self.downloads.get(request_id)
        if not session:
            return
        if self.cancel_event.is_set():
            if not session.future.done():
                session.future.set_exception(OperationCancelled("Operation canceled by user."))
            return
        try:
            offset = int(data.get("offset") or 0)
            if offset != session.received:
                raise RuntimeError(f"Unexpected chunk offset for {session.relative_path}: {offset} != {session.received}")
            chunk = base64.b64decode(str(data.get("data") or ""))
            session.temp_path.parent.mkdir(parents=True, exist_ok=True)
            with session.temp_path.open("ab") as handle:
                handle.write(chunk)
            session.received += len(chunk)
            now = time.monotonic()
            if now - session.last_emit >= 0.35 or session.received >= session.expected_size:
                session.last_emit = now
                total_bytes = int(self.active_download_context.get("total_bytes") or 0)
                bytes_before = int(self.active_download_context.get("bytes_before") or 0)
                percent_start = float(self.active_download_context.get("percent_start") or 10.0)
                percent_end = float(self.active_download_context.get("percent_end") or 55.0)
                await self._emit(
                    "info",
                    f"Receiving {Path(session.relative_path).name}",
                    phase="downloading",
                    percent=self._download_percent(bytes_before + session.received, total_bytes, percent_start, percent_end),
                    message=f"Downloading {self.active_download_context.get('file_index', 0)}/{self.active_download_context.get('total_files', 0)}",
                    progress={
                        "current_file": Path(session.relative_path).name,
                        "current_file_bytes": session.received,
                        "current_file_total_bytes": session.expected_size,
                        "current_file_label": f"{format_bytes(session.received)} / {format_bytes(session.expected_size)}",
                        "downloaded_bytes": bytes_before + session.received,
                        "total_bytes": total_bytes,
                    },
                )
        except Exception as exc:
            if not session.future.done():
                session.future.set_exception(exc)

    async def _handle_file_complete(self, request_id: str, data: dict[str, Any]) -> None:
        session = self.downloads.get(request_id)
        if not session:
            return
        if self.cancel_event.is_set():
            if not session.future.done():
                session.future.set_exception(OperationCancelled("Operation canceled by user."))
            return
        try:
            expected = int(data.get("size") or session.expected_size or 0)
            if expected and session.received != expected:
                raise RuntimeError(f"Incomplete transfer for {session.relative_path}: {session.received}/{expected} bytes")
            if session.final_path.exists():
                session.final_path.unlink()
            session.temp_path.replace(session.final_path)
            if session.mtime:
                os.utime(session.final_path, (session.mtime, session.mtime))
            if not session.future.done():
                session.future.set_result(session.final_path)
        except Exception as exc:
            if not session.future.done():
                session.future.set_exception(exc)

    async def _decode_raw_files(
        self,
        raw_files: list[Path],
        raw_dir: Path,
        decoded_dir: Path,
        dbc_paths: list[Path],
        selected: set[tuple[int, str]],
        percent_start: float = 55.0,
        percent_end: float = 100.0,
    ) -> tuple[list[dict[str, Any]], int]:
        self._check_cancelled()
        if not raw_files:
            raise RuntimeError("No local raw CSV files are available to decode.")
        loop = asyncio.get_running_loop()
        return await asyncio.to_thread(
            self._decode_raw_files_sync,
            raw_files,
            raw_dir,
            decoded_dir,
            dbc_paths,
            selected,
            percent_start,
            percent_end,
            loop,
        )

    def _decode_raw_files_sync(
        self,
        raw_files: list[Path],
        raw_dir: Path,
        decoded_dir: Path,
        dbc_paths: list[Path],
        selected: set[tuple[int, str]],
        percent_start: float,
        percent_end: float,
        loop: asyncio.AbstractEventLoop,
    ) -> tuple[list[dict[str, Any]], int]:
        decoded: list[dict[str, Any]] = []
        skipped = 0
        total_files = len(raw_files)
        for file_index, raw_file in enumerate(raw_files, start=1):
            self._check_cancelled()
            relative = raw_file.relative_to(raw_dir)
            output_file = decoded_dir / relative.with_name(f"{relative.stem}_decoded.csv")
            if output_file.exists() and output_file.stat().st_mtime >= raw_file.stat().st_mtime:
                skipped += 1
                self._emit_from_thread(
                    loop,
                    "info",
                    f"Decode already current for {raw_file.name}",
                    phase="decoding",
                    percent=self._decode_percent(file_index, total_files, 1.0, percent_start, percent_end),
                    message=f"Decoding {file_index}/{total_files}",
                    counts={**self.status["counts"], "decode_skipped": skipped},
                    progress={"current_file": raw_file.name, "skipped": True},
                )
                continue

            last_emit = {"at": 0.0, "rows": -1}

            def on_progress(current_rows: int, total_rows: int, decoded_rows: int) -> None:
                self._check_cancelled()
                now = time.monotonic()
                if current_rows != total_rows and now - last_emit["at"] < 0.35:
                    return
                if current_rows == last_emit["rows"]:
                    return
                last_emit["at"] = now
                last_emit["rows"] = current_rows
                fraction = current_rows / total_rows if total_rows else 0.0
                self._emit_from_thread(
                    loop,
                    "info",
                    f"Decoding {raw_file.name}",
                    phase="decoding",
                    percent=self._decode_percent(file_index, total_files, fraction, percent_start, percent_end),
                    message=f"Decoding {file_index}/{total_files}",
                    progress={
                        "current_file": raw_file.name,
                        "current_rows": current_rows,
                        "total_rows": total_rows,
                        "decoded_rows": decoded_rows,
                    },
                )

            stats = decode_selected_signals(raw_file, output_file, dbc_paths, selected, on_progress, self._check_cancelled)
            self._check_cancelled()
            decoded.append(stats)
            self._emit_from_thread(
                loop,
                "info",
                f"Decoded {raw_file.name}",
                phase="decoding",
                percent=self._decode_percent(file_index, total_files, 1.0, percent_start, percent_end),
                message=f"Decoding {file_index}/{total_files}",
                counts={**self.status["counts"], "decoded": len(decoded), "decode_skipped": skipped},
                progress={
                    "current_file": raw_file.name,
                    "decoded_rows": stats["decoded_rows"],
                    "message_count": stats["message_count"],
                },
            )
        return decoded, skipped

    def _emit_from_thread(self, loop: asyncio.AbstractEventLoop, level: str, event_message: str, **updates: Any) -> None:
        future = asyncio.run_coroutine_threadsafe(self._emit(level, event_message, **updates), loop)
        try:
            future.result(timeout=2)
        except Exception:
            pass

    async def _send_or_raise(self, message: dict[str, Any]) -> None:
        result = await self.send_vehicle_command(message)
        if isinstance(result, dict) and result.get("error"):
            raise RuntimeError(str(result["error"]))

    async def _emit(self, level: str, event_message: str | None = None, **updates: Any) -> None:
        self.status.update(updates)
        if "message" not in updates and event_message:
            self.status["message"] = event_message
        if event_message:
            events = self.status.setdefault("events", [])
            events.append(
                {
                    "ts": _now_iso(),
                    "level": level,
                    "message": event_message,
                    "data": {
                        key: value
                        for key, value in updates.items()
                        if key in {"phase", "percent", "progress", "counts", "folders", "error"}
                    },
                }
            )
            del events[:-100]
        await self.broadcast({"type": "candecoder_progress", "status": self.get_status()})

    def _filter_remote_files(self, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        cleaned: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in files:
            name = str(item.get("name") or Path(str(item.get("path") or "")).name)
            relative = str(item.get("relative_path") or name)
            if not name.lower().endswith(".csv"):
                continue
            if name.lower().endswith("_decoded.csv"):
                continue
            if relative in seen:
                continue
            seen.add(relative)
            cleaned.append(
                {
                    **item,
                    "name": name,
                    "relative_path": relative,
                    "size": int(item.get("size") or 0),
                    "mtime": float(item.get("mtime") or 0),
                }
            )
        cleaned.sort(key=lambda row: (str(row.get("relative_path") or "").lower()))
        return cleaned

    def _load_state(self) -> dict[str, Any]:
        if not STATE_FILE.exists():
            return {"files": {}}
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {"files": {}}

    def _write_state(self, state: dict[str, Any]) -> None:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    def _cache_path(self, entry: dict[str, Any]) -> Path:
        return CACHE_DIR / safe_local_relative_path(str(entry["relative_path"]))

    def _raw_path(self, raw_dir: Path, entry: dict[str, Any]) -> Path:
        return raw_dir / safe_local_relative_path(str(entry["relative_path"]))

    def _cache_is_current(self, entry: dict[str, Any], state: dict[str, Any]) -> bool:
        cache_path = self._cache_path(entry)
        if not cache_path.exists():
            return False
        expected_size = int(entry.get("size") or 0)
        if expected_size and cache_path.stat().st_size != expected_size:
            return False
        record = state.get("files", {}).get(str(entry["relative_path"]))
        if not record:
            return expected_size == 0 or cache_path.stat().st_size == expected_size
        same_size = int(record.get("size") or 0) == expected_size
        same_mtime = int(float(record.get("mtime") or 0)) == int(float(entry.get("mtime") or 0))
        return same_size and same_mtime

    def _path_matches_remote(self, path: Path, entry: dict[str, Any]) -> bool:
        if not path.exists() or not path.is_file():
            return False
        expected_size = int(entry.get("size") or 0)
        if expected_size and path.stat().st_size != expected_size:
            return False
        remote_mtime = float(entry.get("mtime") or 0)
        if remote_mtime:
            return int(path.stat().st_mtime) == int(remote_mtime)
        return True

    def _raw_is_current(self, entry: dict[str, Any], raw_dir: Path) -> bool:
        return self._path_matches_remote(self._raw_path(raw_dir, entry), entry)

    def _ensure_cache_from_raw(self, entry: dict[str, Any], raw_path: Path) -> Path:
        cache_path = self._cache_path(entry)
        if self._path_matches_remote(cache_path, entry):
            return cache_path
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(raw_path, cache_path)
        return cache_path

    def _record_synced_file(self, state: dict[str, Any], entry: dict[str, Any], cache_path: Path | None = None) -> None:
        resolved_cache_path = cache_path or self._cache_path(entry)
        state.setdefault("files", {})[str(entry["relative_path"])] = {
            "relative_path": entry["relative_path"],
            "remote_path": entry.get("path"),
            "size": int(entry.get("size") or 0),
            "mtime": float(entry.get("mtime") or 0),
            "cache_path": str(resolved_cache_path),
            "synced_at": _now_iso(),
        }

    def _copy_cache_to_raw(self, entry: dict[str, Any], raw_dir: Path) -> Path:
        source = self._cache_path(entry)
        destination = self._raw_path(raw_dir, entry)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if self._path_matches_remote(destination, entry):
            return destination
        shutil.copy2(source, destination)
        return destination

    def _download_percent(
        self,
        copied_bytes: int,
        total_bytes: int,
        percent_start: float = 10.0,
        percent_end: float = 55.0,
    ) -> float:
        if total_bytes <= 0:
            return percent_end
        span = percent_end - percent_start
        return round(percent_start + min(1.0, max(0.0, copied_bytes / total_bytes)) * span, 1)

    def _decode_percent(
        self,
        file_index: int,
        total_files: int,
        fraction: float,
        percent_start: float = 55.0,
        percent_end: float = 100.0,
    ) -> float:
        if total_files <= 0:
            return percent_end
        completed_before = max(0, file_index - 1)
        overall = (completed_before + min(1.0, max(0.0, fraction))) / total_files
        return round(percent_start + overall * (percent_end - percent_start), 1)
