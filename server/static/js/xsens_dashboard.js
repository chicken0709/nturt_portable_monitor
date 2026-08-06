const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
const maxDataPoints = 80;

let xsensMap = null;
let xsensMarker = null;
let xsensPathPoints = [];
let xsensPathPolyline = null;
let xsensMapInitialized = false;
let xsensTrackingEnabled = false;

function byId(id) {
    return document.getElementById(id);
}

function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function formatValue(value, decimals = 3) {
    if (!isNumber(value)) return '--';
    return value.toFixed(decimals);
}

function formatUnit(value, decimals, unit) {
    const formatted = formatValue(value, decimals);
    return formatted === '--' ? formatted : `${formatted} ${unit}`;
}

function setText(id, value) {
    const element = byId(id);
    if (element) {
        element.textContent = value;
    }
}

function setStatus(id, ok) {
    const element = byId(id);
    if (element) {
        element.className = ok ? 'status-dot ok' : 'status-dot fail';
    }
}

function formatBool(value) {
    if (value === null || value === undefined) return '--';
    return value ? 'OK' : 'No';
}

function formatClip(...values) {
    if (values.every((value) => value === null || value === undefined)) return '--';
    return values.some(Boolean) ? 'Clipped' : 'OK';
}

function fixTypeLabel(value) {
    const labels = {
        0: 'No Fix',
        1: 'Dead Reckoning',
        2: '2D Fix',
        3: '3D Fix',
        4: 'GNSS + DR',
        5: 'Time Only',
    };
    return labels[value] || (value === null || value === undefined ? '--' : String(value));
}

function rtkStatusLabel(value) {
    const labels = {
        0: 'No RTK',
        1: 'RTK Float',
        2: 'RTK Fixed',
    };
    return labels[value] || (value === null || value === undefined ? '--' : String(value));
}

function setupMap() {
    if (!window.L || !byId('xsens-map')) return;

    xsensMap = L.map('xsens-map').setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors',
    }).addTo(xsensMap);
}

function updateXsensGPSMap(lat, lon) {
    if (!xsensMap || !isNumber(lat) || !isNumber(lon) || lat === 0 || lon === 0) return;

    const latLng = [lat, lon];
    if (!xsensMapInitialized) {
        xsensMap.setView(latLng, 15);
        xsensMapInitialized = true;
    }

    if (xsensMarker) {
        xsensMarker.setLatLng(latLng);
    } else {
        const icon = L.divIcon({
            className: 'ripple-marker',
            html: '<div class="marker-core"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10],
        });
        xsensMarker = L.marker(latLng, { icon }).addTo(xsensMap).bindPopup('Xsens GPS Position');
    }

    if (xsensTrackingEnabled) {
        xsensPathPoints.push(latLng);
        if (xsensPathPolyline) {
            xsensMap.removeLayer(xsensPathPolyline);
        }
        xsensPathPolyline = L.polyline(xsensPathPoints, {
            color: '#06b6d4',
            weight: 3,
            opacity: 0.75,
        }).addTo(xsensMap);
    }

    if (xsensMap.getZoom() >= 10) {
        xsensMap.setView(latLng, xsensMap.getZoom());
    }
}

function createAxisChart(canvasId, label, unit, colors) {
    const canvas = byId(canvasId);
    if (!window.Chart || !canvas) return null;

    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: `${label} X`,
                    data: [],
                    borderColor: colors[0],
                    backgroundColor: `${colors[0]}22`,
                    tension: 0.15,
                    borderWidth: 2,
                    pointRadius: 0,
                },
                {
                    label: `${label} Y`,
                    data: [],
                    borderColor: colors[1],
                    backgroundColor: `${colors[1]}22`,
                    tension: 0.15,
                    borderWidth: 2,
                    pointRadius: 0,
                },
                {
                    label: `${label} Z`,
                    data: [],
                    borderColor: colors[2],
                    backgroundColor: `${colors[2]}22`,
                    tension: 0.15,
                    borderWidth: 2,
                    pointRadius: 0,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { display: false },
                y: {
                    beginAtZero: false,
                    title: { display: true, text: unit },
                    grid: { color: 'rgba(148, 163, 184, 0.14)' },
                    ticks: { color: '#94a3b8' },
                },
            },
            plugins: {
                legend: {
                    labels: { color: '#dbeafe', boxWidth: 10, boxHeight: 10 },
                },
            },
        },
    });
}

const accChart = createAxisChart('acc-chart', 'Acc', 'm/s^2', ['#22c55e', '#06b6d4', '#a855f7']);
const gyroChart = createAxisChart('gyro-chart', 'Gyr', 'rad/s', ['#60a5fa', '#f97316', '#ef4444']);
const velocityChart = createAxisChart('velocity-chart', 'Vel', 'm/s', ['#f59e0b', '#14b8a6', '#8b5cf6']);

function pushChart(chart, values) {
    if (!chart) return;

    if (chart.data.labels.length >= maxDataPoints) {
        chart.data.labels.shift();
        chart.data.datasets.forEach((dataset) => dataset.data.shift());
    }

    chart.data.labels.push(new Date().toLocaleTimeString());
    chart.data.datasets.forEach((dataset, index) => {
        dataset.data.push(isNumber(values[index]) ? values[index] : null);
    });
    chart.update('none');
}

function updateSpeedGauge(speed, maxSpeed = 200) {
    const gauge = byId('xsens-gauge-fill');
    const text = byId('xsens-gauge-speed');
    if (!gauge || !text) return;

    const safeSpeed = isNumber(speed) ? Math.max(speed, 0) : 0;
    const circumference = 2 * Math.PI * 82;
    const percentage = Math.min(safeSpeed / maxSpeed, 1);
    gauge.style.strokeDashoffset = circumference * (1 - percentage);
    text.textContent = String(Math.round(safeSpeed));
}

function formatUtc(utc) {
    if (!utc || utc.year === null || utc.month === null || utc.day === null) return '--';
    const fullYear = utc.year > 99 ? utc.year : 2000 + utc.year;
    const year = String(fullYear).padStart(4, '0');
    const month = String(utc.month).padStart(2, '0');
    const day = String(utc.day).padStart(2, '0');
    const hour = String(utc.hour ?? 0).padStart(2, '0');
    const minute = String(utc.minute ?? 0).padStart(2, '0');
    const second = String(utc.second ?? 0).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function updateConnectionStatus(connected) {
    const statusEl = byId('connection-status');
    if (!statusEl) return;

    statusEl.className = connected ? 'connection-indicator connected' : 'connection-indicator disconnected';
    statusEl.innerHTML = `
        <span class="status-dot"></span>
        <span>${connected ? 'Connected' : 'Disconnected'}</span>
    `;
}

function updateXsensDashboard(data) {
    const xsens = data.xsens || {};
    const gps = xsens.gps || {};
    const velocity = xsens.velocity || {};
    const acceleration = xsens.acceleration || {};
    const freeAcceleration = xsens.free_acceleration || {};
    const accelerationHr = xsens.acceleration_hr || {};
    const rateOfTurn = xsens.rate_of_turn || {};
    const rateOfTurnHr = xsens.rate_of_turn_hr || {};
    const quaternion = xsens.quaternion || {};
    const euler = xsens.euler || {};
    const deltaV = xsens.delta_v || {};
    const deltaQ = xsens.delta_q || {};
    const magnetic = xsens.magnetic_field || {};
    const status = xsens.status_word || {};
    const gnssStatus = xsens.gnss_status || {};
    const gnssDop = xsens.gnss_dop || {};
    const ecef = xsens.position_ecef || {};

    const hasGpsData = isNumber(gps.lat) && isNumber(gps.lon);
    const hasFilterData = status.filter_valid === true || isNumber(quaternion.q0);
    const hasMagData = isNumber(magnetic.mag_x) || isNumber(magnetic.mag_y) || isNumber(magnetic.mag_z);
    const speedKmh = isNumber(velocity.speed_kmh)
        ? velocity.speed_kmh
        : (isNumber(velocity.vel_x) && isNumber(velocity.vel_y)
            ? Math.sqrt((velocity.vel_x ** 2) + (velocity.vel_y ** 2)) * 3.6
            : null);

    setStatus('gps-status', hasGpsData || status.gnss_fix === true);
    setStatus('imu-status', hasFilterData);
    setStatus('mag-status', hasMagData);
    setStatus('rtk-status', status.rtk_status === 1 || status.rtk_status === 2);

    setText('gps-fix-label', status.gnss_fix === true ? 'Fix' : fixTypeLabel(gnssStatus.fix_type));
    setText('filter-valid-label', status.filter_valid === true ? 'Valid' : 'Invalid');
    setText('mag-valid-label', hasMagData ? 'Live' : 'No Data');
    setText('rtk-status-label', rtkStatusLabel(status.rtk_status));

    setText('message-count', String(data.message_count || 0));
    setText('last-update', data.update_time ? new Date(data.update_time).toLocaleTimeString() : '--');

    setText('xsens-gps-lat', formatUnit(gps.lat, 7, 'deg'));
    setText('xsens-gps-lon', formatUnit(gps.lon, 7, 'deg'));
    setText('xsens-gps-alt', formatUnit(gps.alt, 2, 'm'));
    setText('xsens-speed-kmh', formatUnit(speedKmh, 2, 'km/h'));
    updateSpeedGauge(speedKmh);
    updateXsensGPSMap(gps.lat, gps.lon);

    setText('xsens-q0', formatValue(quaternion.q0, 5));
    setText('xsens-q1', formatValue(quaternion.q1, 5));
    setText('xsens-q2', formatValue(quaternion.q2, 5));
    setText('xsens-q3', formatValue(quaternion.q3, 5));
    setText('xsens-roll', formatUnit(euler.roll, 2, 'deg'));
    setText('xsens-pitch', formatUnit(euler.pitch, 2, 'deg'));
    setText('xsens-yaw', formatUnit(euler.yaw, 2, 'deg'));
    setText('xsens-dq0', formatValue(deltaQ.dq0, 5));
    setText('xsens-dq1', formatValue(deltaQ.dq1, 5));
    setText('xsens-dq2', formatValue(deltaQ.dq2, 5));
    setText('xsens-dq3', formatValue(deltaQ.dq3, 5));

    setText('xsens-acc-x', formatUnit(acceleration.acc_x, 3, 'm/s^2'));
    setText('xsens-acc-y', formatUnit(acceleration.acc_y, 3, 'm/s^2'));
    setText('xsens-acc-z', formatUnit(acceleration.acc_z, 3, 'm/s^2'));
    setText('xsens-free-acc-x', formatUnit(freeAcceleration.x, 3, 'm/s^2'));
    setText('xsens-free-acc-y', formatUnit(freeAcceleration.y, 3, 'm/s^2'));
    setText('xsens-free-acc-z', formatUnit(freeAcceleration.z, 3, 'm/s^2'));
    setText('xsens-hr-acc-x', formatUnit(accelerationHr.acc_x, 3, 'm/s^2'));
    setText('xsens-hr-acc-y', formatUnit(accelerationHr.acc_y, 3, 'm/s^2'));
    setText('xsens-hr-acc-z', formatUnit(accelerationHr.acc_z, 3, 'm/s^2'));
    setText('xsens-gyr-x', formatUnit(rateOfTurn.gyr_x, 3, 'rad/s'));
    setText('xsens-gyr-y', formatUnit(rateOfTurn.gyr_y, 3, 'rad/s'));
    setText('xsens-gyr-z', formatUnit(rateOfTurn.gyr_z, 3, 'rad/s'));
    setText('xsens-hr-gyr-x', formatUnit(rateOfTurnHr.gyr_x, 3, 'rad/s'));
    setText('xsens-hr-gyr-y', formatUnit(rateOfTurnHr.gyr_y, 3, 'rad/s'));
    setText('xsens-hr-gyr-z', formatUnit(rateOfTurnHr.gyr_z, 3, 'rad/s'));
    setText('xsens-dv-x', formatUnit(deltaV.x, 5, 'm/s'));
    setText('xsens-dv-y', formatUnit(deltaV.y, 5, 'm/s'));
    setText('xsens-dv-z', formatUnit(deltaV.z, 5, 'm/s'));

    setText('xsens-vel-x', formatUnit(velocity.vel_x, 3, 'm/s'));
    setText('xsens-vel-y', formatUnit(velocity.vel_y, 3, 'm/s'));
    setText('xsens-vel-z', formatUnit(velocity.vel_z, 3, 'm/s'));
    setText('xsens-ecef-x', formatUnit(ecef.x, 2, 'm'));
    setText('xsens-ecef-y', formatUnit(ecef.y, 2, 'm'));
    setText('xsens-ecef-z', formatUnit(ecef.z, 2, 'm'));
    setText('xsens-fix-type', fixTypeLabel(gnssStatus.fix_type));
    setText('xsens-sats', gnssStatus.num_svs ?? gnssStatus.num_sv ?? '--');
    setText('xsens-num-sv', gnssStatus.num_sv ?? '--');
    setText('xsens-gnss-valid', gnssStatus.valid ?? '--');
    setText('xsens-gnss-flags', gnssStatus.flags ?? '--');
    setText('xsens-pdop', formatValue(gnssDop.pdop, 2));
    setText('xsens-tdop', formatValue(gnssDop.tdop, 2));
    setText('xsens-vdop', formatValue(gnssDop.vdop, 2));
    setText('xsens-hdop', formatValue(gnssDop.hdop, 2));

    setText('xsens-mag-x', formatValue(magnetic.mag_x, 5));
    setText('xsens-mag-y', formatValue(magnetic.mag_y, 5));
    setText('xsens-mag-z', formatValue(magnetic.mag_z, 5));
    setText('xsens-temp', formatUnit(xsens.temperature?.temperature, 2, 'degC'));
    setText('xsens-pressure', formatUnit(xsens.barometric_pressure?.pressure, 0, 'Pa'));
    setText('xsens-utc', formatUtc(xsens.utc));

    setText('xsens-self-test', formatBool(status.self_test_ok));
    setText('xsens-filter-valid', formatBool(status.filter_valid));
    setText('xsens-gnss-fix', formatBool(status.gnss_fix));
    setText('xsens-no-rotation', status.no_rotation_status ?? '--');
    setText('xsens-external-clock', formatBool(status.external_clock_synced));
    setText('xsens-time-pulse', formatBool(status.have_gnss_time_pulse));
    setText('xsens-clip-acc', formatClip(status.clip_acc_x, status.clip_acc_y, status.clip_acc_z));
    setText('xsens-clip-gyr', formatClip(status.clip_gyr_x, status.clip_gyr_y, status.clip_gyr_z));
    setText('xsens-clip-mag', formatClip(status.clip_mag_x, status.clip_mag_y, status.clip_mag_z));
    setText('xsens-warning', xsens.warning?.warning_code ?? '--');
    setText('xsens-sample-time', xsens.sample_time?.timestamp_us ?? '--');
    setText('xsens-counter', xsens.group_counter?.counter ?? '--');

    pushChart(accChart, [acceleration.acc_x, acceleration.acc_y, acceleration.acc_z]);
    pushChart(gyroChart, [rateOfTurn.gyr_x, rateOfTurn.gyr_y, rateOfTurn.gyr_z]);
    pushChart(velocityChart, [velocity.vel_x, velocity.vel_y, velocity.vel_z]);
}

ws.onopen = function() {
    updateConnectionStatus(true);
};

ws.onerror = function(error) {
    console.error('WebSocket error:', error);
};

ws.onclose = function() {
    updateConnectionStatus(false);
    setTimeout(() => location.reload(), 5000);
};

ws.onmessage = function(event) {
    const data = JSON.parse(event.data);
    if (!Object.prototype.hasOwnProperty.call(data, 'message_count') && !Object.prototype.hasOwnProperty.call(data, 'xsens')) {
        return;
    }
    updateConnectionStatus(Boolean(data.vehicle_connected));
    updateXsensDashboard(data);
};

document.addEventListener('DOMContentLoaded', function() {
    setupMap();

    const toggleTrackButton = byId('toggle-xsens-track-btn');
    const clearTrackButton = byId('clear-xsens-track-btn');

    if (toggleTrackButton) {
        toggleTrackButton.addEventListener('click', function() {
            xsensTrackingEnabled = !xsensTrackingEnabled;
            this.textContent = xsensTrackingEnabled ? 'Stop Track' : 'Start Track';
            this.classList.toggle('danger', xsensTrackingEnabled);
        });
    }

    if (clearTrackButton) {
        clearTrackButton.addEventListener('click', function() {
            xsensPathPoints = [];
            if (xsensPathPolyline && xsensMap) {
                xsensMap.removeLayer(xsensPathPolyline);
                xsensPathPolyline = null;
            }
        });
    }
});
