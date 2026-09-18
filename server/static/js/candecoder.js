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
const remoteListCount = document.getElementById('remoteListCount');
const remoteFileList = document.getElementById('remoteFileList');
const selectVisibleRemoteButton = document.getElementById('selectVisibleRemoteButton');
const clearRemoteSelectionButton = document.getElementById('clearRemoteSelectionButton');
const workspaceTree = document.getElementById('workspaceTree');
const workspaceTreeCount = document.getElementById('workspaceTreeCount');
const selectLocalDecodeFilesButton = document.getElementById('selectLocalDecodeFilesButton');
const cancelLocalSelectionButton = document.getElementById('cancelLocalSelectionButton');
const refreshWorkspaceButton = document.getElementById('refreshWorkspaceButton');
const workspaceEditor = document.getElementById('workspaceEditor');
const workspaceSelectedPath = document.getElementById('workspaceSelectedPath');
const workspaceMoveInput = document.getElementById('workspaceMoveInput');
const copyWorkspaceButton = document.getElementById('copyWorkspaceButton');
const moveWorkspaceButton = document.getElementById('moveWorkspaceButton');
const deleteWorkspaceButton = document.getElementById('deleteWorkspaceButton');
const workspaceMessage = document.getElementById('workspaceMessage');

const SIGNAL_SEPARATOR = '\u001f';
const RPI_HOST_HISTORY_KEY = 'candecoder.rpiHostHistory';
const RPI_HOST_HISTORY_LIMIT = 8;
const DEFAULT_WORKSPACE_COPY_TARGET = '/mnt/webdav/vehical_data_EP7/';

let ws = null;
let pollTimer = null;
let dbcRows = [];
let templateRows = [];
let signalRows = [];
let editorSelectedSignals = new Set();
let templateTextDirty = false;
let remoteRows = [];
let selectedRemotePaths = new Set();
let lastRemoteTreeSignature = '';
let remoteSelectionMode = false;
let selectedLocalPaths = new Set();
let currentTaskState = 'idle';
let workspaceFetchInFlight = false;
let selectedWorkspacePath = '';
let selectedWorkspaceType = '';
let workspaceTreeData = null;
let localSelectionMode = false;

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

function normalizeRemotePath(value) {
    return String(value || '').replaceAll('\\', '/').trim().replace(/^\/+/, '');
}

function remotePathMatchesSelection(path, selectedValue) {
    const normalizedPath = normalizeRemotePath(path);
    const normalizedSelected = normalizeRemotePath(selectedValue);
    if (!normalizedPath || !normalizedSelected) return false;
    if (normalizedPath === normalizedSelected) return true;
    return normalizedPath.startsWith(`${normalizedSelected.replace(/\/$/, '')}/`);
}

function expandRemoteSelectionValues() {
    const expanded = new Set();
    for (const selectedValue of selectedRemotePaths) {
        const normalizedSelected = normalizeRemotePath(selectedValue);
        if (!normalizedSelected) continue;

        const matches = remoteRows.filter((file) => {
            const relativePath = normalizeRemotePath(remoteFileKey(file));
            return relativePath && remotePathMatchesSelection(relativePath, normalizedSelected);
        });

        if (matches.length) {
            for (const file of matches) {
                const key = remoteFileKey(file);
                if (key) expanded.add(normalizeRemotePath(key));
            }
            continue;
        }

        expanded.add(normalizedSelected);
    }
    return Array.from(expanded).filter(Boolean);
}

function selectedRemotePathList() {
    return expandRemoteSelectionValues();
}

function selectedLocalPathList() {
    return Array.from(selectedLocalPaths);
}

function localPathIncludedInSelection(relativePath) {
    const target = normalizeWorkspacePath(relativePath || '');
    if (!target) return false;
    return Array.from(selectedLocalPaths).some((value) => {
        const item = normalizeWorkspacePath(value || '');
        return item === target || item.startsWith(`${target}/`);
    });
}

function collectDirectoryCsvPaths(rootNode, targetDirPath = '') {
    const cleanTarget = normalizeWorkspacePath(targetDirPath || '');
    if (!rootNode || !cleanTarget) return [];

    const paths = [];
    function walk(node) {
        if (!node) return false;
        const currentPath = normalizeWorkspacePath(node.relative_path || '');
        if (node.type === 'directory' && currentPath === cleanTarget) {
            if (Array.isArray(node.children)) {
                for (const child of node.children) {
                    const childPath = normalizeWorkspacePath(child.relative_path || '');
                    if (child.type === 'file' && child.name && child.name.toLowerCase().endsWith('.csv')) {
                        paths.push(childPath);
                    }
                }
            }
            return true;
        }
        if (Array.isArray(node.children)) {
            for (const child of node.children) {
                if (walk(child)) return true;
            }
        }
        return false;
    }

    walk(rootNode);
    return paths;
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

function buildRemoteTree(files) {
    const root = {
        name: 'LOGS',
        relative_path: '',
        path: '',
        type: 'directory',
        children: [],
    };

    for (const file of files) {
        const relativePath = normalizeRemotePath(remoteFileKey(file));
        if (!relativePath) continue;
        const parts = relativePath.split('/').filter(Boolean);
        let node = root;
        for (let index = 0; index < parts.length - 1; index += 1) {
            const part = parts[index];
            let child = node.children.find((entry) => entry.name === part && entry.type === 'directory');
            if (!child) {
                child = {
                    name: part,
                    relative_path: parts.slice(0, index + 1).join('/'),
                    path: '',
                    type: 'directory',
                    modified: null,
                    children: [],
                };
                node.children.push(child);
            }
            node = child;
        }

        const fileName = parts[parts.length - 1] || relativePath;
        const fileEntry = {
            name: fileName,
            relative_path: relativePath,
            path: relativePath,
            type: 'file',
            size: Number(file.size || 0),
            modified: file.modified || file.mtime,
            children: [],
        };
        node.children.push(fileEntry);
        let current = node;
        while (current) {
            const nextModified = current.modified ? new Date(current.modified).getTime() : 0;
            const candidate = new Date(fileEntry.modified || 0).getTime();
            if (!current.modified || candidate > nextModified) {
                current.modified = fileEntry.modified || file.mtime;
            }
            current = current.parent || null;
        }
    }

    function assignParentPointers(node, parent = null) {
        node.parent = parent;
        for (const child of node.children || []) {
            assignParentPointers(child, node);
        }
    }

    assignParentPointers(root);
    function finalizeDirectoryTimes(node) {
        if (!node || node.type !== 'directory') return;
        if (node.children.length === 0) {
            node.modified = node.modified || null;
            return;
        }
        for (const child of node.children) {
            finalizeDirectoryTimes(child);
        }
        const latestChild = [...node.children].filter((entry) => entry.modified).sort((left, right) => {
            const leftTime = new Date(left.modified).getTime();
            const rightTime = new Date(right.modified).getTime();
            return rightTime - leftTime;
        })[0];
        node.modified = latestChild ? latestChild.modified : node.modified;
    }

    finalizeDirectoryTimes(root);

    root.children.sort((left, right) => String(left.name).toLocaleLowerCase().localeCompare(String(right.name).toLocaleLowerCase()));
    for (const child of root.children) {
        child.children.sort((left, right) => String(left.name).toLocaleLowerCase().localeCompare(String(right.name).toLocaleLowerCase()));
    }
    return root;
}

function remoteTreeNodeSelected(nodePath) {
    const normalized = normalizeRemotePath(nodePath);
    if (!normalized) return false;
    return Array.from(selectedRemotePaths).some((value) => {
        const selected = normalizeRemotePath(value);
        return selected === normalized || selected.startsWith(`${normalized}/`);
    });
}

function toggleRemoteSelectionMode(enabled) {
    remoteSelectionMode = Boolean(enabled);
    if (!remoteSelectionMode) {
        selectedRemotePaths.clear();
    }
    renderRemoteFiles(remoteRows, true);
}

function syncRemoteTreeCheckboxes() {
    if (!remoteSelectionMode) return;

    const allSelected = remoteRows.length > 0 && remoteRows.every((file) => {
        const key = normalizeRemotePath(remoteFileKey(file));
        return key && selectedRemotePaths.has(key);
    });

    for (const checkbox of remoteFileList.querySelectorAll('input[data-remote-select]')) {
        const value = normalizeRemotePath(checkbox.value || '');
        const isRoot = value === '';
        let checked = false;
        if (isRoot) {
            checked = allSelected;
        } else if (checkbox.closest('.workspace-directory')) {
            checked = remoteTreeNodeSelected(value);
        } else {
            checked = selectedRemotePaths.has(value);
        }
        checkbox.checked = checked;
    }
}

function renderRemoteTreeNode(node, level = 0) {
    const relativePath = normalizeRemotePath(node.relative_path || '');
    const isDirectory = node.type === 'directory';
    const isRoot = isDirectory && !relativePath;
    const checked = isRoot
        ? false
        : (isDirectory
            ? remoteTreeNodeSelected(relativePath)
            : selectedRemotePaths.has(relativePath));
    const disabled = currentTaskState === 'running' || currentTaskState === 'canceling';
    const selectionModeClass = remoteSelectionMode ? 'selection-mode' : '';
    const selectionCheckbox = remoteSelectionMode
        ? `<input type="checkbox" data-remote-select value="${escapeHtml(relativePath || '')}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}>`
        : '';

    if (isDirectory) {
        const children = Array.isArray(node.children) ? node.children.map((child) => renderRemoteTreeNode(child, level + 1)).join('') : '';
        const childCount = Array.isArray(node.children) ? node.children.length : 0;
        const meta = childCount ? `${childCount} ${childCount === 1 ? 'child' : 'children'}` : '0 children';
        const summary = `
            <summary data-remote-path="${escapeHtml(relativePath || '')}" title="${escapeHtml(relativePath || node.name)}">
            ${selectionCheckbox}
            <span class="workspace-node-type">DIR</span>
                <span class="workspace-node-name">${escapeHtml(node.name)}</span>
                ${renderWorkspaceMeta([meta, formatFileTime(node.modified)])}
            </summary>
        `;
        return `
            <details class="workspace-node workspace-directory ${selectionModeClass}" data-remote-path="${escapeHtml(relativePath || '')}" ${level === 0 ? 'open' : ''}>
                ${summary}
                ${children ? `<div class="workspace-children">${children}</div>` : ''}
            </details>
        `;
    }

    return `
        <div class="workspace-node workspace-file ${selectionModeClass}" data-remote-path="${escapeHtml(relativePath || '')}" title="${escapeHtml(relativePath)}">
        ${selectionCheckbox}
        <span class="workspace-node-type">CSV</span>
            <span class="workspace-node-name">${escapeHtml(node.name)}</span>
            ${renderWorkspaceMeta([formatBytes(node.size || 0), formatFileTime(node.modified)])}
        </div>
    `;
}

function renderRemoteFiles(files) {
    const nextRows = Array.isArray(files) ? files : [];
    const nextSignature = [...new Set(
        nextRows.map((file) => normalizeRemotePath(remoteFileKey(file))).filter(Boolean)
    )].sort().join('|');
    const isSameList = nextSignature === lastRemoteTreeSignature;

    remoteRows = nextRows;
    const liveKeys = new Set(remoteRows.map(remoteFileKey).map(normalizeRemotePath).filter(Boolean));
    selectedRemotePaths = new Set(Array.from(selectedRemotePaths).map(normalizeRemotePath).filter((key) => liveKeys.has(key) || remoteRows.some((file) => remotePathMatchesSelection(normalizeRemotePath(remoteFileKey(file)), key))));

    const selectedCount = expandRemoteSelectionValues().length;
    const fileLabel = remoteRows.length === 1 ? '1 file' : `${remoteRows.length} files`;
    remoteListCount.textContent = selectedCount ? `${selectedCount} / ${fileLabel}` : fileLabel;
    const isBusy = currentTaskState === 'running' || currentTaskState === 'canceling';
    selectVisibleRemoteButton.disabled = isBusy || !remoteRows.length;
    clearRemoteSelectionButton.disabled = isBusy || (!remoteSelectionMode && !selectedRemotePaths.size);
    if (!remoteRows.length) {
        remoteFileList.innerHTML = '<div class="empty-state">No remote files listed</div>';
        lastRemoteTreeSignature = '';
        return;
    }

    if (isSameList) {
        return;
    }

    const tree = buildRemoteTree(remoteRows);
    remoteFileList.innerHTML = renderRemoteTreeNode(tree);
    lastRemoteTreeSignature = nextSignature;

    for (const checkbox of remoteFileList.querySelectorAll('input[data-remote-select]')) {
        checkbox.addEventListener('change', () => {
            const value = normalizeRemotePath(checkbox.value || '');
            if (!value && remoteRows.length) {
                if (checkbox.checked) {
                    for (const file of remoteRows) {
                        const key = normalizeRemotePath(remoteFileKey(file));
                        if (key) selectedRemotePaths.add(key);
                    }
                } else {
                    selectedRemotePaths.clear();
                }
            } else if (checkbox.closest('.workspace-directory')) {
                const descendantPaths = remoteRows
                    .map((file) => normalizeRemotePath(remoteFileKey(file)))
                    .filter((filePath) => filePath && filePath.startsWith(`${value}/`));
                if (checkbox.checked) {
                    selectedRemotePaths.add(value);
                    for (const filePath of descendantPaths) {
                        selectedRemotePaths.add(filePath);
                    }
                } else {
                    selectedRemotePaths.delete(value);
                    for (const filePath of descendantPaths) {
                        selectedRemotePaths.delete(filePath);
                    }
                }
            } else {
                if (checkbox.checked) {
                    selectedRemotePaths.add(value);
                } else {
                    selectedRemotePaths.delete(value);
                }
            }

            const selectedCount = expandRemoteSelectionValues().length;
            const fileLabel = remoteRows.length === 1 ? '1 file' : `${remoteRows.length} files`;
            remoteListCount.textContent = selectedCount ? `${selectedCount} / ${fileLabel}` : fileLabel;
            syncRemoteTreeCheckboxes();
        });
    }
}

function workspaceTypeLabel(node) {
    if (node?.type === 'directory') return 'DIR';
    if (node?.type === 'link') return 'LINK';
    const name = String(node?.name || '');
    const extension = name.includes('.') ? name.split('.').pop() : '';
    return extension ? extension.slice(0, 4).toUpperCase() : 'FILE';
}

function workspaceItemLabel(count, truncated = false) {
    const label = count === 1 ? '1 item' : `${count} items`;
    return truncated ? `${label} shown` : label;
}

function normalizeWorkspacePath(value) {
    return String(value || '').replaceAll('\\', '/').trim();
}

function workspaceMutationBusy() {
    return currentTaskState === 'running' || currentTaskState === 'canceling';
}

function toggleLocalSelectionMode(enabled) {
    localSelectionMode = Boolean(enabled);
    selectLocalDecodeFilesButton.disabled = localSelectionMode || workspaceMutationBusy();
    cancelLocalSelectionButton.disabled = !localSelectionMode || workspaceMutationBusy();
    if (!localSelectionMode) {
        selectedLocalPaths.clear();
    }
    if (workspaceTreeData) {
        renderWorkspaceTree(workspaceTreeData);
    }
}

function setWorkspaceMessage(message, type = '') {
    if (!message) {
        workspaceMessage.className = 'workspace-message hidden';
        workspaceMessage.textContent = '';
        return;
    }
    workspaceMessage.className = `workspace-message ${type}`.trim();
    workspaceMessage.textContent = message;
}

function updateWorkspaceEditorControls() {
    const isBusy = workspaceMutationBusy();
    const hasWorkspaceSelection = Boolean(selectedWorkspacePath) && selectedWorkspaceType !== 'external';
    const moveTarget = normalizeWorkspacePath(workspaceMoveInput.value);
    const canTransfer = hasWorkspaceSelection && moveTarget && moveTarget !== selectedWorkspacePath;

    workspaceEditor.classList.toggle('hidden', !selectedWorkspacePath && selectedWorkspaceType !== 'directory');
    workspaceSelectedPath.textContent = selectedWorkspacePath || 'candecoder_workspace';
    workspaceMoveInput.disabled = isBusy || !hasWorkspaceSelection;
    copyWorkspaceButton.disabled = isBusy || !canTransfer;
    moveWorkspaceButton.disabled = isBusy || !canTransfer;
    deleteWorkspaceButton.disabled = isBusy || !hasWorkspaceSelection;
}

function syncWorkspaceSelectionInTree() {
    for (const item of workspaceTree.querySelectorAll('[data-workspace-path]')) {
        item.classList.toggle('selected', item.dataset.workspacePath === selectedWorkspacePath);
    }
}

function selectWorkspaceNode(relativePath, type) {
    selectedWorkspacePath = normalizeWorkspacePath(relativePath);
    selectedWorkspaceType = type || '';
    workspaceMoveInput.value = DEFAULT_WORKSPACE_COPY_TARGET;
    setWorkspaceMessage('');
    updateWorkspaceEditorControls();
    syncWorkspaceSelectionInTree();
}

function attachWorkspaceNodeEvents() {
    for (const item of workspaceTree.querySelectorAll('[data-workspace-path]')) {
        item.addEventListener('click', (event) => {
            event.stopPropagation();
            selectWorkspaceNode(item.dataset.workspacePath || '', item.dataset.workspaceType || '');
        });
    }
    for (const item of workspaceTree.querySelectorAll('[data-local-select]')) {
        item.addEventListener('click', (event) => {
            event.stopPropagation();
            const value = normalizeWorkspacePath(item.value || '');
            if (!value) return;
            if (item.checked) {
                selectedLocalPaths.add(value);
            } else {
                selectedLocalPaths.delete(value);
            }
        });
    }
    for (const item of workspaceTree.querySelectorAll('[data-local-dir-select]')) {
        item.addEventListener('click', (event) => {
            event.stopPropagation();
            const value = normalizeWorkspacePath(item.value || '');
            if (!value) return;
            const csvPaths = collectDirectoryCsvPaths(workspaceTreeData?.tree || null, value);
            if (item.checked) {
                selectedLocalPaths.add(value);
                for (const path of csvPaths) {
                    selectedLocalPaths.add(path);
                }
            } else {
                selectedLocalPaths.delete(value);
                for (const path of csvPaths) {
                    selectedLocalPaths.delete(path);
                }
            }
            renderWorkspaceTree(workspaceTreeData);
        });
    }
    syncWorkspaceSelectionInTree();
}

function renderWorkspaceMeta(parts) {
    const cleanParts = parts.filter(Boolean);
    if (!cleanParts.length) return '';
    return `<span class="workspace-node-meta">${cleanParts.map(escapeHtml).join(' | ')}</span>`;
}

function renderWorkspaceChildren(children) {
    if (!children.length) {
        return '<div class="workspace-empty-child">Empty</div>';
    }
    return `<div class="workspace-children">${children.map((child) => renderWorkspaceNode(child)).join('')}</div>`;
}

function renderWorkspaceNode(node, isRoot = false) {
    if (!node) return '';
    const kind = node.type === 'directory' ? 'directory' : 'file';
    const name = node.name || '-';
    const title = node.path || node.relative_path || name;
    const typeLabel = workspaceTypeLabel(node);

    const selectionModeClass = localSelectionMode ? 'selection-mode' : '';

    if (kind === 'directory') {
        const children = Array.isArray(node.children) ? node.children : [];
        const open = isRoot || !String(node.relative_path || '').includes('/') ? 'open' : '';
        const childLabel = children.length === 1 ? '1 child' : `${children.length} children`;
        const error = node.error ? `<div class="workspace-node-error">${escapeHtml(node.error)}</div>` : '';
        const directoryRelativePath = normalizeWorkspacePath(node.relative_path || '');
        const selectedLocal = localSelectionMode && localPathIncludedInSelection(directoryRelativePath) ? 'checked' : '';
        const selectionCheckbox = localSelectionMode
            ? `<input type="checkbox" class="workspace-node-select" data-local-dir-select value="${escapeHtml(node.relative_path || '')}" ${selectedLocal}>`
            : '';
        return `
            <details class="workspace-node workspace-directory ${selectionModeClass}" ${open}>
                <summary data-workspace-path="${escapeHtml(node.relative_path || '')}" data-workspace-type="${escapeHtml(node.type || 'directory')}" title="${escapeHtml(title)}">
                    ${selectionCheckbox}
                    <span class="workspace-node-type">${escapeHtml(typeLabel)}</span>
                    <span class="workspace-node-name">${escapeHtml(name)}</span>
                    ${renderWorkspaceMeta([childLabel, formatFileTime(node.modified)])}
                </summary>
                ${error}
                ${renderWorkspaceChildren(children)}
            </details>
        `;
    }

    const sizeLabel = typeof node.size === 'number' ? formatBytes(node.size) : '';
    const error = node.error ? node.error : '';
    const selectedLocal = localSelectionMode && selectedLocalPaths.has(normalizeWorkspacePath(node.relative_path || '')) ? 'checked' : '';
    const selectionCheckbox = localSelectionMode
        ? `<input type="checkbox" class="workspace-node-select" data-local-select value="${escapeHtml(node.relative_path || '')}" ${selectedLocal}>`
        : '';
    return `
        <div class="workspace-node workspace-file ${selectionModeClass}" data-workspace-path="${escapeHtml(node.relative_path || '')}" data-workspace-type="${escapeHtml(node.type || 'file')}" title="${escapeHtml(title)}">
            ${selectionCheckbox}
            <span class="workspace-node-type">${escapeHtml(typeLabel)}</span>
            <span class="workspace-node-name">${escapeHtml(name)}</span>
            ${renderWorkspaceMeta([sizeLabel, formatFileTime(node.modified), error.trim()])}
        </div>
    `;
}

function renderWorkspaceTree(data) {
    workspaceTreeData = data || null;
    if (!data || data.error) {
        workspaceTreeCount.textContent = '-';
        workspaceTree.innerHTML = `<div class="empty-state">${escapeHtml(data?.error || 'Workspace tree unavailable')}</div>`;
        return;
    }

    workspaceTreeCount.textContent = workspaceItemLabel(Number(data.total_entries || 0), Boolean(data.truncated));
    if (!data.exists || !data.tree) {
        workspaceTree.innerHTML = '<div class="empty-state">candecoder_workspace has not been created yet</div>';
        return;
    }

    const truncated = data.truncated
        ? `<div class="workspace-truncated">Showing first ${escapeHtml(data.max_entries || data.total_entries)} entries</div>`
        : '';
    workspaceTree.innerHTML = `${renderWorkspaceNode(data.tree, true)}${truncated}`;
    attachWorkspaceNodeEvents();
}

async function fetchWorkspaceTree() {
    if (workspaceFetchInFlight) return;
    workspaceFetchInFlight = true;
    refreshWorkspaceButton.disabled = true;
    try {
        const response = await fetch('/api/candecoder/workspace');
        const data = await readCandecoderJson(response);
        renderWorkspaceTree(data);
    } catch (error) {
        renderWorkspaceTree({ error: `Workspace load failed: ${error.message}` });
    } finally {
        workspaceFetchInFlight = false;
        refreshWorkspaceButton.disabled = false;
    }
}

async function copyWorkspaceItem() {
    const source = selectedWorkspacePath;
    const destination = normalizeWorkspacePath(workspaceMoveInput.value);
    if (!source || !destination || source === destination) {
        updateWorkspaceEditorControls();
        return;
    }

    moveWorkspaceButton.disabled = true;
    setWorkspaceMessage('');
    try {
        const response = await fetch('/api/candecoder/workspace/copy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_relative_path: source,
                destination_relative_path: destination,
            }),
        });
        const data = await readCandecoderJson(response);
        if (data.error) {
            setWorkspaceMessage(data.error, 'error');
            return;
        }

        const copied = data.copied || {};
        const copiedInsideWorkspace = Boolean(copied.in_workspace);
        const copiedPath = normalizeWorkspacePath(
            copiedInsideWorkspace
                ? (copied.destination_relative_path || destination)
                : (copied.destination_path || destination)
        );
        renderWorkspaceTree(data.workspace);
        setWorkspaceMessage(`Copied to ${copiedPath}.`, 'success');
        updateWorkspaceEditorControls();
    } catch (error) {
        setWorkspaceMessage(`Copy failed: ${error.message}`, 'error');
    } finally {
        updateWorkspaceEditorControls();
    }
}

async function moveWorkspaceItem() {
    const source = selectedWorkspacePath;
    const destination = normalizeWorkspacePath(workspaceMoveInput.value);
    if (!source || !destination || source === destination) {
        updateWorkspaceEditorControls();
        return;
    }

    moveWorkspaceButton.disabled = true;
    setWorkspaceMessage('');
    try {
        const response = await fetch('/api/candecoder/workspace/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source_relative_path: source,
                destination_relative_path: destination,
            }),
        });
        const data = await readCandecoderJson(response);
        if (data.error) {
            setWorkspaceMessage(data.error, 'error');
            return;
        }

        const moved = data.moved || {};
        const movedInsideWorkspace = Boolean(moved.in_workspace);
        const movedPath = normalizeWorkspacePath(
            movedInsideWorkspace
                ? (moved.destination_relative_path || destination)
                : (moved.destination_path || destination)
        );
        selectedWorkspacePath = movedPath;
        selectedWorkspaceType = movedInsideWorkspace ? (moved.type || selectedWorkspaceType) : 'external';
        renderWorkspaceTree(data.workspace);
        setWorkspaceMessage(`Moved to ${movedPath}.`, 'success');
        updateWorkspaceEditorControls();
    } catch (error) {
        setWorkspaceMessage(`Move failed: ${error.message}`, 'error');
    } finally {
        updateWorkspaceEditorControls();
    }
}

async function deleteWorkspaceItem() {
    const source = selectedWorkspacePath;
    if (!source) return;
    const confirmed = window.confirm(`Delete ${source} from candecoder_workspace?`);
    if (!confirmed) return;

    deleteWorkspaceButton.disabled = true;
    setWorkspaceMessage('');
    try {
        const response = await fetch('/api/candecoder/workspace/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ relative_path: source }),
        });
        const data = await readCandecoderJson(response);
        if (data.error) {
            setWorkspaceMessage(data.error, 'error');
            return;
        }

        selectedWorkspacePath = source;
        selectedWorkspaceType = 'external';
        renderWorkspaceTree(data.workspace);
        setWorkspaceMessage(`Deleted ${data.deleted?.relative_path || source}.`, 'success');
        updateWorkspaceEditorControls();
    } catch (error) {
        setWorkspaceMessage(`Delete failed: ${error.message}`, 'error');
    } finally {
        updateWorkspaceEditorControls();
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
    updateWorkspaceEditorControls();
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
    downloadedCount.textContent = `${counts.downloaded || 0}`;
    decodedCount.textContent = `${counts.decoded || 0}`;
    transferLabel.textContent = progress.current_file_label || (
        progress.total_bytes ? `${progress.downloaded_bytes || 0} / ${progress.total_bytes}` : '-'
    );

    vehicleCount.textContent = status.vehicle_clients ?? vehicleCount.textContent ?? '0';
    setRunningDisabled(currentTaskState === 'running' || currentTaskState === 'canceling', currentTaskState);

    const shouldReplaceRemoteList = status.operation === 'list' || status.phase === 'listing';
    const nextRemoteFiles = shouldReplaceRemoteList
        ? (Array.isArray(status.remote_files) ? status.remote_files : [])
        : (remoteRows.length ? remoteRows : (Array.isArray(status.remote_files) ? status.remote_files : []));
    renderRemoteFiles(nextRemoteFiles, Boolean(shouldReplaceRemoteList));

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
    if (operation === 'decode' && !selectedLocalPaths.size) {
        setError('Select local raw file(s) from the workspace before decoding.');
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
            selected_local_relative_paths: selectedLocalPathList(),
            output_folder_name: decodeFolderInput.value.trim(),
        }
        : operation === 'pull'
            ? buildPullPayload()
            : buildSourcePayload();

    try {
        const previousRemoteRows = [...remoteRows];
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
        if (operation === 'pull' || operation === 'decode') {
            remoteSelectionMode = false;
            selectedRemotePaths.clear();
            const restoredRows = previousRemoteRows.length ? previousRemoteRows : (Array.isArray(data.remote_files) ? data.remote_files : remoteRows);
            renderRemoteFiles(restoredRows, true);
            await fetchWorkspaceTree();
        }
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
selectLocalDecodeFilesButton.addEventListener('click', () => {
    if (workspaceMutationBusy()) return;
    toggleLocalSelectionMode(true);
});
cancelLocalSelectionButton.addEventListener('click', () => {
    if (workspaceMutationBusy()) return;
    toggleLocalSelectionMode(false);
});
refreshWorkspaceButton.addEventListener('click', fetchWorkspaceTree);
copyWorkspaceButton.addEventListener('click', copyWorkspaceItem);
moveWorkspaceButton.addEventListener('click', moveWorkspaceItem);
deleteWorkspaceButton.addEventListener('click', deleteWorkspaceItem);
workspaceMoveInput.addEventListener('input', updateWorkspaceEditorControls);
selectVisibleRemoteButton.addEventListener('click', () => {
    if (currentTaskState === 'running' || currentTaskState === 'canceling') return;
    remoteSelectionMode = true;
    renderRemoteFiles(remoteRows, true);
});
clearRemoteSelectionButton.addEventListener('click', () => {
    if (currentTaskState === 'running' || currentTaskState === 'canceling') return;
    selectedRemotePaths.clear();
    remoteSelectionMode = false;
    renderRemoteFiles(remoteRows, true);
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
    await fetchWorkspaceTree();
    connectWebSocket();
    pollTimer = setInterval(fetchStatus, 2000);
}

initialize();
