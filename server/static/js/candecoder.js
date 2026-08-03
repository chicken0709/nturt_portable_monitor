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
const decodeFolderInput = document.getElementById('decodeFolderInput');
const rpiHostInput = document.getElementById('rpiHostInput');
const rpiHostHistory = document.getElementById('rpiHostHistory');
const rpiUserInput = document.getElementById('rpiUserInput');
const rpiPasswordInput = document.getElementById('rpiPasswordInput');
const remoteLogDirInput = document.getElementById('remoteLogDirInput');
const dbcList = document.getElementById('dbcList');
const listButton = document.getElementById('listButton');
const pullButton = document.getElementById('pullButton');
const decodeButton = document.getElementById('decodeButton');
const cancelButton = document.getElementById('cancelButton');
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
const remoteListCount = document.getElementById('remoteListCount');
const remoteFileList = document.getElementById('remoteFileList');
const selectVisibleRemoteButton = document.getElementById('selectVisibleRemoteButton');
const clearRemoteSelectionButton = document.getElementById('clearRemoteSelectionButton');

const SIGNAL_SEPARATOR = '\u001f';
const RPI_HOST_HISTORY_KEY = 'candecoder.rpiHostHistory';
const RPI_HOST_HISTORY_LIMIT = 8;

let ws = null;
let pollTimer = null;
let dbcRows = [];
let templateRows = [];
let signalRows = [];
let editorSelectedSignals = new Set();
let templateTextDirty = false;
let remoteRows = [];
let selectedRemotePaths = new Set();
let currentTaskState = 'idle';

function setError(message) {
    if (!message) {
        errorBox.classList.add('hidden');
        errorBox.textContent = '';
        return;
    }
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
}

async function readCandecoderJson(response) {
    if (response.status === 401) {
        window.location.href = `/adminshell/login?next=${encodeURIComponent('/candecoder')}`;
        throw new Error('Unauthorized. Please login first.');
    }
    return response.json();
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
    } else if (state === 'canceling') {
        taskState.classList.add('text-amber-300');
    } else if (state === 'canceled') {
        taskState.classList.add('text-zinc-400');
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

function formatBytes(value) {
    let amount = Number(value || 0);
    const units = ['B', 'KB', 'MB', 'GB'];
    for (const unit of units) {
        if (amount < 1024 || unit === 'GB') {
            return unit === 'B' ? `${Math.round(amount)} B` : `${amount.toFixed(1)} ${unit}`;
        }
        amount /= 1024;
    }
    return `${amount.toFixed(1)} GB`;
}

function formatFileTime(value) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
        year: '2-digit',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

function remoteFileKey(file) {
    return String(file?.relative_path || file?.filename || file?.name || file?.path || '');
}

function selectedRemotePathList() {
    return Array.from(selectedRemotePaths);
}

function defaultDecodeFolderName() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    return [
        'decode',
        now.getFullYear(),
        pad(now.getMonth() + 1),
        pad(now.getDate()),
        pad(now.getHours()),
        pad(now.getMinutes()),
        pad(now.getSeconds()),
    ].join('_');
}

function renderRemoteFiles(files) {
    remoteRows = Array.isArray(files) ? files : [];
    const liveKeys = new Set(remoteRows.map(remoteFileKey).filter(Boolean));
    selectedRemotePaths = new Set(Array.from(selectedRemotePaths).filter((key) => liveKeys.has(key)));

    const selectedCount = selectedRemotePaths.size;
    const fileLabel = remoteRows.length === 1 ? '1 file' : `${remoteRows.length} files`;
    remoteListCount.textContent = selectedCount ? `${selectedCount} / ${fileLabel}` : fileLabel;
    const isBusy = currentTaskState === 'running' || currentTaskState === 'canceling';
    selectVisibleRemoteButton.disabled = isBusy || !remoteRows.length;
    clearRemoteSelectionButton.disabled = isBusy || !selectedRemotePaths.size;
    if (!remoteRows.length) {
        remoteFileList.innerHTML = '<div class="empty-state">No remote files listed</div>';
        return;
    }

    remoteFileList.innerHTML = remoteRows.map((file) => {
        const name = file.relative_path || file.filename || file.name || file.path || '-';
        const key = remoteFileKey(file);
        const checked = selectedRemotePaths.has(key) ? 'checked' : '';
        const disabled = isBusy ? 'disabled' : '';
        return `
            <div class="remote-file-row">
                <input type="checkbox" value="${escapeHtml(key)}" ${checked} ${disabled} aria-label="Select ${escapeHtml(name)}">
                <span class="remote-file-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <span class="remote-file-size">${escapeHtml(formatBytes(file.size))}</span>
                <span class="remote-file-time">${escapeHtml(formatFileTime(file.modified || file.mtime))}</span>
            </div>
        `;
    }).join('');

    for (const checkbox of remoteFileList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                selectedRemotePaths.add(checkbox.value);
            } else {
                selectedRemotePaths.delete(checkbox.value);
            }
            renderRemoteFiles(remoteRows);
        });
    }
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

function setRunningDisabled(isBusy, state = '') {
    listButton.disabled = isBusy;
    pullButton.disabled = isBusy;
    decodeButton.disabled = isBusy;
    cancelButton.disabled = !isBusy || state === 'canceling';
    templateSelect.disabled = isBusy;
    patternInput.disabled = isBusy;
    sourceMode.disabled = isBusy;
    decodeFolderInput.disabled = isBusy;
    rpiHostInput.disabled = isBusy;
    rpiUserInput.disabled = isBusy;
    rpiPasswordInput.disabled = isBusy;
    remoteLogDirInput.disabled = isBusy;
    selectVisibleRemoteButton.disabled = isBusy || !remoteRows.length;
    clearRemoteSelectionButton.disabled = isBusy || !selectedRemotePaths.size;

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
        control.disabled = isBusy;
    }
    for (const checkbox of dbcList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = isBusy;
    }
    for (const checkbox of signalPicker.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = isBusy;
    }
    for (const checkbox of remoteFileList.querySelectorAll('input[type="checkbox"]')) {
        checkbox.disabled = isBusy;
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
    currentTaskState = status.state || 'idle';
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
    setRunningDisabled(currentTaskState === 'running' || currentTaskState === 'canceling', currentTaskState);
    renderRemoteFiles(status.remote_files || []);

    setError(status.error || '');
    renderEvents(status.events || []);
}

function updateSourceFields() {
    sshFields.classList.toggle('hidden', sourceMode.value !== 'ssh');
}

function loadRpiHostHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(RPI_HOST_HISTORY_KEY) || '[]');
        return Array.isArray(parsed)
            ? parsed.map((value) => String(value || '').trim()).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function saveRpiHostHistory(host) {
    const cleanHost = String(host || '').trim();
    if (!cleanHost) return;
    const history = [
        cleanHost,
        ...loadRpiHostHistory().filter((value) => value !== cleanHost),
    ].slice(0, RPI_HOST_HISTORY_LIMIT);
    localStorage.setItem(RPI_HOST_HISTORY_KEY, JSON.stringify(history));
    renderRpiHostHistory(history);
}

function renderRpiHostHistory(history = loadRpiHostHistory()) {
    rpiHostHistory.innerHTML = '';
    for (const host of history) {
        const option = document.createElement('option');
        option.value = host;
        rpiHostHistory.appendChild(option);
    }
}

function restoreLastRpiHost() {
    const history = loadRpiHostHistory();
    renderRpiHostHistory(history);
    if (!rpiHostInput.value.trim() && history.length) {
        rpiHostInput.value = history[0];
    }
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
        const data = await readCandecoderJson(response);
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
        const data = await readCandecoderJson(response);
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
        const data = await readCandecoderJson(response);
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
        const data = await readCandecoderJson(response);
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
        const data = await readCandecoderJson(response);
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

function buildSourcePayload() {
    return {
        pattern: patternInput.value || '*.csv',
        source_mode: 'ssh',
        rpi_host: rpiHostInput.value.trim(),
        rpi_user: rpiUserInput.value.trim() || 'pi',
        rpi_password: rpiPasswordInput.value,
        remote_log_dir: remoteLogDirInput.value.trim(),
    };
}

function buildPullPayload() {
    return {
        ...buildSourcePayload(),
        selected_relative_paths: selectedRemotePathList(),
    };
}

async function startOperation(operation) {
    setRunningDisabled(true, 'running');
    setError('');
    const selectedDbcs = selectedDbcNames();
    if (operation === 'decode' && !selectedDbcs.length) {
        setError('Select at least one DBC file.');
        setRunningDisabled(false);
        return;
    }
    if (operation === 'decode' && !selectedRemotePaths.size) {
        setError('Select pulled file(s) from the file list before decoding.');
        setRunningDisabled(false);
        return;
    }
    if (operation !== 'decode' && !rpiHostInput.value.trim()) {
        setError('RPI IP / host is required for SSH/SFTP mode.');
        setRunningDisabled(false);
        return;
    }
    if (operation !== 'decode') {
        saveRpiHostHistory(rpiHostInput.value);
    }
    if (operation === 'decode' && !decodeFolderInput.value.trim()) {
        decodeFolderInput.value = defaultDecodeFolderName();
    }

    const endpointByOperation = {
        list: '/api/candecoder/list',
        pull: '/api/candecoder/pull',
        decode: '/api/candecoder/decode',
    };
    const payload = operation === 'decode'
        ? {
            template_name: templateSelect.value || null,
            dbc_names: selectedDbcs,
            selected_relative_paths: selectedRemotePathList(),
            output_folder_name: decodeFolderInput.value.trim(),
        }
        : operation === 'pull'
            ? buildPullPayload()
            : buildSourcePayload();

    try {
        const response = await fetch(endpointByOperation[operation], {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await readCandecoderJson(response);
        if (data.error) {
            setError(data.error);
            setRunningDisabled(false);
            return;
        }
        updateStatus(data);
    } catch (error) {
        setError(`Start failed: ${error.message}`);
        setRunningDisabled(false);
    }
}

async function cancelOperation() {
    cancelButton.disabled = true;
    try {
        const response = await fetch('/api/candecoder/cancel', { method: 'POST' });
        const data = await readCandecoderJson(response);
        if (data.error) {
            setError(data.error);
            return;
        }
        updateStatus(data);
    } catch (error) {
        setError(`Cancel failed: ${error.message}`);
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

listButton.addEventListener('click', () => startOperation('list'));
pullButton.addEventListener('click', () => startOperation('pull'));
decodeButton.addEventListener('click', () => startOperation('decode'));
cancelButton.addEventListener('click', cancelOperation);
selectVisibleRemoteButton.addEventListener('click', () => {
    for (const file of remoteRows) {
        const key = remoteFileKey(file);
        if (key) selectedRemotePaths.add(key);
    }
    renderRemoteFiles(remoteRows);
});
clearRemoteSelectionButton.addEventListener('click', () => {
    selectedRemotePaths.clear();
    renderRemoteFiles(remoteRows);
});
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
    restoreLastRpiHost();
    updateSourceFields();
    updateTemplateSignalCount();
    await fetchTemplates();
    await fetchDbcs();
    await fetchStatus();
    connectWebSocket();
    pollTimer = setInterval(fetchStatus, 2000);
}

initialize();
