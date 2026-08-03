const localModeButton = document.getElementById('localModeButton');
const sshModeButton = document.getElementById('sshModeButton');
const sshPanel = document.getElementById('sshPanel');
const sshHostInput = document.getElementById('sshHostInput');
const sshHostHistory = document.getElementById('adminShellHostHistory');
const sshUserInput = document.getElementById('sshUserInput');
const sshPortInput = document.getElementById('sshPortInput');
const sshPasswordInput = document.getElementById('sshPasswordInput');
const targetLabel = document.getElementById('targetLabel');
const stateLabel = document.getElementById('stateLabel');
const terminalTitle = document.getElementById('terminalTitle');
const terminalPanel = document.querySelector('.terminal-panel');
const terminalOutput = document.getElementById('terminalOutput');
const xtermContainer = document.getElementById('xtermContainer');
const commandForm = document.getElementById('commandForm');
const commandInput = document.getElementById('commandInput');
const runButton = document.getElementById('runButton');
const cancelButton = document.getElementById('cancelButton');
const clearButton = document.getElementById('clearButton');
const connectTerminalButton = document.getElementById('connectTerminalButton');
const minicomButton = document.getElementById('minicomButton');
const stopTerminalButton = document.getElementById('stopTerminalButton');
const promptLabel = document.getElementById('promptLabel');

const SSH_HOST_HISTORY_KEY = 'adminshell.sshHostHistory';
const SSH_HOST_HISTORY_LIMIT = 8;
const COMMAND_HISTORY_LIMIT = 80;
const COMPLETION_ROW_WIDTH = 96;

let mode = 'local';
let shellSocket = null;
let isRunning = false;
let commandHistory = [];
let historyIndex = -1;
let historyDraft = '';
let localCwd = '';
let sshCwd = '';
let runningMode = 'local';
let completionRequestId = 0;
let pendingCompletion = null;
let interactiveSocket = null;
let interactiveTerminal = null;
let interactiveConnected = false;
let interactiveConnecting = false;
let interactiveActive = false;
let resizeTimer = null;

function appendText(text, className = '') {
    const span = document.createElement('span');
    if (className) span.className = className;
    span.textContent = text;
    terminalOutput.appendChild(span);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function appendLine(text, className = '') {
    appendText(`${text}\n`, className);
}

function setRunning(running, stateText = running ? 'Running' : 'Idle') {
    isRunning = running;
    if (!interactiveConnected && !interactiveConnecting) {
        stateLabel.textContent = stateText;
    }
    const locked = running || interactiveConnected || interactiveConnecting;
    runButton.disabled = locked;
    cancelButton.disabled = !running;
    localModeButton.disabled = locked;
    sshModeButton.disabled = locked;
    sshHostInput.disabled = locked;
    sshUserInput.disabled = locked;
    sshPortInput.disabled = locked;
    sshPasswordInput.disabled = locked;
    updateInteractiveButtons();
}

function setMode(nextMode) {
    if (isRunning) return;
    mode = nextMode;
    const isSsh = mode === 'ssh';
    localModeButton.classList.toggle('active', !isSsh);
    sshModeButton.classList.toggle('active', isSsh);
    sshPanel.classList.toggle('hidden', !isSsh);
    promptLabel.textContent = isSsh ? '#' : '$';
    updateTargetLabels();
}

function updateTargetLabels() {
    if (mode === 'ssh') {
        const host = sshHostInput.value.trim() || 'rpi';
        const user = sshUserInput.value.trim() || 'user';
        terminalTitle.textContent = `${user}@${host}`;
        targetLabel.textContent = sshCwd
            ? `${user}@${host}:${sshPortInput.value || '22'} - ${sshCwd}`
            : `${user}@${host}:${sshPortInput.value || '22'}`;
    } else {
        terminalTitle.textContent = 'local';
        targetLabel.textContent = localCwd || 'Local server';
    }
}

function loadSshHostHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(SSH_HOST_HISTORY_KEY) || '[]');
        return Array.isArray(parsed)
            ? parsed.map((value) => String(value || '').trim()).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function renderSshHostHistory(history = loadSshHostHistory()) {
    sshHostHistory.innerHTML = '';
    for (const host of history) {
        const option = document.createElement('option');
        option.value = host;
        sshHostHistory.appendChild(option);
    }
}

function saveSshHost(host) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) return;
    const history = [
        cleanHost,
        ...loadSshHostHistory().filter((value) => value !== cleanHost),
    ].slice(0, SSH_HOST_HISTORY_LIMIT);
    localStorage.setItem(SSH_HOST_HISTORY_KEY, JSON.stringify(history));
    renderSshHostHistory(history);
}

function restoreLastSshHost() {
    const history = loadSshHostHistory();
    renderSshHostHistory(history);
    if (!sshHostInput.value.trim() && history.length) {
        sshHostInput.value = history[0];
    }
}

function socketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws/adminshell`;
}

function terminalSocketUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${protocol}://${window.location.host}/ws/adminshell/terminal`;
}

function ensureSocket() {
    if (shellSocket && shellSocket.readyState === WebSocket.OPEN) {
        return Promise.resolve(shellSocket);
    }

    return new Promise((resolve, reject) => {
        const socket = new WebSocket(socketUrl());
        shellSocket = socket;

        socket.onopen = () => {
            appendLine('[connected]', 'line-muted');
            resolve(socket);
        };
        socket.onerror = () => {
            reject(new Error('WebSocket connection failed.'));
        };
        socket.onclose = () => {
            if (isRunning) {
                appendLine('[connection closed]', 'line-warning');
                setRunning(false);
            }
        };
        socket.onmessage = (event) => {
            handleSocketMessage(event.data);
        };
    });
}

function handleSocketMessage(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        appendLine(raw);
        return;
    }

    if (data.type === 'hello') {
        if (data.cwd) {
            localCwd = data.cwd;
            updateTargetLabels();
        }
        return;
    }
    if (data.type === 'status') {
        if (data.cwd) {
            if (data.mode === 'ssh') {
                sshCwd = data.cwd;
            } else {
                localCwd = data.cwd;
            }
            updateTargetLabels();
        }
        if (data.state === 'running') {
            setRunning(true, 'Running');
        } else if (data.state === 'canceling') {
            setRunning(true, 'Canceling');
        } else {
            setRunning(false);
        }
        return;
    }
    if (data.type === 'chunk') {
        appendText(data.data || '', data.stream === 'stderr' ? 'line-stderr' : '');
        return;
    }
    if (data.type === 'completion') {
        handleCompletion(data);
        return;
    }
    if (data.type === 'complete') {
        if (data.cwd) {
            if ((data.mode || runningMode) === 'ssh') {
                sshCwd = data.cwd;
            } else {
                localCwd = data.cwd;
            }
            updateTargetLabels();
        }
        const label = data.canceled
            ? 'canceled'
            : `exit ${data.exit_code ?? 'unknown'}`;
        const className = data.canceled || data.exit_code ? 'line-warning' : 'line-success';
        appendLine(`\n[${label}, ${data.duration}s]`, className);
        setRunning(false);
        commandInput.focus();
        return;
    }
    if (data.type === 'error') {
        appendLine(`[error] ${data.message || 'Unknown error'}`, 'line-stderr');
        setRunning(false);
    }
}

function buildPayload(command, payloadType = 'run') {
    const payload = {
        type: payloadType,
        mode,
        command,
    };
    if (mode === 'ssh') {
        payload.ssh = {
            host: sshHostInput.value.trim(),
            user: sshUserInput.value.trim(),
            password: sshPasswordInput.value,
            port: Number(sshPortInput.value || 22),
        };
    }
    return payload;
}

function validateSshTarget() {
    if (mode === 'ssh') {
        if (!sshHostInput.value.trim()) {
            appendLine('[error] RPI IP / host is required.', 'line-stderr');
            return false;
        }
        if (!sshUserInput.value.trim()) {
            appendLine('[error] SSH user is required.', 'line-stderr');
            return false;
        }
        if (!sshPasswordInput.value) {
            appendLine('[error] SSH password is required.', 'line-stderr');
            return false;
        }
    }
    return true;
}

function validateRun(command) {
    if (!command.trim()) {
        appendLine('[error] Command is required.', 'line-stderr');
        return false;
    }
    return validateSshTarget();
}

function updateInteractiveButtons() {
    const locked = isRunning || interactiveConnected || interactiveConnecting;
    connectTerminalButton.disabled = locked;
    minicomButton.disabled = !interactiveConnected;
    stopTerminalButton.disabled = !interactiveConnected && !interactiveConnecting;
    cancelButton.disabled = interactiveActive ? true : !isRunning;
    runButton.disabled = locked;
    localModeButton.disabled = locked;
    sshModeButton.disabled = locked;
    sshHostInput.disabled = locked;
    sshUserInput.disabled = locked;
    sshPortInput.disabled = locked;
    sshPasswordInput.disabled = locked;
}

function terminalSize() {
    const rect = xtermContainer.getBoundingClientRect();
    return {
        cols: Math.max(20, Math.min(240, Math.floor(Math.max(rect.width - 16, 160) / 8))),
        rows: Math.max(6, Math.min(80, Math.floor(Math.max(rect.height - 16, 120) / 17))),
    };
}

function setInteractiveActive(active) {
    interactiveActive = active;
    terminalPanel.classList.toggle('interactive', active);
    terminalOutput.classList.toggle('hidden', active);
    xtermContainer.classList.toggle('hidden', !active);
    commandForm.classList.toggle('hidden', active);
    if (active) {
        setMode('ssh');
        ensureInteractiveTerminal();
        window.setTimeout(() => {
            resizeInteractiveTerminal();
            interactiveTerminal.focus();
        }, 0);
    } else {
        commandInput.focus();
    }
    updateInteractiveButtons();
}

function writeTerminalLine(text) {
    if (interactiveTerminal) {
        interactiveTerminal.write(`${text}\r\n`);
    } else {
        appendLine(text, 'line-muted');
    }
}

function ensureInteractiveTerminal() {
    if (interactiveTerminal) {
        return interactiveTerminal;
    }
    if (!window.Terminal) {
        appendLine('[terminal] xterm.js is not loaded.', 'line-stderr');
        return null;
    }
    interactiveTerminal = new window.Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        rows: 24,
        cols: 80,
        theme: {
            background: '#09090b',
            foreground: '#e4e4e7',
            cursor: '#7dd3fc',
            selectionBackground: '#0ea5e955',
        },
    });
    interactiveTerminal.open(xtermContainer);
    interactiveTerminal.onData((data) => {
        if (interactiveSocket && interactiveSocket.readyState === WebSocket.OPEN && interactiveConnected) {
            interactiveSocket.send(JSON.stringify({ type: 'input', data }));
        }
    });
    return interactiveTerminal;
}

function resizeInteractiveTerminal() {
    if (!interactiveTerminal || !interactiveActive) return;
    const size = terminalSize();
    interactiveTerminal.resize(size.cols, size.rows);
    if (interactiveSocket && interactiveSocket.readyState === WebSocket.OPEN) {
        interactiveSocket.send(JSON.stringify({ type: 'resize', cols: size.cols, rows: size.rows }));
    }
}

function terminalPayloadBase() {
    const size = terminalSize();
    return {
        ssh: {
            host: sshHostInput.value.trim(),
            user: sshUserInput.value.trim(),
            password: sshPasswordInput.value,
            port: Number(sshPortInput.value || 22),
        },
        cols: size.cols,
        rows: size.rows,
    };
}

async function connectInteractiveTerminal() {
    if (interactiveConnected || interactiveConnecting) return;
    if (!window.Terminal) {
        appendLine('[terminal] xterm.js is not loaded.', 'line-stderr');
        return;
    }
    if (mode !== 'ssh') {
        setMode('ssh');
    }
    if (!validateSshTarget()) return;
    setInteractiveActive(true);
    const terminal = ensureInteractiveTerminal();
    if (!terminal) return;

    saveSshHost(sshHostInput.value);
    interactiveConnecting = true;
    stateLabel.textContent = 'Connecting';
    updateInteractiveButtons();
    terminal.clear();
    writeTerminalLine('[connecting]');

    const socket = new WebSocket(terminalSocketUrl());
    interactiveSocket = socket;

    socket.onopen = () => {
        const payload = terminalPayloadBase();
        socket.send(JSON.stringify({ type: 'start', ...payload }));
    };
    socket.onerror = () => {
        writeTerminalLine('[terminal error] WebSocket connection failed.');
        interactiveConnected = false;
        interactiveConnecting = false;
        stateLabel.textContent = 'Idle';
        updateInteractiveButtons();
    };
    socket.onclose = () => {
        interactiveConnected = false;
        interactiveConnecting = false;
        stateLabel.textContent = 'Idle';
        setInteractiveActive(false);
        updateInteractiveButtons();
    };
    socket.onmessage = (event) => {
        handleInteractiveMessage(event.data);
    };
}

function handleInteractiveMessage(raw) {
    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        if (interactiveTerminal) interactiveTerminal.write(raw);
        return;
    }
    if (data.type === 'output') {
        if (interactiveTerminal) interactiveTerminal.write(data.data || '');
        return;
    }
    if (data.type === 'status') {
        if (data.state === 'connecting') {
            stateLabel.textContent = 'Connecting';
        } else if (data.state === 'connected') {
            interactiveConnected = true;
            interactiveConnecting = false;
            stateLabel.textContent = 'Interactive';
            resizeInteractiveTerminal();
            if (interactiveTerminal) interactiveTerminal.focus();
        } else if (data.state === 'closed') {
            interactiveConnected = false;
            interactiveConnecting = false;
            stateLabel.textContent = 'Idle';
            writeTerminalLine('[closed]');
            setInteractiveActive(false);
        }
        updateInteractiveButtons();
        return;
    }
    if (data.type === 'error') {
        interactiveConnected = false;
        interactiveConnecting = false;
        stateLabel.textContent = 'Idle';
        writeTerminalLine(`[error] ${data.message || 'Unknown terminal error'}`);
        updateInteractiveButtons();
    }
}

function stopInteractiveTerminal() {
    if (interactiveSocket && interactiveSocket.readyState === WebSocket.OPEN) {
        interactiveSocket.send(JSON.stringify({ type: 'stop' }));
        interactiveSocket.close();
    }
    interactiveConnected = false;
    interactiveConnecting = false;
    stateLabel.textContent = 'Idle';
    setInteractiveActive(false);
    updateInteractiveButtons();
}

function sendInteractiveCommand(command) {
    if (!interactiveConnected || !interactiveSocket || interactiveSocket.readyState !== WebSocket.OPEN) return;
    interactiveSocket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
    if (interactiveTerminal) interactiveTerminal.focus();
}

function setCommandValue(value) {
    commandInput.value = value;
    commandInput.focus();
    commandInput.setSelectionRange(value.length, value.length);
}

async function runCommand(command) {
    if (!command.trim()) {
        commandInput.value = '';
        return;
    }
    if (!validateRun(command)) return;
    const socket = await ensureSocket();
    if (mode === 'ssh') {
        saveSshHost(sshHostInput.value);
    }

    const target = mode === 'ssh'
        ? `${sshUserInput.value.trim()}@${sshHostInput.value.trim()}`
        : 'local';
    appendLine(`${target} ${promptLabel.textContent} ${command}`, 'line-command');
    runningMode = mode;
    socket.send(JSON.stringify(buildPayload(command)));
    setRunning(true);
    commandHistory.unshift(command);
    commandHistory = commandHistory.slice(0, COMMAND_HISTORY_LIMIT);
    historyIndex = -1;
    historyDraft = '';
    commandInput.value = '';
}

function formatCompletionCandidates(candidates) {
    const cleanCandidates = candidates.map((candidate) => String(candidate || '')).filter(Boolean);
    if (!cleanCandidates.length) return '';
    const width = Math.min(
        36,
        Math.max(12, ...cleanCandidates.map((candidate) => candidate.length + 2)),
    );
    const rows = [];
    let row = '';
    for (const candidate of cleanCandidates) {
        const cell = candidate.padEnd(width, ' ');
        if (row && row.length + cell.length > COMPLETION_ROW_WIDTH) {
            rows.push(row.trimEnd());
            row = '';
        }
        row += cell;
    }
    if (row) rows.push(row.trimEnd());
    return rows.join('\n');
}

function handleCompletion(data) {
    if (!pendingCompletion || data.request_id !== pendingCompletion.id) {
        return;
    }

    const request = pendingCompletion;
    pendingCompletion = null;
    if (commandInput.value !== request.command) {
        return;
    }

    if (data.error) {
        appendLine(`[completion] ${data.error}`, 'line-warning');
        commandInput.focus();
        return;
    }

    const start = Math.max(0, Math.min(Number(data.replacement_start || 0), commandInput.value.length));
    const end = Math.max(start, Math.min(Number(data.replacement_end || start), commandInput.value.length));
    const replacement = String(data.replacement || '');
    const currentSegment = commandInput.value.slice(start, end);
    let changed = false;

    if (replacement && replacement !== currentSegment) {
        commandInput.setRangeText(replacement, start, end, 'end');
        changed = true;
    }

    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    if (!changed && candidates.length > 1) {
        appendText('\n');
        appendLine(formatCompletionCandidates(candidates), 'line-muted');
    }

    commandInput.focus();
}

async function requestCompletion() {
    if (isRunning || !validateSshTarget()) return;
    const socket = await ensureSocket();
    const requestId = ++completionRequestId;
    pendingCompletion = {
        id: requestId,
        command: commandInput.value,
    };
    const payload = buildPayload(commandInput.value, 'complete');
    payload.cursor = commandInput.selectionStart || 0;
    payload.request_id = requestId;
    socket.send(JSON.stringify(payload));
}

function recallHistory(direction) {
    if (!commandHistory.length) return;
    if (historyIndex === -1) {
        historyDraft = commandInput.value;
    }
    if (direction < 0) {
        historyIndex = Math.min(historyIndex + 1, commandHistory.length - 1);
    } else {
        historyIndex = Math.max(historyIndex - 1, -1);
    }
    setCommandValue(historyIndex >= 0 ? commandHistory[historyIndex] : historyDraft);
}

commandForm.addEventListener('submit', (event) => {
    event.preventDefault();
    runCommand(commandInput.value).catch((error) => {
        appendLine(`[error] ${error.message}`, 'line-stderr');
        setRunning(false);
    });
});

commandInput.addEventListener('keydown', (event) => {
    if (event.isComposing) {
        return;
    }
    if (event.key === 'Enter') {
        event.preventDefault();
        commandForm.requestSubmit();
        return;
    }
    if (event.key === 'Tab') {
        event.preventDefault();
        requestCompletion().catch((error) => {
            appendLine(`[completion] ${error.message}`, 'line-warning');
        });
        return;
    }
    if (event.key === 'ArrowUp') {
        event.preventDefault();
        recallHistory(-1);
        return;
    }
    if (event.key === 'ArrowDown') {
        event.preventDefault();
        recallHistory(1);
    }
});

cancelButton.addEventListener('click', () => {
    if (shellSocket && shellSocket.readyState === WebSocket.OPEN) {
        shellSocket.send(JSON.stringify({ type: 'cancel' }));
        setRunning(true, 'Canceling');
    }
});

clearButton.addEventListener('click', () => {
    if (interactiveActive && interactiveTerminal) {
        interactiveTerminal.clear();
    } else {
        terminalOutput.textContent = '';
    }
});

connectTerminalButton.addEventListener('click', () => {
    connectInteractiveTerminal().catch((error) => {
        writeTerminalLine(`[error] ${error.message}`);
        interactiveConnected = false;
        interactiveConnecting = false;
        updateInteractiveButtons();
    });
});

minicomButton.addEventListener('click', () => {
    sendInteractiveCommand('minicom');
});

stopTerminalButton.addEventListener('click', () => {
    stopInteractiveTerminal();
});

localModeButton.addEventListener('click', () => setMode('local'));
sshModeButton.addEventListener('click', () => setMode('ssh'));
sshHostInput.addEventListener('input', updateTargetLabels);
sshUserInput.addEventListener('input', updateTargetLabels);
sshPortInput.addEventListener('input', updateTargetLabels);
window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(resizeInteractiveTerminal, 120);
});

restoreLastSshHost();
setMode('local');
updateInteractiveButtons();
ensureSocket().catch((error) => {
    appendLine(`[error] ${error.message}`, 'line-stderr');
});
