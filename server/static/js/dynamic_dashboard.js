class NTURTDashboard {
    constructor() {
        this.websocket = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 3000;
        
        // Data storage
        this.lastData = null;
        this.torqueHistory = [];
        this.rpmHistory = [];
        this.maxHistoryPoints = 100;
        
        // Chart instances
        this.torqueChart = null;
        this.cellVoltageChart = null;
        this.cellTempChart = null;     
        
        // Initialize components
        this.initWebSocket();
        this.initCharts();
        this.initializeTireTempHeatmap();
        this.startHeartbeatCheck();

        console.log('NTURT Dashboard initialized - Version 2026-01-30 with vehicle connection detection');
    }

    closeWebSocket() {
        if (this.websocket) {
            // Remove event listeners to prevent them from firing during cleanup
            this.websocket.onopen = null;
            this.websocket.onmessage = null;
            this.websocket.onclose = null;
            this.websocket.onerror = null;
            
            // Check readyState before closing to avoid errors on already closed sockets
            if (this.websocket.readyState === WebSocket.OPEN || this.websocket.readyState === WebSocket.CONNECTING) {
                this.websocket.close();
            }
            this.websocket = null;
            this.isConnected = false;
            console.log('Previous WebSocket connection closed and cleaned up.');
        }
    }

    initWebSocket() {
        this.closeWebSocket(); // Ensure any old connection is cleaned up first

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${protocol}://${window.location.host}/ws`;
                
        try {
            this.websocket = new WebSocket(wsUrl);
            
            this.websocket.onopen = () => {
                this.isConnected = true;
                this.reconnectAttempts = 0;
                this.updateConnectionStatus(true);
                console.log('WebSocket connected');
            };
            
            this.websocket.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.lastData = data;
                    
                    // 更新车辆连接状态
                    if (data.vehicle_connected !== undefined) {
                        const statusElement = document.getElementById('connection-status');
                        const textElement = document.getElementById('connection-text');
                        
                        if (data.vehicle_connected) {
                            statusElement.className = 'connection-indicator connected';
                            textElement.textContent = 'Connected';
                        } else {
                            statusElement.className = 'connection-indicator disconnected';
                            textElement.textContent = 'Disconnected';
                        }
                    }
                    
                    this.updateDashboard(data);
                } catch (error) {
                    console.error('Error parsing WebSocket data:', error);
                }
            };
            
            this.websocket.onclose = () => {
                if (this.isConnected) { // Only log and schedule reconnect if it was a real connection
                    this.isConnected = false;
                    this.updateConnectionStatus(false);
                    console.log('WebSocket disconnected. Scheduling reconnect...');
                    this.scheduleReconnect();
                }
            };
            
            this.websocket.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.isConnected = false;
                this.updateConnectionStatus(false);
            };
            
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.updateConnectionStatus(false);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`Attempting to reconnect... (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
            setTimeout(() => {
                this.initWebSocket();
            }, this.reconnectDelay);
        } else {
            console.log('Max reconnection attempts reached');
            document.getElementById('connection-text').textContent = 'Connection failed';
        }
    }

    updateConnectionStatus(connected) {
        const statusElement = document.getElementById('connection-status');
        const textElement = document.getElementById('connection-text');
        
        if (connected) {
            statusElement.className = 'connection-indicator connected';
            textElement.textContent = 'Connected';
        } else {
            statusElement.className = 'connection-indicator disconnected';
            textElement.textContent = 'Disconnected';
        }
    }

    updateDashboard(data) {
        try {
            // Update message count and timestamp
            this.updateMessageCount(data.message_count);
            this.updateLastUpdate(data.update_time);
            
            // Update battery information bar
            this.updateBatteryInfo(data.accumulator);
            
            // Update VCU data (APPS and Brake bars)
            this.updateVCUData(data.vcu);
            
            // Update speed gauge with RPM conversion
            this.updateSpeedGauge(data.velocity, data.inverters);
            
            // Update trip distance
            this.updateTripDistance(data.distance);
            
            // Update RPM gauges for individual motors
            this.updateRPMGauges(data.inverters);
            
            // Update inverter status
            this.updateInverterStatus(data.inverters);
            
            // Update charts with new data
            this.updateCharts(data);
            
            // Update vcu status
            this.updateVCUStatus(data.vcu);

            // Update CAN logging status
            this.updateCANLoggingStatus(data.logging);

            // Update tire temp heatmaps
            this.updateTireTempHeatmaps(data.tire_temp);
        } catch (error) {
            console.error('Error updating dashboard:', error);
        }
    }

    updateMessageCount(count) {
        const element = document.getElementById('message-count');
        if (element && count !== undefined) {
            element.textContent = count.toLocaleString();
        }
    }

    updateLastUpdate(timestamp) {
        const element = document.getElementById('last-update');
        if (element && timestamp) {
            const date = new Date(timestamp);
            element.textContent = `Last update: ${date.toLocaleTimeString()}`;
        }
    }

    updateBatteryInfo(accumulator) {
        if (!accumulator) return;
        
        // Update SOC (State of Charge)
        if (accumulator.soc !== null && accumulator.soc !== undefined) {
            const socPercent = Math.max(0, Math.min(100, accumulator.soc));
            const socBar = document.getElementById('battery-soc-bar');
            const socValue = document.getElementById('battery-soc-value');
            
            if (socBar) {
                socBar.style.width = `${socPercent}%`;
                // 根據電量變更顏色
                if (socPercent > 50) {
                    socBar.className = 'battery-bar bg-green-500 h-full rounded transition-all duration-300';
                } else if (socPercent > 20) {
                    socBar.className = 'battery-bar bg-yellow-500 h-full rounded transition-all duration-300';
                } else {
                    socBar.className = 'battery-bar bg-red-500 h-full rounded transition-all duration-300';
                }
            }
            if (socValue) socValue.textContent = `${socPercent}%`;
        }
        
        // Update Battery Temperature
        if (accumulator.temperature !== null && accumulator.temperature !== undefined) {
            const tempValue = document.getElementById('battery-temp-value');
            if (tempValue) {
                tempValue.textContent = `${accumulator.temperature.toFixed(1)}°C`;
                // 根據溫度變更顏色
                if (accumulator.temperature > 60) {
                    tempValue.className = 'text-red-400 font-bold';
                } else if (accumulator.temperature > 45) {
                    tempValue.className = 'text-yellow-400 font-bold';
                } else {
                    tempValue.className = 'text-green-400 font-bold';
                }
            }
        }
        
        // Calculate and update Total Voltage (sum of all cell voltages)
        if (accumulator.cell_voltages && Array.isArray(accumulator.cell_voltages)) {
            let totalVoltage = 0;
            let validCells = 0;
            
            accumulator.cell_voltages.forEach(voltage => {
                if (voltage !== null && voltage !== undefined && voltage !== -13 && voltage > 0) {
                    totalVoltage += voltage;
                    validCells++;
                }
            });
            
            const voltageValue = document.getElementById('battery-voltage-value');
            if (voltageValue) {
                voltageValue.textContent = `${totalVoltage.toFixed(1)}V`;
            }
            
            // Update valid cells count
            const cellCountValue = document.getElementById('battery-cells-count');
            if (cellCountValue) {
                cellCountValue.textContent = `${validCells} cells`;
            }
        }
        
        // Update Pack Voltage from direct reading
        if (accumulator.voltage !== null && accumulator.voltage !== undefined) {
            const packVoltageValue = document.getElementById('battery-pack-voltage');
            if (packVoltageValue) {
                packVoltageValue.textContent = `${accumulator.voltage.toFixed(1)}V`;
            }
        }
        
        // Update Current
        if (accumulator.current !== null && accumulator.current !== undefined) {
            const currentValue = document.getElementById('battery-current-value');
            if (currentValue) {
                currentValue.textContent = `${accumulator.current.toFixed(2)}A`;
                // 根據電流方向變更顏色 (正值充電，負值放電)
                if (accumulator.current > 0) {
                    currentValue.className = 'text-green-400 font-bold';
                } else {
                    currentValue.className = 'text-orange-400 font-bold';
                }
            }
        }
    }

    updateVCUData(vcu) {
        if (!vcu) return;
        
        // Update APPS bar and value
        if (vcu.accel !== null && vcu.accel !== undefined) {
            const appsPercent = vcu.accel;
            const appsFill = document.getElementById('apps-fill');
            const appsValue = document.getElementById('apps-value');
            
            if (appsFill) appsFill.style.height = `${appsPercent}%`;
            if (appsValue) appsValue.textContent = `${appsPercent}%`;
        }
        
        // Update Brake bar and value
        if (vcu.brake !== null && vcu.brake !== undefined) {
            const brakePercent = Math.max(0, Math.min(100, vcu.brake));
            const brakeFill = document.getElementById('brake-fill');
            const brakeValue = document.getElementById('brake-value');
            
            if (brakeFill) brakeFill.style.height = `${brakePercent}%`;
            if (brakeValue) brakeValue.textContent = `${brakePercent}%`;
        }

        // Update APPS 1/2 and BSE 1/2 values
        document.getElementById('vcu-apps1').textContent = formatValue(vcu.apps1, '', 0);
        document.getElementById('vcu-apps2').textContent = formatValue(vcu.apps2, '', 0);
        document.getElementById('vcu-bse1').textContent = formatValue(vcu.bse1, '', 0);
        document.getElementById('vcu-bse2').textContent = formatValue(vcu.bse2, '', 0);
    }

    updateTripDistance(distance) {
        const distanceElement = document.getElementById('trip-distance-value');
        if (distance && distance.trip_distance_km !== null && distance.trip_distance_km !== undefined) {
            const distanceKm = parseFloat(distance.trip_distance_km);
            distanceElement.textContent = distanceKm.toFixed(2) + ' km';
        } else {
            distanceElement.textContent = '0.00 km';
        }
    }

    updateTripDistance(distance) {
        const distanceElement = document.getElementById('trip-distance-value');
        if (distance && distance.trip_distance_km !== null && distance.trip_distance_km !== undefined) {
            const distanceKm = parseFloat(distance.trip_distance_km);
            distanceElement.textContent = distanceKm.toFixed(2) + ' km';
        } else {
            distanceElement.textContent = '0.00 km';
        }
    }

    updateSpeedGauge(velocity, inverters) {
        let speed = 0;
        let totalRPM = 0;
        let motorCount = 0;
        
        // Calculate average RPM from all motors and convert to km/h
        if (inverters) {
            Object.values(inverters).forEach(motor => {
                if (motor.speed !== null && motor.speed !== undefined) {
                    totalRPM += Math.abs(motor.speed);
                    motorCount++;
                }
            });
            
            if (motorCount > 0) {
                const avgRPM = totalRPM / motorCount;
                speed = avgRPM * 0.00709; // RPM to km/h conversion
            }
        }
        
        // Fallback to velocity data if available
        if (speed === 0 && velocity && velocity.speed_kmh !== null) {
            speed = Math.abs(velocity.speed_kmh);
        }
        
        // Update speed display
        const speedValue = document.getElementById('speed-value');
        const rpmValue = document.getElementById('rpm-value');
        const speedGauge = document.getElementById('speed-gauge');
        
        if (speedValue) {
            speedValue.textContent = Math.round(speed);
        }
        
        if (rpmValue && motorCount > 0) {
            rpmValue.textContent = Math.round(speed / 0.00709); 
        }
        
        // Update gauge visual (0-200 km/h range)
        if (speedGauge) {
            const maxSpeed = 200;
            const angle = Math.min(360, (speed / maxSpeed) * 360);
            speedGauge.style.setProperty('--gauge-angle', `${angle}deg`);
        }
    }

    updateRPMGauges(inverters) {
        if (!inverters) return;
        
        const motorIds = ['fl', 'fr', 'rl', 'rr'];
        const motorMap = {
            'fl': 1, 'fr': 2, 'rl': 3, 'rr': 4
        };
        
        motorIds.forEach(motorId => {
            const motorNum = motorMap[motorId];
            const motor = inverters[motorNum];
            
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
    }

    updateInverterStatus(inverters) {
        if (!inverters) return;
        
        Object.entries(inverters).forEach(([invNum, data]) => {
            const invCards = document.querySelectorAll('.bg-slate-800');
            const invIndex = parseInt(invNum) - 1;
            
            if (invIndex >= 0 && invIndex < invCards.length) {
                const card = invCards[invIndex];
                
                // Update heartbeat indicator
                const heartbeatIndicator = card.querySelector('.heartbeat-indicator');
                if (heartbeatIndicator && data.heartbeat !== null) {
                    heartbeatIndicator.className = `heartbeat-indicator ${data.heartbeat ? 'heartbeat-ok' : 'heartbeat-fail'}`;
                }
                
                // Update status with visual indicators
                const statusContainer = card.querySelector('.inv-status-container');
                if (statusContainer && data.status !== null) {
                    const statusInfo = this.formatInverterStatus(data.status);
                    statusContainer.innerHTML = this.generateStatusHTML(statusInfo);
                }
                
                // Update other fields
                this.updateInverterField(card, '.inv-torque', data.torque !== null ? `${data.torque.toFixed(2)} Nm` : 'N/A');
                this.updateInverterField(card, '.inv-dc-voltage', data.dc_voltage !== null ? `${data.dc_voltage.toFixed(1)} V` : 'N/A');
                this.updateInverterField(card, '.inv-dc-current', data.dc_current !== null ? `${data.dc_current.toFixed(1)} A` : 'N/A');
                this.updateInverterField(card, '.inv-mos-temp', data.mos_temp !== null ? `${data.mos_temp.toFixed(1)}°C` : 'N/A');
                this.updateInverterField(card, '.inv-motor-temp', data.motor_temp !== null ? `${data.motor_temp.toFixed(1)}°C` : 'N/A');
                this.updateInverterField(card, '.inv-mcu-temp', data.mcu_temp !== null ? `${data.mcu_temp.toFixed(1)}°C` : 'N/A');
                this.updateInverterField(card, '.inv-heartbeat', data.heartbeat !== null ? (data.heartbeat ? 'OK' : 'Fail') : 'N/A');
            }
        });
    }

    updateInverterField(card, selector, value) {
        const element = card.querySelector(selector);
        if (element) {
            element.textContent = value;
            
            // Add status styling for status field
            if (selector === '.inv-status') {
                element.className = element.className.replace(/status-\w+/g, '');
                if (value === 'OK' || value === 'Ready') {
                    element.classList.add('status-ok');
                } else if (value === 'N/A' || value === 'Unknown') {
                    element.classList.add('status-unknown');
                } else {
                    element.classList.add('status-bad');
                }
            }
        }
    }

    generateStatusHTML(statusInfo) {
        if (typeof statusInfo === 'string') {
            return statusInfo;
        }
        
        const readyLight = statusInfo.ready ? 'status-light-green' : 'status-light-red';
        const enabledLight = statusInfo.enabled ? 'status-light-green' : 'status-light-red';
        const faultLight = statusInfo.fault ? 'status-light-red' : 'status-light-green';
        const hvLight = statusInfo.hv ? 'status-light-green' : 'status-light-red';
        
        const errorClass = statusInfo.errorCode === 0x0000 ? 'error-none' : 'error-active';
        
        return `
            <div class="status-indicators">
                <div class="status-row">
                    <span class="status-label">Ready:</span>
                    <span class="status-light ${readyLight}"></span>
                </div>
                <div class="status-row">
                    <span class="status-label">Enable:</span>
                    <span class="status-light ${enabledLight}"></span>
                </div>
                <div class="status-row">
                    <span class="status-label">Fault:</span>
                    <span class="status-light ${faultLight}"></span>
                </div>
                <div class="status-row">
                    <span class="status-label">HV:</span>
                    <span class="status-light ${hvLight}"></span>
                </div>
                <div class="error-info ${errorClass}">
                    <div class="error-text">${statusInfo.errorText}</div>
                    <div class="error-code">(0x${statusInfo.errorCode.toString(16).padStart(4, '0').toUpperCase()})</div>
                </div>
            </div>
        `;
    }

    getInverterStatus(status) {
        if (!status || status === null) return 'N/A';
        
        // Simple status interpretation - you may need to adjust based on your specific status codes
        if (Array.isArray(status)) {
            const [status1, status2] = status;
            if (status1 === 0 && status2 === 0) return 'OK';
            return `0x${status1.toString(16).padStart(2, '0')}${status2.toString(16).padStart(2, '0')}`;
        }
        
        return status.toString();
    }

    initCharts() {
        // Initialize Torque Chart
        const torqueCtx = document.getElementById('torque-chart');
        if (torqueCtx) {
            this.torqueChart = new Chart(torqueCtx, {
                type: 'line',
                data: {
                    labels: [],
                    datasets: [
                        {
                            label: 'FL Motor',
                            data: [],
                            borderColor: '#3b82f6',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'FR Motor',
                            data: [],
                            borderColor: '#10b981',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'FL Motor(FB)',
                            data: [],
                            borderColor: '#24acf6',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'FR Motor(FB)',
                            data: [],
                            borderColor: '#095b10',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'RL Motor',
                            data: [],
                            borderColor: '#f59e0b',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'RR Motor',
                            data: [],
                            borderColor: '#ef4444',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'RL Motor(FB)',
                            data: [],
                            borderColor: '#d0c63f',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        },
                        {
                            label: 'RR Motor(FB)',
                            data: [],
                            borderColor: '#a80000',
                            backgroundColor: 'rgba(0, 0, 0, 0.1)',
                            tension: 0.4,
                            pointRadius: 0
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            labels: { color: '#e2e8f0' }
                        }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#94a3b8' },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' }
                        },
                        y: {
                            min: -20,
                            max: 20,
                            ticks: { color: '#94a3b8' },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' },
                            title: {
                                display: true,
                                text: 'Torque (Nm)',
                                color: '#e2e8f0'
                            }
                        }
                    },
                    animation: { duration: 0 }
                }
            });
        }

        const errorBackgroundPlugin = {
            id: 'errorBackground',
            afterDatasetsDraw(chart) {
                if (!chart.statusHistory || chart.statusHistory.length === 0) return;
                
                // Check if there are ANY errors - if not, don't draw anything
                const hasAnyError = chart.statusHistory.some(status => status === true);
                if (!hasAnyError) return;
                
                const ctx = chart.ctx;
                const { left, top, width, height } = chart.chartArea;
                const dataLength = chart.data.labels.length;
                
                if (!ctx || dataLength === 0 || !chart.statusHistory) return;
                
                // Calculate pixel width per data point
                const pixelWidth = width / dataLength;
                
                let errorStartIndex = -1;
                
                for (let i = 0; i < chart.statusHistory.length; i++) {
                    const hasError = chart.statusHistory[i] === true;
                    
                    if (hasError && errorStartIndex === -1) {
                        errorStartIndex = i;
                    } else if (!hasError && errorStartIndex !== -1) {
                        // Draw rectangle for error range
                        const startX = left + (errorStartIndex * pixelWidth);
                        const endX = left + (i * pixelWidth);
                        
                        ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
                        ctx.fillRect(startX, top, endX - startX, height);
                        
                        errorStartIndex = -1;
                    }
                }
                
                // Handle error extending to end
                if (errorStartIndex !== -1) {
                    const startX = left + (errorStartIndex * pixelWidth);
                    const endX = left + width;
                    
                    ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
                    ctx.fillRect(startX, top, endX - startX, height);
                }
            }
        };

        Chart.register(errorBackgroundPlugin);

        // Initialize Cell Voltage Chart
        const cellVoltageCtx = document.getElementById('cell-voltage-chart');
        if (cellVoltageCtx) {
            this.cellVoltageChart = new Chart(cellVoltageCtx, {
                type: 'bar',
                data: {
                    labels: ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Group 6', 'Group 7'],
                    datasets: [{
                        label: 'Voltage Sum (V)',
                        data: [0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: 'rgba(234, 179, 8, 0.6)',
                        borderColor: '#eab308',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: '#e2e8f0' } }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#94a3b8' },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' }
                        },
                        y: {
                            ticks: { color: '#94a3b8' },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' },
                            title: {
                                display: true,
                                text: 'Voltage (V)',
                                color: '#e2e8f0'
                            }
                        }
                    },
                    animation: { duration: 0 }
                }
            });
        }

        // Initialize Cell Temperature Chart
        const cellTempCtx = document.getElementById('cell-temperature-chart');
        if (cellTempCtx) {
            this.cellTempChart = new Chart(cellTempCtx, {
                type: 'bar',
                data: {
                    labels: ['Group 1', 'Group 2', 'Group 3', 'Group 4', 'Group 5', 'Group 6', 'Group 7'],
                    datasets: [{
                        label: 'Temperature Avg (°C)',
                        data: [0, 0, 0, 0, 0, 0, 0],
                        backgroundColor: 'rgba(249, 115, 22, 0.6)',
                        borderColor: '#f97316',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { labels: { color: '#e2e8f0' } }
                    },
                    scales: {
                        x: {
                            ticks: { color: '#94a3b8' },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' }
                        },
                        y: {
                            ticks: { color: '#94a3b8' },
                            grid: { color: 'rgba(148, 163, 184, 0.1)' },
                            title: {
                                display: true,
                                text: 'Temperature (°C)',
                                color: '#e2e8f0'
                            }
                        }
                    },
                    animation: { duration: 0 }
                }
            });
        }
    }

    updateCharts(data) {
        const currentTime = data.timestamp ? new Date(data.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
        
        // Update Torque Chart
        if (this.torqueChart && data.inverters) {
            const torqueData = [
                data.inverters[1]?.target_torque || 0,
                data.inverters[2]?.target_torque || 0,
                data.inverters[1]?.torque || 0,
                data.inverters[2]?.torque || 0,
                data.inverters[3]?.target_torque || 0,
                data.inverters[4]?.target_torque || 0,
                data.inverters[3]?.torque || 0,
                data.inverters[4]?.torque || 0
            ];
            
            // Add new data point
            this.torqueChart.data.labels.push(currentTime);
            this.torqueChart.data.datasets.forEach((dataset, index) => {
                dataset.data.push(torqueData[index]);
            });
            
            // Limit data points AND sync statusHistory
            if (this.torqueChart.data.labels.length > this.maxHistoryPoints) {
                this.torqueChart.data.labels.shift();
                this.torqueChart.data.datasets.forEach(dataset => {
                    dataset.data.shift();
                });
                // TRIM statusHistory too!
                if (this.torqueChart.statusHistory && this.torqueChart.statusHistory.length > 0) {
                    this.torqueChart.statusHistory.shift();
                }
            }
            
            this.torqueChart.update('none');
        }

        // Update Cell Voltage Chart
        if (this.cellVoltageChart && data.accumulator && data.accumulator.cell_voltages) {
            const voltageGroups = this.processCellVoltages(data.accumulator.cell_voltages);
            this.cellVoltageChart.data.datasets[0].data = voltageGroups;
            this.cellVoltageChart.update('none');
        }

        // Update Cell Temperature Chart
        if (this.cellTempChart && data.accumulator && data.accumulator.cell_temperatures) {
            const tempGroups = this.processCellTemperatures(data.accumulator.cell_temperatures);
            this.cellTempChart.data.datasets[0].data = tempGroups;
            this.cellTempChart.update('none');
        }
    }

    initializeTireTempHeatmap() {
        const tireTempIds = ['tire-temp-fl', 'tire-temp-fr', 'tire-temp-rl', 'tire-temp-rr'];

        const width = 32;
        const height = 24;
       
        tireTempIds.forEach(id => {
            const element = document.getElementById(id);
            if (!element) return;

            const ctx = element.getContext('2d');
            const imageData = ctx.createImageData(width, height);
            const data = imageData.data;

            // generate a 2D matrix data
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    // initialize to 0
                    const rgb = getProgressiveColor(0);

                    // find the index in the flat 1D canvas array
                    const i = (y * width + x) * 4;

                    // Assign the data elements
                    data[i]     = rgb[0]; // R
                    data[i + 1] = rgb[1]; // G
                    data[i + 2] = rgb[2]; // B
                    data[i + 3] = 255;    // A
                }
            }

            // write the matrix pixel data back to the canvas context
            ctx.putImageData(imageData, 0, 0);
        });
    }

    updateTireTempHeatmaps(tireTemps) {
        if (!tireTemps) return;

        const width = 32; 
        const height = 24;

        const mapping = [
            { key: 1, id: 'tire-temp-fl' },
            { key: 2, id: 'tire-temp-fr' },
            { key: 3, id: 'tire-temp-rl' },
            { key: 4, id: 'tire-temp-rr' }
        ];

        mapping.forEach(({ key, id }) => {
            const element = document.getElementById(id);
            if (!element) return;

            const ctx = element.getContext('2d');
            const tireTempData = tireTemps[key];

            // cell_index might be 0
            if (!tireTempData || tireTempData.cell_index === null || !tireTempData.cell_temperatures) {
                console.log(`Invalid temperature data for tire ${key}`);
                return;
            }

            const startIdx = tireTempData.cell_index;
            const temps = tireTempData.cell_temperatures; // each temp maps to a whole column

            const imageData = ctx.getImageData(0, 0, width, height);
            const data = imageData.data;

            // loop through the 7 incoming temperature values
            for (let i = 0; i < temps.length; i++) {
                const colX = (startIdx * 7) + i;

                // ensure column fits within the canvas width boundaries
                if (colX < 0 || colX >= width) continue;

                const temp = temps[i];
                const [r, g, b] = getProgressiveColor(temp);

                // dill this column vertically
                for (let y = 0; y < height; y++) {
                    // map 2D grid coordinates (colX, y) to 1D index
                    const pixelIndex = (y * width) + colX;
                    const pixelStartIndex = pixelIndex * 4;

                    data[pixelStartIndex]     = r;     // red
                    data[pixelStartIndex + 1] = g;     // green
                    data[pixelStartIndex + 2] = b;     // blue
                    data[pixelStartIndex + 3] = 255;   // alpha
                }
            }

            ctx.putImageData(imageData, 0, 0);
        });
    }

    startHeartbeatCheck() {
        // Send periodic heartbeat to maintain WebSocket connection
        setInterval(() => {
            if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
                this.websocket.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 30000); // Send heartbeat every 30 seconds
    }

    processCellVoltages(voltages) {
        const groups = [];
        for (let i = 0; i < 7; i++) {
            let sum = 0;
            let count = 0;
            const startIndex = i * 15;
            const endIndex = Math.min(startIndex + 15, voltages.length);
            
            for (let j = startIndex; j < endIndex; j++) {
                if (voltages[j] !== null && voltages[j] !== undefined && voltages[j] !== -13) {
                    sum += voltages[j];
                    count++;
                }
            }
            groups.push(count > 0 ? sum : 0);
        }
        return groups;
    }

    processCellTemperatures(temperatures) {
        const groups = [];
        for (let i = 0; i < 7; i++) {
            let sum = 0;
            let count = 0;
            const startIndex = i * 32;
            const endIndex = Math.min(startIndex + 32, temperatures.length);
            
            for (let j = startIndex; j < endIndex; j++) {
                if (temperatures[j] !== null && temperatures[j] !== undefined && temperatures[j] !== -13) {
                    sum += temperatures[j];
                    count++;
                }
            }
            groups.push(count > 0 ? sum / count : 0);
        }
        return groups;
    }

    formatInverterStatus(status) {
        if (status === null || status === undefined) {
            return '<span class="status-unknown">N/A</span>';
        }
        
        let INVready = false;
        let INVenabled = false;
        let INVfault = false;
        let HV = false;
        
        for (let i = 0; i < 8; i++) {
            if ((status[0] >> i) & 0x01) {
                switch (i) {
                    case 1:
                        INVready = true;
                        break;
                    case 2:
                        INVenabled = true;
                        break;
                    case 3:
                        INVfault = true;
                        break;
                    case 4:
                        HV = true;
                        break;
                }
            }
        }
        
        let statusText3 = '';
        let ERRORstatus = status[1];
        
        switch (ERRORstatus) {
            case 0x0000:
                statusText3 = 'ERROR_NONE';
                break;
            case 0x0001:
                statusText3 = 'ERROR_INSTANT_OC';
                break;
            case 0x0002:
                statusText3 = 'ERROR_RMS_OC';
                break;
            case 0x0003:
                statusText3 = 'ERROR_INV_OT';
                break;
            case 0x0004:
                statusText3 = 'ERROR_MOT_OT';
                break;
            case 0x0005:
                statusText3 = 'ERROR_ENC';
                break;
            case 0x0006:
                statusText3 = 'ERROR_CAN_OT';
                break;
            case 0x0007:
                statusText3 = 'ERROR_GATE';
                break;
            case 0x0008:
                statusText3 = 'ERROR_HW_OC';
                break;
            default:
                statusText3 = 'Unknown Error';
                break;
        }
        
        return {
            ready: INVready,
            enabled: INVenabled,
            fault: INVfault,
            hv: HV,
            errorText: statusText3,
            errorCode: ERRORstatus
        };
    }

    // Clean up resources
    destroy() {
        this.closeWebSocket(); // Use the new robust cleanup method

        if (this.torqueChart) {
            this.torqueChart.destroy();
        }
        if (this.cellVoltageChart) {
            this.cellVoltageChart.destroy();
        }
        if (this.cellTempChart) {
            this.cellTempChart.destroy();
        }
    }

    updateVCUStatus(vcu) {
        if (!vcu) return;
        
        const statusList = document.getElementById('vcu-list');
        if (!statusList) return;
        
        const statusNames = vcu.status;
        
        // Process status names
        const activeStates = [];
        let hasError = false;
        
        if (!statusNames || statusNames.length === 0) {
            activeStates.push({ name: 'No Status', emoji: '❓', color: 'text-red-400' });
        } else if (Array.isArray(statusNames)) {
            statusNames.forEach(flagName => {
                const displayName = flagName.replace('STATE_', '');
                let emoji = '⚪';
                let color = 'text-slate-400';
                
                if (displayName.includes('ERROR')) {
                    emoji = '🔴';
                    color = 'text-red-400';
                    hasError = true;
                } else if (displayName.includes('RUNNING')) {
                    emoji = '🟢';
                    color = 'text-green-400';
                } else if (displayName.includes('RTD')) {
                    emoji = '🟡';
                    color = 'text-yellow-400';
                } else if (displayName === 'READY') {
                    emoji = '🟢';
                    color = 'text-green-400';
                }
                
                activeStates.push({ name: displayName, emoji, color });
            });
        } else {
            activeStates.push({ name: 'Invalid Format', emoji: '❓', color: 'text-slate-400' });
        }
        
        // Display in list
        statusList.innerHTML = activeStates.map(state => 
            `<div class="${state.color}">${state.emoji} ${state.name}</div>`
        ).join('');

        // Update torque graph with error indicator
        if (this.torqueChart) {
            if (!this.torqueChart.statusHistory) {
                this.torqueChart.statusHistory = [];
            }
            
            const currentDataLength = this.torqueChart.data.labels.length;
            
            if (this.torqueChart.statusHistory.length > currentDataLength) {
                this.torqueChart.statusHistory.splice(currentDataLength);
            }
            
            while (this.torqueChart.statusHistory.length < currentDataLength) {
                this.torqueChart.statusHistory.push(false);
            }
            
            if (currentDataLength > 0) {
                this.torqueChart.statusHistory[currentDataLength - 1] = hasError;
            }
            
            this.torqueChart.update('none');
        }

        const gearIndicator = document.getElementById('gear-indicator');
        const gearValue = vcu.gear;

        if (gearValue === null || gearValue === undefined) {
            gearIndicator.textContent = 'N/A';
            gearIndicator.parentElement.className = "ml-4 px-2 py-1 text-xs uppercase tracking-wider rounded text-red-400 border border-red-500/30";
        } else if (gearValue === 0) {
            gearIndicator.textContent = 'FORWARD';
            gearIndicator.parentElement.className = "ml-4 px-2 py-1 text-xs uppercase tracking-wider rounded text-blue-400 border border-blue-500/30";
        } else if (gearValue === 1) {
            gearIndicator.textContent = 'REVERSE';
            gearIndicator.parentElement.className = "ml-4 px-2 py-1 text-xs uppercase tracking-wider rounded text-yellow-400 border border-yellow-500/30";
        }
    }

    updateCANLoggingStatus(logging) {
        if (!logging) return;

        const canLoggingStatus = document.getElementById('can-logging-status');
        if (!canLoggingStatus) return;

        const isLogging = logging.status && logging.status !== 0;
        const colorClass = isLogging ? 'text-green-400' : 'text-white-400';
        const icon = isLogging ? '🟢 Logging' : '⚪ Idle';

        // handle timestamp (seconds)
        const timeString = logging.start_time 
            ? new Date(logging.start_time * 1000).toLocaleTimeString('en-US') 
            : 'N/A';

        canLoggingStatus.innerHTML = `
            <div class="${colorClass}">${icon}</div>
            <div class="${colorClass}">Started at: ${timeString}</div>
        `;
    }
}

// Initialize dashboard when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    window.dashboard = new NTURTDashboard();
    
    // Handle page unload
    window.addEventListener('beforeunload', () => {
        if (window.dashboard) {
            window.dashboard.destroy();
        }
    });
});

// Export for potential external use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NTURTDashboard;
}

function formatValue(value, suffix = '', decimals = 2) {
    if (value === null || value === undefined) {
        return 'N/A';
    }
    if (typeof value === 'number') {
        return value.toFixed(decimals) + suffix;
    }
    return value.toString() + suffix;
}

function getProgressiveColor(temp) {
    // clamp temperature between 0 and 100
    const clampedTemp = Math.max(0, Math.min(100, temp));

    // map 0 -> 100 to hue 240 (Blue) -> 0 (Red)
    const hue = 240 - (clampedTemp * 2.4);
    
    // HSL to RGB conversion formula
    return hslToRgb(hue, 100, 40);
}

function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    
    return [
        Math.round(255 * f(0)), // red
        Math.round(255 * f(8)), // green
        Math.round(255 * f(4))  // blue
    ];
}