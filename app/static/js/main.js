const SENSOR_COLORS = {
    1: { border: "#2ecc71", bg: "rgba(46, 204, 113, 0.2)" },
    2: { border: "#3498db", bg: "rgba(52, 152, 219, 0.2)" },
    3: { border: "#e67e22", bg: "rgba(230, 126, 34, 0.2)" },
    4: { border: "#9b59b6", bg: "rgba(155, 89, 182, 0.2)" }
};

const UNIT_MAP = {
    celsius: "°C",
    fahrenheit: "°F",
    percent: "%",
    pressure: "hPa"
};

function getToken() {
    const name = "token=";
    const decodedCookie = decodeURIComponent(document.cookie);
    const ca = decodedCookie.split(';');
    for(let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') {
            c = c.substring(1);
        }
        if (c.indexOf(name) == 0) {
            return c.substring(name.length, c.length);
        }
    }
    return null;
}

document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value;
    const password = document.getElementById("password").value;

    const res = await fetch("/login", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
    });

    if (!res.ok) {
        document.getElementById("error").innerText = "Invalid login";
        return;
    }

    const data = await res.json();
    console.log("Your API token (for FastAPI docs):", data.access_token);
    console.log("Use: Bearer " + data.access_token);

    window.location.href = "/dashboard";
});


let chartInstances = {};
let chartLoadSequence = 0;
let chartLoadController = null;
let expandedChartInstance = null;
let expandLoadSequence = 0;
let expandLoadController = null;
let autoRefreshTimer = null;
const AUTO_REFRESH_INTERVAL_MS = 60000;

function capitalizeFirstLetter(val) {
    return String(val).charAt(0).toUpperCase() + String(val).slice(1);
}

function formatDateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function formatTimeInputValue(date) {
    return date.toTimeString().slice(0, 5);
}

function setDefaultCustomRange() {
    const fromDateEl = document.getElementById("customFromDate");
    const fromTimeEl = document.getElementById("customFromTime");
    const toDateEl = document.getElementById("customToDate");
    const toTimeEl = document.getElementById("customToTime");

    if (!fromDateEl || !fromTimeEl || !toDateEl || !toTimeEl) return;
    if (fromDateEl.value || fromTimeEl.value || toDateEl.value || toTimeEl.value) return;

    const to = new Date();
    const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);

    fromDateEl.value = formatDateInputValue(from);
    fromTimeEl.value = formatTimeInputValue(from);
    toDateEl.value = formatDateInputValue(to);
    toTimeEl.value = formatTimeInputValue(to);
}

function handleTimeRangeChange() {
    const controls = document.getElementById("customRangeControls");
    const timeRange = document.getElementById("timeRange").value;

    if (timeRange === "custom") {
        if (controls) controls.style.display = "flex";
        setDefaultCustomRange();
        return;
    }

    if (controls) controls.style.display = "none";
    loadAllCharts();
}

function getMeasurementQueryString() {
    const timeRange = document.getElementById("timeRange").value;

    if (timeRange !== "custom") {
        return new URLSearchParams({ hours: timeRange }).toString();
    }

    const fromDate = document.getElementById("customFromDate").value;
    const fromTime = document.getElementById("customFromTime").value;
    const toDate = document.getElementById("customToDate").value;
    const toTime = document.getElementById("customToTime").value;

    if (!fromDate || !fromTime || !toDate || !toTime) {
        alert("Please fill in From and To date/time.");
        return null;
    }

    const from = new Date(`${fromDate}T${fromTime}`);
    const to = new Date(`${toDate}T${toTime}`);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        alert("Please enter a valid custom date/time range.");
        return null;
    }

    if (from > to) {
        alert("From must be before To.");
        return null;
    }

    return new URLSearchParams({
        from_ts: from.toISOString(),
        to_ts: to.toISOString()
    }).toString();
}

async function loadAllCharts() {
    const token = getToken() || localStorage.getItem("token");
    const measurementQuery = getMeasurementQueryString();
    if (!measurementQuery) return;

    const loadId = ++chartLoadSequence;
    if (chartLoadController) {
        chartLoadController.abort();
    }
    chartLoadController = new AbortController();
    const { signal } = chartLoadController;

    const container = document.getElementById("chartsContainer");
    
    Object.values(chartInstances).forEach(chart => chart.destroy());
    chartInstances = {};

    try {
        const [sensorsRes, devicesRes, mtRes] = await Promise.all([
            fetch("/sensors", { headers: { "Authorization": "Bearer " + token }, signal }),
            fetch("/devices", { headers: { "Authorization": "Bearer " + token }, signal }),
            fetch("/measurement-types", { signal })
        ]);

        if (loadId !== chartLoadSequence) return;

        if (!sensorsRes.ok || !devicesRes.ok || !mtRes.ok) {
            container.innerHTML = "<p>Unable to load charts.</p>";
            return;
        }

        const sensors = await sensorsRes.json();
        const devices = await devicesRes.json();
        const measurementTypes = await mtRes.json();

        if (loadId !== chartLoadSequence) return;
        
        if (devices.length === 0) {
            container.innerHTML = "<p>No devices available.</p>";
            return;
        }
        
        container.innerHTML = "";
        
        const mtMap = {};
        measurementTypes.forEach(mt => mtMap[mt.id] = mt);

        const usersById = {};
        if (typeof isAdmin !== "undefined" && isAdmin) {
            const usersRes = await fetch("/users", {
                headers: { "Authorization": "Bearer " + token },
                signal
            });
            if (loadId !== chartLoadSequence) return;
            if (usersRes.ok) {
                const users = await usersRes.json();
                if (loadId !== chartLoadSequence) return;
                users.forEach(user => {
                    usersById[user.id] = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
                });
            }
        }

        const sensorsByDevice = {};
        sensors.forEach(sensor => {
            if (!sensorsByDevice[sensor.device_id]) {
                sensorsByDevice[sensor.device_id] = [];
            }
            sensorsByDevice[sensor.device_id].push(sensor);
        });

        const deviceMap = {};
        devices.forEach(device => {
            deviceMap[device.id] = device;
        });

        const orderedDevices = devices
            .sort((a, b) => {
                const ownerA = usersById[a.user_id] || "";
                const ownerB = usersById[b.user_id] || "";
                return ownerA.localeCompare(ownerB) || a.name.localeCompare(b.name);
            });

        const unknownDeviceIds = new Set();
        for (const sensor of sensors.filter(sensor => !deviceMap[sensor.device_id])) {
            if (unknownDeviceIds.has(sensor.device_id)) continue;
            unknownDeviceIds.add(sensor.device_id);

            if (!sensorsByDevice[sensor.device_id]) {
                sensorsByDevice[sensor.device_id] = [];
            }
            orderedDevices.push({
                id: sensor.device_id,
                name: "Unknown Device",
                user_id: null,
                location_name: ""
            });
        }

        let lastOwnerLabel = null;
        let currentOwnerPanel = null;

        for (const device of orderedDevices) {
            if (loadId !== chartLoadSequence) return;

            const deviceSensors = (sensorsByDevice[device.id] || [])
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

            const ownerLabel = usersById[device.user_id] || (device.user_id ? `User #${device.user_id}` : "Unassigned");
            if (typeof isAdmin !== "undefined" && isAdmin && ownerLabel !== lastOwnerLabel) {
                currentOwnerPanel = document.createElement("section");
                currentOwnerPanel.className = "chart-user-panel";

                const ownerHeading = document.createElement("h2");
                ownerHeading.className = "chart-owner-heading";
                ownerHeading.textContent = ownerLabel;
                currentOwnerPanel.appendChild(ownerHeading);
                container.appendChild(currentOwnerPanel);
                lastOwnerLabel = ownerLabel;
            }

            const section = document.createElement("section");
            section.className = "device-chart-section";
            section.innerHTML = `
                <div class="device-chart-heading">
                    <h3>${escapeHtml(device.name)}</h3>
                    <span>${escapeHtml(device.location_name || "no location")}</span>
                </div>
                <div class="device-chart-grid"></div>
            `;
            (currentOwnerPanel || container).appendChild(section);

            const grid = section.querySelector(".device-chart-grid");

            if (deviceSensors.length === 0) {
                grid.innerHTML = '<p class="empty-device-message">No sensors configured for this device.</p>';
                continue;
            }

            for (const sensor of deviceSensors) {
                if (loadId !== chartLoadSequence) return;

                const card = document.createElement("div");
                card.className = "chart-card";
                card.onclick = () => expandChart(sensor.id);
                card.innerHTML = `
                    <h4>${escapeHtml(sensor.name)} - ${escapeHtml(capitalizeFirstLetter(sensor.location || "unknown"))}</h4>
                    <div class="current-value" id="value-${sensor.id}">--<span class="unit"></span></div>
                    <div class="chart-card-stats" id="stats-${sensor.id}"></div>
                    <canvas id="chart-${sensor.id}"></canvas>
                `;
                grid.appendChild(card);
                
                const res = await fetch(`/measurements/by-sensor/${sensor.id}?${measurementQuery}`, {
                    headers: { "Authorization": "Bearer " + token },
                    cache: "no-store",
                    signal
                });
                const data = res.ok ? await res.json() : [];
                if (loadId !== chartLoadSequence) return;

                // Fetch stats
                const statsRes = await fetch(`/measurements/stats/${sensor.id}?${measurementQuery}`, {
                    headers: { "Authorization": "Bearer " + token },
                    cache: "no-store",
                    signal
                });
                const stats = statsRes.ok ? await statsRes.json() : null;
                if (loadId !== chartLoadSequence) return;

                const colors = SENSOR_COLORS[sensor.measurement_type_id] || { border: "#95a5a6", bg: "rgba(149, 165, 166, 0.2)"};
                const valueEl = document.getElementById(`value-${sensor.id}`);

                if (!valueEl) return;

                if (data.length > 0) {
                    const latest = data[data.length - 1];
                    const mt = mtMap[sensor.measurement_type_id];
                    const unit = mt ? UNIT_MAP[mt.unit] || mt.unit : '';
                    valueEl.innerHTML = `${parseFloat(latest.value).toFixed(1)}<span class="unit"> ${unit}</span>`;
                    valueEl.style.color = colors.border;
                } else {
                    valueEl.innerHTML = "No data<span class='unit'></span>";
                }

                // Display stats
                if (stats && (stats.min_value !== null || stats.max_value !== null || stats.avg_value !== null)) {
                    const mt = mtMap[sensor.measurement_type_id];
                    const unit = mt ? UNIT_MAP[mt.unit] || mt.unit : '';
                    const statsEl = document.getElementById(`stats-${sensor.id}`);
                    if (statsEl) {
                        statsEl.innerHTML = `
                            <div class="stat-item">
                                <div class="stat-item-label">Min</div>
                                <div class="stat-item-value">${stats.min_value !== null ? parseFloat(stats.min_value).toFixed(1) : '--'}<span class="unit">${unit}</span></div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-item-label">Avg</div>
                                <div class="stat-item-value">${stats.avg_value !== null ? parseFloat(stats.avg_value).toFixed(1) : '--'}<span class="unit">${unit}</span></div>
                            </div>
                            <div class="stat-item">
                                <div class="stat-item-label">Max</div>
                                <div class="stat-item-value">${stats.max_value !== null ? parseFloat(stats.max_value).toFixed(1) : '--'}<span class="unit">${unit}</span></div>
                            </div>
                        `;
                    }
                }
                
                const labels = data.map(x => formatTime(x.ts));
                const values = data.map(x => x.value);
                
                const ctx = document.getElementById(`chart-${sensor.id}`).getContext('2d');
                chartInstances[sensor.id] = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: sensor.name,
                            data: values,
                            borderColor: colors.border,
                            backgroundColor: colors.bg,
                            fill: true,
                            tension: 0.3
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                            legend: { display: false }
                        },
                        scales: {
                            x: { 
                                ticks: { maxTicksLimit: 8 }
                            }
                        }
                    }
                });
            }
        }
    } catch (error) {
        if (error.name === "AbortError") return;
        container.innerHTML = "<p>Unable to load charts.</p>";
    }
}

function formatTime(ts) {
    const date = new Date(ts);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function expandChart(sensorId) {
    const token = getToken() || localStorage.getItem("token");
    const measurementQuery = getMeasurementQueryString();
    if (!measurementQuery) return;

    const loadId = ++expandLoadSequence;
    if (expandLoadController) {
        expandLoadController.abort();
    }
    expandLoadController = new AbortController();
    const { signal } = expandLoadController;
    
    try {
        const sensorRes = await fetch(`/sensors/${sensorId}`, {
            headers: { "Authorization": "Bearer " + token },
            signal
        });
        const sensor = await sensorRes.json();
        if (loadId !== expandLoadSequence) return;
        
        const mtRes = await fetch(`/measurement-types/${sensor.measurement_type_id}`, {
            headers: { "Authorization": "Bearer " + token },
            signal
        });
        const mt = await mtRes.json();
        if (loadId !== expandLoadSequence) return;
        
        const dataRes = await fetch(`/measurements/by-sensor/${sensorId}?${measurementQuery}`, {
            headers: { "Authorization": "Bearer " + token },
            cache: "no-store",
            signal
        });
        const data = await dataRes.json();
        if (loadId !== expandLoadSequence) return;
        
        const overlay = document.getElementById("modalOverlay");
        let modal = document.getElementById("expandChartModal");
        
        if (!modal) {
            overlay.innerHTML += `
                <div id="expandChartModal" class="modal" style="width: 90%; max-width: 1100px; max-height: 80vh;">
                    <div class="modal-header">
                        <h3 id="expandChartTitle">Chart</h3>
                        <button type="button" class="close-modal" onclick="closeExpandModal()">×</button>
                    </div>
                    <div class="modal-body" style="max-height: calc(80vh - 60px); overflow-y: auto;">
                        <div class="current-value" id="expandCurrentValue" style="text-align: center; margin-bottom: 15px;"></div>
                        <canvas id="expandChart" style="max-height: 50vh;"></canvas>
                    </div>
                </div>
            `;
            modal = document.getElementById("expandChartModal");
        }
        
        document.getElementById("expandChartTitle").textContent = sensor.name;
        
        const valueEl = document.getElementById("expandCurrentValue");
        if (data.length > 0) {
            const latest = data[data.length - 1];
            valueEl.innerHTML = `Current: <strong>${parseFloat(latest.value).toFixed(1)} ${mt.unit}</strong>`;
        } else {
            valueEl.innerHTML = "No data";
        }
        
        overlay.style.display = "flex";
        modal.style.display = "block";
        
        const labels = data.map(x => formatTime(x.ts));
        const values = data.map(x => x.value);
        const colors = SENSOR_COLORS[sensor.measurement_type_id] || { border: "#95a5a6", bg: "rgba(149, 165, 166, 0.2)"};
        
        if (expandedChartInstance) {
            expandedChartInstance.destroy();
        }

        const ctx = document.getElementById("expandChart").getContext('2d');
        expandedChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: sensor.name,
                    data: values,
                    borderColor: colors.border,
                    backgroundColor: colors.bg,
                    fill: true,
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: { 
                        ticks: { maxTicksLimit: 15 }
                    }
                }
            }
        });
    } catch (error) {
        if (error.name !== "AbortError") {
            alert("Unable to load expanded chart.");
        }
    }
}

function closeExpandModal() {
    const overlay = document.getElementById("modalOverlay");
    const modal = document.getElementById("expandChartModal");

    if (overlay) overlay.style.display = "none";
    if (modal) modal.style.display = "none";

    if (expandLoadController) {
        expandLoadController.abort();
    }

    if (expandedChartInstance) {
        expandedChartInstance.destroy();
        expandedChartInstance = null;
    }
}


async function loadUser() {
    const token = getToken() || localStorage.getItem("token");

    const res = await fetch("/me", {
        headers: {
            "Authorization": "Bearer " + token
        }
    });

    const data = await res.json();

    const userInfoEl = document.getElementById("user-info");
    if (userInfoEl) {
        userInfoEl.innerText = `Logged in as: ${data.email}`;
    }
}


async function logout() {
    const token = getToken() || localStorage.getItem("token");
    
    await fetch("/logout", {
        method: "POST",
        headers: {
            "Authorization": "Bearer " + token
        }
    });
    
    localStorage.removeItem("token");
    window.location.href = "/login-page";
}

window.addEventListener("DOMContentLoaded", () => {
    if (document.getElementById("chartsContainer")) {
        loadUser();
        
        const deviceSelect = document.getElementById("deviceSelect");
        if (deviceSelect && typeof devices !== 'undefined') {
            devices.forEach(device => {
                const option = document.createElement("option");
                option.value = device.id;
                option.textContent = `${device.name} (${device.location})`;
                deviceSelect.appendChild(option);
            });
        }
        
        const measurementTypeSelect = document.getElementById("measurementTypeSelect");
        if (measurementTypeSelect && typeof measurementTypes !== 'undefined') {
            measurementTypes.forEach(mt => {
                const option = document.createElement("option");
                option.value = mt.id;
                option.textContent = `${mt.name} (${mt.unit})`;
                measurementTypeSelect.appendChild(option);
            });
        }
        
        loadAllCharts();
        startAutoRefresh();
    }
});

window.addEventListener("beforeunload", stopAutoRefresh);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        startAutoRefresh();
    } else {
        stopAutoRefresh();
    }
});

async function loadSensors() {
    const deviceId = document.getElementById("deviceSelect").value;
    const measurementTypeId = document.getElementById("measurementTypeSelect").value;
    const sensorSelect = document.getElementById("sensorSelect");
    
    sensorSelect.innerHTML = '<option value="">Select Sensor</option>';
    
    if (!deviceId || !measurementTypeId) return;
    
    const token = getToken() || localStorage.getItem("token");
    
    const res = await fetch(`/sensors?device_id=${deviceId}&measurement_type_id=${measurementTypeId}`, {
        headers: {
            "Authorization": "Bearer " + token
        }
    });
    
    const sensors = await res.json();
    
    sensors.forEach(sensor => {
        const option = document.createElement("option");
        option.value = sensor.id;
        option.textContent = sensor.name;
        sensorSelect.appendChild(option);
    });
}

function updateSensorOptions() {
    loadSensors();
}

function closeModals() {
    document.getElementById("modalOverlay").style.display = "none";
    document.querySelectorAll(".modal").forEach(m => m.style.display = "none");
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

async function loadDevicesForSelect(selectId, selectedId = "") {
    const token = getToken() || localStorage.getItem("token");
    const select = document.getElementById(selectId);
    const res = await fetch("/devices", {
        headers: { "Authorization": "Bearer " + token }
    });
    const deviceList = await res.json();

    select.innerHTML = '<option value="">Select Device</option>';
    deviceList.forEach(device => {
        const option = document.createElement("option");
        option.value = device.id;
        option.textContent = `${device.name} (${device.location_name || "no location"})`;
        option.selected = String(device.id) === String(selectedId);
        select.appendChild(option);
    });

    return deviceList;
}

async function fetchMeasurementTypes() {
    const res = await fetch("/measurement-types");
    if (!res.ok) {
        return [];
    }
    return await res.json();
}

async function loadMeasurementTypesForSelect(selectId, selectedId = "") {
    const select = document.getElementById(selectId);
    select.innerHTML = '<option value="">Select Measurement Type</option>';

    const typeList = await fetchMeasurementTypes();

    typeList.forEach(mt => {
        const option = document.createElement("option");
        option.value = mt.id;
        option.textContent = `${mt.name} (${mt.unit})`;
        option.selected = String(mt.id) === String(selectedId);
        select.appendChild(option);
    });
}

function refreshChartsIfVisible() {
    if (document.getElementById("chartsContainer")) {
        loadAllCharts();
    }
}

function startAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
    }

    autoRefreshTimer = setInterval(() => {
        if (document.visibilityState === "visible" && document.getElementById("chartsContainer")) {
            loadAllCharts();
        }
    }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
        autoRefreshTimer = null;
    }
}

async function showManageDevicesModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("manageDevicesModal").style.display = "block";

    const token = getToken() || localStorage.getItem("token");
    const container = document.getElementById("devicesList");
    container.innerHTML = "Loading...";

    const res = await fetch("/devices", {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) {
        container.innerHTML = "<p>Unable to load devices.</p>";
        return;
    }

    const deviceList = await res.json();
    if (deviceList.length === 0) {
        container.innerHTML = "<p>No devices found.</p>";
        return;
    }

    container.innerHTML = `
        <table class="manage-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Serial</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${deviceList.map(device => `
                    <tr>
                        <td>${escapeHtml(device.name)}</td>
                        <td>${escapeHtml(device.serial_number || "-")}</td>
                        <td>${escapeHtml(device.location_name || "-")}</td>
                        <td>${escapeHtml(device.status || "-")}</td>
                        <td class="row-actions">
                            <button type="button" onclick="editDevice(${device.id})">Edit</button>
                            <button type="button" class="danger-small" onclick="deleteDevice(${device.id})">Delete</button>
                        </td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

async function showManageSensorsModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("manageSensorsModal").style.display = "block";

    const token = getToken() || localStorage.getItem("token");
    const container = document.getElementById("sensorsList");
    container.innerHTML = "Loading...";

    const [sensorsRes, devicesRes] = await Promise.all([
        fetch("/sensors", { headers: { "Authorization": "Bearer " + token } }),
        fetch("/devices", { headers: { "Authorization": "Bearer " + token } })
    ]);

    if (!sensorsRes.ok || !devicesRes.ok) {
        container.innerHTML = "<p>Unable to load sensors.</p>";
        return;
    }

    const sensors = await sensorsRes.json();
    const deviceList = await devicesRes.json();
    const typeList = await fetchMeasurementTypes();
    const deviceMap = {};
    const measurementTypeMap = {};
    deviceList.forEach(device => deviceMap[device.id] = device.name);
    typeList.forEach(mt => measurementTypeMap[mt.id] = `${mt.name} (${mt.unit})`);

    if (sensors.length === 0) {
        container.innerHTML = "<p>No sensors found.</p>";
        return;
    }

    container.innerHTML = `
        <table class="manage-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Device</th>
                    <th>Type</th>
                    <th>Location</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${sensors.map(sensor => `
                    <tr>
                        <td>${escapeHtml(sensor.name || "-")}</td>
                        <td>${escapeHtml(deviceMap[sensor.device_id] || "Unknown")}</td>
                        <td>${escapeHtml(measurementTypeMap[sensor.measurement_type_id] || "Unknown")}</td>
                        <td>${escapeHtml(sensor.location || "-")}</td>
                        <td class="row-actions">
                            <button type="button" onclick="editSensor(${sensor.id})">Edit</button>
                            <button type="button" class="danger-small" onclick="deleteSensor(${sensor.id})">Delete</button>
                        </td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

async function showAddDeviceModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("addDeviceModal").style.display = "block";

    const container = document.getElementById("deviceSensorCheckboxes");
    container.innerHTML = "Loading...";

    const typeList = await fetchMeasurementTypes();
    if (typeList.length === 0) {
        container.innerHTML = "<p>No measurement types available.</p>";
        return;
    }

    container.innerHTML = "";
    typeList.forEach(mt => {
        const label = document.createElement("label");
        label.innerHTML = `
            <input type="checkbox" value="${mt.id}" data-name="${escapeHtml(mt.name)}">
            <span>${escapeHtml(mt.name)} (${escapeHtml(mt.unit)})</span>
        `;
        container.appendChild(label);
    });
}

async function createDevice() {
    const token = getToken() || localStorage.getItem("token");
    
    const name = document.getElementById("newDeviceName").value;
    const serial = document.getElementById("newDeviceSerial").value;
    const passkey = document.getElementById("newDevicePasskey").value;
    const location = document.getElementById("newDeviceLocation").value;
    
    if (!name) {
        alert("Please enter a device name");
        return;
    }
    if (!passkey) {
        alert("Please enter a pass key");
        return;
    }
    
    const deviceRes = await fetch("/devices", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
            name: name,
            passkey: passkey,
            serial_number: serial,
            location_name: location
        })
    });

    if (!deviceRes.ok) {
        const err = await deviceRes.json();
        alert("Error creating device: " + (err.detail || "Unknown error"));
        return;
    }

    const device = await deviceRes.json();
    const selectedTypes = Array.from(document.querySelectorAll("#deviceSensorCheckboxes input:checked"))
        .map(input => ({
            id: parseInt(input.value),
            name: input.dataset.name
        }));

    for (const measurementType of selectedTypes) {
        const sensorRes = await fetch("/sensors", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token
            },
            body: JSON.stringify({
                device_id: device.id,
                measurement_type_id: measurementType.id,
                name: `${name} - ${measurementType.name}`,
                location: location || null
            })
        });

        if (!sensorRes.ok) {
            const err = await sensorRes.json();
            alert("Device created, but one sensor could not be created: " + (err.detail || "Unknown error"));
            refreshChartsIfVisible();
            showManageDevicesModal();
            return;
        }
    }

    alert(selectedTypes.length ? "Device and sensors created!" : "Device created!");
    refreshChartsIfVisible();
    showManageDevicesModal();
}

async function editDevice(deviceId) {
    const token = getToken() || localStorage.getItem("token");
    const res = await fetch("/devices", {
        headers: { "Authorization": "Bearer " + token }
    });
    const deviceList = await res.json();
    const device = deviceList.find(d => d.id === deviceId);
    if (!device) return;

    const name = prompt("Device name:", device.name || "");
    if (name === null) return;
    if (!name.trim()) {
        alert("Device name cannot be empty");
        return;
    }
    const serial = prompt("Serial number:", device.serial_number || "");
    if (serial === null) return;
    const location = prompt("Location:", device.location_name || "");
    if (location === null) return;
    const status = prompt("Status:", device.status || "active");
    if (status === null) return;

    const updateRes = await fetch(`/devices/${deviceId}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
            name,
            serial_number: serial || null,
            location_name: location || null,
            status: status || null
        })
    });

    if (!updateRes.ok) {
        const err = await updateRes.json();
        alert("Error: " + (err.detail || "Failed to update device"));
        return;
    }

    refreshChartsIfVisible();
    showManageDevicesModal();
}

function showAddMeasurementTypeModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("addMeasurementTypeModal").style.display = "block";
}

async function showManageMeasurementTypesModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("manageMeasurementTypesModal").style.display = "block";

    const container = document.getElementById("measurementTypesList");
    container.innerHTML = "Loading...";

    const typeList = await fetchMeasurementTypes();
    if (typeList.length === 0) {
        container.innerHTML = "<p>No measurement types found.</p>";
        return;
    }

    container.innerHTML = `
        <table class="manage-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>Unit</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${typeList.map(mt => `
                    <tr>
                        <td>${escapeHtml(mt.name)}</td>
                        <td>${escapeHtml(mt.unit)}</td>
                        <td class="row-actions">
                            <button type="button" onclick="editMeasurementType(${mt.id})">Edit</button>
                            <button type="button" class="danger-small" onclick="deleteMeasurementType(${mt.id})">Delete</button>
                        </td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

async function createMeasurementType() {
    const token = getToken() || localStorage.getItem("token");
    
    const name = document.getElementById("newMeasTypeName").value.trim();
    const unit = document.getElementById("newMeasTypeUnit").value.trim();
    
    if (!name || !unit) {
        alert("Please enter both name and unit");
        return;
    }
    
    const res = await fetch("/measurement-types", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({ name, unit })
    });
    
    if (res.ok) {
        alert("Measurement type created!");
        refreshChartsIfVisible();
        showManageMeasurementTypesModal();
    } else {
        const err = await res.json();
        alert("Error: " + (err.detail || "Failed to create measurement type"));
    }
}

async function editMeasurementType(typeId) {
    const token = getToken() || localStorage.getItem("token");
    const typeList = await fetchMeasurementTypes();
    const measurementType = typeList.find(mt => mt.id === typeId);
    if (!measurementType) return;

    const name = prompt("Name:", measurementType.name || "");
    if (name === null) return;
    if (!name.trim()) {
        alert("Name cannot be empty");
        return;
    }

    const unit = prompt("Unit:", measurementType.unit || "");
    if (unit === null) return;
    if (!unit.trim()) {
        alert("Unit cannot be empty");
        return;
    }

    const res = await fetch(`/measurement-types/${typeId}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
            name: name.trim(),
            unit: unit.trim()
        })
    });

    if (!res.ok) {
        const err = await res.json();
        alert("Error: " + (err.detail || "Failed to update measurement type"));
        return;
    }

    refreshChartsIfVisible();
    showManageMeasurementTypesModal();
}

async function deleteMeasurementType(typeId) {
    const token = getToken() || localStorage.getItem("token");

    if (!confirm("Are you sure you want to delete this measurement type?")) {
        return;
    }

    const res = await fetch(`/measurement-types/${typeId}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) {
        const err = await res.json();
        alert("Error: " + (err.detail || "Failed to delete measurement type"));
        return;
    }

    refreshChartsIfVisible();
    showManageMeasurementTypesModal();
}

async function showAddSensorModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("addSensorModal").style.display = "block";
    await loadDevicesForSelect("newSensorDevice");
    await loadMeasurementTypesForSelect("newSensorMeasurementType");
}

async function createSensor() {
    const token = getToken() || localStorage.getItem("token");
    const deviceId = document.getElementById("newSensorDevice").value;
    const measurementTypeId = document.getElementById("newSensorMeasurementType").value;
    const name = document.getElementById("newSensorName").value.trim();
    const location = document.getElementById("newSensorLocation").value;

    if (!deviceId || !measurementTypeId || !name) {
        alert("Please select a device, measurement type, and name");
        return;
    }

    const res = await fetch("/sensors", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
            device_id: parseInt(deviceId),
            measurement_type_id: parseInt(measurementTypeId),
            name,
            location
        })
    });

    if (!res.ok) {
        const err = await res.json();
        alert("Error: " + (err.detail || "Failed to create sensor"));
        return;
    }

    alert("Sensor created!");
    refreshChartsIfVisible();
    showManageSensorsModal();
}

async function editSensor(sensorId) {
    const token = getToken() || localStorage.getItem("token");
    const res = await fetch("/sensors", {
        headers: { "Authorization": "Bearer " + token }
    });
    const sensors = await res.json();
    const sensor = sensors.find(s => s.id === sensorId);
    if (!sensor) return;

    const deviceId = prompt("Device ID:", sensor.device_id);
    if (deviceId === null) return;
    const measurementTypeId = prompt("Measurement type ID:", sensor.measurement_type_id);
    if (measurementTypeId === null) return;
    const name = prompt("Sensor name:", sensor.name || "");
    if (name === null) return;
    const location = prompt("Location:", sensor.location || "");
    if (location === null) return;

    const parsedDeviceId = parseInt(deviceId);
    const parsedMeasurementTypeId = parseInt(measurementTypeId);
    if (Number.isNaN(parsedDeviceId) || Number.isNaN(parsedMeasurementTypeId) || !name.trim()) {
        alert("Please enter a valid device ID, measurement type ID, and sensor name");
        return;
    }

    const updateRes = await fetch(`/sensors/${sensorId}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
            device_id: parsedDeviceId,
            measurement_type_id: parsedMeasurementTypeId,
            name,
            location: location || null
        })
    });

    if (!updateRes.ok) {
        const err = await updateRes.json();
        alert("Error: " + (err.detail || "Failed to update sensor"));
        return;
    }

    refreshChartsIfVisible();
    showManageSensorsModal();
}

async function deleteSensor(sensorId) {
    const token = getToken() || localStorage.getItem("token");

    if (!confirm("Are you sure you want to delete this sensor?")) {
        return;
    }

    const res = await fetch(`/sensors/${sensorId}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
    });
    
    if (res.ok) {
        alert("Sensor deleted!");
        refreshChartsIfVisible();
        showManageSensorsModal();
    } else {
        const err = await res.json();
        alert("Error: " + (err.detail || "Failed to delete sensor"));
    }
}

async function deleteDevice(deviceId) {
    const token = getToken() || localStorage.getItem("token");
    
    if (!confirm("Are you sure? This will delete all sensors for this device!")) {
        return;
    }
    
    const res = await fetch(`/devices/${deviceId}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
    });
    
    if (res.ok) {
        alert("Device deleted!");
        refreshChartsIfVisible();
        showManageDevicesModal();
    } else {
        const err = await res.json();
        alert("Error: " + (err.detail || "Failed to delete device"));
    }
}

function showAddUserModal() {
    if (!isAdmin) return;

    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("addUserModal").style.display = "block";
}

async function createUser() {
    const token = getToken() || localStorage.getItem("token");
    const email = document.getElementById("newUserEmail").value.trim();
    const password = document.getElementById("newUserPassword").value;
    const firstName = document.getElementById("newUserFirstName").value.trim();
    const lastName = document.getElementById("newUserLastName").value.trim();
    const role = document.getElementById("newUserRole").value;

    if (!email || !password) {
        alert("Please enter email and password");
        return;
    }

    const res = await fetch("/users", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify({
            email,
            password,
            first_name: firstName || null,
            last_name: lastName || null,
            role
        })
    });

    if (res.ok) {
        alert("User created!");
        showManageUsersModal();
        return;
    }

    const err = await res.json();
    alert("Error: " + (err.detail || "Failed to create user"));
}

async function showManageUsersModal() {
    if (!isAdmin) return;

    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("manageUsersModal").style.display = "block";

    const token = getToken() || localStorage.getItem("token");
    const container = document.getElementById("usersList");
    container.innerHTML = "Loading...";

    const meRes = await fetch("/me", {
        headers: { "Authorization": "Bearer " + token }
    });
    const currentUser = meRes.ok ? await meRes.json() : null;

    const res = await fetch("/users", {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) {
        container.innerHTML = "<p>Unable to load users.</p>";
        return;
    }

    const users = await res.json();
    if (users.length === 0) {
        container.innerHTML = "<p>No users found.</p>";
        return;
    }

    container.innerHTML = `
        <table class="manage-table">
            <thead>
                <tr>
                    <th>Email</th>
                    <th>Name</th>
                    <th>Role</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${users.map(user => {
                    const isCurrentUser = currentUser && user.id === currentUser.id;
                    return `
                        <tr>
                            <td>${escapeHtml(user.email)}</td>
                            <td>${escapeHtml([user.first_name, user.last_name].filter(Boolean).join(" ") || "-")}</td>
                            <td>${escapeHtml(user.roles.join(", ") || "no role")}</td>
                            <td>${user.is_active ? "Active" : "Inactive"}</td>
                            <td class="row-actions">
                                <button type="button" onclick="editUser(${user.id})">Edit</button>
                                <button type="button" class="danger-small" onclick="deleteUser(${user.id})" ${isCurrentUser ? "disabled" : ""}>Delete</button>
                            </td>
                        </tr>
                    `;
                }).join("")}
            </tbody>
        </table>
    `;
}

async function editUser(userId) {
    const token = getToken() || localStorage.getItem("token");
    const res = await fetch("/users", {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) {
        alert("Could not load users");
        return;
    }

    const users = await res.json();
    const user = users.find(u => u.id === userId);
    if (!user) return;

    const email = prompt("Email:", user.email || "");
    if (email === null) return;
    if (!email.trim()) {
        alert("Email cannot be empty");
        return;
    }

    const firstName = prompt("First name:", user.first_name || "");
    if (firstName === null) return;
    const lastName = prompt("Last name:", user.last_name || "");
    if (lastName === null) return;
    const role = prompt("Role (user/admin):", user.roles[0] || "user");
    if (role === null) return;
    const isActiveInput = prompt("Active? (yes/no):", user.is_active ? "yes" : "no");
    if (isActiveInput === null) return;
    const password = prompt("New password (leave blank to keep current):", "");
    if (password === null) return;

    const normalizedRole = role.trim().toLowerCase();
    const normalizedActive = isActiveInput.trim().toLowerCase();
    if (!["user", "admin"].includes(normalizedRole)) {
        alert("Role must be user or admin");
        return;
    }
    if (!["yes", "no"].includes(normalizedActive)) {
        alert("Active must be yes or no");
        return;
    }

    const payload = {
        email: email.trim(),
        first_name: firstName.trim() || null,
        last_name: lastName.trim() || null,
        role: normalizedRole,
        is_active: normalizedActive === "yes"
    };
    if (password) {
        payload.password = password;
    }

    const updateRes = await fetch(`/users/${userId}`, {
        method: "PUT",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token
        },
        body: JSON.stringify(payload)
    });

    if (!updateRes.ok) {
        const err = await updateRes.json();
        alert("Error: " + (err.detail || "Failed to update user"));
        return;
    }

    showManageUsersModal();
}

async function deleteUser(userId) {
    const token = getToken() || localStorage.getItem("token");

    if (!userId) {
        return;
    }

    if (!confirm("Are you sure you want to remove this user?")) {
        return;
    }

    const res = await fetch(`/users/${userId}`, {
        method: "DELETE",
        headers: { "Authorization": "Bearer " + token }
    });

    if (res.ok) {
        alert("User deleted!");
        showManageUsersModal();
        return;
    }

    const err = await res.json();
    alert("Error: " + (err.detail || "Failed to delete user"));
}

async function showAlertsModal() {
    closeModals();
    document.getElementById("modalOverlay").style.display = "flex";
    document.getElementById("alertsModal").style.display = "block";
    
    const token = getToken() || localStorage.getItem("token");
    const container = document.getElementById("alertsList");
    const historyContainer = document.getElementById("alertHistoryList");
    const sensorSelect = document.getElementById("newAlertSensor");
    container.innerHTML = "Loading...";
    historyContainer.innerHTML = "Loading...";
    
    const sensorsRes = await fetch("/sensors", {
        headers: { "Authorization": "Bearer " + token }
    });
    const sensors = await sensorsRes.json();
    const sensorIds = sensors.map(s => s.id);
    
    sensorSelect.innerHTML = '<option value="">Select Sensor</option>' + 
        sensors.map(s => `<option value="${s.id}">${s.name}</option>`).join("");
    
    const rulesRes = await fetch("/alert-rules", {
        headers: { "Authorization": "Bearer " + token }
    });
    const rules = await rulesRes.json();
    
    const userRules = rules.filter(r => sensorIds.includes(r.sensor_id));
    
    if (userRules.length === 0) {
        container.innerHTML = "<p>No alerts found.</p>";
        await loadAlertHistory();
        return;
    }
    
    const sensorMap = {};
    sensors.forEach(s => sensorMap[s.id] = s.name);
    
    container.innerHTML = userRules.map(rule => `
        <div class="alert-item" data-id="${rule.id}">
            <div class="alert-item-content">
                <div class="alert-sensor">Sensor: ${sensorMap[rule.sensor_id] || 'Unknown'}</div>
                <div class="alert-rule">
                    ${rule.min_value ? `Min: ${rule.min_value}` : ''}
                    ${rule.max_value ? `Max: ${rule.max_value}` : ''}
                </div>
                <div class="alert-status ${rule.is_active ? 'active' : 'resolved'}">
                    ${rule.is_active ? 'Active' : 'Inactive'}
                </div>
            </div>
            <div class="alert-item-actions">
                <button class="edit-btn" onclick="editAlert(${rule.id}, ${rule.sensor_id}, ${rule.min_value || 'null'}, ${rule.max_value || 'null'}, ${rule.is_active})">Edit</button>
                <button class="delete-btn" onclick="deleteAlert(${rule.id})">Deactivate</button>
            </div>
        </div>
    `).join("");

    await loadAlertHistory();
}

function formatDateTime(ts) {
    if (!ts) return "-";
    const date = new Date(ts);
    return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

async function loadAlertHistory() {
    const token = getToken() || localStorage.getItem("token");
    const container = document.getElementById("alertHistoryList");

    const res = await fetch("/alert-history", {
        headers: { "Authorization": "Bearer " + token }
    });

    if (!res.ok) {
        container.innerHTML = "<p>Unable to load alert history.</p>";
        return;
    }

    const history = await res.json();
    if (history.length === 0) {
        container.innerHTML = "<p>No triggered alerts yet.</p>";
        return;
    }

    container.innerHTML = `
        <table class="manage-table alert-history-table">
            <thead>
                <tr>
                    ${isAdmin ? "<th>User</th>" : ""}
                    <th>Device</th>
                    <th>Sensor</th>
                    <th>Value</th>
                    <th>Threshold</th>
                    <th>Status</th>
                    <th>Triggered</th>
                    <th>Resolved</th>
                </tr>
            </thead>
            <tbody>
                ${history.map(item => `
                    <tr>
                        ${isAdmin ? `<td>${escapeHtml(item.user_email || "Unassigned")}</td>` : ""}
                        <td>${escapeHtml(item.device_name || "-")}</td>
                        <td>${escapeHtml(item.sensor_name || "-")}</td>
                        <td>${item.measurement_value ?? "-"}</td>
                        <td>
                            ${item.min_value !== null ? `Min ${item.min_value}` : ""}
                            ${item.max_value !== null ? `Max ${item.max_value}` : ""}
                        </td>
                        <td>${escapeHtml(item.status || "-")}</td>
                        <td>${formatDateTime(item.created_at)}</td>
                        <td>${formatDateTime(item.resolved_at)}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

async function createAlertFromModal() {
    const token = getToken() || localStorage.getItem("token");
    const sensor_id = document.getElementById("newAlertSensor").value;
    const alertType = document.getElementById("newAlertType").value;
    const value = parseFloat(document.getElementById("newAlertValue").value);
    
    if (!sensor_id || isNaN(value)) {
        alert("Please select a sensor and enter a value");
        return;
    }
    
    const payload = {
        sensor_id: parseInt(sensor_id),
        min_value: alertType === "min" ? value : null,
        max_value: alertType === "max" ? value : null
    };
    
    try {
        const res = await fetch("/alert-rules", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to create alert");
        }
        
        document.getElementById("newAlertSensor").value = "";
        document.getElementById("newAlertValue").value = "";
        
        showAlertsModal();
    } catch (err) {
        alert("Error: " + err.message);
    }
}

async function editAlert(ruleId, sensorId, minValue, maxValue, isActive) {
    const token = getToken() || localStorage.getItem("token");
    
    const sensorsRes = await fetch("/sensors", {
        headers: { "Authorization": "Bearer " + token }
    });
    const sensors = await sensorsRes.json();
    
    const currentMin = minValue === 'null' ? '' : minValue;
    const currentMax = maxValue === 'null' ? '' : maxValue;
    const alertType = maxValue !== 'null' ? 'max' : 'min';
    const currentValue = maxValue !== 'null' ? maxValue : minValue;
    
    const newAlertType = prompt("Alert type (max/min):", alertType);
    if (newAlertType === null) return;
    
    const newValue = prompt("Value:", currentValue);
    if (newValue === null) return;
    
    const payload = {
        sensor_id: parseInt(sensorId),
        min_value: newAlertType === "min" ? parseFloat(newValue) : null,
        max_value: newAlertType === "max" ? parseFloat(newValue) : null
    };
    
    try {
        const res = await fetch(`/alert-rules/${ruleId}`, {
            method: "PUT",
            headers: {
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to update alert");
        }
        
        showAlertsModal();
    } catch (err) {
        alert("Error: " + err.message);
    }
}

async function deleteAlert(ruleId) {
    if (!confirm("Are you sure you want to delete this alert rule?")) return;
    
    const token = getToken() || localStorage.getItem("token");
    
    try {
        const res = await fetch(`/alert-rules/${ruleId}`, {
            method: "DELETE",
            headers: { "Authorization": "Bearer " + token }
        });
        
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || "Failed to delete alert");
        }
        
        showAlertsModal();
    } catch (err) {
        alert("Error: " + err.message);
    }
}
