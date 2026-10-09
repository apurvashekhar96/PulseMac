/**
 * PulseMac Frontend Application Logic
 * High-performance SSE subscriber, retina canvas telemetry renderer,
 * and thermal culprit attribution manager.
 */

// Application State
const state = {
  isFahrenheit: false,
  soundEnabled: true,
  desktopNotify: true,
  activeFilter: 'all',
  searchQuery: '',
  sortCol: 'cpu',
  sortAsc: false,
  history: [], // Last 60 telemetry points
  pendingKillPid: null,
  pendingKillName: null,
  audioCtx: null,
  lastAudioAlertTime: 0
};

const CIRCUMFERENCE = 339.29; // 2 * Math.PI * 54

// DOM Elements
const el = {
  frontmostApp: document.getElementById('frontmost-app-name'),
  sysChip: document.getElementById('sys-model-chip'),
  quickThermal: document.getElementById('quick-thermal-text'),
  quickThermalBadge: document.getElementById('thermal-quick-badge'),
  uptime: document.getElementById('system-uptime'),
  
  // Alert Banner
  alertBanner: document.getElementById('global-alert-banner'),
  alertTitle: document.getElementById('banner-alert-title'),
  alertDesc: document.getElementById('banner-alert-desc'),
  alertDismiss: document.getElementById('banner-dismiss-btn'),

  // Gauges
  ringCpu: document.getElementById('ring-cpu'),
  ringGpu: document.getElementById('ring-gpu'),
  ringNpu: document.getElementById('ring-npu'),
  ringThermal: document.getElementById('ring-thermal'),

  cpuTotalVal: document.getElementById('cpu-total-val'),
  cpuUserVal: document.getElementById('cpu-user-val'),
  cpuSysVal: document.getElementById('cpu-sys-val'),
  cpuLoadAvg: document.getElementById('cpu-loadavg-val'),
  cpuCoresCount: document.getElementById('cpu-core-count'),

  gpuTotalVal: document.getElementById('gpu-total-val'),
  gpuRendererVal: document.getElementById('gpu-renderer-val'),
  gpuTilerVal: document.getElementById('gpu-tiler-val'),
  gpuMemVal: document.getElementById('gpu-mem-val'),

  npuTotalVal: document.getElementById('npu-total-val'),
  npuDaemonsVal: document.getElementById('npu-daemons-val'),
  npuClientsVal: document.getElementById('npu-clients-val'),

  thermalDieVal: document.getElementById('thermal-die-val'),
  thermalRateVal: document.getElementById('thermal-rate-val'),
  thermalBatteryVal: document.getElementById('thermal-battery-val'),
  thermalVirtualVal: document.getElementById('thermal-virtual-val'),
  thermalPowerVal: document.getElementById('thermal-power-val'),
  thermalPressureBadge: document.getElementById('thermal-pressure-badge'),

  // Spotlight
  spotlightIcon: document.getElementById('spotlight-status-icon'),
  spotlightNarrative: document.getElementById('spotlight-narrative'),
  spotlightTrendText: document.getElementById('spotlight-trend-text'),
  culpritRow: document.getElementById('culprit-details-row'),
  culpritName: document.getElementById('culprit-name'),
  culpritRoleBadge: document.getElementById('culprit-role-badge'),
  culpritPid: document.getElementById('culprit-pid'),
  culpritCpu: document.getElementById('culprit-cpu'),
  culpritDeltaCpu: document.getElementById('culprit-delta-cpu'),
  culpritMem: document.getElementById('culprit-mem'),
  culpritScore: document.getElementById('culprit-score'),
  culpritTerminateBtn: document.getElementById('culprit-terminate-btn'),

  // Multi-Core Grid
  coresGrid: document.getElementById('cores-matrix-grid'),

  // Process Table
  procTableBody: document.getElementById('process-table-body'),
  procSearchInput: document.getElementById('proc-search-input'),
  filterPills: document.getElementById('filter-pills'),

  // Watchdog Card
  watchdogCard: document.getElementById('persistence-watchdog-card'),
  watchdogDot: document.getElementById('watchdog-dot'),
  watchdogConditionText: document.getElementById('watchdog-condition-text'),
  watchdogTimerText: document.getElementById('watchdog-timer-text'),
  watchdogBarFill: document.getElementById('watchdog-bar-fill'),
  watchdogStatusText: document.getElementById('watchdog-status-text'),
  watchdogSensorTag: document.getElementById('watchdog-sensor-tag'),
  watchdogResetBtn: document.getElementById('watchdog-reset-btn'),

  // Modals
  settingsModal: document.getElementById('settings-modal'),
  settingsOpenBtn: document.getElementById('settings-open-btn'),
  settingsCloseBtn: document.getElementById('settings-close-btn'),
  tempThreshSlider: document.getElementById('temp-thresh-slider'),
  tempThreshDisplay: document.getElementById('temp-thresh-display'),
  durationSlider: document.getElementById('duration-slider'),
  durationDisplay: document.getElementById('duration-display'),
  sensorModeSelect: document.getElementById('sensor-mode-select'),
  soundCheckbox: document.getElementById('sound-checkbox'),
  notifyCheckbox: document.getElementById('notify-checkbox'),
  saveSettingsBtn: document.getElementById('save-settings-btn'),
  testSoundBtn: document.getElementById('test-sound-btn'),

  killModal: document.getElementById('kill-modal'),
  killCloseBtn: document.getElementById('kill-close-btn'),
  killCancelBtn: document.getElementById('kill-cancel-btn'),
  killConfirmBtn: document.getElementById('kill-confirm-btn'),
  killTargetName: document.getElementById('kill-target-name'),
  killTargetPid: document.getElementById('kill-target-pid'),

  unitToggleBtn: document.getElementById('unit-toggle-btn'),
  unitC: document.getElementById('unit-c'),
  unitF: document.getElementById('unit-f'),
  soundToggleBtn: document.getElementById('sound-toggle-btn'),
  soundIcon: document.getElementById('sound-icon'),
  notifyPermBtn: document.getElementById('notify-perm-btn'),

  canvas: document.getElementById('telemetryCanvas')
};

// Canvas 2D Context
const ctx = el.canvas ? el.canvas.getContext('2d') : null;

/**
 * Format Temperature according to unit toggle
 */
function formatTemp(celsius) {
  if (celsius === null || celsius === undefined) return '--';
  if (state.isFahrenheit) {
    const f = (celsius * 9 / 5) + 32;
    return `${f.toFixed(1)}°F`;
  }
  return `${celsius.toFixed(1)}°C`;
}

/**
 * Web Audio API Alert Chime
 */
function playAlertChime(isCritical = false) {
  if (!state.soundEnabled) return;

  const now = Date.now();
  if (now - state.lastAudioAlertTime < 8000) return; // 8s cooldown
  state.lastAudioAlertTime = now;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!state.audioCtx) {
      state.audioCtx = new AudioContext();
    }
    if (state.audioCtx.state === 'suspended') {
      state.audioCtx.resume();
    }

    const t = state.audioCtx.currentTime;
    const osc1 = state.audioCtx.createOscillator();
    const osc2 = state.audioCtx.createOscillator();
    const gainNode = state.audioCtx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';

    if (isCritical) {
      osc1.frequency.setValueAtTime(659.25, t); // E5
      osc1.frequency.exponentialRampToValueAtTime(880, t + 0.15); // A5
      osc2.frequency.setValueAtTime(880, t);
      osc2.frequency.exponentialRampToValueAtTime(1318.5, t + 0.15); // E6
    } else {
      osc1.frequency.setValueAtTime(587.33, t); // D5
      osc1.frequency.exponentialRampToValueAtTime(783.99, t + 0.18); // G5
      osc2.frequency.setValueAtTime(783.99, t);
    }

    gainNode.gain.setValueAtTime(0.01, t);
    gainNode.gain.linearRampToValueAtTime(0.2, t + 0.05);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t + 0.6);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(state.audioCtx.destination);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.65);
    osc2.stop(t + 0.65);
  } catch (e) {
    console.warn('Audio chime failed:', e);
  }
}

/**
 * Update Ring Progress
 */
function setRingProgress(circleElement, percent, max = 100) {
  if (!circleElement) return;
  const clamped = Math.max(0, Math.min(max, percent));
  const offset = CIRCUMFERENCE - (clamped / max) * CIRCUMFERENCE;
  circleElement.style.strokeDashoffset = offset;
}

/**
 * Render Core Load Matrix
 */
function renderCoreMatrix(cores = []) {
  if (!el.coresGrid) return;
  if (el.coresGrid.children.length !== cores.length) {
    el.coresGrid.innerHTML = '';
    cores.forEach(c => {
      const row = document.createElement('div');
      row.className = 'core-row';
      row.id = `core-row-${c.core}`;
      row.innerHTML = `
        <span class="core-name">Core ${c.core}</span>
        <div class="core-bar-track">
          <div class="core-bar-fill" id="core-fill-${c.core}" style="width: ${c.usage}%"></div>
        </div>
        <span class="core-val" id="core-val-${c.core}">${c.usage}%</span>
      `;
      el.coresGrid.appendChild(row);
    });
    return;
  }

  cores.forEach(c => {
    const fill = document.getElementById(`core-fill-${c.core}`);
    const val = document.getElementById(`core-val-${c.core}`);
    if (fill) fill.style.width = `${c.usage}%`;
    if (val) val.textContent = `${c.usage}%`;
  });
}

/**
 * Render Real-Time Canvas Chart
 */
function renderTimelineChart() {
  if (!ctx || !el.canvas) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = el.canvas.getBoundingClientRect();

  if (el.canvas.width !== rect.width * dpr || el.canvas.height !== rect.height * dpr) {
    el.canvas.width = rect.width * dpr;
    el.canvas.height = rect.height * dpr;
  }

  const w = el.canvas.width;
  const h = el.canvas.height;
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  const drawW = rect.width;
  const drawH = rect.height;

  ctx.clearRect(0, 0, drawW, drawH);

  // Background Grid Lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (drawH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(drawW, y);
    ctx.stroke();

    // Value Labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.font = '10px -apple-system, sans-serif';
    ctx.fillText(`${100 - i * 25}%`, 6, y + (i === 0 ? 12 : -4));
  }

  const pts = state.history;
  if (pts.length < 2) return;

  const stepX = drawW / Math.max(59, pts.length - 1);

  // Helper to draw series
  function drawSeries(valGetter, strokeColor, fillColor, maxY = 100) {
    ctx.beginPath();
    pts.forEach((pt, idx) => {
      const x = idx * stepX;
      const rawVal = valGetter(pt);
      const y = drawH - (Math.min(maxY, Math.max(0, rawVal)) / maxY) * drawH;
      if (idx === 0) {
        ctx.moveTo(x, y);
      } else {
        const prevX = (idx - 1) * stepX;
        const prevRaw = valGetter(pts[idx - 1]);
        const prevY = drawH - (Math.min(maxY, Math.max(0, prevRaw)) / maxY) * drawH;
        const cx = (prevX + x) / 2;
        ctx.bezierCurveTo(cx, prevY, cx, y, x, y);
      }
    });

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Fill under curve
    if (fillColor) {
      ctx.lineTo((pts.length - 1) * stepX, drawH);
      ctx.lineTo(0, drawH);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
  }

  // Draw GPU (Purple)
  const gradGpu = ctx.createLinearGradient(0, 0, 0, drawH);
  gradGpu.addColorStop(0, 'rgba(179, 136, 255, 0.18)');
  gradGpu.addColorStop(1, 'rgba(179, 136, 255, 0.0)');
  drawSeries(p => p.gpu, '#b388ff', gradGpu, 100);

  // Draw CPU (Cyan)
  const gradCpu = ctx.createLinearGradient(0, 0, 0, drawH);
  gradCpu.addColorStop(0, 'rgba(0, 229, 255, 0.22)');
  gradCpu.addColorStop(1, 'rgba(0, 229, 255, 0.0)');
  drawSeries(p => p.cpu, '#00e5ff', gradCpu, 100);

  // Draw Temp (Crimson, scaled 20°C to 100°C)
  drawSeries(p => (p.temp - 20) / 0.8, '#ff0054', null, 100);
}

/**
 * Render Process Table
 */
function renderProcessTable(processes = []) {
  if (!el.procTableBody) return;

  let filtered = processes.slice();

  // 1. Filter by role tab
  if (state.activeFilter === 'foreground') {
    filtered = filtered.filter(p => p.isForeground);
  } else if (state.activeFilter === 'background') {
    filtered = filtered.filter(p => p.type === 'BACKGROUND_APP');
  } else if (state.activeFilter === 'daemon') {
    filtered = filtered.filter(p => p.type === 'SYSTEM_DAEMON' || p.type === 'BACKGROUND_SERVICE');
  }

  // 2. Search query filter
  if (state.searchQuery.trim()) {
    const q = state.searchQuery.toLowerCase();
    filtered = filtered.filter(p => p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
  }

  // 3. Sort
  filtered.sort((a, b) => {
    let va = a[state.sortCol];
    let vb = b[state.sortCol];
    if (typeof va === 'string') {
      return state.sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return state.sortAsc ? va - vb : vb - va;
  });

  if (filtered.length === 0) {
    el.procTableBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-4">No matching processes found</td></tr>`;
    return;
  }

  let html = '';
  filtered.forEach(p => {
    let roleClass = 'daemon';
    let roleLabel = 'DAEMON';

    if (p.isForeground) {
      roleClass = 'foreground';
      roleLabel = 'FOREGROUND ACTIVE';
    } else if (p.type === 'BACKGROUND_APP') {
      roleClass = 'background-app';
      roleLabel = 'BACKGROUND APP';
    }

    html += `
      <tr>
        <td>
          <div class="proc-name-col">
            <span>${escapeHtml(p.name)}</span>
          </div>
        </td>
        <td>
          <span class="role-tag ${roleClass}">${roleLabel}</span>
        </td>
        <td class="font-mono">${p.pid}</td>
        <td class="font-mono text-cyan font-semibold">${p.cpu.toFixed(1)}%</td>
        <td class="font-mono text-emerald">${p.mem.toFixed(1)}%</td>
        <td class="font-mono ${p.impactScore > 20 ? 'text-crimson font-semibold' : 'text-muted'}">${p.impactScore.toFixed(1)}</td>
        <td class="text-right">
          <button class="btn btn-sm btn-subtle" onclick="window.requestKillProcess(${p.pid}, '${escapeHtml(p.name)}')">End</button>
        </td>
      </tr>
    `;
  });

  el.procTableBody.innerHTML = html;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[m]);
}

/**
 * Handle incoming telemetry snapshot & analysis from SSE
 */
function handleTelemetryUpdate(data) {
  const { snapshot, analysis, persistence, newAlert, settings } = data;
  if (!snapshot) return;

  // Sync settings
  if (settings) {
    state.soundEnabled = settings.soundEnabled;
    state.desktopNotify = settings.desktopNotify;
    state.tempThreshold = settings.tempThreshold;
    state.durationMinutes = settings.durationMinutes;
    state.sensorMode = settings.sensorMode;

    if (el.soundIcon) el.soundIcon.textContent = state.soundEnabled ? '🔔' : '🔕';
    if (el.tempThreshSlider && !state.isUserInteractingSettings) {
      el.tempThreshSlider.value = settings.tempThreshold;
      el.tempThreshDisplay.textContent = `${settings.tempThreshold}°C`;
    }
    if (el.durationSlider && !state.isUserInteractingSettings) {
      el.durationSlider.value = settings.durationMinutes;
      el.durationDisplay.textContent = `${settings.durationMinutes} Mins`;
    }
    if (el.sensorModeSelect && !state.isUserInteractingSettings) {
      el.sensorModeSelect.value = settings.sensorMode || 'die';
    }
    if (el.soundCheckbox) el.soundCheckbox.checked = settings.soundEnabled;
    if (el.notifyCheckbox) el.notifyCheckbox.checked = settings.desktopNotify;
  }

  // System Model
  if (snapshot.system) {
    if (el.sysChip) el.sysChip.textContent = `${snapshot.system.cpuBrand || 'Apple Silicon'} • ${snapshot.system.model || 'macOS'}`;
    if (el.uptime) {
      const hrs = Math.floor(snapshot.system.uptime / 3600);
      const mins = Math.floor((snapshot.system.uptime % 3600) / 60);
      el.uptime.textContent = `Uptime: ${hrs}h ${mins}m`;
    }
  }

  // Active Focus Window
  if (el.frontmostApp) el.frontmostApp.textContent = snapshot.frontmostApp || 'Desktop';

  // CPU Gauge & KPIs
  if (snapshot.cpu) {
    const cpuTotal = snapshot.cpu.total;
    if (el.cpuTotalVal) el.cpuTotalVal.textContent = `${cpuTotal}%`;
    if (el.cpuUserVal) el.cpuUserVal.textContent = `${snapshot.cpu.user}%`;
    if (el.cpuSysVal) el.cpuSysVal.textContent = `${snapshot.cpu.sys}%`;
    if (el.cpuLoadAvg && snapshot.cpu.loadAvg) {
      el.cpuLoadAvg.textContent = snapshot.cpu.loadAvg.slice(0, 2).join(', ');
    }
    if (el.cpuCoresCount) el.cpuCoresCount.textContent = `${snapshot.cpu.coreCount} Cores`;
    setRingProgress(el.ringCpu, cpuTotal);
    renderCoreMatrix(snapshot.cpu.cores);
  }

  // GPU Gauge & KPIs
  if (snapshot.gpu) {
    const gpuTotal = snapshot.gpu.deviceUtil;
    if (el.gpuTotalVal) el.gpuTotalVal.textContent = `${gpuTotal}%`;
    if (el.gpuRendererVal) el.gpuRendererVal.textContent = `${snapshot.gpu.rendererUtil}%`;
    if (el.gpuTilerVal) el.gpuTilerVal.textContent = `${snapshot.gpu.tilerUtil}%`;
    if (el.gpuMemVal) el.gpuMemVal.textContent = `${snapshot.gpu.inUseMemoryMb} MB`;
    setRingProgress(el.ringGpu, gpuTotal);
  }

  // NPU Gauge & KPIs
  if (snapshot.npu) {
    const npuUtil = snapshot.npu.utilization;
    if (el.npuTotalVal) el.npuTotalVal.textContent = `${npuUtil}%`;
    if (el.npuDaemonsVal) el.npuDaemonsVal.textContent = `${snapshot.npu.daemonsActive} Active`;
    if (el.npuClientsVal) el.npuClientsVal.textContent = String(snapshot.npu.activeClientsCount);
    setRingProgress(el.ringNpu, npuUtil);
  }

  // Thermals Gauge & KPIs
  if (snapshot.thermal) {
    const dieTemp = snapshot.thermal.socDieTempC;
    if (el.thermalDieVal) el.thermalDieVal.textContent = formatTemp(dieTemp);
    if (el.thermalBatteryVal) el.thermalBatteryVal.textContent = formatTemp(snapshot.thermal.batteryTempC);
    if (el.thermalVirtualVal) el.thermalVirtualVal.textContent = formatTemp(snapshot.thermal.virtualTempC);
    if (el.thermalPowerVal) {
      el.thermalPowerVal.textContent = `${snapshot.thermal.isCharging ? 'Charging' : 'Battery'} (${snapshot.thermal.batteryCapacity}%)`;
    }
    if (el.thermalPressureBadge) {
      el.thermalPressureBadge.textContent = snapshot.thermal.thermalPressure;
      el.thermalPressureBadge.className = `badge badge-thermal ${snapshot.thermal.thermalPressure.toLowerCase()}`;
    }

    // Color gradient for temperature ring (ranges roughly 30°C to 90°C)
    const tempProgress = Math.max(0, Math.min(100, ((dieTemp - 30) / 60) * 100));
    setRingProgress(el.ringThermal, tempProgress);

    // Quick badge in header
    if (el.quickThermalBadge && el.quickThermal) {
      el.quickThermal.textContent = `SoC: ${formatTemp(dieTemp)}`;
      el.quickThermalBadge.className = `thermal-quick-badge ${snapshot.thermal.statusLevel.toLowerCase()}`;
    }
  }

  // History sliding buffer for chart
  state.history.push({
    time: Date.now(),
    cpu: snapshot.cpu ? snapshot.cpu.total : 0,
    gpu: snapshot.gpu ? snapshot.gpu.deviceUtil : 0,
    temp: snapshot.thermal ? snapshot.thermal.socDieTempC : 30
  });
  if (state.history.length > 60) state.history.shift();

  renderTimelineChart();

  // Update Persistence Watchdog Card
  if (persistence) {
    const elapsedMin = Math.floor(persistence.elapsedSeconds / 60);
    const elapsedSec = persistence.elapsedSeconds % 60;
    const targetMin = Math.floor(persistence.targetSeconds / 60);
    const targetSec = persistence.targetSeconds % 60;

    if (el.watchdogConditionText) {
      el.watchdogConditionText.textContent = `Condition: Above ${formatTemp(persistence.threshold)} continuously for > ${persistence.durationMinutes} mins`;
    }
    if (el.watchdogTimerText) {
      el.watchdogTimerText.textContent = `${elapsedMin}m ${String(elapsedSec).padStart(2, '0')}s / ${targetMin}m ${String(targetSec).padStart(2, '0')}s`;
    }
    if (el.watchdogBarFill) {
      el.watchdogBarFill.style.width = `${persistence.progressPercent}%`;
    }
    if (el.watchdogSensorTag) {
      el.watchdogSensorTag.textContent = settings?.sensorMode === 'raw' 
        ? 'Monitoring: Raw Apple PMU Sensor' 
        : 'Monitoring: SoC Die Model (28s Thermal Inertia)';
    }

    if (persistence.isAlertFired) {
      if (el.watchdogCard) el.watchdogCard.className = 'persistence-watchdog-card alert-fired';
      if (el.watchdogDot) el.watchdogDot.className = 'watchdog-pulse-dot alert-fired';
      if (el.watchdogStatusText) {
        el.watchdogStatusText.textContent = `🚨 PERSISTENT HIGH TEMPERATURE ALERT ACTIVE! Temperature has remained at ${formatTemp(persistence.currentTemp)} for over ${persistence.durationMinutes} minutes!`;
      }
      playAlertChime(true);
      showGlobalBanner(
        `Persistent High Temperature Alert (>${persistence.durationMinutes}m)`,
        `Temperature has been continuously above ${formatTemp(persistence.threshold)} for ${elapsedMin}m ${elapsedSec}s. Check culprit process below.`,
        analysis?.primaryCulprit
      );
    } else if (persistence.isAboveThreshold) {
      if (el.watchdogCard) el.watchdogCard.className = 'persistence-watchdog-card elevated';
      if (el.watchdogDot) el.watchdogDot.className = 'watchdog-pulse-dot elevated';
      if (el.watchdogStatusText) {
        el.watchdogStatusText.textContent = `⏳ Temperature elevated (${formatTemp(persistence.currentTemp)} >= ${formatTemp(persistence.threshold)}). Sustained for ${elapsedMin}m ${elapsedSec}s (${persistence.progressPercent}%). Alert triggers after ${persistence.durationMinutes} continuous minutes.`;
      }
      hideGlobalBanner();
    } else {
      if (el.watchdogCard) el.watchdogCard.className = 'persistence-watchdog-card';
      if (el.watchdogDot) el.watchdogDot.className = 'watchdog-pulse-dot';
      if (el.watchdogStatusText) {
        el.watchdogStatusText.textContent = `✅ Temperature is within safe limits (${formatTemp(persistence.currentTemp)} < ${formatTemp(persistence.threshold)}). No continuous heat detected.`;
      }
      hideGlobalBanner();
    }
  }

  // Attribution & Spike Spotlight
  if (analysis) {
    if (el.thermalRateVal) {
      const sign = analysis.delta5s >= 0 ? '+' : '';
      el.thermalRateVal.textContent = `${sign}${analysis.delta5s}°/5s`;
    }

    if (el.spotlightNarrative) el.spotlightNarrative.textContent = analysis.statusMessage;
    if (el.spotlightTrendText) el.spotlightTrendText.textContent = analysis.trend;

    if (analysis.trend.startsWith('RISING')) {
      if (el.spotlightIcon) el.spotlightIcon.textContent = '🔥';
      if (el.spotlightTrendText) el.spotlightTrendText.className = 'text-amber';
    } else if (analysis.trend === 'COOLING') {
      if (el.spotlightIcon) el.spotlightIcon.textContent = '❄️';
      if (el.spotlightTrendText) el.spotlightTrendText.className = 'text-cyan';
    } else {
      if (el.spotlightIcon) el.spotlightIcon.textContent = '✨';
      if (el.spotlightTrendText) el.spotlightTrendText.className = 'text-emerald';
    }

    // Display primary culprit card
    if (analysis.primaryCulprit && (analysis.isSpike || analysis.primaryCulprit.cpu > 15)) {
      const c = analysis.primaryCulprit;
      if (el.culpritRow) el.culpritRow.style.display = 'flex';
      if (el.culpritName) el.culpritName.textContent = c.name;
      if (el.culpritPid) el.culpritPid.textContent = `PID ${c.pid}`;
      if (el.culpritCpu) el.culpritCpu.textContent = `${c.cpu.toFixed(1)}%`;
      if (el.culpritDeltaCpu) el.culpritDeltaCpu.textContent = `+${c.deltaCpu.toFixed(1)}%`;
      if (el.culpritMem) el.culpritMem.textContent = `${c.mem.toFixed(1)}%`;
      if (el.culpritScore) el.culpritScore.textContent = `${c.heatScore.toFixed(1)}`;

      if (el.culpritRoleBadge) {
        el.culpritRoleBadge.textContent = c.isForeground ? 'FOREGROUND ACTIVE' : (c.type === 'BACKGROUND_APP' ? 'BACKGROUND APP' : 'SYSTEM DAEMON');
        el.culpritRoleBadge.className = `role-badge ${c.isForeground ? 'foreground' : ''}`;
      }

      if (el.culpritTerminateBtn) {
        el.culpritTerminateBtn.onclick = () => window.requestKillProcess(c.pid, c.name);
      }
    } else {
      if (el.culpritRow) el.culpritRow.style.display = 'none';
    }
  }

  // Process Table
  renderProcessTable(snapshot.processes || []);
}

function showGlobalBanner(title, desc, culprit) {
  if (!el.alertBanner) return;
  el.alertBanner.style.display = 'block';
  if (el.alertTitle) el.alertTitle.textContent = title;
  if (el.alertDesc) el.alertDesc.textContent = desc;

  const inspectBtn = document.getElementById('banner-culprit-action');
  if (inspectBtn && culprit) {
    inspectBtn.style.display = 'inline-block';
    inspectBtn.onclick = () => window.requestKillProcess(culprit.pid, culprit.name);
  }
}

function hideGlobalBanner() {
  if (el.alertBanner) el.alertBanner.style.display = 'none';
}

/**
 * Connect to SSE Event Stream
 */
function connectSSE() {
  const evtSource = new EventSource('/events');

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleTelemetryUpdate(data);
    } catch (e) {
      console.error('Failed to parse SSE message:', e);
    }
  };

  evtSource.onerror = (err) => {
    console.warn('SSE connection interrupted, retrying in 2s...', err);
    evtSource.close();
    setTimeout(connectSSE, 2000);
  };
}

/**
 * Process Termination Flow
 */
window.requestKillProcess = function(pid, name) {
  state.pendingKillPid = pid;
  state.pendingKillName = name;
  if (el.killTargetName) el.killTargetName.textContent = name;
  if (el.killTargetPid) el.killTargetPid.textContent = `PID ${pid}`;
  if (el.killModal) el.killModal.style.display = 'flex';
};

async function executeKillProcess() {
  if (!state.pendingKillPid) return;
  try {
    const res = await fetch('/api/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: state.pendingKillPid, force: false })
    });
    const result = await res.json();
    if (result.success) {
      if (el.killModal) el.killModal.style.display = 'none';
      state.pendingKillPid = null;
    } else {
      alert(`Could not terminate process: ${result.error}`);
    }
  } catch (e) {
    alert(`Request error: ${e.message}`);
  }
}

/**
 * Event Listeners & Wiring
 */
function initEventListeners() {
  // Unit toggle
  if (el.unitToggleBtn) {
    el.unitToggleBtn.addEventListener('click', () => {
      state.isFahrenheit = !state.isFahrenheit;
      el.unitC.className = state.isFahrenheit ? 'unit-inactive' : 'unit-active';
      el.unitF.className = state.isFahrenheit ? 'unit-active' : 'unit-inactive';
    });
  }

  // Audio Toggle
  if (el.soundToggleBtn) {
    el.soundToggleBtn.addEventListener('click', () => {
      state.soundEnabled = !state.soundEnabled;
      if (el.soundIcon) el.soundIcon.textContent = state.soundEnabled ? '🔔' : '🔕';
      fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ soundEnabled: state.soundEnabled })
      });
    });
  }

  // Desktop Notifications
  if (el.notifyPermBtn) {
    el.notifyPermBtn.addEventListener('click', async () => {
      if ('Notification' in window) {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
          new Notification('PulseMac Alerts Enabled', {
            body: 'You will receive desktop alerts when thermal spikes occur.'
          });
        }
      }
    });
  }

  // Search input
  if (el.procSearchInput) {
    el.procSearchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
    });
  }

  // Filter pills
  if (el.filterPills) {
    el.filterPills.addEventListener('click', (e) => {
      if (e.target.classList.contains('filter-pill')) {
        document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        state.activeFilter = e.target.getAttribute('data-filter');
      }
    });
  }

  // Table header sort
  document.querySelectorAll('.process-table th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-sort');
      if (state.sortCol === col) {
        state.sortAsc = !state.sortAsc;
      } else {
        state.sortCol = col;
        state.sortAsc = false;
      }
      document.querySelectorAll('.process-table th').forEach(h => h.classList.remove('sort-active', 'asc', 'desc'));
      th.classList.add('sort-active', state.sortAsc ? 'asc' : 'desc');
    });
  });

  // Settings Modal
  if (el.settingsOpenBtn) {
    el.settingsOpenBtn.onclick = () => {
      state.isUserInteractingSettings = true;
      el.settingsModal.style.display = 'flex';
    };
  }
  if (el.settingsCloseBtn) {
    el.settingsCloseBtn.onclick = () => {
      state.isUserInteractingSettings = false;
      el.settingsModal.style.display = 'none';
    };
  }
  if (el.tempThreshSlider) {
    el.tempThreshSlider.oninput = (e) => el.tempThreshDisplay.textContent = `${e.target.value}°C`;
  }
  if (el.durationSlider) {
    el.durationSlider.oninput = (e) => el.durationDisplay.textContent = `${Number(e.target.value).toFixed(1)} Mins`;
  }

  if (el.testSoundBtn) el.testSoundBtn.onclick = () => playAlertChime(true);

  if (el.saveSettingsBtn) {
    el.saveSettingsBtn.onclick = async () => {
      const payload = {
        tempThreshold: Number(el.tempThreshSlider.value),
        durationMinutes: Number(el.durationSlider.value),
        sensorMode: el.sensorModeSelect.value,
        soundEnabled: el.soundCheckbox.checked,
        desktopNotify: el.notifyCheckbox.checked
      };
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      state.isUserInteractingSettings = false;
      el.settingsModal.style.display = 'none';
    };
  }

  // Kill Modal
  if (el.killCloseBtn) el.killCloseBtn.onclick = () => el.killModal.style.display = 'none';
  if (el.killCancelBtn) el.killCancelBtn.onclick = () => el.killModal.style.display = 'none';
  if (el.killConfirmBtn) el.killConfirmBtn.onclick = executeKillProcess;

  // Dismiss alert & reset time calculations
  async function dismissAndResetTimer() {
    hideGlobalBanner();
    if (el.watchdogTimerText) el.watchdogTimerText.textContent = `0m 00s / ${Math.round((state.durationMinutes || 5) * 60)}s`;
    if (el.watchdogBarFill) el.watchdogBarFill.style.width = '0%';
    if (el.watchdogCard) el.watchdogCard.className = 'persistence-watchdog-card';
    if (el.watchdogDot) el.watchdogDot.className = 'watchdog-pulse-dot';
    if (el.watchdogStatusText) el.watchdogStatusText.textContent = '🔄 Persistent time calculation reset to 0s by user.';

    try {
      await fetch('/api/alerts/dismiss', { method: 'POST' });
    } catch (e) {
      console.warn('Failed to dismiss alert:', e);
    }
  }

  // Banner dismiss & watchdog reset
  if (el.alertDismiss) el.alertDismiss.onclick = dismissAndResetTimer;
  if (el.watchdogResetBtn) el.watchdogResetBtn.onclick = dismissAndResetTimer;
}

// Window resize chart re-render
window.addEventListener('resize', renderTimelineChart);

// PWA Service Worker & Install Prompt Registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => {
      console.warn('PWA ServiceWorker registration failed:', err);
    });
  });
}

let deferredPrompt = null;
const pwaInstallBtn = document.getElementById('pwa-install-btn');

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (pwaInstallBtn) {
    pwaInstallBtn.style.display = 'inline-flex';
  }
});

if (pwaInstallBtn) {
  pwaInstallBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      pwaInstallBtn.style.display = 'none';
    }
    deferredPrompt = null;
  });
}

window.addEventListener('appinstalled', () => {
  if (pwaInstallBtn) pwaInstallBtn.style.display = 'none';
  console.log('PulseMac PWA installed successfully!');
});

// Initialize
initEventListeners();
connectSSE();

