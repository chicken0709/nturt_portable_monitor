// WebSocket Connection
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

ws.onopen = function() {
    document.getElementById('connection-status').className = 'connection-indicator connected';
    document.getElementById('connection-text').textContent = 'Connected';
};

ws.onclose = function() {
    document.getElementById('connection-status').className = 'connection-indicator disconnected';
    document.getElementById('connection-text').textContent = 'Disconnected';
};

// Three.js 3D Setup
let scene, camera, renderer, vehicleMesh;

function init3D() {
    const container = document.getElementById('canvas-container');
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.z = 5;
    camera.position.y = 2;
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true});
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(10, 10, 10);
    scene.add(directionalLight);

    // --- STL model loading ---
    const loader = new THREE.STLLoader();
    
    loader.load('/static/models/racecar.STL', function (geometry) {
        
        // center the geometry pivot point so it rotates smoothly around its center of mass
        geometry.center();

        // define the material
        const material = new THREE.MeshPhongMaterial({ 
            color: 0xaaaaaa,
            shininess: 0,
            flatShading: false
        });

        // create the mesh
        vehicleMesh = new THREE.Mesh(geometry, material); 

        // scale adjustment
        vehicleMesh.scale.set(0.00175, 0.00175, 0.00175);

        vehicleMesh.position.y = 0.8; // raise the car slightly above the grid

        // add to layout
        scene.add(vehicleMesh);

    }, function (xhr) {
        console.log((xhr.loaded / xhr.total * 100) + '% loaded');
    }, function (error) {
        console.error('An error occurred while loading car.stl:', error);
    });

    // Grid
    const gridHelper = new THREE.GridHelper(16, 16, 0x262626, 0x262626);
    gridHelper.position.y = -0.5;
    scene.add(gridHelper);

    animate3D();
}

function animate3D() {
    requestAnimationFrame(animate3D);
    renderer.render(scene, camera);
}

function updateVehicleOrientation(roll, pitch, yaw) {
    if (vehicleMesh) {
        const toRadians = Math.PI / 180;
        vehicleMesh.rotation.set(
            (pitch || 0) * toRadians,
            (yaw || 0) * toRadians,
            (roll || 0) * toRadians,
            'XYZ'
        );
    }
}

// Chart Setup
const chartConfig = {
    type: 'line',
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        elements: {
            point: {
                radius: 0      // hide the point dots
            }
        },
        scales: {
            x: {
                display: false,
                grid: {
                    color: 'rgba(181, 181, 181, 0.3)'
                },
                ticks: {
                    display: false 
                }
            },
            y: {
                grid: {
                    color: 'rgba(181, 181, 181, 0.3)'
                },
                ticks: {
                    color: '#dddddd'
                }
            }
        },
        plugins: {
            legend: {
                labels: {
                    color: '#ffffff'
                }
            }
        }
    }
};

const accelChart = new Chart(document.getElementById('accel-chart'), {
    ...chartConfig,
    data: {
        labels: Array(50).fill(''),
        datasets: [
            {
                label: 'X',
                data: Array(50).fill(0),
                borderColor: '#2da6d9',
                backgroundColor: 'rgba(24, 24, 27, 0.4)',
                borderWidth: 3,
                tension: 0.4
            },
            {
                label: 'Y',
                data: Array(50).fill(0),
                borderColor: '#cccccc',
                backgroundColor: 'rgba(24, 24, 27, 0.4)',
                borderWidth: 3,
                tension: 0.4
            },
            {
                label: 'Z',
                data: Array(50).fill(0),
                borderColor: '#059669',
                backgroundColor: 'rgba(24, 24, 27, 0.4)',
                borderWidth: 3,
                tension: 0.4
            }
        ]
    }
});

const gyroChart = new Chart(document.getElementById('gyro-chart'), {
    ...chartConfig,
    data: {
        labels: Array(50).fill(''),
        datasets: [
            {
                label: 'X',
                data: Array(50).fill(0),
                borderColor: '#2da6d9',
                backgroundColor: 'rgba(24, 24, 27, 0.4)',
                borderWidth: 3,
                tension: 0.4
            },
            {
                label: 'Y',
                data: Array(50).fill(0),
                borderColor: '#cccccc',
                backgroundColor: 'rgba(24, 24, 27, 0.4)',
                borderWidth: 3,
                tension: 0.4
            },
            {
                label: 'Z',
                data: Array(50).fill(0),
                borderColor: '#059669',
                backgroundColor: 'rgba(24, 24, 27, 0.4)',
                borderWidth: 3,
                tension: 0.4
            }
        ]
    }
});

function updateChart(chart, x, y, z) {
    chart.data.datasets[0].data.shift();
    chart.data.datasets[0].data.push(x || 0);
    chart.data.datasets[1].data.shift();
    chart.data.datasets[1].data.push(y || 0);
    chart.data.datasets[2].data.shift();
    chart.data.datasets[2].data.push(z || 0);
    chart.update('none');
}

// traction circle chart
const tractionChartConfig = {
    type: 'scatter',
    data: {
        datasets: [{
            data: [{ x: 0, y: 0 }], 
            backgroundColor: '#dddddd', 
            pointRadius: 6,
            pointHoverRadius: 6,
            showLine: false
        }]
    },
    options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 1, 
        clip: false,    
        animation: false,
        layout: { padding: 0 },
        scales: {
            x: {
                min: -2,
                max: 2,
                position: 'center',
                grid: { color: 'rgba(150, 150, 150, 0.3)' },
                // ticks: { 
                //     stepSize: 0.5,
                //     color: '#dddddd',
                //     callback: function(value) {
                //         if (value === 1 || value === 2 || value === -1 || value === -2) {
                //             return value + 'g';
                //         }
                //         return '';
                //     } 
                // }
                ticks: { stepSize: 0.5, display: false }
            },
            y: {
                min: -2,
                max: 2,
                position: 'center',
                grid: { color: 'rgba(150, 150, 150, 0.3)' },
                // ticks: { 
                //     stepSize: 0.5,
                //     color: '#dddddd', 
                //     callback: function(value) {
                //         if (value === 1 || value === 2 || value === -1 || value === -2) {
                //             return value + 'g';
                //         }
                //         return '';
                //     }
                // }
                ticks: { stepSize: 0.5, display: false }
            }
        },
        plugins: {
            legend: { display: false },
            annotation: {
                annotations: {
                    innerCircle: {
                        type: 'ellipse',
                        xMin: -1, xMax: 1, yMin: -1, yMax: 1,
                        backgroundColor: 'transparent',
                        borderColor: '#2da6d9',
                        borderWidth: 3
                    },
                    outerCircle: {
                        type: 'ellipse',
                        xMin: -2, xMax: 2, yMin: -2, yMax: 2,
                        backgroundColor: 'transparent',
                        borderColor: '#2da6d9',
                        borderWidth: 3
                    }
                }
            }
        }
    },
};

// Initialize
const tractionChart = new Chart(document.getElementById('traction-chart'), tractionChartConfig);

function updateLiveGForce(latG, longG) {
    tractionChart.data.datasets[0].data[0] = { x: latG, y: longG };
    tractionChart.update();
}

// Data Update Functions
function formatValue(value, decimals = 3) {
    if (value === null || value === undefined) return 'N/A';
    return typeof value === 'number' ? value.toFixed(decimals) : 'N/A';
}

function updateSteeringWheel(angle) {
    if (angle !== null && angle !== undefined) {
        const wheel = document.getElementById('steering-wheel');
        const rotation = -angle; // Invert angle for correct visual direction
        wheel.style.transform = `rotate(${rotation}deg)`;
        document.getElementById('steering-angle').textContent = formatValue(rotation, 1) + '°';
    }
}

function updateSuspension(fl, fr, rl, rr) {
    if (fl !== null && fl !== undefined) {
        // Normalize to percentage (assuming range 0-12 cm)
        const frontPercent = ((fl * 100) / 12) * 100;
        document.getElementById('susp-fl-fill').style.height = Math.max(0, Math.min(100, frontPercent)) + '%';
        document.getElementById('susp-fl-value').textContent = formatValue(fl * 100, 2) + 'cm';
    }

    if (rl !== null && rl !== undefined) {
        // Normalize to percentage (assuming range 0-12 cm)
        const rearPercent = ((rl * 100) / 12) * 100;
        document.getElementById('susp-rl-fill').style.height = Math.max(0, Math.min(100, rearPercent)) + '%';
        document.getElementById('susp-rl-value').textContent = formatValue(rl * 100, 2) + 'cm';
    }

    if (fr !== null && fr !== undefined) {
        // Normalize to percentage (assuming range 0-12 cm)
        const frontRightPercent = ((fr * 100) / 12) * 100;
        document.getElementById('susp-fr-fill').style.height = Math.max(0, Math.min(100, frontRightPercent)) + '%';
        document.getElementById('susp-fr-value').textContent = formatValue(fr * 100, 2) + 'cm';
    }

    if (rr !== null && rr !== undefined) {
        // Normalize to percentage (assuming range 0-12 cm)
        const rearRightPercent = ((rr * 100) / 12) * 100;
        document.getElementById('susp-rr-fill').style.height = Math.max(0, Math.min(100, rearRightPercent)) + '%';
        document.getElementById('susp-rr-value').textContent = formatValue(rr * 100, 2) + 'cm';
    }
}

function updateEulerFromXsens(euler) {
    if (!euler) return;

    document.getElementById('euler-roll').textContent = formatValue(euler.roll, 2) + '°';
    document.getElementById('euler-pitch').textContent = formatValue(euler.pitch, 2) + '°';
    document.getElementById('euler-yaw').textContent = formatValue(euler.yaw, 2) + '°';

    if (typeof euler.roll === 'number' && typeof euler.pitch === 'number' && typeof euler.yaw === 'number') {
        updateVehicleOrientation(euler.roll, euler.pitch, euler.yaw);
    }
}

function updateXsensMotion(xsens) {
    if (!xsens) return;

    const acceleration = xsens.acceleration || {};
    const freeAcceleration = xsens.free_acceleration || {};
    const rateOfTurn = xsens.rate_of_turn || {};
    const magnetic = xsens.magnetic_field || {};

    document.getElementById('imu1-accel-km6-x').textContent = formatValue(acceleration.acc_x);
    document.getElementById('imu1-accel-km6-y').textContent = formatValue(acceleration.acc_y);
    document.getElementById('imu1-accel-km6-z').textContent = formatValue(acceleration.acc_z);

    document.getElementById('imu1-accel-km308-x').textContent = formatValue(freeAcceleration.x);
    document.getElementById('imu1-accel-km308-y').textContent = formatValue(freeAcceleration.y);
    document.getElementById('imu1-accel-km308-z').textContent = formatValue(freeAcceleration.z);

    document.getElementById('imu1-gyro-x').textContent = formatValue(rateOfTurn.gyr_x, 3);
    document.getElementById('imu1-gyro-y').textContent = formatValue(rateOfTurn.gyr_y, 3);
    document.getElementById('imu1-gyro-z').textContent = formatValue(rateOfTurn.gyr_z, 3);

    document.getElementById('imu1-mag-x').textContent = formatValue(magnetic.mag_x, 5);
    document.getElementById('imu1-mag-y').textContent = formatValue(magnetic.mag_y, 5);
    document.getElementById('imu1-mag-z').textContent = formatValue(magnetic.mag_z, 5);

    updateChart(accelChart, acceleration.acc_x, acceleration.acc_y, acceleration.acc_z);
    updateChart(gyroChart, rateOfTurn.gyr_x, rateOfTurn.gyr_y, rateOfTurn.gyr_z);

    const metersPerSecondSquaredPerG = 9.80665;
    updateLiveGForce(
        (freeAcceleration.y || 0) / metersPerSecondSquaredPerG,
        (freeAcceleration.x || 0) / metersPerSecondSquaredPerG
    );

    updateEulerFromXsens(xsens.euler);
}

function updateXsensHighRate(xsens) {
    if (!xsens) return;

    const accelerationHr = xsens.acceleration_hr || {};
    const rateOfTurnHr = xsens.rate_of_turn_hr || {};

    document.getElementById('imu2-accel-x').textContent = formatValue(accelerationHr.acc_x);
    document.getElementById('imu2-accel-y').textContent = formatValue(accelerationHr.acc_y);
    document.getElementById('imu2-accel-z').textContent = formatValue(accelerationHr.acc_z);

    document.getElementById('imu2-gyro-x').textContent = formatValue(rateOfTurnHr.gyr_x, 3);
    document.getElementById('imu2-gyro-y').textContent = formatValue(rateOfTurnHr.gyr_y, 3);
    document.getElementById('imu2-gyro-z').textContent = formatValue(rateOfTurnHr.gyr_z, 3);
}

// WebSocket Message Handler
ws.onmessage = function(event) {
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
    
    // Update message count
    document.getElementById('message-count').textContent = data.message_count || 0;
    
    // // Update last update time
    // if (data.update_time) {
    //     const time = new Date(data.update_time);
    //     document.getElementById('last-update').textContent = time.toLocaleTimeString();
    // }

    // Update XSens data
    if (data.xsens) {
        updateXsensMotion(data.xsens);
        updateXsensHighRate(data.xsens);
    }

    // Update VCU data
    if (data.vcu) {
        updateSteeringWheel(data.vcu.steer);
        updateSuspension(data.vcu.suspFL, data.vcu.suspFR, data.vcu.suspRL, data.vcu.suspRR);
    }
};

// Initialize 3D scene
document.addEventListener('DOMContentLoaded', function() {
    init3D();
    
    // Handle window resize
    window.addEventListener('resize', function() {
        const container = document.getElementById('canvas-container');
        camera.aspect = container.clientWidth / container.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(container.clientWidth, container.clientHeight);
    });
});
