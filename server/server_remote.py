"""
NTURT CAN Data Server - Remote Side
===================================
This script runs on the remote Raspberry Pi.
It receives CAN data from vehicle clients and serves web dashboard to users.
"""

import time
import json
import hmac
import os
import asyncio
import hashlib
from pathlib import Path
from urllib.parse import parse_qs
import uvicorn
import websockets
from typing import List, Dict
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import FastAPI, WebSocket, Request
from fastapi.middleware.cors import CORSMiddleware

from adminshell_service import handle_adminshell_terminal_websocket, handle_adminshell_websocket
from can_decoder import CANDecoder
from candecoder_service import CANDecoderSyncService

# Configuration
SERVER_DIR = Path(__file__).resolve().parent


def env_int(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        print(f"Invalid {name}={value!r}; using {default}.")
        return default


WEB_HOST = os.environ.get("NTURT_WEB_HOST", "0.0.0.0")
DATA_HOST = os.environ.get("NTURT_DATA_HOST", "0.0.0.0")
WEB_PORT = env_int("NTURT_WEB_PORT", 8888)  # server hosting port
DATA_PORT = env_int("NTURT_DATA_PORT", 8889)  # port for client connections
ADMINSHELL_USERNAME = os.environ.get("ADMINSHELL_USERNAME", "nturt")
ADMINSHELL_PASSWORD = os.environ.get("ADMINSHELL_PASSWORD", "nturt03734301")
ADMINSHELL_COOKIE_NAME = "adminshell_session"
ADMINSHELL_SESSION_MAX_AGE = 12 * 60 * 60
ADMINSHELL_SESSION_SECRET = os.environ.get(
    "ADMINSHELL_SESSION_SECRET",
    "nturacing-adminshell-session-secret",
)

# FastAPI app setup
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

templates = Jinja2Templates(directory=str(SERVER_DIR / "templates"))
app.mount("/static", StaticFiles(directory=str(SERVER_DIR / "static")), name="static")

# WebSocket connections for web clients
web_connections: List[WebSocket] = []

# Vehicle client connections
vehicle_clients: Dict[str, dict] = {}

class RemoteCANServer:
    def __init__(self):
        # Connection status
        self.vehicle_connected = False
        self.last_data_time = None
        self.connection_timeout = 3.0  # treat as disconnected if no data for 3 seconds
        
        # Initialize CAN decoder
        self.decoder = CANDecoder()

        self.mode_switch_completed = True
        self.message_count = 0
        self.message_handlers = {
            'can_message': 'handle_single_can_message',
            'can_batch': 'handle_batched_can_message',
            'heartbeat': 'handle_heartbeat',
            'csv_list': 'handle_csv_list',
            'mode_changed': 'handle_mode_changed',
            'csv_status': 'handle_csv_status',
            'csv_progress': 'handle_csv_progress',
            'error': 'handle_error'
        }
        self.candecoder_sync = CANDecoderSyncService(
            self.send_candecoder_command,
            self.broadcast_to_web_clients,
            lambda: bool(vehicle_clients),
        )
        
        print("Remote CAN Server initialized")

    def check_vehicle_connection(self):
        # check vehicle connection status
        if not vehicle_clients:
            self.vehicle_connected = False
            return False
        
        # check if there is recent data update
        if self.last_data_time is not None:
            time_since_update = time.time() - self.last_data_time
            if time_since_update > self.connection_timeout:
                self.vehicle_connected = False
                return False
            else:
                self.vehicle_connected = True
                return True
        else:
            # client connected but no data received yet, consider it connected for now
            self.vehicle_connected = bool(vehicle_clients)
            return self.vehicle_connected

    async def handle_vehicle_client(self, websocket):
        # handle connection from vehicle
        client_id = f"{websocket.remote_address[0]}:{websocket.remote_address[1]}"
        print(f"Vehicle client connected: {client_id}")
        
        vehicle_clients[client_id] = {
            'websocket': websocket,
            'connected_at': time.time(),
            'last_heartbeat': time.time(),
            'message_count': 0
        }

        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    msg_type = data.get('type')

                    if await self.candecoder_sync.handle_vehicle_message(data, client_id):
                        continue

                    handler_name = self.message_handlers.get(msg_type)
                    if not handler_name:
                        print(f"Unknown message type from {client_id}: {msg_type}")
                        continue
                    handler = getattr(self, handler_name)
                    
                    await handler(data, client_id)
                except json.JSONDecodeError:
                    print(f"Invalid JSON from {client_id}")
                except Exception as e:
                    print(f"Error processing message from {client_id}: {e}")
                    
        except websockets.exceptions.ConnectionClosed:
            print(f"Vehicle client disconnected: {client_id}")
        finally:
            if client_id in vehicle_clients:
                del vehicle_clients[client_id]

    async def handle_single_can_message(self, data, client_id):
        # ignore CAN messages if mode switch not completed
        if not self.mode_switch_completed: return
    
        # handle single CAN message (backward compatibility)
        can_id = data['can_id']
        can_data = bytes(data['data'])
        
        # create mock CAN message
        mock_message = self.create_mock_can_message(can_id, can_data)
        self.decoder.decode_can_message(mock_message)
        self.message_count += 1
        vehicle_clients[client_id]['message_count'] += 1
        
        # update last data reception time
        self.last_data_time = time.time()
        self.vehicle_connected = True

    async def handle_batched_can_message(self, data, client_id):
        # handle batched CAN messages
        messages = data.get('messages', [])
        for msg in messages:
            await self.handle_single_can_message(msg, client_id)
                        
    async def handle_heartbeat(self, data, client_id):
        # update heartbeat 
        vehicle_clients[client_id]['last_heartbeat'] = time.time()
        vehicle_clients[client_id]['mode'] = data.get('mode', 'realtime')
        vehicle_clients[client_id]['csv_file'] = data.get('csv_file')
        
        # print dropped messages info
        if 'dropped_messages' in data and data['dropped_messages'] > 0:
            print(f"Client {client_id}: Dropped {data['dropped_messages']} messages, Queue: {data.get('queue_size', 0)}")

    async def handle_csv_list(self, data, client_id):
        # receive CSV file list
        files_count = data.get('count', 0)
        print(f"[DEBUG] Received CSV file list: {files_count} files")
        print(f"[DEBUG] Files: {[f.get('filename', 'unknown') for f in data.get('files', [])[:5]]}")
        vehicle_clients[client_id]['csv_files'] = data.get('files', [])
        
        # broadcast to all web clients
        print(f"[DEBUG] Broadcasting to {len(web_connections)} web clients")
        await self.broadcast_to_web_clients({
            'type': 'csv_files',
            'files': data.get('files', []),
            'client_id': client_id
        })
        print("[DEBUG] Broadcast completed")

    async def handle_mode_changed(self, data, client_id):
        # mode change notification
        print(f"Mode changed to: {data.get('mode')} for {client_id}")
        vehicle_clients[client_id]['mode'] = data.get('mode')

        self.mode_switch_completed = True
        
        await self.broadcast_to_web_clients({
            'type': 'mode_changed',
            'mode': data.get('mode'),
            'file': data.get('file'),
            'client_id': client_id
        })

    async def handle_csv_status(self, data, client_id):
        # CSV playback status update
        print(f"CSV status: {data.get('status')}")
        await self.broadcast_to_web_clients({
            'type': 'csv_status',
            'status': data.get('status'),
            'message': data.get('message')
        })

    async def handle_csv_progress(self, data, client_id):
        # CSV playback progress update
        await self.broadcast_to_web_clients({
            'type': 'csv_progress',
            'percentage': data.get('percentage', 0),
            'current_time': data.get('current_time', 0),
            'total_time': data.get('total_time', 0),
            'current_index': data.get('current_index', 0),
            'total_count': data.get('total_count', 0)
        })

    async def handle_error(self, data, client_id):
        # error messages from client
        print(f"Error from client: {data.get('message')}")
        await self.broadcast_to_web_clients({
            'type': 'error',
            'message': data.get('message')
        })
    
    def create_mock_can_message(self, can_id, data):
        # create mock CAN message object for decoder
        return MockCanMessage(can_id, data)
    
    def get_broadcast_data(self):
        # prepare data for broadcasting to web clients
        return self.decoder.get_broadcast_data(vehicle_clients, self.message_count, self.vehicle_connected, self.last_data_time)

    async def broadcast_to_web_clients(self, data):
        # broadcast data to all web clients
        if not web_connections: return
        
        # send data and remove disconnected clients
        disconnected = []
        for websocket in web_connections:
            try:
                await websocket.send_json(data)
            except:
                disconnected.append(websocket)

        for ws in disconnected:
            if ws in web_connections:
                web_connections.remove(ws)
    
    async def broadcaster_loop(self):
        # broadcast data to web clients periodically
        while True:
            if web_connections:
                self.check_vehicle_connection()
                await self.broadcast_to_web_clients(self.get_broadcast_data())
            await asyncio.sleep(0.05)  # 20 FPS

    async def send_to_vehicle_client(self, message_dict, status_dict):
        # send message to vehicle client
        if not vehicle_clients:
            print("❌ No vehicle client connected")
            return {'error': 'No vehicle client connected'}
        
        client_id = list(vehicle_clients.keys())[0]
        websocket = vehicle_clients[client_id]['websocket']
        
        try:
            message = json.dumps(message_dict)
            print(f"📤 Sending to client: {message}")
            await websocket.send(message)
            return status_dict
        except Exception as e:
            print(f"❌ Send error: {e}")
            return {'error': str(e)}

    async def send_candecoder_command(self, message_dict):
        return await self.send_to_vehicle_client(message_dict, {'status': 'sent'})

class MockCanMessage:
    def __init__(self, arbitration_id, data):
        self.arbitration_id = arbitration_id
        self.data = data

# Global server instance
can_server = None


def _adminshell_signature(username: str, issued_at: int) -> str:
    message = f"{username}:{issued_at}".encode("utf-8")
    secret = ADMINSHELL_SESSION_SECRET.encode("utf-8")
    return hmac.new(secret, message, hashlib.sha256).hexdigest()


def _make_adminshell_session(username: str) -> str:
    issued_at = int(time.time())
    signature = _adminshell_signature(username, issued_at)
    return f"{username}:{issued_at}:{signature}"


def _verify_adminshell_session(token: str | None) -> bool:
    if not token:
        return False
    try:
        username, issued_text, signature = token.split(":", 2)
        issued_at = int(issued_text)
    except (ValueError, TypeError):
        return False
    if username != ADMINSHELL_USERNAME:
        return False
    if time.time() - issued_at > ADMINSHELL_SESSION_MAX_AGE:
        return False
    expected = _adminshell_signature(username, issued_at)
    return hmac.compare_digest(signature, expected)


def _adminshell_redirect(request: Request) -> RedirectResponse:
    next_path = request.url.path
    return RedirectResponse(f"/adminshell/login?next={next_path}", status_code=303)


def _safe_adminshell_next(raw_next: str | None) -> str:
    next_path = str(raw_next or "/adminshell")
    if not next_path.startswith("/") or next_path.startswith("//"):
        return "/adminshell"
    if not (next_path.startswith("/adminshell") or next_path.startswith("/candecoder")):
        return "/adminshell"
    return next_path


def _protected_tool_title(next_path: str) -> str:
    if next_path.startswith("/candecoder"):
        return "CAN Log Decoder"
    return "Admin Shell"


async def _read_urlencoded_form(request: Request) -> dict[str, str]:
    body = (await request.body()).decode("utf-8", errors="replace")
    parsed = parse_qs(body, keep_blank_values=True)
    return {key: values[0] if values else "" for key, values in parsed.items()}


def _is_adminshell_request_authenticated(request: Request) -> bool:
    return _verify_adminshell_session(request.cookies.get(ADMINSHELL_COOKIE_NAME))


def _is_adminshell_websocket_authenticated(websocket: WebSocket) -> bool:
    return _verify_adminshell_session(websocket.cookies.get(ADMINSHELL_COOKIE_NAME))


def _protected_api_denied(request: Request) -> JSONResponse | None:
    if _is_adminshell_request_authenticated(request):
        return None
    return JSONResponse({"error": "Unauthorized. Please login first."}, status_code=401)


# FastAPI Routes
@app.get("/", response_class=HTMLResponse)
async def main_navigation(request: Request):
    return templates.TemplateResponse("main_navigation.html", {"request": request})

@app.get("/racing", response_class=HTMLResponse)
async def racing_dashboard(request: Request):
    return templates.TemplateResponse("racing_dashboard.html", {"request": request})

@app.get("/AMS", response_class=HTMLResponse)
async def ams_dashboard(request: Request):
    return templates.TemplateResponse("battery_dashboard.html", {"request": request})

@app.get("/TQ", response_class=HTMLResponse)
async def tq_dashboard(request: Request):
    return templates.TemplateResponse("torque_dashboard.html", {"request": request})

@app.get("/dashboard", response_class=HTMLResponse)
async def chart_dashboard(request: Request):
    return templates.TemplateResponse("dynamic_dashboard.html", {"request": request})

@app.get("/IMU", response_class=HTMLResponse)
async def imu_dashboard(request: Request):
    return templates.TemplateResponse("IMU_dashboard.html", {"request": request})

@app.get("/xsens", response_class=HTMLResponse)
async def xsens_dashboard(request: Request):
    return templates.TemplateResponse("xsens_dashboard.html", {"request": request})

@app.get("/csv_control", response_class=HTMLResponse)
async def csv_control(request: Request):
    return templates.TemplateResponse("csv_control.html", {"request": request})

@app.get("/candecoder", response_class=HTMLResponse)
async def candecoder(request: Request):
    if not _is_adminshell_request_authenticated(request):
        return _adminshell_redirect(request)
    return templates.TemplateResponse("candecoder.html", {"request": request})

@app.get("/adminshell/login", response_class=HTMLResponse)
async def adminshell_login(request: Request):
    next_path = _safe_adminshell_next(request.query_params.get("next"))
    if _is_adminshell_request_authenticated(request):
        return RedirectResponse(next_path, status_code=303)
    return templates.TemplateResponse(
        "adminshell_login.html",
        {
            "request": request,
            "next_path": next_path,
            "tool_title": _protected_tool_title(next_path),
            "error": "",
        },
    )

@app.post("/adminshell/login", response_class=HTMLResponse)
async def adminshell_login_submit(request: Request):
    form = await _read_urlencoded_form(request)
    username = form.get("username", "")
    password = form.get("password", "")
    next_path = _safe_adminshell_next(form.get("next"))
    if hmac.compare_digest(username, ADMINSHELL_USERNAME) and hmac.compare_digest(password, ADMINSHELL_PASSWORD):
        response = RedirectResponse(next_path, status_code=303)
        response.set_cookie(
            ADMINSHELL_COOKIE_NAME,
            _make_adminshell_session(username),
            max_age=ADMINSHELL_SESSION_MAX_AGE,
            httponly=True,
            samesite="lax",
            secure=request.url.scheme == "https",
        )
        return response
    return templates.TemplateResponse(
        "adminshell_login.html",
        {
            "request": request,
            "next_path": next_path,
            "tool_title": _protected_tool_title(next_path),
            "error": "Invalid username or password.",
        },
        status_code=401,
    )

@app.get("/adminshell/logout")
async def adminshell_logout():
    response = RedirectResponse("/adminshell/login", status_code=303)
    response.delete_cookie(ADMINSHELL_COOKIE_NAME)
    return response

@app.get("/adminshell", response_class=HTMLResponse)
async def adminshell(request: Request):
    if not _is_adminshell_request_authenticated(request):
        return _adminshell_redirect(request)
    return templates.TemplateResponse("adminshell.html", {"request": request})

@app.get('/api/data')
async def get_data():
    if can_server:
        return can_server.get_broadcast_data()
    else:
        return {'error': 'CAN server not initialized'}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # handle WebSocket connection from web client
    await websocket.accept()
    web_connections.append(websocket)
    print('Web client connected')
    
    # Push data once when connected
    if can_server:
        can_server.check_vehicle_connection()
        await can_server.broadcast_to_web_clients(can_server.get_broadcast_data())
    
    try:
        while True:
            await websocket.receive_text()
    except Exception as e:
        print('Web client disconnected', e)
    finally:
        if websocket in web_connections:
            web_connections.remove(websocket)

@app.websocket("/ws/adminshell")
async def adminshell_websocket(websocket: WebSocket):
    if not _is_adminshell_websocket_authenticated(websocket):
        await websocket.close(code=1008)
        return
    await handle_adminshell_websocket(websocket)

@app.websocket("/ws/adminshell/terminal")
async def adminshell_terminal_websocket(websocket: WebSocket):
    if not _is_adminshell_websocket_authenticated(websocket):
        await websocket.close(code=1008)
        return
    await handle_adminshell_terminal_websocket(websocket)

@app.get('/api/status')
async def get_status():
    # get server status
    return {
        'vehicle_clients': len(vehicle_clients),
        'web_clients': len(web_connections),
        'message_count': can_server.message_count if can_server else 0,
        'clients_info': [
            {
                'id': client_id,
                'connected_at': info['connected_at'],
                'last_heartbeat': info['last_heartbeat'],
                'message_count': info['message_count'],
                'mode': info.get('mode', 'realtime'),
                'csv_file': info.get('csv_file')
            }
            for client_id, info in vehicle_clients.items()
        ]
    }

@app.get('/api/candecoder/templates')
async def get_candecoder_templates(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'templates': []}
    return {'templates': can_server.candecoder_sync.template_rows()}

@app.get('/api/candecoder/dbcs')
async def get_candecoder_dbcs(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'dbcs': []}
    return {'dbcs': can_server.candecoder_sync.dbc_rows()}

@app.post('/api/candecoder/signals')
async def get_candecoder_signals(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'signals': []}
    try:
        data = await request.json()
    except Exception:
        data = {}
    try:
        return {'signals': can_server.candecoder_sync.signal_rows(data.get('dbc_names') or [])}
    except Exception as e:
        return {'error': str(e), 'signals': []}

@app.post('/api/candecoder/templates/save')
async def save_candecoder_template(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    try:
        return can_server.candecoder_sync.save_template(
            name=data.get('name') or '',
            original_name=data.get('original_name') or None,
            signals=data.get('signals') or [],
        )
    except Exception as e:
        return {'error': str(e)}

@app.get('/api/candecoder/status')
async def get_candecoder_status(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    status = can_server.candecoder_sync.get_status()
    status['vehicle_clients'] = len(vehicle_clients)
    return status

@app.get('/api/candecoder/workspace')
async def get_candecoder_workspace(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        return can_server.candecoder_sync.workspace_tree()
    except Exception as e:
        return {'error': str(e)}

@app.post('/api/candecoder/workspace/move')
async def move_candecoder_workspace_item(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    try:
        return can_server.candecoder_sync.move_workspace_item(
            data.get('source_relative_path'),
            data.get('destination_relative_path'),
        )
    except Exception as e:
        return {'error': str(e)}

@app.post('/api/candecoder/workspace/copy')
async def copy_candecoder_workspace_item(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    try:
        return can_server.candecoder_sync.copy_workspace_item(
            data.get('source_relative_path'),
            data.get('destination_relative_path'),
        )
    except Exception as e:
        return {'error': str(e)}

@app.post('/api/candecoder/workspace/delete')
async def delete_candecoder_workspace_item(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    try:
        return can_server.candecoder_sync.delete_workspace_item(data.get('relative_path'))
    except Exception as e:
        return {'error': str(e)}

@app.post('/api/candecoder/list')
async def list_candecoder_files(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await can_server.candecoder_sync.start_list(
        pattern=data.get('pattern') or '*.csv',
        source_mode='ssh',
        rpi_host=data.get('rpi_host'),
        rpi_user=data.get('rpi_user') or 'pi',
        rpi_password=data.get('rpi_password'),
        remote_log_dir=data.get('remote_log_dir'),
    )

@app.post('/api/candecoder/pull')
async def pull_candecoder_files(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await can_server.candecoder_sync.start_pull(
        pattern=data.get('pattern') or '*.csv',
        source_mode='ssh',
        rpi_host=data.get('rpi_host'),
        rpi_user=data.get('rpi_user') or 'pi',
        rpi_password=data.get('rpi_password'),
        remote_log_dir=data.get('remote_log_dir'),
        selected_relative_paths=data.get('selected_relative_paths') or [],
    )

@app.post('/api/candecoder/decode')
async def decode_candecoder_files(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await can_server.candecoder_sync.start_decode(
        template_name=data.get('template_name'),
        dbc_names=data.get('dbc_names') or [],
        selected_relative_paths=data.get('selected_relative_paths') or [],
        output_folder_name=data.get('output_folder_name'),
    )

@app.post('/api/candecoder/cancel')
async def cancel_candecoder_task(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    return await can_server.candecoder_sync.cancel()

@app.post('/api/candecoder/start')
async def start_candecoder(request: Request):
    denied = _protected_api_denied(request)
    if denied:
        return denied
    if not can_server:
        return {'error': 'CAN server not initialized'}
    try:
        data = await request.json()
    except Exception:
        data = {}
    return await can_server.candecoder_sync.start(
        template_name=data.get('template_name'),
        pattern=data.get('pattern') or '*.csv',
        source_mode='ssh',
        rpi_host=data.get('rpi_host'),
        rpi_user=data.get('rpi_user') or 'pi',
        rpi_password=data.get('rpi_password'),
        remote_log_dir=data.get('remote_log_dir'),
        dbc_names=data.get('dbc_names') or [],
        selected_relative_paths=data.get('selected_relative_paths') or [],
        output_folder_name=data.get('output_folder_name'),
    )

@app.post('/api/csv/request_list')
async def request_csv_list():
    # request CSV file list from vehicle client
    if not vehicle_clients:
        print("❌ No vehicle client connected")
        return {'error': 'No vehicle client connected'}
    if not can_server: return {'error': 'CAN server not initialized'}
    
    print(f"📥 API received request CSV list. Vehicle clients: {len(vehicle_clients)}")
    
    client_id = list(vehicle_clients.keys())[0]
    message_dict = {'type': 'request_csv_list'}
    status_dict = {'status': 'requested', 'client_id': client_id}
    
    return await can_server.send_to_vehicle_client(message_dict, status_dict)

@app.post('/api/csv/select')
async def select_csv_file(request: Request):
    # select CSV file for playback
    if not can_server: return {'error': 'CAN server not initialized'}
    can_server.message_count = 0
    can_server.mode_switch_completed = False

    # clear data buffer
    print("🧹 Clearing data buffer before playing csv file...")
    can_server.decoder.reset_data_store()
    print("✅ Data buffer cleared")

    data = await request.json()
    filename = data.get('filename')
    
    if not filename: return {'error': 'No filename provided'}
    
    print(f"📁 API received select CSV: {filename}")
    
    message_dict = {'type': 'select_csv', 'filename': filename}
    status_dict = {'status': 'selected', 'filename': filename}

    return await can_server.send_to_vehicle_client(message_dict, status_dict)

@app.post('/api/csv/switch_realtime')
async def switch_to_realtime():
    # switch back to realtime mode and clear data buffer
    if not can_server: return {'error': 'CAN server not initialized'}
    can_server.message_count = 0
    can_server.mode_switch_completed = False
    
    # clear data buffer
    print("🧹 Clearing data buffer before switching to realtime mode...")
    can_server.decoder.reset_data_store()
    print("✅ Data buffer cleared")
    
    message_dict = {'type': 'switch_realtime'}
    status_dict = {'status': 'switched', 'buffer_cleared': True}

    return await can_server.send_to_vehicle_client(message_dict, status_dict)

@app.post('/api/csv/pause')
async def toggle_csv_pause():
    # toggle CSV playback pause/resume
    if not can_server: return {'error': 'CAN server not initialized'}

    print("⏸️ API received toggle pause")
    
    message_dict = {'type': 'csv_pause'}
    status_dict = {'status': 'toggled'}

    return await can_server.send_to_vehicle_client(message_dict, status_dict)

@app.post('/api/csv/restart')
async def restart_csv_playback():
    # restart CSV playback
    if not can_server: return {'error': 'CAN server not initialized'}
    can_server.message_count = 0

    print("🔄 API received restart")
    
    message_dict = {'type': 'csv_restart'}
    status_dict = {'status': 'restarted'}

    return await can_server.send_to_vehicle_client(message_dict, status_dict)

@app.post('/api/csv/jump_percentage')
async def jump_to_percentage(request: Request):
    # jump to specified percentage position in CSV playback
    if not can_server: return {'error': 'CAN server not initialized'}
    
    data = await request.json()
    percentage = data.get('percentage', 0)
    
    print(f"📍 API received jump_percentage: {percentage}%")

    message_dict = {'type': 'csv_jump_percentage', 'percentage': percentage}
    status_dict = {'status': 'jumped', 'percentage': percentage}
    
    return await can_server.send_to_vehicle_client(message_dict, status_dict)

@app.post('/api/csv/jump_time')
async def jump_time(request: Request):
    # jump forward or backward by specified seconds in CSV playback
    if not can_server: return {'error': 'CAN server not initialized'}

    data = await request.json()
    seconds = data.get('seconds', 0)
    
    print(f"⏱️  API received jump_time: {seconds}s")

    message_dict = {'type': 'csv_jump_time', 'seconds': seconds}
    status_dict = {'status': 'jumped', 'seconds': seconds}

    return await can_server.send_to_vehicle_client(message_dict, status_dict)
    
@app.post('/api/csv/set_speed')
async def set_playback_speed(request: Request):
    # set playback speed
    if not can_server: return {'error': 'CAN server not initialized'}
    
    data = await request.json()
    speed = data.get('speed', 1.0)
    
    print(f"⚡ API received set_speed: {speed}x")

    message_dict = {'type': 'csv_set_speed', 'speed': speed}
    status_dict = {'status': 'speed_set', 'speed': speed}

    return await can_server.send_to_vehicle_client(message_dict, status_dict)
    
async def start_vehicle_data_server():
    # start vehicle data server
    global can_server
    can_server = RemoteCANServer()
    
    # start broadcaster loop
    broadcaster_task = asyncio.create_task(can_server.broadcaster_loop())
    
    # start WebSocket server to receive vehicle data
    try:
        async with websockets.serve(can_server.handle_vehicle_client, DATA_HOST, DATA_PORT):
            print(f"Vehicle data server listening on {DATA_HOST}:{DATA_PORT}")
            await broadcaster_task
    except OSError as e:
        print(f"Vehicle data server failed to bind {DATA_HOST}:{DATA_PORT}: {e}")
        print("Set NTURT_DATA_PORT to another port if this port is blocked or reserved.")
        await broadcaster_task

@app.on_event("startup")
async def startup_event():
    # app startup
    asyncio.create_task(start_vehicle_data_server())

if __name__ == '__main__':
    print("=" * 70)
    print("NTURT CAN Monitor Server - Remote Side")
    print("=" * 70)
    print(f"Web Dashboard: http://{WEB_HOST}:{WEB_PORT}")
    print(f"Vehicle Data Server: {DATA_HOST}:{DATA_PORT}")
    print("Press Ctrl+C to stop the server.")
    print("=" * 70)
    
    uvicorn.run(app, host=WEB_HOST, port=WEB_PORT)
