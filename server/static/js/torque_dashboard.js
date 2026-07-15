// WebSocket connection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

// Chart data storage - keep only 20 seconds of data (assuming ~10 updates per second = 200 data points)
const maxDataPoints = 200; // 20 seconds at 10 Hz

const canvas = document.getElementById('radial-gauge');
const container = canvas.parentElement;
const speedGaugeSize = container.clientWidth;

const speedGauge = new RadialGauge({
    renderTo: 'radial-gauge',
    width: speedGaugeSize * 0.9,
    height: speedGaugeSize * 0.9,
    units: 'km/h',
    minValue: 0,
    maxValue: 100,
    majorTicks: ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90', '100'],
    highlights: [],
    valueInt : 1,
    valueDec : 0,
    colorMajorTicks: "#ddd",
    colorMinorTicks: "#ddd",
    colorTitle: "#eee",
    colorUnits: "#ccc",
    colorNumbers: "#eee",
    colorPlate: "#222",
    colorNeedle: '#62aae1',
    colorNeedleEnd: '#62aae1',
    colorValueBoxRect: 'rgb(72, 72, 72)',
    colorValueBoxRectEnd: 'rgb(72, 72, 72)',
    colorValueBoxBackground: 'rgb(101, 101, 101)',
    colorValueText: '#eee',
    animation: false
}).draw();

const throttleData = {
    labels: [],
    datasets: [
        { 
            label: 'Throttle', 
            data: [], 
            borderColor: '#21c05b', 
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            borderWidth: 3,
            tension: 0.1,
            pointRadius: 0,
            hoverRadius: 0,
            hidden: false 
        }
    ]
};

const brakeData = {
    labels: [],
    datasets: [
        { 
            label: 'Brake', 
            data: [], 
            borderColor: '#ed1212', 
            backgroundColor: 'rgba(221, 32, 32, 0.1)',
            borderWidth: 3,
            tension: 0.1,
            pointRadius: 0,
            hoverRadius: 0,
            hidden: false 
        }
    ]
};

const torqueDataFront = {
    labels: [],
    datasets: [
        { 
            label: 'FL', 
            data: [], 
            borderColor: '#2da6d9', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'FR', 
            data: [], 
            borderColor: '#cccccc', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'FL(FB)', 
            data: [], 
            borderColor: '#059669', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'FR(FB)', 
            data: [], 
            borderColor: '#fbbf24', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        }
    ]
};

const torqueDataRear = {
    labels: [],
    datasets: [
        { 
            label: 'RL', 
            data: [], 
            borderColor: '#2da6d9', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'RR', 
            data: [], 
            borderColor: '#cccccc', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'RL(FB)', 
            data: [], 
            borderColor: '#059669', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'RR(FB)', 
            data: [], 
            borderColor: '#fbbf24', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        }
    ]
};

const rpmData = {
    labels: [],
    datasets: [
        { 
            label: 'FL', 
            data: [], 
            borderColor: '#2da6d9', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'FR', 
            data: [], 
            borderColor: '#cccccc', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'RL', 
            data: [], 
            borderColor: '#059669', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        },
        { 
            label: 'RR', 
            data: [], 
            borderColor: '#fbbf24', 
            backgroundColor: 'rgba(24, 24, 27, 0.4)',
            borderWidth: 2.5,
            tension: 0.1,
            pointRadius: 0,
            hidden: false 
        }
    ]
};

// Error markers storage
const errorMarkers = [];

// Initialize charts
const throttleChart = new Chart(document.getElementById('throttle-chart'), {
    type: 'line',
    data: throttleData,
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: false,
            },
            y: {
                display: true,
                min: 0,
                max: 100,
                title: {
                    display: false,
                },
                ticks: {
                    stepSize: 20,
                    color: '#dddddd'
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                }
            }
        },
        plugins: {
            tooltip: { enabled: false, },
            legend: { display: false, },
            annotation: {
                annotations: {}
            }
        }
    }
});

const brakeChart = new Chart(document.getElementById('brake-chart'), {
    type: 'line',
    data: brakeData,
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: false,
            },
            y: {
                display: true,
                min: 0,
                max: 100,
                title: {
                    display: false,
                },
                ticks: {
                    stepSize: 20,
                    color: '#dddddd'
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                }
            }
        },
        plugins: {
            tooltip: { enabled: false, },
            legend: { display: false, },
            annotation: {
                annotations: {}
            }
        }
    }
});

const torqueChartFront = new Chart(document.getElementById('torque-chart-front'), {
    type: 'line',
    data: torqueDataFront,
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: true,
                title: {
                    display: false
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                },
                ticks: { 
                    display: true,
                    color: '#808080',
                    maxRotation: 45,
                    minRotation: 45,
                    autoSkip: true,
                    maxTicksLimit: 8,
                    font: {
                        size: 11
                    },
                    callback: function(value, index, ticks) {
                        // Show actual timestamps from data
                        return this.getLabelForValue(value);
                    }
                }
            },
            y: {
                display: true,
                min: -20,
                max: 20,
                title: {
                    display: true,
                    text: 'Torque (Nm)',
                    color: '#dddddd',
                    font: { size: 12 }
                },
                ticks: {
                    stepSize: 5,
                    color: '#dddddd'
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                }
            }
        },
        plugins: {
            tooltip: {
                enabled: true,
                padding: 12,                           
                titleColor: '#f4f4f5',                 
                bodyColor: '#d4d4d8',                  
                
                callbacks: {
                    labelColor: function(context) {
                        // Get the main line color of this dataset (FL, FR, etc.)
                        const datasetColor = context.dataset.borderColor;
                        
                        return {
                            // Force both the border AND the fill of the tooltip box 
                            // to use the dataset's main line color (eliminating the white fill)
                            borderColor: datasetColor,
                            backgroundColor: datasetColor,
                            borderWidth: 1,
                            borderRadius: 0 // rounded corners for the mini boxes
                        };
                    }
                }
            },
            legend: { 
                display: true,
                position: 'top',
                align: 'center',
                labels: {
                    color: '#dddddd',
                    usePointStyle: true,
                    pointStyle: 'rect',
                    boxWidth: 20,
                    boxHeight: 10,
                    padding: 15,
                    font: {
                        size: 12,
                        weight: 'bold'
                    }
                },
                onClick: function(e, legendItem, legend) {
                    const index = legendItem.datasetIndex;
                    const chart = legend.chart;
                    const meta = chart.getDatasetMeta(index);
                    meta.hidden = !meta.hidden;
                    chart.update();
                }
            },
            annotation: {
                annotations: {}
            }
        }
    }
});

const torqueChartRear = new Chart(document.getElementById('torque-chart-rear'), {
    type: 'line',
    data: torqueDataRear,
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: true,
                title: {
                    display: false
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                },
                ticks: { 
                    display: true,
                    color: '#808080',
                    maxRotation: 45,
                    minRotation: 45,
                    autoSkip: true,
                    maxTicksLimit: 8,
                    font: {
                        size: 11
                    },
                    callback: function(value, index, ticks) {
                        // Show actual timestamps from data
                        return this.getLabelForValue(value);
                    }
                }
            },
            y: {
                display: true,
                min: -20,
                max: 20,
                title: {
                    display: true,
                    text: 'Torque (Nm)',
                    color: '#dddddd',
                    font: { size: 12 }
                },
                ticks: {
                    stepSize: 5,
                    color: '#dddddd'
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                }
            }
        },
        plugins: {
            tooltip: {
                enabled: true,
                padding: 12,                           
                titleColor: '#f4f4f5',                 
                bodyColor: '#d4d4d8',                  
                
                callbacks: {
                    labelColor: function(context) {
                        // Get the main line color of this dataset (FL, FR, etc.)
                        const datasetColor = context.dataset.borderColor;
                        
                        return {
                            // Force both the border AND the fill of the tooltip box 
                            // to use the dataset's main line color (eliminating the white fill)
                            borderColor: datasetColor,
                            backgroundColor: datasetColor,
                            borderWidth: 1,
                            borderRadius: 0 // rounded corners for the mini boxes
                        };
                    }
                }
            },
            legend: { 
                display: true,
                position: 'top',
                align: 'center',
                labels: {
                    color: '#dddddd',
                    usePointStyle: true,
                    pointStyle: 'rect',
                    boxWidth: 20,
                    boxHeight: 10,
                    padding: 15,
                    font: {
                        size: 12,
                        weight: 'bold'
                    }
                },
                onClick: function(e, legendItem, legend) {
                    const index = legendItem.datasetIndex;
                    const chart = legend.chart;
                    const meta = chart.getDatasetMeta(index);
                    meta.hidden = !meta.hidden;
                    chart.update();
                }
            },
            annotation: {
                annotations: {}
            }
        }
    }
});

const rpmChart = new Chart(document.getElementById('rpm-chart'), {
    type: 'line',
    data: rpmData,
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        scales: {
            x: {
                display: true,
                title: {
                    display: false
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.3)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                },
                ticks: { 
                    display: true,
                    color: '#808080',
                    maxRotation: 45,
                    minRotation: 45,
                    autoSkip: true,
                    maxTicksLimit: 8,
                    font: {
                        size: 11
                    },
                    callback: function(value, index, ticks) {
                        // Show actual timestamps from data
                        return this.getLabelForValue(value);
                    }
                }
            },
            y: {
                display: true,
                min: 0,
                max: 12000,
                title: {
                    display: true,
                    text: 'RPM',
                    color: '#dddddd',
                    font: { size: 12 }
                },
                ticks: {
                    stepSize: 2000,
                    color: '#dddddd'
                },
                grid: { 
                    display: true,
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: true,
                    drawOnChartArea: true,
                    drawTicks: true,
                    lineWidth: 1
                }
            }
        },
        plugins: {
            tooltip: {
                enabled: true,
                backgroundColor: 'rgba(24, 24, 27, 0.9)', 
                borderColor: 'rgba(63, 63, 70, 0.6)',     
                borderWidth: 1,                        
                cornerRadius: 8,                       
                padding: 12,                           
                titleColor: '#f4f4f5',                 
                bodyColor: '#d4d4d8',                  
                
                callbacks: {
                    labelColor: function(context) {
                        // Get the main line color of this dataset (FL, FR, etc.)
                        const datasetColor = context.dataset.borderColor;
                        
                        return {
                            // Force both the border AND the fill of the tooltip box 
                            // to use the dataset's main line color (eliminating the white fill)
                            borderColor: datasetColor,
                            backgroundColor: datasetColor,
                            borderWidth: 1,
                            borderRadius: 0 // Slightly rounded corners for the mini boxes
                        };
                    }
                }
            },
            legend: { 
                display: true,
                position: 'top',
                align: 'center',
                labels: {
                    color: '#ffffff',
                    usePointStyle: true,
                    pointStyle: 'rect',
                    boxWidth: 20,
                    boxHeight: 10,
                    padding: 15,
                    font: {
                        size: 12,
                        weight: 'bold'
                    }
                },
                onClick: function(e, legendItem, legend) {
                    const index = legendItem.datasetIndex;
                    const chart = legend.chart;
                    const meta = chart.getDatasetMeta(index);
                    meta.hidden = !meta.hidden;
                    chart.update();
                }
            },
            annotation: {
                annotations: {}
            }
        }
    }
});

// WebSocket handlers
ws.onopen = () => {
    document.getElementById('connection-status').className = 'connection-indicator connected';
    document.getElementById('connection-text').textContent = 'Connected';
    document.querySelector('.status-dot').className = 'status-dot green';
};

ws.onclose = () => {
    document.getElementById('connection-status').className = 'connection-indicator disconnected';
    document.getElementById('connection-text').textContent = 'Disconnected';
    document.querySelector('.status-dot').className = 'status-dot red';
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    // update vehicle connection status
    if (data.vehicle_connected !== undefined) {
        if (data.vehicle_connected) {
            document.getElementById('connection-status').className = 'connection-indicator connected';
            document.getElementById('connection-text').textContent = 'Connected';
            document.getElementById('connection-text').style.color = '#10b981'; // emerald-500
            document.querySelector('.status-dot').className = 'status-dot green';
        } else {
            document.getElementById('connection-status').className = 'connection-indicator disconnected';
            document.getElementById('connection-text').textContent = 'Disconnected';
            document.getElementById('connection-text').style.color = '#ef4444'; // rose-500
            document.querySelector('.status-dot').className = 'status-dot red';
        }
    }
    
    updateDisplay(data);
};

// Error code lookup
const ERROR_CODES = {
    0x0000: 'NONE',
    0x0001: 'INSTANT_OC',
    0x0002: 'RMS_OC',
    0x0003: 'INV_OT',
    0x0004: 'MOT_OT',
    0x0005: 'ENC',
    0x0006: 'CAN_OT',
    0x0007: 'GATE',
    0x0008: 'HW_OC'
};

function getErrorCode(status) {
    if (!status || !Array.isArray(status) || status.length < 2) return '--';
    const errorCode = status[1];
    const errorName = ERROR_CODES[errorCode] || 'UNKNOWN';
    return `${errorName} (0x${errorCode.toString(16).toUpperCase().padStart(4, '0')})`;
}

function parseInverterStatus(status) {
    // Parse status word byte 0 for Ready(bit1), Enable(bit2), Fault(bit3), HV(bit4)
    if (!status || !Array.isArray(status) || status.length < 1) {
        return { ready: false, enable: false, fault: false, hv: false };
    }
    
    const statusByte = status[0];
    return {
        ready: (statusByte >> 1) & 0x01,
        enable: (statusByte >> 2) & 0x01,
        fault: (statusByte >> 3) & 0x01,
        hv: (statusByte >> 4) & 0x01
    };
}

function updateStatusLight(elementId, isOn, inverted = false) {
    const element = document.getElementById(elementId);
    if (!element) return;
    
    // For fault indicator, on=bad (red), off=good (green)
    if (inverted) {
        element.className = isOn ? 'status-light off' : 'status-light on';
    } else {
        element.className = isOn ? 'status-light on' : 'status-light off';
    }
}

function updateDisplay(data) {
    // Update message count and time
    const messageCount = data.message_count || 0;
    const messageCountEl = document.getElementById('message-count');
    if (messageCountEl) {
        messageCountEl.textContent = messageCount;
    }
    document.getElementById('floating-message-count').textContent = messageCount;
    
    // Update top bar controls
    // if (data.velocity && data.velocity.speed_kmh !== null) {
    //     const speed = Math.round(data.velocity.speed_kmh);
    //     // document.getElementById('speed-value').textContent = speed;
    //     speedGauge.value = speed;
    //     console.log(`Speed updated: ${speed} km/h`);
    // }

    // Update speed gauge
    let incomingSpeed = null;
    let totalRPM = 0;
    let motorCount = 0;

    // Calculate average RPM from all motors and convert to km/h
    if (data.inverters) {
        Object.values(data.inverters).forEach(motor => {
            if (motor.speed !== null && motor.speed !== undefined) {
                totalRPM += Math.abs(motor.speed);
                motorCount++;
            }
        });
        
        if (motorCount > 0) {
            const avgRPM = totalRPM / motorCount;
            incomingSpeed = avgRPM * 0.00709; // RPM to km/h conversion
        }
    }

    // Fallback to velocity data if inverter data wasn't found or was empty
    if ((incomingSpeed === null || incomingSpeed === 0) && data.velocity && data.velocity.speed_kmh !== null && data.velocity.speed_kmh !== undefined) {
        incomingSpeed = Math.abs(data.velocity.speed_kmh);
    }

    // Only update the gauge if we successfully calculated/found a valid speed metric.
    if (incomingSpeed !== null) {
        speedGauge.value = incomingSpeed;
    }

    if (data.vcu) {
        const appsPercent = data.vcu.accel || 0;
        const brakePercent = data.vcu.brake || 0;

        // 1. CRITICAL FIX: Push an empty string (or a timestamp) to the labels array
        // to give Chart.js an anchor point on the X-Axis.
        const timestamp = new Date().toLocaleTimeString(); // Or just use '' if you want it blank
        throttleData.labels.push(timestamp);
        throttleData.datasets[0].data.push(appsPercent);
        brakeData.labels.push(timestamp);
        brakeData.datasets[0].data.push(brakePercent);
        
        // 2. PERFORMANCE SAFEGUARD: Cap the maximum number of live telemetry points
        if (throttleData.labels.length > maxDataPoints) {
            throttleData.labels.shift();             // Remove oldest X-axis point
            throttleData.datasets[0].data.shift();   // Remove oldest Throttle data point
        }
        if (brakeData.labels.length > maxDataPoints) {
            brakeData.labels.shift();              // Remove oldest X-axis point
            brakeData.datasets[0].data.shift();    // Remove oldest Brake data point
        }
        
        document.getElementById('apps-value').textContent = appsPercent + '%';
        document.getElementById('apps-fill').style.height = appsPercent + '%';
        
        document.getElementById('brake-value').textContent = brakePercent + '%';
        document.getElementById('brake-fill').style.height = brakePercent + '%';

        throttleChart.update();
        brakeChart.update();
    }

    if (data.distance) {
        const distance = data.distance.trip_distance_km || 0;
        document.getElementById('trip-distance-value').textContent = distance.toFixed(2) + ' km';
    }

    // Update motor RPMs
    if (data.inverters) {
        const motorIds = ['fl', 'fr', 'rl', 'rr'];
        const motorMap = {
            'fl': 1, 'fr': 2, 'rl': 3, 'rr': 4
        };
        
        motorIds.forEach(motorId => {
            const motorNum = motorMap[motorId];
            const motor = data.inverters[motorNum];
            
            const valueElement = document.getElementById(`rpm-${motorId}-value`);
            const gaugeElement = document.getElementById(`rpm-${motorId}-gauge`);
            const speedElement = document.getElementById(`speed-${motorId}-value`);
            if (motor && motor.speed !== null && motor.speed !== undefined) {
                const rpm = Math.abs(motor.speed);
                
                if (valueElement) {
                    valueElement.textContent = Math.round(rpm);
                }
                const speedElement = document.getElementById(`speed-${motorId}-value`);
                if (speedElement) {
                    const speed = rpm * 0.00709; // RPM轉換為km/h
                    speedElement.textContent = `${speed.toFixed(1)} km/h`;
                }
                
                if (gaugeElement) {
                    const maxRPM = 8000;
                    const angle = Math.min(360, (rpm / maxRPM) * 360);
                    gaugeElement.style.setProperty('--gauge-angle', `${angle}deg`);
                }
            } else {
                if (valueElement) valueElement.textContent = '0';
                if (speedElement) speedElement.textContent = '0 km/h'; // 新增
                if (gaugeElement) gaugeElement.style.setProperty('--gauge-angle', '0deg');
            }
        });

        // Update charts
        updateCharts(data);

        // Update temperatures
        updateTemperatures(data);

        // Update status displays
        updateStatus(data);
    }
}

function updateCharts(data) {
    const now = new Date();
    const hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const timestamp = `${displayHours}:${minutes}:${seconds} ${ampm}`;

    // Add new data point
    if (torqueDataFront.labels.length >= maxDataPoints) {
        torqueDataFront.labels.shift();
        torqueDataFront.datasets.forEach(ds => ds.data.shift());
        
        // Shift all error marker positions as data scrolls left
        const annotations = torqueChartFront.options.plugins.annotation.annotations;
        Object.keys(annotations).forEach(key => {
            if (annotations[key].xMin > 0) {
                annotations[key].xMin--;
                annotations[key].xMax--;
            } else {
                // Remove markers that have scrolled off the left side
                delete annotations[key];
            }
        });
    }

    if (torqueDataRear.labels.length >= maxDataPoints) {
        torqueDataRear.labels.shift();
        rpmData.labels.shift();
        torqueDataRear.datasets.forEach(ds => ds.data.shift());
        rpmData.datasets.forEach(ds => ds.data.shift());
        
        // Shift all error marker positions as data scrolls left
        const annotations = torqueChartRear.options.plugins.annotation.annotations;
        Object.keys(annotations).forEach(key => {
            if (annotations[key].xMin > 0) {
                annotations[key].xMin--;
                annotations[key].xMax--;
            } else {
                // Remove markers that have scrolled off the left side
                delete annotations[key];
            }
        });
    }

    torqueDataFront.labels.push(timestamp);
    torqueDataRear.labels.push(timestamp);
    rpmData.labels.push(timestamp);

    // Update torque data: FL, FR, FL(FB), FR(FB)
    const fl = data.inverters[1];  // FL motor
    const fr = data.inverters[2];  // FR motor

    if (fl) {
        torqueDataFront.datasets[0].data.push(fl.target_torque || 0);  // FL target
        torqueDataFront.datasets[2].data.push(fl.torque || 0);  // FL feedback
        
        // Check for FL error
        if (fl.status && Array.isArray(fl.status) && fl.status.length >= 2) {
            const errorCode = fl.status[1];
            if (errorCode !== 0x0000 && errorCode !== null) {
                const markerId = `error-${Date.now()}-fl`;
                torqueChartFront.options.plugins.annotation.annotations[markerId] = {
                    type: 'line',
                    xMin: torqueDataFront.labels.length - 1,
                    xMax: torqueDataFront.labels.length - 1,
                    borderColor: '#ef4444',
                    borderWidth: 2.5,
                    label: {
                        display: true,
                        content: 'FL',
                        position: 'start',
                        color: '#ffffff',
                        backgroundColor: 'rgba(239, 68, 68, 0.8)'
                    }
                };
            }
        }
    } else {
        torqueDataFront.datasets[0].data.push(0);
        torqueDataFront.datasets[2].data.push(0);
    }
    
    if (fr) {
        torqueDataFront.datasets[1].data.push(fr.target_torque || 0);  // FR target
        torqueDataFront.datasets[3].data.push(fr.torque || 0);  // FR feedback
        
        // Check for FR error
        if (fr.status && Array.isArray(fr.status) && fr.status.length >= 2) {
            const errorCode = fr.status[1];
            if (errorCode !== 0x0000 && errorCode !== null) {
                const markerId = `error-${Date.now()}-fr`;
                torqueChartFront.options.plugins.annotation.annotations[markerId] = {
                    type: 'line',
                    xMin: torqueDataFront.labels.length - 1,
                    xMax: torqueDataFront.labels.length - 1,
                    borderColor: '#ef4444',
                    borderWidth: 2.5,
                    label: {
                        display: true,
                        content: 'FR',
                        position: 'start',
                        color: '#ffffff',
                        backgroundColor: 'rgba(239, 68, 68, 0.8)'
                    }
                };
            }
        }
    } else {
        torqueDataFront.datasets[1].data.push(0);
        torqueDataFront.datasets[3].data.push(0);
    }

    // Update torque data: RL, RR, RL(FB), RR(FB)
    const rl = data.inverters[3];  // RL motor
    const rr = data.inverters[4];  // RR motor
    
    if (rl) {
        torqueDataRear.datasets[0].data.push(rl.target_torque || 0);  // RL target
        torqueDataRear.datasets[2].data.push(rl.torque || 0);  // RL feedback
        
        // Check for RL error
        if (rl.status && Array.isArray(rl.status) && rl.status.length >= 2) {
            const errorCode = rl.status[1];
            if (errorCode !== 0x0000 && errorCode !== null) {
                const markerId = `error-${Date.now()}-rl`;
                torqueChartRear.options.plugins.annotation.annotations[markerId] = {
                    type: 'line',
                    xMin: torqueDataRear.labels.length - 1,
                    xMax: torqueDataRear.labels.length - 1,
                    borderColor: '#ef4444',
                    borderWidth: 2.5,
                    label: {
                        display: true,
                        content: 'RL',
                        position: 'start',
                        color: '#ffffff',
                        backgroundColor: 'rgba(239, 68, 68, 0.8)'
                    }
                };
            }
        }
    } else {
        torqueDataRear.datasets[0].data.push(0);
        torqueDataRear.datasets[2].data.push(0);
    }
    
    if (rr) {
        torqueDataRear.datasets[1].data.push(rr.target_torque || 0);  // RR target
        torqueDataRear.datasets[3].data.push(rr.torque || 0);  // RR feedback
        
        // Check for RR error
        if (rr.status && Array.isArray(rr.status) && rr.status.length >= 2) {
            const errorCode = rr.status[1];
            if (errorCode !== 0x0000 && errorCode !== null) {
                const markerId = `error-${Date.now()}-rr`;
                torqueChartRear.options.plugins.annotation.annotations[markerId] = {
                    type: 'line',
                    xMin: torqueDataRear.labels.length - 1,
                    xMax: torqueDataRear.labels.length - 1,
                    borderColor: '#ef4444',
                    borderWidth: 2.5,
                    label: {
                        display: true,
                        content: 'RR',
                        position: 'start',
                        color: '#ffffff',
                        backgroundColor: 'rgba(239, 68, 68, 0.8)'
                    }
                };
            }
        }
    } else {
        torqueDataRear.datasets[1].data.push(0);
        torqueDataRear.datasets[3].data.push(0);
    }

    // Update RPM data for all 4 motors (no error markers)
    for (let i = 1; i <= 4; i++) {
        const inv = data.inverters[i];
        if (inv) {
            rpmData.datasets[i - 1].data.push(inv.speed || 0);
            if (i === 3 && inv.speed !== null) {
                // RL motor speed is negative in some cases, take absolute value
                rpmData.datasets[i - 1].data[rpmData.datasets[i - 1].data.length - 1] = Math.abs(inv.speed);
            }
        } else {
            rpmData.datasets[i - 1].data.push(0);
        }
    }

    torqueChartFront.update();
    torqueChartRear.update();
    rpmChart.update();
}

function updateTemperatures(data) {
    const motors = ['fl', 'fr', 'rl', 'rr'];
    
    for (let i = 0; i < 4; i++) {
        const motorName = motors[i];
        const inv = data.inverters[i + 1];
        
        if (inv && inv.motor_temp !== null) {
            const temp = inv.motor_temp;
            const tempElement = document.getElementById(`temp-${motorName}`);
            const mosElement = document.getElementById(`temp-${motorName}-mos`);
            const mcuElement = document.getElementById(`temp-${motorName}-mcu`);
            
            tempElement.textContent = temp.toFixed(1) + '°C';
            
            // Color coding for motor temp
            if (temp < 50) {
                tempElement.className = 'temp-display cold';
            } else if (temp < 70) {
                tempElement.className = 'temp-display warm';
            } else {
                tempElement.className = 'temp-display hot';
            }
            
            // MOS temperature with color coding
            if (mosElement && inv.mos_temp !== null) {
                const mosTemp = inv.mos_temp;
                mosElement.textContent = mosTemp.toFixed(1) + '°C';
                if (mosTemp >= 70) {
                    mosElement.style.color = '#ef4444'; // Red
                } else {
                    mosElement.style.color = ''; // Default
                }
            }
            
            // MCU temperature with color coding
            if (mcuElement && inv.mcu_temp !== null) {
                const mcuTemp = inv.mcu_temp;
                mcuElement.textContent = mcuTemp.toFixed(1) + '°C';
                if (mcuTemp >= 70) {
                    mcuElement.style.color = '#ef4444'; // Red
                } else {
                    mcuElement.style.color = ''; // Default
                }
            }
        }
    }
}

function updateStatus(data) {
    const motors = ['fl', 'fr', 'rl', 'rr'];
    
    for (let i = 0; i < 4; i++) {
        const motorName = motors[i];
        const inv = data.inverters[i + 1];
        
        if (inv) {
            // Torque
            const torqueEl = document.getElementById(`status-${motorName}-torque`);
            if (torqueEl && inv.torque !== null) {
                torqueEl.textContent = inv.torque.toFixed(2);
            }
            
            // DC Voltage
            const voltageEl = document.getElementById(`status-${motorName}-voltage`);
            if (voltageEl && inv.dc_voltage !== null) {
                voltageEl.textContent = inv.dc_voltage.toFixed(1) + 'V';
            }
            
            // DC Current
            const currentEl = document.getElementById(`status-${motorName}-current`);
            if (currentEl && inv.dc_current !== null) {
                currentEl.textContent = inv.dc_current.toFixed(1) + 'A';
            }
            
            // Error Code
            const errorEl = document.getElementById(`status-${motorName}-error`);
            if (errorEl) {
                errorEl.textContent = getErrorCode(inv.status);
            }
            
            // Status lights (Ready, Enable, Fault, HV)
            const statusBits = parseInverterStatus(inv.status);
            updateStatusLight(`status-${motorName}-ready`, statusBits.ready);
            updateStatusLight(`status-${motorName}-enable`, statusBits.enable);
            updateStatusLight(`status-${motorName}-fault`, statusBits.fault, true); // Inverted: fault=bad
            updateStatusLight(`status-${motorName}-hv`, statusBits.hv);
            
            // Heartbeat
            const heartbeatEl = document.querySelector(`[data-inv="${i + 1}"]`);
            if (heartbeatEl) {
                if (inv.heartbeat === true) {
                    heartbeatEl.className = 'heartbeat-indicator heartbeat-ok';
                } else {
                    heartbeatEl.className = 'heartbeat-indicator heartbeat-fail';
                }
            }
        }
    }
}

// Initial data fetch
fetch('/api/data')
    .then(response => response.json())
    .then(data => updateDisplay(data))
    .catch(error => console.error('Error fetching initial data:', error));