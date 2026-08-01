const templateSelect = document.getElementById('templateSelect');
const templateManager = document.getElementById('templateManager');
const templateManagerHint = document.getElementById('templateManagerHint');
const templateEditorSelect = document.getElementById('templateEditorSelect');
const templateNameInput = document.getElementById('templateNameInput');
const signalSearchInput = document.getElementById('signalSearchInput');
const newTemplateButton = document.getElementById('newTemplateButton');
const selectVisibleSignalsButton = document.getElementById('selectVisibleSignalsButton');
const clearTemplateSignalsButton = document.getElementById('clearTemplateSignalsButton');
const signalPicker = document.getElementById('signalPicker');
const templateSignalsInput = document.getElementById('templateSignalsInput');
const templateSignalCount = document.getElementById('templateSignalCount');
const saveTemplateButton = document.getElementById('saveTemplateButton');
const templateEditorMessage = document.getElementById('templateEditorMessage');
const patternInput = document.getElementById('patternInput');
const sourceMode = document.getElementById('sourceMode');
const sshFields = document.getElementById('sshFields');
const rpiHostInput = document.getElementById('rpiHostInput');
const rpiUserInput = document.getElementById('rpiUserInput');
const rpiPasswordInput = document.getElementById('rpiPasswordInput');
const remoteLogDirInput = document.getElementById('remoteLogDirInput');
const dbcList = document.getElementById('dbcList');
const startButton = document.getElementById('startButton');
const progressFill = document.getElementById('progressFill');
const percentLabel = document.getElementById('percentLabel');
const phaseLabel = document.getElementById('phaseLabel');
const currentFile = document.getElementById('currentFile');
const remoteCount = document.getElementById('remoteCount');
const downloadedCount = document.getElementById('downloadedCount');
const decodedCount = document.getElementById('decodedCount');
const transferLabel = document.getElementById('transferLabel');
const eventLog = document.getElementById('eventLog');
const errorBox = document.getElementById('errorBox');
const taskState = document.getElementById('taskState');
const vehicleCount = document.getElementById('vehicleCount');
const undecodedFolder = document.getElementById('undecodedFolder');
const decodedFolder = document.getElementById('decodedFolder');

const SIGNAL_SEPARATOR = '\u001f';

let ws = null;
let pollTimer = null;
let dbcRows = [];
let templateRows = [];
let signalRows = [];
let editorSelectedSignals = new Set();
let templateTextDirty = false;

function setError(message) {
    if (!message) {
        errorBox.classList.add('hidden');
        errorBox.textContent = '';
        return;
    }
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
}

function setTemplateMessage(message, type = '') {
    if (!message) {
        templateEditorMessage.className = 'template-editor-message hidden';
        templateEditorMessage.textContent = '';
        return;
    }
    templateEditorMessage.className = `template-editor-message ${type}`.trim();
    templateEditorMessage.textContent = message;
}

function normalizeStatus(payload) {
    if (!payload) return null;
    if (payload.status) return payload.status;
    return payload;
}

function textOrDash(value) {
    if (value === undefined || value === null || value === '') return '-';
    return String(value);
}

function updateTaskState(state) {
    const value = textOrDash(state);
    taskState.textContent = value.charAt(0).toUpperCase() + value.slice(1);
    taskState.className = 'status-value';
    if (state === 'running') {
        taskState.classList.add('text-sky-300');
    } else if (state === 'succeeded') {
        taskState.classList.add('text-emerald-400');
    } else if (state === 'failed') {
        taskState.classList.add('text-rose-400');
    } else {
        taskState.classList.add('text-zinc-300');
    }
}

function formatEventTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).slice(11, 19);
    return date.toLocaleTimeString([], { hour12: false });
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function renderEvents(events) {
    const rows = (events || []).slice(-80);
    eventLog.innerHTML = rows.map((event) => {
        const level = String(event.level || 'info').toLowerCase();
        return `
            <div class="event-row">
                <time>${formatEventTime(event.ts)}</time>
                <span class="event-level ${level}">${level}</span>
                <span class="event-message" title="${escapeHtml(event.message || '')}">${escapeHtml(event.message || '')}</span>
            </div>
        `;
    }).join('');
    eventLog.scrollTop = eventLog.scrollHeight;
}

function setRunningDisabled(isRunning) {
    startButton.disabled = isRunning;
    templateSelect.disabled = isRunning;
    patternInput.disabled = isRunning;
    sourceMode.disabled = isRunning;
    rpiHostInput.disabled = isRunning;
    rpiUserInput.disabled = isRunning;
    rpiPasswordInput.disabled = isRunning;
    remoteLogDirInput.disabled = isRunning;

    const editorControls = [
        templateEditorSelect,
        templateNameInput,
        signalSearchInput,
        newTemplateButton,
        selectVisibleSignalsButton,
        clearTemplateSignalsButton,
        templateSignalsInput,
        saveTemplateButton,
    ];
    for (const control of editorControls) {
        control.disabled = isRunning;
    }
    for (const checkbox of dbcList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = isRunning;
    }
    for (const checkbox of signalPicker.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = isRunning;
    }
}

function updateStatus(rawStatus) {
    const status = normalizeStatus(rawStatus);
    if (!status || status.error && !status.state) {
        setError(status?.error || 'Status unavailable');
        return;
    }

    const percent = Math.max(0, Math.min(100, Number(status.percent || 0)));
    progressFill.style.width = `${percent}%`;
    percentLabel.textContent = `${percent.toFixed(1)}%`;
    phaseLabel.textContent = textOrDash(status.phase);
    updateTaskState(status.state);

    const progress = status.progress || {};
    const counts = status.counts || {};
    currentFile.textContent = textOrDash(progress.current_file || progress.current_file_name);
    remoteCount.textContent = counts.remote_files ?? progress.remote_files ?? 0;
    downloadedCount.textContent = `${counts.downloaded || 0} / ${counts.download_skipped || 0} skipped`;
    decodedCount.textContent = `${counts.decoded || 0} / ${counts.decode_skipped || 0} skipped`;
    transferLabel.textContent = progress.current_file_label || (
        progress.total_bytes ? `${progress.downloaded_bytes || 0} / ${progress.total_bytes}` : '-'
    );

    vehicleCount.textContent = status.vehicle_clients ?? vehicleCount.textContent ?? '0';
    undecodedFolder.textContent = status.folders?.undecoded || '-';
    decodedFolder.textContent = status.folders?.decoded || '-';
    setRunningDisabled(status.state === 'running');

    setError(status.error || '');
    renderEvents(status.events || []);
}

function updateSourceFields() {
    sshFields.classList.toggle('hidden', sourceMode.value !== 'ssh');
}

function makeSignalKey(canId, signalName) {
    return `${Number(canId)}${SIGNAL_SEPARATOR}${String(signalName)}`;
}

function signalFromKey(key) {
    const parts = String(key).split(SIGNAL_SEPARATOR);
    return {
        can_id: Number(parts[0]),
        signal_name: parts.slice(1).join(SIGNAL_SEPARATOR),
    };
}

function formatCanId(canId) {
    const value = Number(canId);
    if (!Number.isFinite(value)) return String(canId);
    return `0x${value.toString(16).toUpperCase().padStart(3, '0')}`;
}

function selectedDbcNames() {
    return Array.from(dbcList.querySelectorAll('input[type="checkbox"]:checked')).map((input) => input.value);
}

function findTemplate(name) {
    return templateRows.find((template) => template.name === name);
}

function populateTemplateSelects(preferredMain = templateSelect.value, preferredEditor = templateEditorSelect.value) {
    templateSelect.innerHTML = '<option value="">All DBC signals</option>';
    templateEditorSelect.innerHTML = '<option value="">New Template</option>';

    for (const template of templateRows) {
        const mainOption = document.createElement('option');
        mainOption.value = template.name;
        mainOption.textContent = `${template.name} (${template.signal_count})`;
        templateSelect.appendChild(mainOption);

        const editorOption = document.createElement('option');
        editorOption.value = template.name;
        editorOption.textContent = `${template.name} (${template.signal_count})`;
        templateEditorSelect.appendChild(editorOption);
    }

    if (preferredMain && findTemplate(preferredMain)) {
        templateSelect.value = preferredMain;
    }
    if (preferredEditor && findTemplate(preferredEditor)) {
        templateEditorSelect.value = preferredEditor;
    }
}

function updateTemplateTextFromSet() {
    const rows = Array.from(editorSelectedSignals)
        .map(signalFromKey)
        .sort((a, b) => a.can_id - b.can_id || a.signal_name.localeCompare(b.signal_name))
        .map((signal) => `${formatCanId(signal.can_id)}, ${signal.signal_name}`);
    templateSignalsInput.value = rows.join('\n');
    templateTextDirty = false;
    updateTemplateSignalCount();
}

function parseSignalText() {
    const text = templateSignalsInput.value.trim();
    if (!text) return [];

    if (text.startsWith('[')) {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error('JSON must be an array.');
        }
        return parsed.map((item, index) => {
            const canId = parseCanId(item.can_id);
            const signalName = String(item.signal_name || '').trim();
            if (!signalName) {
                throw new Error(`Line ${index + 1}: signal_name is required.`);
            }
            return { can_id: canId, signal_name: signalName };
        });
    }

    const rows = [];
    const lines = templateSignalsInput.value.split(/\r?\n/);
    lines.forEach((rawLine, index) => {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) return;

        let canIdRaw = '';
        let signalName = '';
        if (line.includes(',')) {
            const parts = line.split(',');
            canIdRaw = parts.shift().trim();
            signalName = parts.join(',').trim();
        } else {
            const parts = line.split(/\s+/);
            canIdRaw = parts.shift() || '';
            signalName = parts.join(' ').trim();
        }

        const canId = parseCanId(canIdRaw);
        if (!signalName) {
            throw new Error(`Line ${index + 1}: signal name is required.`);
        }
        rows.push({ can_id: canId, signal_name: signalName });
    });
    return rows;
}

function parseCanId(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        throw new Error('CAN ID is required.');
    }
    const radix = text.toLowerCase().startsWith('0x') ? 16 : 10;
    const parsed = Number.parseInt(radix === 16 ? text.slice(2) : text, radix);
    if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid CAN ID: ${text}`);
    }
    return parsed;
}

function syncSetFromTextarea() {
    const rows = parseSignalText();
    editorSelectedSignals = new Set(rows.map((row) => makeSignalKey(row.can_id, row.signal_name)));
    templateTextDirty = false;
    updateTemplateSignalCount();
    renderSignalPicker();
    return rows;
}

function updateTemplateSignalCount() {
    let count = editorSelectedSignals.size;
    if (templateTextDirty) {
        try {
            count = new Set(parseSignalText().map((row) => makeSignalKey(row.can_id, row.signal_name))).size;
        } catch {
            count = editorSelectedSignals.size;
        }
    }
    const label = count === 1 ? '1 signal' : `${count} signals`;
    templateSignalCount.textContent = label;
    templateManagerHint.textContent = label;
}

function clearTemplateEditor() {
    templateEditorSelect.value = '';
    templateNameInput.value = '';
    templateNameInput.dataset.originalName = '';
    editorSelectedSignals = new Set();
    templateSignalsInput.value = '';
    templateTextDirty = false;
    signalSearchInput.value = '';
    setTemplateMessage('');
    updateTemplateSignalCount();
    renderSignalPicker();
}

function loadTemplateIntoEditor(name) {
    setTemplateMessage('');
    if (!name) {
        clearTemplateEditor();
        return;
    }
    const template = findTemplate(name);
    if (!template) {
        clearTemplateEditor();
        return;
    }

    templateEditorSelect.value = template.name;
    templateNameInput.value = template.name;
    templateNameInput.dataset.originalName = template.name;
    editorSelectedSignals = new Set((template.signals || []).map((signal) => makeSignalKey(signal.can_id, signal.signal_name)));
    updateTemplateTextFromSet();
    renderSignalPicker();
}

function filteredSignalRows() {
    const query = signalSearchInput.value.trim().toLowerCase();
    if (!query) return signalRows;
    return signalRows.filter((row) => {
        const haystack = [
            row.can_id_hex,
            String(row.can_id),
            row.message_name,
            row.signal_name,
            row.dbc_label,
        ].join(' ').toLowerCase();
        return haystack.includes(query);
    });
}

function renderSignalPicker() {
    signalPicker.innerHTML = '';
    if (!selectedDbcNames().length) {
        signalPicker.innerHTML = '<div class="empty-state">No DBC selected</div>';
        return;
    }
    if (!signalRows.length) {
        signalPicker.innerHTML = '<div class="empty-state">No DBC signals found</div>';
        return;
    }

    const rows = filteredSignalRows();
    if (!rows.length) {
        signalPicker.innerHTML = '<div class="empty-state">No matching signals</div>';
        return;
    }

    for (const row of rows) {
        const key = makeSignalKey(row.can_id, row.signal_name);
        const label = document.createElement('label');
        label.className = 'signal-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = key;
        checkbox.checked = editorSelectedSignals.has(key);
        checkbox.addEventListener('change', () => {
            if (templateTextDirty) {
                try {
                    syncSetFromTextarea();
                } catch (error) {
                    setTemplateMessage(error.message, 'error');
                    checkbox.checked = editorSelectedSignals.has(key);
                    return;
                }
            }
            if (checkbox.checked) {
                editorSelectedSignals.add(key);
            } else {
                editorSelectedSignals.delete(key);
            }
            updateTemplateTextFromSet();
            renderSignalPicker();
        });

        const id = document.createElement('span');
        id.className = 'signal-id';
        id.textContent = row.can_id_hex || formatCanId(row.can_id);

        const text = document.createElement('span');
        text.className = 'signal-name';
        text.title = `${row.message_name || ''} / ${row.signal_name}`;
        text.textContent = row.signal_name;

        const meta = document.createElement('span');
        meta.className = 'signal-meta';
        meta.textContent = `${row.message_name || '-'} | ${row.dbc_label || '-'}`;
        text.appendChild(meta);

        label.appendChild(checkbox);
        label.appendChild(id);
        label.appendChild(text);
        signalPicker.appendChild(label);
    }
}

async function fetchTemplates(preferredMain, preferredEditor) {
    try {
        const response = await fetch('/api/candecoder/templates');
        const data = await response.json();
        templateRows = data.templates || [];
        populateTemplateSelects(preferredMain, preferredEditor);
    } catch (error) {
        setError(`Template load failed: ${error.message}`);
    }
}

async function fetchSignals() {
    try {
        const selectedDbcs = selectedDbcNames();
        if (!selectedDbcs.length) {
            signalRows = [];
            renderSignalPicker();
            return;
        }
        const response = await fetch('/api/candecoder/signals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dbc_names: selectedDbcs })
        });
        const data = await response.json();
        if (data.error) {
            setTemplateMessage(data.error, 'error');
            signalRows = [];
        } else {
            signalRows = data.signals || [];
        }
        renderSignalPicker();
    } catch (error) {
        setTemplateMessage(`Signal load failed: ${error.message}`, 'error');
    }
}

async function fetchDbcs() {
    try {
        const response = await fetch('/api/candecoder/dbcs');
        const data = await response.json();
        dbcRows = data.dbcs || [];
        if (!dbcRows.length) {
            dbcList.innerHTML = '<div class="empty-state">No DBC files found</div>';
            renderSignalPicker();
            return;
        }
        dbcList.innerHTML = '';
        for (const dbc of dbcRows) {
            const label = document.createElement('label');
            label.className = 'dbc-option';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = dbc.name;
            checkbox.checked = true;
            checkbox.addEventListener('change', fetchSignals);

            const name = document.createElement('span');
            name.textContent = dbc.name;
            name.title = dbc.path || dbc.name;

            label.appendChild(checkbox);
            label.appendChild(name);
            dbcList.appendChild(label);
        }
        await fetchSignals();
    } catch (error) {
        setError(`DBC load failed: ${error.message}`);
    }
}

async function fetchStatus() {
    try {
        const response = await fetch('/api/candecoder/status');
        const data = await response.json();
        updateStatus(data);
    } catch (error) {
        setError(`Status request failed: ${error.message}`);
    }
}

async function saveTemplate() {
    setTemplateMessage('');
    let signals = [];
    try {
        signals = parseSignalText();
    } catch (error) {
        setTemplateMessage(error.message, 'error');
        return;
    }

    const name = templateNameInput.value.trim();
    if (!name) {
        setTemplateMessage('Template name is required.', 'error');
        return;
    }
    if (!signals.length) {
        setTemplateMessage('Select at least one signal.', 'error');
        return;
    }

    saveTemplateButton.disabled = true;
    try {
        const response = await fetch('/api/candecoder/templates/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name,
                original_name: templateNameInput.dataset.originalName || null,
                signals
            })
        });
        const data = await response.json();
        if (data.error) {
            setTemplateMessage(data.error, 'error');
            return;
        }

        templateRows = data.templates || [];
        populateTemplateSelects(data.saved?.name, data.saved?.name);
        loadTemplateIntoEditor(data.saved?.name);
        templateSelect.value = data.saved?.name || '';
        setTemplateMessage(`Saved ${data.saved?.name || name}.`, 'success');
    } catch (error) {
        setTemplateMessage(`Save failed: ${error.message}`, 'error');
    } finally {
        saveTemplateButton.disabled = false;
    }
}

async function startSync() {
    startButton.disabled = true;
    setError('');
    const selectedDbcs = selectedDbcNames();
    if (!selectedDbcs.length) {
        setError('Select at least one DBC file.');
        startButton.disabled = false;
        return;
    }
    if (sourceMode.value === 'ssh' && !rpiHostInput.value.trim()) {
        setError('RPI IP / host is required for SSH/SFTP mode.');
        startButton.disabled = false;
        return;
    }
    try {
        const response = await fetch('/api/candecoder/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                template_name: templateSelect.value || null,
                pattern: patternInput.value || '*.csv',
                source_mode: sourceMode.value,
                rpi_host: rpiHostInput.value.trim(),
                rpi_user: rpiUserInput.value.trim() || 'pi',
                rpi_password: rpiPasswordInput.value,
                remote_log_dir: remoteLogDirInput.value.trim(),
                dbc_names: selectedDbcs
            })
        });
        const data = await response.json();
        if (data.error) {
            setError(data.error);
            startButton.disabled = false;
            return;
        }
        updateStatus(data);
    } catch (error) {
        setError(`Start failed: ${error.message}`);
        startButton.disabled = false;
    }
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${window.location.host}/ws`);

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'candecoder_progress') {
                updateStatus(data.status);
            } else if (data.vehicle_clients !== undefined) {
                vehicleCount.textContent = data.vehicle_clients;
            }
        } catch (error) {
            console.error('Invalid WebSocket message', error);
        }
    };

    ws.onclose = () => {
        setTimeout(connectWebSocket, 3000);
    };
}

startButton.addEventListener('click', startSync);
sourceMode.addEventListener('change', updateSourceFields);
templateEditorSelect.addEventListener('change', () => loadTemplateIntoEditor(templateEditorSelect.value));
newTemplateButton.addEventListener('click', clearTemplateEditor);
signalSearchInput.addEventListener('input', renderSignalPicker);
templateSignalsInput.addEventListener('input', () => {
    templateTextDirty = true;
    updateTemplateSignalCount();
});
templateSignalsInput.addEventListener('blur', () => {
    if (!templateTextDirty) return;
    try {
        syncSetFromTextarea();
        setTemplateMessage('');
    } catch (error) {
        setTemplateMessage(error.message, 'error');
    }
});
selectVisibleSignalsButton.addEventListener('click', () => {
    if (templateTextDirty) {
        try {
            syncSetFromTextarea();
        } catch (error) {
            setTemplateMessage(error.message, 'error');
            return;
        }
    }
    for (const row of filteredSignalRows()) {
        editorSelectedSignals.add(makeSignalKey(row.can_id, row.signal_name));
    }
    updateTemplateTextFromSet();
    renderSignalPicker();
});
clearTemplateSignalsButton.addEventListener('click', () => {
    editorSelectedSignals = new Set();
    updateTemplateTextFromSet();
    renderSignalPicker();
});
saveTemplateButton.addEventListener('click', saveTemplate);

async function initialize() {
    updateSourceFields();
    updateTemplateSignalCount();
    await fetchTemplates();
    await fetchDbcs();
    await fetchStatus();
    connectWebSocket();
    pollTimer = setInterval(fetchStatus, 2000);
}

initialize();
