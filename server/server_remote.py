"""
NTURT CAN Portable Monitor
===================================
This script runs on a Raspberry Pi.
It receives CAN data directly from vehicle and serves dashboard to users.
"""

import os
import can
import time
import hmac
import signal
import asyncio
import hashlib
import uvicorn
import ipaddress
from pathlib import Path
from typing import List, Dict
from packaging import version
from urllib.parse import parse_qs
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import FastAPI, WebSocket, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse

from adminshell_service import handle_adminshell_terminal_websocket, handle_adminshell_websocket
from can_decoder import CANDecoder

# Configuration
SERVER_DIR = Path(__file__).resolve().parent

def env_init(name, default):
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        print(f"Invalid {name}={value!r}; using {default}.")
        return default

WEB_HOST = os.environ.get("NTURT_WEB_HOST", "0.0.0.0")
WEB_PORT = env_init("NTURT_WEB_PORT", 8888)  # hosting port

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
        self.can_buses = {}
        self.can_last_message_time = {"can0": None, "can1": None}
        self.can_reader_tasks = []
        
        # Initialize CAN decoder
        self.decoder = CANDecoder()
        self.message_count = 0
        
        print("Portable CAN monitor initialized")

    def check_vehicle_connection(self):
        # check vehicle connection status
        if self.can_buses and self.last_data_time is not None:
            self.vehicle_connected = time.time() - self.last_data_time <= self.connection_timeout
        else:
            self.vehicle_connected = False
        return self.vehicle_connected

    def open_can_interfaces(self):
        for interface in ("can0", "can1"):
            try:
                can_kwargs = dict(channel=interface)
                if version.parse(can.__version__) >= version.parse('4.2.0'):
                    can_kwargs['interface'] = 'socketcan'
                else:
                    can_kwargs['bustype'] = 'socketcan' 
                self.can_buses[interface] = can.interface.Bus(**can_kwargs)
            except Exception as error:
                print(f"Could not open {interface}: {error}")
                continue

    async def read_can_interface(self, interface, bus):
        while True:
            try:
                message = await asyncio.to_thread(bus.recv, 0.5)
                if message is None:
                    continue
                self.decoder.decode_can_message(message)
                self.message_count += 1
                received_at = time.time()
                self.can_last_message_time[interface] = received_at
                self.last_data_time = received_at
                self.vehicle_connected = True
            except asyncio.CancelledError:
                raise
            except Exception as error:
                print(f"Error reading {interface}: {error}")
                await asyncio.sleep(0.1)

    def close_can_interfaces(self):
        for task in self.can_reader_tasks:
            task.cancel()
        for bus in self.can_buses.values():
            bus.shutdown()
        self.can_reader_tasks.clear()
        self.can_buses.clear()
    
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
    if not next_path.startswith("/adminshell"):
        return "/adminshell"
    return next_path

async def _read_urlencoded_form(request: Request) -> dict[str, str]:
    body = (await request.body()).decode("utf-8", errors="replace")
    parsed = parse_qs(body, keep_blank_values=True)
    return {key: values[0] if values else "" for key, values in parsed.items()}

def _is_adminshell_request_authenticated(request: Request) -> bool:
    return _verify_adminshell_session(request.cookies.get(ADMINSHELL_COOKIE_NAME))

def _is_adminshell_websocket_authenticated(websocket: WebSocket) -> bool:
    return _verify_adminshell_session(websocket.cookies.get(ADMINSHELL_COOKIE_NAME))

# FastAPI Routes
@app.get("/", response_class=HTMLResponse)
async def main_navigation(request: Request):
    return templates.TemplateResponse(request, "main_navigation.html", {"request": request})

@app.get("/racing", response_class=HTMLResponse)
async def racing_dashboard(request: Request):
    return templates.TemplateResponse(request, "racing_dashboard.html", {"request": request})

@app.get("/AMS", response_class=HTMLResponse)
async def ams_dashboard(request: Request):
    return templates.TemplateResponse(request, "battery_dashboard.html", {"request": request})

@app.get("/TQ", response_class=HTMLResponse)
async def tq_dashboard(request: Request):
    return templates.TemplateResponse(request, "torque_dashboard.html", {"request": request})

@app.get("/dashboard", response_class=HTMLResponse)
async def chart_dashboard(request: Request):
    return templates.TemplateResponse(request, "dynamic_dashboard.html", {"request": request})

@app.get("/IMU", response_class=HTMLResponse)
async def imu_dashboard(request: Request):
    return templates.TemplateResponse(request, "IMU_dashboard.html", {"request": request})

@app.get("/xsens", response_class=HTMLResponse)
async def xsens_dashboard(request: Request):
    return templates.TemplateResponse(request, "xsens_dashboard.html", {"request": request})

@app.get("/adminshell/login", response_class=HTMLResponse)
async def adminshell_login(request: Request):
    next_path = _safe_adminshell_next(request.query_params.get("next"))
    if _is_adminshell_request_authenticated(request):
        return RedirectResponse(next_path, status_code=303)
    return templates.TemplateResponse(
        request,
        "adminshell_login.html",
        {
            "request": request,
            "next_path": next_path,
            "tool_title": "Admin Shell",
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
        request,
        "adminshell_login.html",
        {
            "request": request,
            "next_path": next_path,
            "tool_title": "Admin Shell",
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
    return templates.TemplateResponse(request, "adminshell.html", {"request": request})

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
    now = time.time()
    can_interfaces = {}
    for interface in ("can0", "can1"):
        last_message_time = (
            can_server.can_last_message_time.get(interface)
            if can_server else None
        )
        age = now - last_message_time if last_message_time is not None else None
        available = bool(can_server and interface in can_server.can_buses)
        can_interfaces[interface] = {
            'available': available,
            'working': available and age is not None and age <= can_server.connection_timeout,
            'status': (
                'receiving' if available and age is not None and age <= can_server.connection_timeout
                else 'no_recent_data' if available
                else 'unavailable'
            ),
            'last_message_age_seconds': round(age, 2) if age is not None else None,
        }
    return {
        'web_clients': len(web_connections),
        'message_count': can_server.message_count if can_server else 0,
        'can_interfaces': can_interfaces,
    }

@app.post('/api/app/exit')
async def exit_app(request: Request):
    client_host = request.client.host if request.client else ""
    try:
        is_local_request = ipaddress.ip_address(client_host).is_loopback
        launcher_pid = int(os.environ.get("NTURT_LAUNCHER_PID", ""))
    except (ValueError, TypeError):
        is_local_request = False
        launcher_pid = 0

    if not is_local_request:
        return {"error": "App exit is only available from this device."}
    if launcher_pid <= 0 or os.getppid() != launcher_pid:
        return {"error": "The app was not started by its desktop launcher."}

    # Let the HTTP response reach the browser before the launcher closes it.
    asyncio.get_running_loop().call_later(0.5, os.kill, launcher_pid, signal.SIGTERM)
    return {"status": "closing"}
    
async def start_vehicle_data_server():
    # start vehicle data server
    global can_server
    can_server = RemoteCANServer()
    can_server.open_can_interfaces()
    can_server.can_reader_tasks = [
        asyncio.create_task(can_server.read_can_interface(interface, bus))
        for interface, bus in can_server.can_buses.items()
    ]
    
    # start broadcaster loop
    broadcaster_task = asyncio.create_task(can_server.broadcaster_loop())
    await broadcaster_task

@app.on_event("startup")
async def startup_event():
    # app startup
    asyncio.create_task(start_vehicle_data_server())

@app.on_event("shutdown")
async def shutdown_event():
    if can_server:
        can_server.close_can_interfaces()

if __name__ == '__main__':
    print("=" * 70)
    print("NTURT Portable CAN Monitor")
    print("=" * 70)
    print(f"Dashboard: http://{WEB_HOST}:{WEB_PORT}")
    print("Press Ctrl+C to stop the monitor.")
    print("=" * 70)
    
    uvicorn.run(app, host=WEB_HOST, port=WEB_PORT)
