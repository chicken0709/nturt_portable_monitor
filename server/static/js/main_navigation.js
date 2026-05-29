// WebSocket connection
const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${protocol}://${window.location.host}/ws`;
let ws = new WebSocket(wsUrl);

ws.onopen = () => {
    document.getElementById('connection-indicator').className = 'w-3 h-3 rounded-full bg-green-500 status-indicator';
    document.getElementById('connection-text').textContent = 'System Running';
    const serverStatusElement = document.getElementById('server-status');
    serverStatusElement.textContent = 'Running';
    serverStatusElement.classList.remove('text-red-500');
    serverStatusElement.classList.add('text-emerald-500');
};

ws.onclose = () => {
    document.getElementById('connection-indicator').className = 'w-3 h-3 rounded-full bg-red-500';
    document.getElementById('connection-text').textContent = 'Connection Lost';

    const serverStatusElement = document.getElementById('server-status');
    serverStatusElement.textContent = 'Offline';
    serverStatusElement.classList.remove('text-emerald-500');
    serverStatusElement.classList.add('text-red-500');

    // reconnect
    setTimeout(() => {
        ws = new WebSocket(wsUrl);
    }, 3000);
};

ws.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        if (data.message_count) {
            document.getElementById('message-count').textContent = data.message_count;
        }
        if (data.vehicle_clients !== undefined) {
            document.getElementById('client-count').textContent = data.vehicle_clients;
        }
    } catch (e) {
        console.error('Error parsing WebSocket data:', e);
    }
};

// fetch and update status
async function updateStatus() {
    try {
        const response = await fetch('/api/status');
        const status = await response.json();
        document.getElementById('client-count').textContent = status.vehicle_clients || 0;
        document.getElementById('message-count').textContent = status.message_count || 0;
    } catch (e) {
        console.error('Failed to fetch status:', e);
    }
}

setInterval(updateStatus, 5000);
updateStatus();