let ws = null;
let selectedFile = null;
let isDragging = false;
let currentSpeed = 1;
let currentMode = 'realtime';
let isPaused = false;

function log(message, type = 'info') {
    const logDiv = document.getElementById('log');
    const timestamp = new Date().toLocaleTimeString('en-GB', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type} border-b border-zinc-800 py-1 px-3 last:border-0`;
    entry.innerHTML = `<span class="timestamp">[${timestamp}]</span> ${message}`;
    logDiv.appendChild(entry);
    logDiv.scrollTop = logDiv.scrollHeight;
    
    while (logDiv.children.length > 150) {
        logDiv.removeChild(logDiv.firstChild);
    }
}

function clearLog() {
    document.getElementById('log').innerHTML = '';
    log('Log cleared', 'info');
}

function updateWSStatus(connected) {
    const status = document.getElementById('wsStatus');
    status.textContent = connected ? 'Connected' : 'Disconnected';
    status.className = 'text-xs ' + (connected ? 'text-green-500' : 'text-red-500');
}

function updateModeStatus(mode, filename = null) {
    currentMode = mode;
    const modeStatus = document.getElementById('modeStatus');
    const timelineSection = document.getElementById('timelineSection');
    const pauseBtn = document.getElementById('pauseBtn');
    const speedBtns = document.querySelectorAll('.speed-btn');
    const jumpBtns = document.querySelectorAll('.jump-btn');
    const timelineSlider = document.getElementById('timelineSlider');
    
    if (mode === 'csv') {
        modeStatus.textContent = 'CSV Replay';
        pauseBtn.disabled = false;
        isPaused = false;
        pauseBtn.textContent = 'Pause';
        speedBtns.forEach(btn => { btn.disabled = false; });
        jumpBtns.forEach(btn => { btn.disabled = false; });
        timelineSlider.classList.remove('opacity-50', 'pointer-events-none');  
    } else if (mode === 'realtime') {
        modeStatus.textContent = 'Realtime';
        pauseBtn.disabled = true;
        isPaused = false;
        pauseBtn.textContent = 'Pause';
        speedBtns.forEach(btn => { btn.disabled = true; });
        jumpBtns.forEach(btn => { btn.disabled = true; });
        timelineSlider.classList.add('opacity-50', 'pointer-events-none');
    } else if (mode === 'idle') {
        modeStatus.textContent = 'Idle';
        pauseBtn.disabled = false;
        isPaused = false;
        pauseBtn.textContent = 'Restart';
        speedBtns.forEach(btn => { btn.disabled = true; });
        jumpBtns.forEach(btn => { btn.disabled = true; });
        timelineSlider.classList.add('opacity-50', 'pointer-events-none');
    }
}

function connectWebSocket() {
    log('Connecting to WebSocket...', 'debug');
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.hostname}:${window.location.port}/ws`;
    
    try {
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            log('WebSocket connected!', 'success');
            updateWSStatus(true);
            updateModeStatus('realtime');
        };
        
        ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            handleServerMessage(data);
        };
        
        ws.onerror = (error) => {
            log('WebSocket error', 'error');
        };
        
        ws.onclose = () => {
            log('WebSocket closed, reconnecting in 3s...', 'warning');
            updateWSStatus(false);
            setTimeout(connectWebSocket, 3000);
        };
    } catch (error) {
        log(`Failed to create WebSocket: ${error}`, 'error');
    }
}

function handleServerMessage(data) {
    if (data.type === 'csv_files') {
        log(`Received ${data.files.length} CSV files`, 'success');
        displayCSVFiles(data.files);
    } else if (data.type === 'mode_changed') {
        log(`Mode changed: ${data.mode}`, 'info');
        updateModeStatus(data.mode, data.file);
    } else if (data.type === 'csv_status') {
        const msg = data.status || data.message;
        log(`CSV: ${msg}`, 'info');
    } else if (data.type === 'csv_progress') {
        updateProgress(data);
    } else if (data.type === 'error') {
        log(`Error: ${data.message}`, 'error');
    }
}

async function testConnection() {
    log('Testing connection...', 'debug');
    try {
        const response = await fetch('/api/status');
        const data = await response.json();
        log(`Server OK! Vehicles: ${data.vehicle_clients}, Web: ${data.web_clients}`, 'success');
        
        const vehicleCountSpan = document.getElementById('vehicle-client-count');
        const webCountSpan = document.getElementById('web-client-count');
        vehicleCountSpan.textContent = `${data.vehicle_clients}`;
        webCountSpan.textContent = `${data.web_clients}`;
    } catch (error) {
        log(`Connection test failed: ${error.message}`, 'error');
    }
}

async function requestCSVList() {
    log('→ Requesting CSV list...', 'debug');
    try {
        const response = await fetch('/api/csv/request_list', { method: 'POST' });
        const result = await response.json();
        
        if (result.error) {
            log(`Request failed: ${result.error}`, 'error');
        } else {
            log(`Request sent, waiting for response...`, 'success');
        }
    } catch (error) {
        log(`Request failed: ${error.message}`, 'error');
    }
}

function displayCSVFiles(files) {
    const fileList = document.getElementById('fileList');
    
    if (files.length === 0) {
        fileList.innerHTML = '<p style="color: #718096; text-align: center; padding: 20px;">No CSV files found on vehicle.</p>';
        return;
    }
    
    fileList.innerHTML = files.map(file => {
            const formattedDate = new Date(file.modified).toLocaleString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Create a safe ID
            const safeId = `file-${file.filename.replace(/[^a-zA-Z0-9]/g, '_')}`;

            return `
                <div class="file-item group flex items-center justify-between p-3 mb-2 bg-zinc-900/50 border border-zinc-800 rounded-lg cursor-pointer hover:bg-zinc-800 hover:border-zinc-700 transition-all" 
                    onclick="selectFile('${file.filename}')" 
                    id="${safeId}">
                    
                    <div class="flex items-center gap-3 overflow-hidden">
                        <svg xmlns="http://www.w3.org/2000/svg" 
                            class="w-5 h-5 text-zinc-500 group-hover:text-sky-400 transition-colors duration-200 flex-shrink-0" 
                            viewBox="0 0 24 24" 
                            fill="none" 
                            stroke="currentColor" 
                            stroke-width="2" 
                            stroke-linecap="round" 
                            stroke-linejoin="round">
                            <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                            <polyline points="14 2 14 8 20 8"/>
                            <line x1="16" y1="13" x2="8" y2="13"/>
                            <line x1="16" y1="17" x2="8" y2="17"/>
                            <line x1="10" y1="9" x2="8" y2="9"/>
                        </svg>
                        <div class="flex flex-col min-w-0">
                            <span class="text-[14px] text-zinc-300 truncate">${file.filename}</span>
                            <span class="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">${file.size_mb} MB</span>
                        </div>
                    </div>

                    <div class="text-right flex-shrink-0">
                        <div class="text-[11px] text-zinc-500 font-mono">${formattedDate}</div>
                    </div>
                </div>
            `;
        }).join('');
    
    log(`Displayed ${files.length} files`, 'success');
}

async function selectFile(filename) {
    log(`Selecting: ${filename}`, 'debug');
    selectedFile = filename;
    
    document.querySelectorAll('.file-item').forEach(item => {
        item.classList.remove('selected');
    });
    const fileElement = document.getElementById(`file-${filename.replace(/[^a-zA-Z0-9]/g, '_')}`);
    if (fileElement) {
        fileElement.classList.add('selected');
    }
    
    document.getElementById('selectedFileName').textContent = filename;
    
    try {
        const response = await fetch('/api/csv/select', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: filename })
        });
        const result = await response.json();
        
        if (result.error) {
            log(`Failed to select: ${result.error}`, 'error');
        } else {
            log(`Switching to CSV mode...`, 'success');
        }
    } catch (error) {
        log(`Selection failed: ${error.message}`, 'error');
    }
}

async function switchToRealtime() {
    log('→ Switching to realtime...', 'debug');
    try {
        const response = await fetch('/api/csv/switch_realtime', { method: 'POST' });
        const result = await response.json();
        
        if (result.error) {
            log(`Failed: ${result.error}`, 'error');
        } else {
            log('Switched to realtime', 'success');
            updateModeStatus('realtime');
            selectedFile = null;
            document.getElementById('selectedFileName').textContent = 'None';
            document.querySelectorAll('.file-item').forEach(item => {
                item.classList.remove('selected');
            });
            updateProgress({
                percentage: 0,
                current_time: 0,
                total_time: 0
            });
        }
    } catch (error) {
        log(`Switch failed: ${error.message}`, 'error');
    }
}

async function togglePause() {
    if (currentMode === 'idle') {
        isPaused = false;
         try {
            await fetch('/api/csv/restart', { method: 'POST' });
            log(`Restarted replay`, 'success');
        } catch (error) {
            log(`Restart failed: ${error.message}`, 'error');
        }
        return
    }

    if (currentMode !== 'csv') {
        log('Pause only works in CSV mode', 'warning');
        return;
    }
    
    isPaused = !isPaused;
    const pauseBtn = document.getElementById('pauseBtn');
    pauseBtn.textContent = isPaused ? 'Resume' : 'Pause';
    
    log(`${isPaused ? 'Pausing' : 'Resuming'}...`, 'debug');
    
    try {
        await fetch('/api/csv/pause', { method: 'POST' });
        log(`${isPaused ? 'Paused' : 'Resumed'}`, 'success');
    } catch (error) {
        log(`Toggle failed: ${error.message}`, 'error');
    }
}

async function setSpeed(speed) {
    currentSpeed = speed;
    
    document.querySelectorAll('.speed-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    event.target.classList.add('active');
    
    log(`Setting speed to ${speed}x...`, 'debug');
    
    try {
        const response = await fetch('/api/csv/set_speed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ speed: speed })
        });
        const result = await response.json();
        
        if (result.error) {
            log(`Speed set failed: ${result.error}`, 'error');
        } else {
            log(`Speed set to ${speed}x`, 'success');
        }
    } catch (error) {
        log(`Speed set failed: ${error.message}`, 'error');
    }
}

async function jumpTime(seconds) {
    log(`Jumping ${seconds > 0 ? '+' : ''}${seconds}s...`, 'debug');
    
    try {
        const response = await fetch('/api/csv/jump_time', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ seconds: seconds })
        });
        const result = await response.json();
        
        if (result.error) {
            log(`Jump failed: ${result.error}`, 'error');
        } else {
            log(`Jumped ${seconds}s`, 'success');
        }
    } catch (error) {
        log(`Jump failed: ${error.message}`, 'error');
    }
}

async function jumpToPercentage(percentage) {
    log(`Jumping to ${percentage.toFixed(1)}%...`, 'debug');
    
    try {
        const response = await fetch('/api/csv/jump_percentage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ percentage: percentage })
        });
        const result = await response.json();
        
        if (result.error) {
            log(`Jump failed: ${result.error}`, 'error');
        } else {
            log(`Jumped to ${percentage.toFixed(1)}%`, 'success');
        }
    } catch (error) {
        log(`Jump failed: ${error.message}`, 'error');
    }
}

function updateProgress(data) {
    if (isDragging) return;
    
    const percentage = data.percentage || 0;
    const currentTime = data.current_time || 0;
    const totalTime = data.total_time || 0;
    
    const thumb = document.getElementById('timelineThumb');
    const progress = document.getElementById('timelineProgress');
    thumb.style.left = percentage + '%';
    progress.style.width = percentage + '%';
    
    document.getElementById('currentTime').textContent = formatTime(currentTime);
    document.getElementById('totalTime').textContent = formatTime(totalTime);
    document.getElementById('progressPercent').textContent = percentage.toFixed(1) + '%';
}

function formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function initTimelineControl() {
    const slider = document.getElementById('timelineSlider');
    const thumb = document.getElementById('timelineThumb');
    const progress = document.getElementById('timelineProgress');

    function updatePosition(clientX) {
        const rect = slider.getBoundingClientRect();
        let percentage = ((clientX - rect.left) / rect.width) * 100;
        percentage = Math.max(0, Math.min(100, percentage));
        
        thumb.style.left = percentage + '%';
        progress.style.width = percentage + '%';
        
        return percentage;
    }

    function handleDragStart(e) {
        isDragging = true;
        e.preventDefault();
    }

    function handleDrag(e) {
        if (!isDragging) return;
        e.preventDefault();
        
        const clientX = e.type.includes('touch') ? e.touches[0].clientX : e.clientX;
        updatePosition(clientX);
    }

    function handleDragEnd(e) {
        if (!isDragging) return;
        isDragging = false;
        
        const clientX = e.type.includes('touch') ? e.changedTouches[0].clientX : e.clientX;
        const percentage = updatePosition(clientX);
        
        jumpToPercentage(percentage);
    }

    slider.addEventListener('click', (e) => {
        if (e.target === thumb) return;
        const percentage = updatePosition(e.clientX);
        jumpToPercentage(percentage);
    });

    thumb.addEventListener('mousedown', handleDragStart);
    thumb.addEventListener('touchstart', handleDragStart);
    
    document.addEventListener('mousemove', handleDrag);
    document.addEventListener('touchmove', handleDrag);
    
    document.addEventListener('mouseup', handleDragEnd);
    document.addEventListener('touchend', handleDragEnd);
}

// Initialize
log('=== CSV Replay Control Started ===', 'info');
connectWebSocket();
initTimelineControl();

setTimeout(() => {
    testConnection();
}, 1000);