// Scroll to specific segment
function scrollToSegment(type, segmentIndex) {
    // First expand the section if collapsed
    const contentId = type === 'voltage' ? 'voltages-content' : 'temperatures-content';
    const iconId = type === 'voltage' ? 'voltages-icon' : 'temperatures-icon';
    const content = document.getElementById(contentId);
    const icon = document.getElementById(iconId);
    
    // Expand if collapsed
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        icon.classList.remove('collapsed');
    }
    
    // Wait for expansion animation, then scroll
    setTimeout(() => {
        const targetId = type === 'voltage' ? `voltage-segment-${segmentIndex}` : `temp-segment-${segmentIndex}`;
        const targetElement = document.getElementById(targetId);
        
        if (targetElement) {
            // Scroll with offset for better visibility
            const yOffset = -100; // 100px offset from top
            const y = targetElement.getBoundingClientRect().top + window.pageYOffset + yOffset;
            
            window.scrollTo({
                top: y,
                behavior: 'smooth'
            });
            
            // Add highlight effect
            targetElement.style.transition = 'background-color 0.3s';
            targetElement.style.backgroundColor = 'rgba(50, 50, 50, 0.6)';
            setTimeout(() => {
                targetElement.style.backgroundColor = '';
            }, 1000);
        }
    }, 300); // Wait for collapse animation
}

// WebSocket connection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

// Connection handlers
ws.onopen = () => {
    console.log('Connected to WebSocket');
    document.getElementById('connection-status').className = 'connection-indicator connected';
    document.getElementById('connection-text').textContent = 'Connected';
    document.getElementById('connection-text').style.color = '#10b981'; // emerald-500
    document.querySelector('.status-dot').className = 'status-dot green';
};

ws.onclose = () => {
    console.log('Disconnected from WebSocket');
    document.getElementById('connection-status').className = 'connection-indicator disconnected';
    document.getElementById('connection-text').textContent = 'Disconnected';
    document.getElementById('connection-text').style.color = '#ef4444'; // rose-500
    document.querySelector('.status-dot').className = 'status-dot red';
};

ws.onerror = (error) => {
    console.error('WebSocket error:', error);
};

ws.onmessage = (event) => {
    try {
        const data = JSON.parse(event.data);
        
        // update vehicle connection status
        if (data.vehicle_connected !== undefined) {
            const statusDiv = document.getElementById('connection-status');
            if (data.vehicle_connected) {
                statusDiv.className = 'connection-indicator connected';
                statusDiv.innerHTML = '<span class="status-dot green"></span><span>Connected</span>';
            } else {
                statusDiv.className = 'connection-indicator disconnected';
                statusDiv.innerHTML = '<span class="status-dot red"></span><span>Disconnected</span>';
            }
        }

        updateDisplay(data);
    } catch (error) {
        console.error('Error parsing data:', error);
    }
};

// Initialize cell displays
function initializeCellDisplays() {
    // Initialize segment overview table
    const segmentOverviewTbody = document.getElementById('segment-overview-tbody');
    for (let seg = 0; seg < 7; seg++) {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td class="segment-name" style="color: #38bdf8;" onclick="scrollToSegment('voltage', ${seg})">Segment ${seg}</td>
            <td class="text-center voltage-cell" onclick="scrollToSegment('voltage', ${seg})">
                <span id="overview-seg${seg}-v-avg">--V</span>
            </td>
            <td class="text-center voltage-cell" onclick="scrollToSegment('voltage', ${seg})">
                <span id="overview-seg${seg}-v-max">--V</span>
            </td>
            <td class="text-center voltage-cell" onclick="scrollToSegment('voltage', ${seg})">
                <span id="overview-seg${seg}-v-min">--V</span>
            </td>
            <td class="text-center temp-cell" onclick="scrollToSegment('temperature', ${seg})">
                <span id="overview-seg${seg}-t-avg">--°C</span>
            </td>
            <td class="text-center temp-cell" onclick="scrollToSegment('temperature', ${seg})">
                <span id="overview-seg${seg}-t-max">--°C</span>
            </td>
            <td class="text-center temp-cell" onclick="scrollToSegment('temperature', ${seg})">
                <span id="overview-seg${seg}-t-min">--°C</span>
            </td>
        `;
        segmentOverviewTbody.appendChild(row);
    }

    // Initialize voltage cells (105 cells, 7 segments of 15 cells each)
    const voltageContainer = document.getElementById('cell-voltages-container');
    for (let seg = 0; seg < 7; seg++) {
        const segmentDiv = document.createElement('div');
        segmentDiv.className = 'mb-6';
        segmentDiv.id = `voltage-segment-${seg}`; // Add ID for scroll targeting
        
        // Segment header - UPDATED WITH TOTAL VOLTAGE
        const headerDiv = document.createElement('div');
        headerDiv.className = 'segment-header';
        headerDiv.innerHTML = `
            <div class="flex justify-between items-center">
                <span id="segment-label-${seg}" class="text-lg font-bold text-sky-400">Segment ${seg}</span>
                <span class="text-xl font-bold text-amber-400">
                    Total: <span id="seg${seg}-voltage-total">--V</span>
                </span>
            </div>
            <div class="mt-2">
                <span class="segment-stat">
                    <span class="segment-stat-label">Avg:</span>
                    <span class="segment-stat-value" id="seg${seg}-voltage-avg">--V</span>
                </span>
                <span class="segment-stat">
                    <span class="segment-stat-label">Max:</span>
                    <span class="segment-stat-value" id="seg${seg}-voltage-max">--V</span>
                </span>
                <span class="segment-stat">
                    <span class="segment-stat-label">Min:</span>
                    <span class="segment-stat-value" id="seg${seg}-voltage-min">--V</span>
                </span>
            </div>
        `;
        segmentDiv.appendChild(headerDiv);
        
        // Cell grid
        const cellGrid = document.createElement('div');
        cellGrid.className = 'grid grid-cols-5 md:grid-cols-10 lg:grid-cols-15 gap-2';
        for (let i = 0; i < 15; i++) {
            const cellIndex = seg * 15 + i;
            const cellDiv = document.createElement('div');
            cellDiv.className = 'cell-item cell-normal';
            cellDiv.id = `cell-v-${cellIndex}`;
            cellDiv.innerHTML = `
                <div class="cell-label">C${cellIndex}</div>
                <div class="cell-value">--</div>
            `;
            cellGrid.appendChild(cellDiv);
        }
        segmentDiv.appendChild(cellGrid);
        voltageContainer.appendChild(segmentDiv);
    }

    // Initialize temperature cells (224 cells, 7 segments of 32 cells each)
    const tempContainer = document.getElementById('cell-temperatures-container');
    for (let seg = 0; seg < 7; seg++) {
        const segmentDiv = document.createElement('div');
        segmentDiv.className = 'mb-6';
        segmentDiv.id = `temp-segment-${seg}`; // Add ID for scroll targeting
        
        // Segment header
        const headerDiv = document.createElement('div');
        headerDiv.className = 'segment-header';
        headerDiv.innerHTML = `
            <span class="text-lg font-bold text-sky-400">Segment ${seg}</span>
            <div class="mt-2">
                <span class="segment-stat">
                    <span class="segment-stat-label">Avg:</span>
                    <span class="segment-stat-value" id="seg${seg}-temp-avg">--°C</span>
                </span>
                <span class="segment-stat">
                    <span class="segment-stat-label">Max:</span>
                    <span class="segment-stat-value" id="seg${seg}-temp-max">--°C</span>
                </span>
                <span class="segment-stat">
                    <span class="segment-stat-label">Min:</span>
                    <span class="segment-stat-value" id="seg${seg}-temp-min">--°C</span>
                </span>
            </div>
        `;
        segmentDiv.appendChild(headerDiv);
        
        // Cell grid
        const cellGrid = document.createElement('div');
        cellGrid.className = 'grid grid-cols-4 md:grid-cols-8 lg:grid-cols-16 gap-2';
        for (let i = 0; i < 32; i++) {
            const cellIndex = seg * 32 + i;
            const cellDiv = document.createElement('div');
            cellDiv.className = 'cell-item cell-normal';
            cellDiv.id = `cell-t-${cellIndex}`;
            cellDiv.innerHTML = `
                <div class="cell-label">T${cellIndex}</div>
                <div class="cell-value">--</div>
            `;
            cellGrid.appendChild(cellDiv);
        }
        segmentDiv.appendChild(cellGrid);
        tempContainer.appendChild(segmentDiv);
    }
}

function updateDisplay(data) {
    // Update floating message count
    if (data.message_count !== null && data.message_count !== undefined) {
        document.getElementById('floating-message-count').textContent = data.message_count;
    }

    if (!data.accumulator) return;

    const acc = data.accumulator;

    // Update SOC
    if (acc.soc !== null && acc.soc !== undefined) {
        document.getElementById('acc-soc').textContent = acc.soc.toFixed(1) + '%';
    }

    // Update Current
    if (acc.current !== null && acc.current !== undefined) {
        const currentEl = document.getElementById('acc-current-main');
        currentEl.textContent = acc.current.toFixed(2) + 'A';
    }

    // Process cell voltages - calculate total and find max/min cells
    if (acc.cell_voltages && Array.isArray(acc.cell_voltages)) {
        let totalVoltage = 0;
        let validVoltages = 0;
        let maxCellVoltage = -Infinity;
        let minCellVoltage = Infinity;
        let maxCellIndex = -1;
        let minCellIndex = -1;

        // Find max/min across all cells
        for (let i = 0; i < acc.cell_voltages.length; i++) {
            const voltage = acc.cell_voltages[i];
            if (voltage !== null && voltage !== undefined) {
                totalVoltage += voltage;
                validVoltages++;
                
                if (voltage > maxCellVoltage) {
                    maxCellVoltage = voltage;
                    maxCellIndex = i;
                }
                if (voltage < minCellVoltage) {
                    minCellVoltage = voltage;
                    minCellIndex = i;
                }
            }
        }

        // Update total voltage display
        if (validVoltages > 0) {
            const voltageEl = document.getElementById('acc-voltage');
            voltageEl.textContent = totalVoltage.toFixed(2) + 'V';
            
            // Color code total voltage: white default, yellow >=439, red >=441
            if (totalVoltage >= 441) {
                voltageEl.className = 'stat-value text-red-400';
            } else if (totalVoltage >= 439) {
                voltageEl.className = 'stat-value text-amber-400';
            } else {
                voltageEl.className = 'stat-value text-white';
            }
            
            // Show max cell
            const maxSegment = Math.floor(maxCellIndex / 15);
            document.getElementById('acc-voltage-max-seg').textContent = `Cell ${maxCellIndex} (Seg ${maxSegment})`;
            
            const maxVoltageEl = document.getElementById('acc-voltage-max');
            maxVoltageEl.textContent = maxCellVoltage.toFixed(3) + 'V';
            // Color code max voltage: white default, yellow >=4.18, red >=4.2
            if (maxCellVoltage >= 4.2) {
                maxVoltageEl.style.color = '#ef4444';
            } else if (maxCellVoltage >= 4.18) {
                maxVoltageEl.style.color = '#eab308';
            } else {
                maxVoltageEl.style.color = '#ffffff';
            }
            
            // Show min cell
            const minSegment = Math.floor(minCellIndex / 15);
            document.getElementById('acc-voltage-min-seg').textContent = `Cell ${minCellIndex} (Seg ${minSegment})`;
            
            const minVoltageEl = document.getElementById('acc-voltage-min');
            minVoltageEl.textContent = minCellVoltage.toFixed(3) + 'V';
            // Color code min voltage: white default, yellow >=4.18, red >=4.2
            if (minCellVoltage >= 4.2) {
                minVoltageEl.style.color = '#ef4444';
            } else if (minCellVoltage >= 4.18) {
                minVoltageEl.style.color = '#eab308';
            } else {
                minVoltageEl.style.color = '#ffffff';
            }
        }
    }

    // Process cell temperatures - calculate average and find hottest cell
    if (acc.cell_temperatures && Array.isArray(acc.cell_temperatures)) {
        let totalTemp = 0;
        let validTemps = 0;
        let maxCellTemp = -Infinity;
        let maxCellTempIndex = -1;

        // Find max temp across all cells
        for (let i = 0; i < acc.cell_temperatures.length; i++) {
            const temp = acc.cell_temperatures[i];
            if (temp !== null && temp !== undefined && temp !== -13) {
                totalTemp += temp;
                validTemps++;
                
                if (temp > maxCellTemp) {
                    maxCellTemp = temp;
                    maxCellTempIndex = i;
                }
            }
        }

        // Update average temperature display
        if (validTemps > 0) {
            const avgTemp = totalTemp / validTemps;
            const tempElement = document.getElementById('acc-temp');
            tempElement.textContent = avgTemp.toFixed(1) + '°C';
            
            // Apply temperature color: white default, yellow >=50, red >=70
            if (avgTemp >= 70) {
                tempElement.className = 'stat-value text-red-400';
            } else if (avgTemp >= 50) {
                tempElement.className = 'stat-value text-amber-400';
            } else {
                tempElement.className = 'stat-value text-white';
            }

            // Show hottest cell
            const hottestSegment = Math.floor(maxCellTempIndex / 32);
            document.getElementById('acc-temp-max-seg').textContent = `Cell ${maxCellTempIndex} (Seg ${hottestSegment})`;
            
            const maxTempEl = document.getElementById('acc-temp-max');
            if (maxCellTemp !== -Infinity) {
                maxTempEl.textContent = maxCellTemp.toFixed(1) + '°C';
                // Color code max temperature: white default, yellow >=50, red >=70
                if (maxCellTemp >= 70) {
                    maxTempEl.style.color = '#ef4444';
                } else if (maxCellTemp >= 50) {
                    maxTempEl.style.color = '#eab308';
                } else {
                    maxTempEl.style.color = '#ffffff';
                }
            } else {
                maxTempEl.textContent = '--';
                maxTempEl.style.color = '#ffffff';
            }
        }
    }

    // Update status
    let hasError = false;
    let errorMessage = 'No Errors';

    if (acc.error_flags && acc.error_flags.length > 0) {
        hasError = acc.error_flags.some(flag => flag !== 0);
        if (hasError) {
            errorMessage = 'Error Detected';
        }
    }

    const statusText = document.getElementById('acc-status-text');
    if (hasError) {
        statusText.textContent = 'ERROR';
        statusText.className = 'text-red-400';
    } else {
        statusText.textContent = 'OK';
        statusText.className = 'text-emerald-600';
    }
    document.getElementById('acc-error-text').textContent = errorMessage;

    // Update cell voltages from flat array (105 cells, 15 per segment)
    if (acc.cell_voltages && Array.isArray(acc.cell_voltages)) {
        for (let segIdx = 0; segIdx < 7; segIdx++) {
            const startIdx = segIdx * 15;
            const endIdx = Math.min(startIdx + 15, acc.cell_voltages.length);
            
            // Collect voltages for this segment
            const voltages = [];
            for (let i = startIdx; i < endIdx; i++) {
                if (acc.cell_voltages[i] !== null && acc.cell_voltages[i] !== undefined) {
                    voltages.push(acc.cell_voltages[i]);
                }
            }

            if (voltages.length > 0) {
                const totalSegVoltage = voltages.reduce((a, b) => a + b, 0);
                const avgVoltage = totalSegVoltage / voltages.length;
                const maxVoltage = Math.max(...voltages);
                const minVoltage = Math.min(...voltages);

                // UPDATE SEGMENT TOTAL VOLTAGE
                const totalEl = document.getElementById(`seg${segIdx}-voltage-total`);
                if (totalEl) {
                    totalEl.textContent = totalSegVoltage.toFixed(2) + 'V';
                    // Color code total: white default, yellow >=62.7, red >=63
                    if (totalSegVoltage >= 63.0) {
                        totalEl.style.color = '#ef4444';
                    } else if (totalSegVoltage >= 62.7) {
                        totalEl.style.color = '#eab308';
                    } else {
                        totalEl.style.color = '#ffffff';
                    }
                }

                // Update segment overview
                const overviewAvgEl = document.getElementById(`overview-seg${segIdx}-v-avg`);
                if (overviewAvgEl) {
                    overviewAvgEl.textContent = avgVoltage.toFixed(3) + 'V';
                    // Color coding: white default, yellow >=4.18, red >=4.2
                    if (avgVoltage >= 4.2) {
                        overviewAvgEl.style.color = '#ef4444';
                    } else if (avgVoltage >= 4.18) {
                        overviewAvgEl.style.color = '#eab308';
                    } else {
                        overviewAvgEl.style.color = '#ffffff';
                    }
                }
                
                const overviewMaxEl = document.getElementById(`overview-seg${segIdx}-v-max`);
                if (overviewMaxEl) {
                    overviewMaxEl.textContent = maxVoltage.toFixed(3) + 'V';
                    if (maxVoltage >= 4.2) {
                        overviewMaxEl.style.color = '#ef4444';
                    } else if (maxVoltage >= 4.18) {
                        overviewMaxEl.style.color = '#eab308';
                    } else {
                        overviewMaxEl.style.color = '#ffffff';
                    }
                }
                
                const overviewMinEl = document.getElementById(`overview-seg${segIdx}-v-min`);
                if (overviewMinEl) {
                    overviewMinEl.textContent = minVoltage.toFixed(3) + 'V';
                    if (minVoltage >= 4.2) {
                        overviewMinEl.style.color = '#ef4444';
                    } else if (minVoltage >= 4.18) {
                        overviewMinEl.style.color = '#eab308';
                    } else {
                        overviewMinEl.style.color = '#ffffff';
                    }
                }

                // Update segment header
                const avgEl = document.getElementById(`seg${segIdx}-voltage-avg`);
                if (avgEl) {
                    avgEl.textContent = avgVoltage.toFixed(3) + 'V';
                    // Color code segment average: white default, yellow >=4.18, red >=4.2
                    if (avgVoltage >= 4.2) {
                        avgEl.className = 'segment-stat-value text-red-400';
                    } else if (avgVoltage >= 4.18) {
                        avgEl.className = 'segment-stat-value text-yellow-400';
                    } else {
                        avgEl.className = 'segment-stat-value text-white';
                    }
                }

                const maxEl = document.getElementById(`seg${segIdx}-voltage-max`);
                if (maxEl) {
                    maxEl.textContent = maxVoltage.toFixed(3) + 'V';
                    // Color code max: white default, yellow >=4.18, red >=4.2
                    if (maxVoltage >= 4.2) {
                        maxEl.className = 'segment-stat-value text-red-400';
                    } else if (maxVoltage >= 4.18) {
                        maxEl.className = 'segment-stat-value text-yellow-400';
                    } else {
                        maxEl.className = 'segment-stat-value text-white';
                    }
                }

                const minEl = document.getElementById(`seg${segIdx}-voltage-min`);
                if (minEl) {
                    minEl.textContent = minVoltage.toFixed(3) + 'V';
                    // Color code min: white default, yellow >=4.18, red >=4.2
                    if (minVoltage >= 4.2) {
                        minEl.className = 'segment-stat-value text-red-400';
                    } else if (minVoltage >= 4.18) {
                        minEl.className = 'segment-stat-value text-yellow-400';
                    } else {
                        minEl.className = 'segment-stat-value text-white';
                    }
                }

                // if max - min > 0.06V, highlight segment header and turn label red
                const headerEl = document.getElementById(`voltage-segment-${segIdx}`);
                const segmentLabel = document.getElementById(`segment-label-${segIdx}`);
                if (headerEl && segmentLabel) {
                    if ((maxVoltage - minVoltage) > 0.06) {
                        segmentLabel.className = 'text-lg font-bold text-red-400 bg-red-900 bg-opacity-30 px-2 py-1 rounded';
                    } else {
                        segmentLabel.className = 'text-lg font-bold text-sky-400';     
                    }
                }

                // Update individual cells
                for (let i = startIdx; i < endIdx; i++) {
                    const voltage = acc.cell_voltages[i];
                    const cellEl = document.getElementById(`cell-v-${i}`);
                    if (cellEl && voltage !== null && voltage !== undefined) {
                        const valueEl = cellEl.querySelector('.cell-value');
                        valueEl.textContent = voltage.toFixed(3);

                        // Color code cell: white default, yellow >=4.18, red >=4.2
                        if (voltage >= 4.2) {
                            cellEl.className = 'cell-item cell-danger';
                            valueEl.className = 'cell-value text-red-400';
                        } else if (voltage >= 4.18) {
                            cellEl.className = 'cell-item cell-warning';
                            valueEl.className = 'cell-value text-yellow-400';
                        } else {
                            cellEl.className = 'cell-item cell-normal';
                            valueEl.className = 'cell-value text-white';
                        }
                    }
                }
            }
        }
    }

    // Update cell temperatures from flat array (224 cells, 32 per segment)
    if (acc.cell_temperatures && Array.isArray(acc.cell_temperatures)) {
        for (let segIdx = 0; segIdx < 7; segIdx++) {
            const startIdx = segIdx * 32;
            const endIdx = Math.min(startIdx + 32, acc.cell_temperatures.length);
            
            // Collect temperatures for this segment
            const validTemps = [];
            const allTemps = [];
            for (let i = startIdx; i < endIdx; i++) {
                const temp = acc.cell_temperatures[i];
                if (temp !== null && temp !== undefined) {
                    allTemps.push(temp);
                    if (temp !== -13) {
                        validTemps.push(temp);
                    }
                }
            }
            
            if (allTemps.length > 0) {
                const avgTemp = validTemps.length > 0 ? validTemps.reduce((a, b) => a + b, 0) / validTemps.length : 0;
                const maxTemp = Math.max(...allTemps);
                const minTemp = Math.min(...validTemps);

                // Update segment overview
                const overviewAvgEl = document.getElementById(`overview-seg${segIdx}-t-avg`);
                if (overviewAvgEl) {
                    overviewAvgEl.textContent = avgTemp.toFixed(1) + '°C';
                    // Color coding: white default, yellow >=50, red >=70
                    if (avgTemp >= 70) {
                        overviewAvgEl.style.color = '#ef4444';
                    } else if (avgTemp >= 50) {
                        overviewAvgEl.style.color = '#eab308';
                    } else {
                        overviewAvgEl.style.color = '#ffffff';
                    }
                }
                
                const overviewMaxEl = document.getElementById(`overview-seg${segIdx}-t-max`);
                if (overviewMaxEl) {
                    overviewMaxEl.textContent = maxTemp.toFixed(1) + '°C';
                    if (maxTemp >= 70) {
                        overviewMaxEl.style.color = '#ef4444';
                    } else if (maxTemp >= 50) {
                        overviewMaxEl.style.color = '#eab308';
                    } else {
                        overviewMaxEl.style.color = '#ffffff';
                    }
                }
                
                const overviewMinEl = document.getElementById(`overview-seg${segIdx}-t-min`);
                if (overviewMinEl) {
                    overviewMinEl.textContent = minTemp.toFixed(1) + '°C';
                    // Show error color for sensor errors (-13)
                    if (minTemp === -13) {
                        overviewMinEl.style.color = '#ef4444';  // Red for sensor error
                    } else if (minTemp >= 70) {
                        overviewMinEl.style.color = '#ef4444';
                    } else if (minTemp >= 50) {
                        overviewMinEl.style.color = '#eab308';
                    } else {
                        overviewMinEl.style.color = '#ffffff';
                    }
                }

                // Update segment header
                const avgEl = document.getElementById(`seg${segIdx}-temp-avg`);
                if (avgEl) {
                    avgEl.textContent = avgTemp.toFixed(1) + '°C';
                    // Color code average: white default, yellow >=50, red >=70
                    if (avgTemp >= 70) {
                        avgEl.className = 'segment-stat-value text-red-400';
                    } else if (avgTemp >= 50) {
                        avgEl.className = 'segment-stat-value text-yellow-400';
                    } else {
                        avgEl.className = 'segment-stat-value text-white';
                    }
                }

                const maxEl = document.getElementById(`seg${segIdx}-temp-max`);
                if (maxEl) {
                    maxEl.textContent = maxTemp.toFixed(1) + '°C';
                    // Color code max: white default, yellow >=50, red >=70
                    if (maxTemp >= 70) {
                        maxEl.className = 'segment-stat-value text-red-400';
                    } else if (maxTemp >= 50) {
                        maxEl.className = 'segment-stat-value text-yellow-400';
                    } else {
                        maxEl.className = 'segment-stat-value text-white';
                    }
                }

                const minEl = document.getElementById(`seg${segIdx}-temp-min`);
                if (minEl) {
                    minEl.textContent = minTemp.toFixed(1) + '°C';
                    // Show error color for sensor errors (-13)
                    if (minTemp === -13) {
                        minEl.className = 'segment-stat-value text-red-400';  // Red for sensor error
                    } else if (minTemp >= 70) {
                        minEl.className = 'segment-stat-value text-red-400';
                    } else if (minTemp >= 50) {
                        minEl.className = 'segment-stat-value text-yellow-400';
                    } else {
                        minEl.className = 'segment-stat-value text-white';
                    }
                }

                // Update individual cells
                for (let i = startIdx; i < endIdx; i++) {
                    const temp = acc.cell_temperatures[i];
                    const cellEl = document.getElementById(`cell-t-${i}`);
                    if (cellEl && temp !== null && temp !== undefined) {
                        const valueEl = cellEl.querySelector('.cell-value');
                        valueEl.textContent = temp.toFixed(1);

                        // Color code cell: red for -13 (sensor error), otherwise normal rules
                        if (temp === -13) {
                            cellEl.className = 'cell-item cell-danger';
                            valueEl.className = 'cell-value text-red-400';
                        } else if (temp >= 70) {
                            cellEl.className = 'cell-item cell-danger';
                            valueEl.className = 'cell-value text-red-400';
                        } else if (temp >= 50) {
                            cellEl.className = 'cell-item cell-warning';
                            valueEl.className = 'cell-value text-yellow-400';
                        } else {
                            cellEl.className = 'cell-item cell-normal';
                            valueEl.className = 'cell-value text-white';
                        }
                    }
                }
            }
        }
    }
}

// Initialize on load
window.addEventListener('load', () => {
    initializeCellDisplays();
});