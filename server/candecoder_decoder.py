from __future__ import annotations

import csv
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import cantools


logging.getLogger("cantools").setLevel(logging.ERROR)

SERVER_DIR = Path(__file__).resolve().parent
REPO_ROOT = SERVER_DIR.parent
WORKSPACE_ROOT = REPO_ROOT.parent
DBC_DIR = SERVER_DIR / "dbc"
LOCAL_TEMPLATE_CONFIG = SERVER_DIR / "candecoder_templates.json"
WORKSPACE_TEMPLATE_CONFIG = WORKSPACE_ROOT / "CANdecoder" / "config.json"


@dataclass(frozen=True)
class CANLogEntry:
    timestamp: int
    can_id: int
    extended: bool
    direction: str
    bus: int
    length: int
    data: bytes


def _first_value(row: dict[str, str], names: tuple[str, ...], default: str = "") -> str:
    for name in names:
        if name in row and row[name] is not None:
            return row[name]
    lowered = {key.lower(): value for key, value in row.items() if key}
    for name in names:
        value = lowered.get(name.lower())
        if value is not None:
            return value
    return default


def _parse_can_id(value: str) -> int:
    text = value.strip()
    if not text:
        raise ValueError("empty CAN ID")
    if text.lower().startswith("0x"):
        return int(text, 16)
    return int(text, 16)


def _parse_payload(row: dict[str, str], length: int) -> bytes:
    payload: list[int] = []
    for index in range(1, max(length, 0) + 1):
        raw = _first_value(row, (f"D{index}", f"d{index}")).strip()
        if not raw:
            payload.append(0)
            continue
        payload.append(int(raw, 16) & 0xFF)
    return bytes(payload)


def parse_can_csv(filepath: str | Path) -> list[CANLogEntry]:
    entries: list[CANLogEntry] = []
    with Path(filepath).open("r", newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                timestamp = int(float(_first_value(row, ("Time Stamp", "timestamp", "TimeStamp", "time"))))
                can_id = _parse_can_id(_first_value(row, ("ID", "id", "can_id", "CAN ID")))
                length_raw = _first_value(row, ("LEN", "len", "length", "Length"), "0").strip()
                length = max(0, min(64, int(length_raw or "0")))
                payload = _parse_payload(row, length)
                entries.append(
                    CANLogEntry(
                        timestamp=timestamp,
                        can_id=can_id,
                        extended=_first_value(row, ("Extended", "extended"), "false").strip().lower() == "true",
                        direction=_first_value(row, ("Dir", "direction"), ""),
                        bus=int(_first_value(row, ("Bus", "bus", "bus_id"), "0") or "0"),
                        length=length,
                        data=payload,
                    )
                )
            except (ValueError, TypeError):
                continue
    return entries


def normalize_payload_for_msg(raw_data: bytes, msg: Any) -> bytes:
    target_len = int(getattr(msg, "length", len(raw_data)))
    if target_len <= 0:
        return raw_data
    if len(raw_data) == target_len:
        return raw_data
    if len(raw_data) > target_len:
        return raw_data[:target_len]
    return raw_data + bytes([0] * (target_len - len(raw_data)))


def discover_dbc_paths() -> list[Path]:
    if not DBC_DIR.exists():
        return []
    return sorted(
        [path for path in DBC_DIR.iterdir() if path.is_file() and path.suffix.lower() == ".dbc"],
        key=lambda path: path.name.lower(),
    )


def discover_dbc_info() -> list[dict[str, Any]]:
    return [
        {
            "name": path.name,
            "path": str(path),
            "size": path.stat().st_size,
        }
        for path in discover_dbc_paths()
    ]


def discover_dbc_signals(dbc_names: list[str] | None = None) -> list[dict[str, Any]]:
    dbc_paths = discover_dbc_paths()
    if dbc_names:
        by_name = {path.name: path for path in dbc_paths}
        missing = [name for name in dbc_names if name not in by_name]
        if missing:
            raise ValueError(f"Unknown DBC selection: {', '.join(missing)}")
        dbc_paths = [by_name[name] for name in dbc_names]

    rows_by_key: dict[tuple[int, str], dict[str, Any]] = {}
    for dbc_path in dbc_paths:
        db = cantools.database.load_file(str(dbc_path), strict=False)
        for msg in db.messages:
            for signal in msg.signals:
                key = (int(msg.frame_id), str(signal.name))
                row = rows_by_key.setdefault(
                    key,
                    {
                        "can_id": int(msg.frame_id),
                        "can_id_hex": f"0x{int(msg.frame_id):03X}",
                        "message_name": str(msg.name),
                        "signal_name": str(signal.name),
                        "dbcs": [],
                    },
                )
                row["dbcs"].append(dbc_path.name)

    rows = list(rows_by_key.values())
    for row in rows:
        row["dbc_label"] = ", ".join(sorted(set(row["dbcs"]), key=str.lower))
    return sorted(rows, key=lambda item: (int(item["can_id"]), item["signal_name"].lower()))


def load_dbc_messages(dbc_paths: list[str | Path]) -> dict[int, Any]:
    id_to_msg: dict[int, Any] = {}
    for dbc_path in dbc_paths:
        db = cantools.database.load_file(str(dbc_path), strict=False)
        for msg in db.messages:
            id_to_msg[msg.frame_id] = msg
    return id_to_msg


def template_config_path() -> Path | None:
    if WORKSPACE_TEMPLATE_CONFIG.exists():
        return WORKSPACE_TEMPLATE_CONFIG
    if LOCAL_TEMPLATE_CONFIG.exists():
        return LOCAL_TEMPLATE_CONFIG
    return None


def writable_template_config_path() -> Path:
    return template_config_path() or LOCAL_TEMPLATE_CONFIG


def load_template_config() -> dict[str, Any]:
    cfg_path = template_config_path()
    if not cfg_path:
        return {"dbc_files": [], "export_signals": [], "export_templates": {}}
    try:
        raw = json.loads(cfg_path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError:
        return {"dbc_files": [], "export_signals": [], "export_templates": {}}
    return raw if isinstance(raw, dict) else {"dbc_files": [], "export_signals": [], "export_templates": {}}


def parse_can_id_value(value: Any) -> int:
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        raise ValueError("empty CAN ID")
    return int(text, 0)


def normalize_template_signal_items(items: list[dict[str, Any]] | list[Any]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for item in items:
        try:
            if isinstance(item, dict):
                can_id = parse_can_id_value(item["can_id"])
                signal_name = str(item["signal_name"]).strip()
            else:
                can_id = parse_can_id_value(item.can_id)
                signal_name = str(item.signal_name).strip()
        except (AttributeError, KeyError, TypeError, ValueError):
            continue
        if not signal_name:
            continue
        key = (can_id, signal_name)
        if key in seen:
            continue
        seen.add(key)
        normalized.append({"can_id": can_id, "signal_name": signal_name})
    return normalized


def signal_items_from_set(items: set[tuple[int, str]]) -> list[dict[str, Any]]:
    return [
        {"can_id": can_id, "signal_name": signal_name}
        for can_id, signal_name in sorted(items, key=lambda item: (item[0], item[1].lower()))
    ]


def signal_set_from_items(items: list[dict[str, Any]] | list[Any]) -> set[tuple[int, str]]:
    selected: set[tuple[int, str]] = set()
    for item in normalize_template_signal_items(items):
        selected.add((int(item["can_id"]), str(item["signal_name"])))
    return selected


def load_signal_templates() -> dict[str, set[tuple[int, str]]]:
    raw = load_template_config()
    templates = raw.get("export_templates", {})
    result: dict[str, set[tuple[int, str]]] = {}
    if isinstance(templates, dict):
        for name, items in templates.items():
            if isinstance(items, list):
                result[str(name)] = signal_set_from_items(items)
    export_signals = raw.get("export_signals", [])
    if isinstance(export_signals, list):
        result.setdefault("export_signals", signal_set_from_items(export_signals))
    return result


def load_signal_template(template_name: str) -> set[tuple[int, str]]:
    return load_signal_templates().get(template_name, set())


def load_signal_template_items(template_name: str) -> list[dict[str, Any]]:
    raw = load_template_config()
    templates = raw.get("export_templates", {})
    if isinstance(templates, dict) and template_name in templates and isinstance(templates[template_name], list):
        return normalize_template_signal_items(templates[template_name])
    export_signals = raw.get("export_signals", [])
    if template_name == "export_signals" and isinstance(export_signals, list):
        return normalize_template_signal_items(export_signals)
    return []


def validate_template_name(name: str) -> str:
    clean_name = str(name or "").strip()
    if not clean_name:
        raise ValueError("Template name is required.")
    if clean_name in {".", ".."} or "/" in clean_name or "\\" in clean_name:
        raise ValueError("Template name cannot contain path separators.")
    if any(ord(char) < 32 for char in clean_name):
        raise ValueError("Template name cannot contain control characters.")
    if len(clean_name) > 80:
        raise ValueError("Template name must be 80 characters or less.")
    return clean_name


def save_signal_template(
    name: str,
    items: list[dict[str, Any]] | list[Any],
    original_name: str | None = None,
) -> dict[str, Any]:
    clean_name = validate_template_name(name)
    clean_original = validate_template_name(original_name) if original_name else None
    normalized = normalize_template_signal_items(items)
    if not normalized:
        raise ValueError("Template must include at least one signal.")

    cfg = load_template_config()
    templates = cfg.get("export_templates", {})
    if not isinstance(templates, dict):
        templates = {}
    cfg["export_templates"] = templates

    if clean_original and clean_original != clean_name and clean_original in templates:
        del templates[clean_original]

    if clean_name == "export_signals":
        cfg["export_signals"] = normalized
        source = "export_signals"
    else:
        templates[clean_name] = normalized
        source = "export_templates"

    cfg_path = writable_template_config_path()
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    cfg_path.write_text(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "name": clean_name,
        "signal_count": len(normalized),
        "signals": normalized,
        "source": source,
        "config_path": str(cfg_path),
    }


def all_signals(id_to_msg: dict[int, Any]) -> set[tuple[int, str]]:
    selected: set[tuple[int, str]] = set()
    for can_id, msg in id_to_msg.items():
        for signal in msg.signals:
            selected.add((can_id, signal.name))
    return selected


def safe_suffix(value: str | None) -> str:
    if not value:
        return ""
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip()).strip("._-")
    return cleaned[:48] if cleaned else ""


def decode_selected_signals(
    input_csv: str | Path,
    output_csv: str | Path,
    dbc_paths: list[str | Path],
    selected_signals: set[tuple[int, str]],
    progress_callback: Callable[[int, int, int], None] | None = None,
) -> dict[str, Any]:
    entries = parse_can_csv(input_csv)
    id_to_msg = load_dbc_messages(dbc_paths)

    valid_keys = {
        (can_id, signal.name)
        for can_id, msg in id_to_msg.items()
        for signal in msg.signals
    }
    selected = selected_signals & valid_keys
    if not selected and selected_signals:
        raise ValueError("Selected template signals do not match the loaded DBC files.")
    if not selected:
        selected = all_signals(id_to_msg)

    selected_sorted = sorted(selected, key=lambda item: (item[0], item[1]))
    selected_ids = {can_id for can_id, _ in selected_sorted}
    selected_set = set(selected_sorted)
    latest_values: dict[tuple[int, str], Any] = {key: "" for key in selected_sorted}

    rows: list[list[Any]] = []
    decoded_messages = 0
    decode_errors = 0
    headers = ["TimeStamp"] + [f"0x{can_id:03X}_{signal}" for can_id, signal in selected_sorted]
    total_entries = len(entries)
    progress_interval = max(1, total_entries // 40) if total_entries else 1

    for row_index, entry in enumerate(entries, start=1):
        if entry.can_id in selected_ids:
            msg = id_to_msg.get(entry.can_id)
            if msg:
                try:
                    payload = normalize_payload_for_msg(entry.data, msg)
                    decoded = msg.decode(payload, decode_choices=False)
                except Exception:
                    decode_errors += 1
                else:
                    changed = False
                    for signal in msg.signals:
                        key = (entry.can_id, signal.name)
                        if key in selected_set and signal.name in decoded:
                            latest_values[key] = decoded[signal.name]
                            changed = True
                    if changed:
                        decoded_messages += 1
                        rows.append([f"{float(entry.timestamp):.6f}"] + [latest_values[key] for key in selected_sorted])
        if progress_callback and (row_index == total_entries or row_index % progress_interval == 0):
            progress_callback(row_index, total_entries, len(rows))

    output_path = Path(output_csv)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(rows)

    return {
        "input": str(input_csv),
        "output": str(output_path),
        "message_count": len(entries),
        "decoded_rows": len(rows),
        "decoded_messages": decoded_messages,
        "decode_errors": decode_errors,
        "signal_count": len(selected_sorted),
    }
