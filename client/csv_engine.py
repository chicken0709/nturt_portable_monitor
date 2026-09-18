"""
CSV Engine for NTURT Remote Monitor
====================================
This module handles CSV file loading and replay functionality.
"""

import os
import csv
import json
import time
import glob
import base64
import fnmatch
import asyncio
from datetime import datetime

CSV_REPLAY_SPEED = 1.0
LOGS_DIR = '/home/nturt/Desktop/nturacing_remote_monitor/server/candecoder_workspace/undecoded'

class CSVEngine:
    def __init__ (self, client):
        self.client = client            # reference to the main client for sending messages and accessing state

        self.csv_file = None            # currently loaded CSV file path
        self.csv_paused = False         # pause flag for replay control
        self.csv_data = []              # store CSV data
        self.csv_index = 0              # current replay index
        self.csv_start_time = None      # replay start time (real time)
        self.csv_base_timestamp = None  # csv base timestamp
        self.csv_file_version = 0       # csv file version for detecting changes (incremented on each file selection)
        self.csv_jumped = False         # flag to indicate if a jump command was received or if we just switched to a new file (trigger time re-anchoring in the replay loop)
        self.csv_playback_speed = CSV_REPLAY_SPEED # playback speed multiplier 
        self.candecoder_transfer_tasks = {}

    async def csv_player(self):
        last_version_processed = -1
        
        while self.client.running:
            try:
                # state check
                # if not in CSV mode, or already finished the current version, wait
                if self.client.mode != 'csv' or self.csv_file_version == last_version_processed:
                    await asyncio.sleep(0.2) 
                    continue

                # load the new CSV file for replay
                print(f"🎬 Starting CSV replay from: {self.csv_file}")
                print(f"🕐 CSV時間範圍: {self.csv_data[0]['timestamp']} - {self.csv_data[-1]['timestamp']}")
                print(f"⏱️ 預計回放時長: {(self.csv_data[-1]['timestamp'] - self.csv_data[0]['timestamp']) / 1000000:.2f} 秒")
                
                if not self.csv_data:
                    print("⚠️ Failed to load CSV or file empty. Switching to idle.")
                    self.client.mode = 'idle'
                    last_version_processed = self.csv_file_version # mark as "attempted"
                    continue

                last_version_processed = self.csv_file_version
                total_rows = len(self.csv_data)
    
                # this loop "cancels" itself if mode changes or a new file version is requested
                while (self.client.running and 
                    self.client.mode == 'csv' and 
                    self.csv_file_version == last_version_processed):
                    
                    # jump handling
                    if self.csv_jumped:
                        self.csv_base_timestamp = None  # force timing re-anchor
                        self.csv_jumped = False         # clear the flag

                    if self.csv_index >= total_rows:
                        await self.notify_completion(total_rows)
                        self.client.mode = 'idle'
                        await self.client.websocket.send(json.dumps({
                            'type': 'mode_changed',
                            'mode': 'idle',
                            'filename': self.csv_file
                        }))
                        break

                    if self.csv_paused:
                        self.csv_base_timestamp = None 
                        await asyncio.sleep(0.1)
                        continue

                    # timing control
                    now = time.time()
                    
                    if self.csv_base_timestamp is None:
                        # new file selected, paused, or jumped
                        self.csv_base_timestamp = now
                        # re-anchor to the CSV timestamp of the new current index
                        self._current_csv_anchor_ts = self.csv_data[min(self.csv_index, total_rows-1)]['timestamp']

                    # calculate how much "CSV time" has passed since the anchor
                    elapsed_seconds = (now - self.csv_base_timestamp) * self.csv_playback_speed
                    target_ts = self._current_csv_anchor_ts + (elapsed_seconds * 1000000)

                    # enqueue messages until we catch up to the target timestamp, or if a mode change/jump happens
                    while (self.csv_index < total_rows and 
                        self.csv_data[self.csv_index]['timestamp'] <= target_ts):
                        
                        if self.client.mode != 'csv' or self.csv_jumped:
                            break 
                            
                        msg = self.csv_data[self.csv_index]
                        await self.client.enqueue_can_message(msg['can_id'], msg['data'], msg['bus_id'])
                        
                        self.csv_index += 1

                    # periodic progress update to UI (every ~0.5s)
                    if time.time() - getattr(self, 'last_progress_update', 0) > 0.5:
                        self.last_progress_update = time.time()
                        await self.send_progress_update(self.csv_data, self.csv_index)

                    await asyncio.sleep(0.001) # yield to other tasks (heartbeat, command_receiver)

                print(f"ℹ️ CSV Player exited replay loop (Mode: {self.client.mode})")

            except Exception as e:
                print(f"❌ Error in CSV Player: {e}")
                await asyncio.sleep(1)

        print("🛑 CSV Player shut down.")

    def parse_csv_file(self, file_path):
        # parse the CSV file and return a list of messages with timestamp, can_id, bus_id, and data bytes
        csv_data = []
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    try:
                        ts = int(row.get('Time Stamp', row.get('timestamp', 0)))
                        can_id = int(row.get('ID', row.get('id', row.get('can_id', '0'))), 16)
                        bus_id = int(row.get('bus', row.get('bus_id', 0)))

                        data_bytes = []
                        for i in range(1, 13):
                            val = row.get(f'D{i}')
                            # check if the value exists and isn't just whitespace
                            if val and val.strip():
                                try:
                                    # convert hex string to integer
                                    data_bytes.append(int(val.strip(), 16))
                                except ValueError:
                                    print(f"⚠️ Warning: Invalid hex data '{val}' at D{i}. Stopping payload here.")
                                    break
                            else:
                                # end of data payload (empty cell or missing key)
                                break
                        
                        csv_data.append({
                            'timestamp': ts,
                            'can_id': can_id,
                            'bus_id': bus_id,
                            'data': bytes(data_bytes)
                        })
                    except (ValueError, TypeError):
                        continue # skip malformed rows
            return csv_data
        except Exception as e:
            print(f"❌ File Load Error: {e}")
            return None
    
    async def send_progress_update(self, csv_data, index):
        # sends replay progress to the server
        total = len(csv_data)
        # clamp index to valid range
        safe_idx = min(index, total - 1)
        
        current_ts = csv_data[safe_idx]['timestamp']
        start_ts = csv_data[0]['timestamp']
        total_ts = csv_data[-1]['timestamp']

        await self.client.websocket.send(json.dumps({
            'type': 'csv_progress',
            'percentage': round((index / total) * 100, 2),
            'current_time': round((current_ts - start_ts) / 1000000, 2),
            'total_time': round((total_ts - start_ts) / 1000000, 2),
            'current_index': index,
            'total_count': total
        }))

    async def notify_completion(self, total_rows):
        # inform the server that CSV replay has completed
        if self.client.websocket:
            await self.client.websocket.send(json.dumps({
                'type': 'csv_status',
                'status': 'completed',
                'message': f'CSV replay completed: {total_rows} rows.',
                'row_count': total_rows
            }))
        print("⏸️ CSV replay finished. Waiting for next command...")

    def scan_csv_files(self):
        # scan csv files in LOGS_DIR and return a list of file info
        try:
            csv_files = []
            pattern = os.path.join(LOGS_DIR, '*.csv')
            
            for filepath in glob.glob(pattern):
                filename = os.path.basename(filepath)
                file_stat = os.stat(filepath)
                file_time = datetime.fromtimestamp(file_stat.st_mtime)
                file_size = file_stat.st_size
                
                csv_files.append({
                    'filename': filename,
                    'path': filepath,
                    'modified': file_time.isoformat(),
                    'size': file_size,
                    'size_mb': round(file_size / 1024 / 1024, 2)
                })
            
            # sort by modified time (newest first)
            csv_files.sort(key=lambda x: x['modified'], reverse=True)
            return csv_files
        except Exception as e:
            print(f"Error scanning CSV files: {e}")
            return []

    def get_logs_root(self):
        # resolve LOGS_DIR from this file so systemd cwd differences do not matter
        return os.path.abspath(os.path.join(os.path.dirname(__file__), LOGS_DIR))

    def scan_candecoder_log_files(self, pattern='*.csv', recursive=True):
        root = self.get_logs_root()
        csv_files = []
        if not os.path.isdir(root):
            return csv_files

        if recursive:
            iterator = (
                os.path.join(dirpath, filename)
                for dirpath, _, filenames in os.walk(root)
                for filename in filenames
            )
        else:
            iterator = glob.glob(os.path.join(root, pattern))

        for filepath in iterator:
            filename = os.path.basename(filepath)
            if not fnmatch.fnmatch(filename, pattern):
                continue
            if filename.lower().endswith('_decoded.csv'):
                continue
            try:
                file_stat = os.stat(filepath)
                relative_path = os.path.relpath(filepath, root).replace(os.sep, '/')
                csv_files.append({
                    'name': filename,
                    'filename': filename,
                    'relative_path': relative_path,
                    'path': filepath,
                    'modified': datetime.fromtimestamp(file_stat.st_mtime).isoformat(),
                    'mtime': file_stat.st_mtime,
                    'size': file_stat.st_size,
                    'size_mb': round(file_stat.st_size / 1024 / 1024, 2)
                })
            except OSError:
                continue

        csv_files.sort(key=lambda row: row['relative_path'].lower())
        return csv_files

    async def scan_candecoder_log_files_async(self, pattern='*.csv', recursive=True):
        root = self.get_logs_root()
        csv_files = []
        if not os.path.isdir(root):
            return csv_files

        if recursive:
            paths = (
                os.path.join(dirpath, filename)
                for dirpath, _, filenames in os.walk(root)
                for filename in filenames
            )
        else:
            paths = glob.glob(os.path.join(root, pattern))

        for index, filepath in enumerate(paths, start=1):
            if index % 100 == 0:
                await asyncio.sleep(0)
            filename = os.path.basename(filepath)
            if not fnmatch.fnmatch(filename, pattern):
                continue
            if filename.lower().endswith('_decoded.csv'):
                continue
            try:
                file_stat = os.stat(filepath)
                relative_path = os.path.relpath(filepath, root).replace(os.sep, '/')
                csv_files.append({
                    'name': filename,
                    'filename': filename,
                    'relative_path': relative_path,
                    'path': filepath,
                    'modified': datetime.fromtimestamp(file_stat.st_mtime).isoformat(),
                    'mtime': file_stat.st_mtime,
                    'size': file_stat.st_size,
                    'size_mb': round(file_stat.st_size / 1024 / 1024, 2)
                })
            except OSError:
                continue

        csv_files.sort(key=lambda row: row['relative_path'].lower())
        return csv_files

    def resolve_candecoder_log_path(self, relative_path):
        root = self.get_logs_root()
        safe_parts = [
            part
            for part in str(relative_path or '').replace('\\', '/').split('/')
            if part and part not in ('.', '..')
        ]
        candidate = os.path.abspath(os.path.join(root, *safe_parts))
        root_with_sep = root if root.endswith(os.sep) else root + os.sep
        if candidate != root and not candidate.startswith(root_with_sep):
            raise ValueError('Requested path is outside LOGS_DIR.')
        if not os.path.isfile(candidate):
            raise FileNotFoundError(relative_path)
        return candidate
        
    async def handle_request_csv_list(self, data):
        # server requests CSV file list
        print("[DEBUG] Received request for CSV file list")
        csv_files = self.scan_csv_files()
        print(f"[DEBUG] Found {len(csv_files)} CSV files")
        
        response = {
            'type': 'csv_list',
            'files': csv_files,
            'count': len(csv_files)
        }

        print(f"[DEBUG] Sending response with {len(csv_files)} files")
        await self.client.websocket.send(json.dumps(response))
        print(f"[DEBUG] Response sent successfully")

    async def handle_candecoder_request_log_list(self, data):
        request_id = data.get('request_id')
        if not request_id:
            return
        existing = self.candecoder_transfer_tasks.pop(request_id, None)
        if existing:
            existing.cancel()
        task = asyncio.create_task(self._send_candecoder_log_list(data))
        self.candecoder_transfer_tasks[request_id] = task
        task.add_done_callback(lambda done_task, rid=request_id: self.candecoder_transfer_tasks.pop(rid, None))

    async def _send_candecoder_log_list(self, data):
        request_id = data.get('request_id')
        pattern = data.get('pattern') or '*.csv'
        recursive = bool(data.get('recursive', True))
        print(f"[CANDECODER] Listing logs: pattern={pattern}, recursive={recursive}")
        try:
            files = await self.scan_candecoder_log_files_async(pattern=pattern, recursive=recursive)
            await self.client.websocket.send(json.dumps({
                'type': 'candecoder_log_list',
                'request_id': request_id,
                'files': files,
                'count': len(files)
            }))
        except asyncio.CancelledError:
            print(f"[CANDECODER] Log listing canceled: {request_id}")
            if self.client.websocket:
                try:
                    await self.client.websocket.send(json.dumps({
                        'type': 'candecoder_file_error',
                        'request_id': request_id,
                        'message': 'Listing canceled.'
                    }))
                except Exception:
                    pass
            raise
        except Exception as e:
            await self.client.websocket.send(json.dumps({
                'type': 'candecoder_file_error',
                'request_id': request_id,
                'message': str(e)
            }))

    async def handle_candecoder_get_file(self, data):
        request_id = data.get('request_id')
        if not request_id:
            return
        existing = self.candecoder_transfer_tasks.pop(request_id, None)
        if existing:
            existing.cancel()
        task = asyncio.create_task(self._send_candecoder_file(data))
        self.candecoder_transfer_tasks[request_id] = task
        task.add_done_callback(lambda done_task, rid=request_id: self.candecoder_transfer_tasks.pop(rid, None))

    async def handle_candecoder_cancel_request(self, data):
        request_id = data.get('request_id')
        task = self.candecoder_transfer_tasks.get(request_id)
        if task:
            print(f"[CANDECODER] Canceling file transfer: {request_id}")
            task.cancel()

    def cancel_candecoder_transfers(self):
        for task in list(self.candecoder_transfer_tasks.values()):
            task.cancel()
        self.candecoder_transfer_tasks.clear()

    async def _send_candecoder_file(self, data):
        request_id = data.get('request_id')
        relative_path = data.get('relative_path')
        chunk_size = int(data.get('chunk_size') or (256 * 1024))
        chunk_size = max(16 * 1024, min(chunk_size, 512 * 1024))
        print(f"[CANDECODER] Sending file: {relative_path}")
        try:
            filepath = self.resolve_candecoder_log_path(relative_path)
            total_size = os.path.getsize(filepath)
            offset = 0
            with open(filepath, 'rb') as handle:
                while True:
                    chunk = handle.read(chunk_size)
                    if not chunk:
                        break
                    await self.client.websocket.send(json.dumps({
                        'type': 'candecoder_file_chunk',
                        'request_id': request_id,
                        'relative_path': relative_path,
                        'offset': offset,
                        'size': total_size,
                        'data': base64.b64encode(chunk).decode('ascii')
                    }))
                    offset += len(chunk)
                    await asyncio.sleep(0)

            await self.client.websocket.send(json.dumps({
                'type': 'candecoder_file_complete',
                'request_id': request_id,
                'relative_path': relative_path,
                'size': total_size
            }))
            print(f"[CANDECODER] Sent {relative_path} ({total_size} bytes)")
        except asyncio.CancelledError:
            print(f"[CANDECODER] File transfer canceled: {relative_path}")
            if self.client.websocket:
                try:
                    await self.client.websocket.send(json.dumps({
                        'type': 'candecoder_file_error',
                        'request_id': request_id,
                        'relative_path': relative_path,
                        'message': 'Transfer canceled.'
                    }))
                except Exception:
                    pass
            raise
        except Exception as e:
            print(f"[CANDECODER] File transfer failed: {e}")
            await self.client.websocket.send(json.dumps({
                'type': 'candecoder_file_error',
                'request_id': request_id,
                'relative_path': relative_path,
                'message': str(e)
            }))

    async def handle_select_csv(self, data):
        # server selects a CSV file for replay
        filename = data.get('filename')
        print(f"Received CSV selection: {filename}")
        path = os.path.join(LOGS_DIR, filename)

        if os.path.exists(path):
            self.client.mode = 'idle'

            # clear queue
            self.client.cleanup()
            await asyncio.sleep(0.05) 
            
            self.csv_file = path
            self.csv_index = 0
            self.csv_paused = False
            self.csv_jumped = True
            self.csv_base_timestamp = None
            self.csv_file_version += 1 # increment version to signal a new file has been loaded
            self.csv_data = self.parse_csv_file(self.csv_file)
            
            self.client.mode = 'csv'
            print(f"Switched to CSV mode: {self.csv_file}")
        
            await self.client.websocket.send(json.dumps({
                'type': 'mode_changed',
                'mode': 'csv',
                'file': filename
            }))
        else:
            print(f"CSV file not found: {self.csv_file}")
            await self.client.websocket.send(json.dumps({
                'type': 'error',
                'message': f'File not found: {filename}'
            }))

    async def handle_csv_pause(self, data):
        # pause/resume csv replay 
        self.csv_paused = not self.csv_paused
        print(f"CSV replay {'paused' if self.csv_paused else 'resumed'}")

    async def handle_csv_jump_percentage(self, data):
        # jump to a specific percentage in the CSV file
        percentage = data.get('percentage', 0)
        if self.csv_data:
            percentage = max(0, min(100, percentage))
            target_index = int(len(self.csv_data) * percentage / 100)
            self.csv_index = target_index
            self.csv_jumped = True
            print(f"Jumped to {percentage:.2f}% ({self.csv_index}/{len(self.csv_data)})")
            
            await self.client.websocket.send(json.dumps({
                'type': 'csv_status',
                'status': 'jumped',
                'percentage': percentage,
                'index': self.csv_index
            }))

    async def handle_csv_jump_time(self, data):
        # jump forward/backward by a specific number of seconds
        seconds = data.get('seconds', 0)
        if self.csv_data: 
            # use current index timestamp or last available timestamp
            idx = min(self.csv_index, len(self.csv_data) - 1)
            current_timestamp = self.csv_data[idx]['timestamp']
            target_timestamp = current_timestamp + (seconds * 1000000)
            
            # clamp the target_index within valid bounds
            target_index = self.csv_index
            if seconds > 0:
                for i in range(self.csv_index, len(self.csv_data)):
                    target_index = i
                    if self.csv_data[i]['timestamp'] >= target_timestamp:
                        break
            else:
                for i in range(self.csv_index, -1, -1):
                    target_index = i
                    if self.csv_data[i]['timestamp'] <= target_timestamp:
                        break

            # clamp csv_index to valid range
            self.csv_index = min(max(0, target_index), len(self.csv_data) - 1)
            self.csv_jumped = True
            
            # calculate progress
            progress = (self.csv_index / len(self.csv_data)) * 100
            print(f"Jumped to {progress:.2f}% ({self.csv_index}/{len(self.csv_data)})")
            
            # send update to server
            await self.client.websocket.send(json.dumps({
                'type': 'csv_status',
                'status': 'jumped',
                'progress': round(progress, 2),
                'index': self.csv_index,
                'seconds': seconds
            }))

            await self.send_progress_update(self.csv_data, self.csv_index)

    async def handle_csv_set_speed(self, data):
        # set replay speed
        speed = data.get('speed', 1.0)
        if speed > 0:
            self.csv_playback_speed = speed
            self.csv_jumped = True # trigger timing re-anchor with new speed
            print(f"replay speed set to {speed}x")
            
            await self.client.websocket.send(json.dumps({
                'type': 'csv_status',
                'status': 'speed_changed',
                'speed': speed
            }))

    async def handle_csv_restart(self, data):
        # restart current CSV replay
        if self.client.mode == 'idle' and self.csv_file:
            # wrap the path/filename in a dict so handle_select_csv can read it
            filename = os.path.basename(self.csv_file)
            await self.handle_select_csv({'filename': filename})
