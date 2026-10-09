import os from 'node:os';
import { exec, execSync } from 'node:child_process';
import util from 'node:util';

const execAsync = util.promisify(exec);

let prevCpus = null;
let lastFrontmost = 'Unknown';
let lastFrontmostTime = 0;
let cachedHwModel = null;
let cachedCpuBrand = null;
let smoothedDieTemp = null;
let lastThermalTime = Date.now();

// Initialize hardware identifiers
try {
  cachedHwModel = execSync('sysctl -n hw.model', { timeout: 1000 }).toString().trim();
  cachedCpuBrand = execSync('sysctl -n machdep.cpu.brand_string', { timeout: 1000 }).toString().trim();
} catch (e) {
  cachedHwModel = os.platform() + ' ' + os.arch();
  cachedCpuBrand = os.cpus()[0]?.model || 'Apple Silicon';
}

/**
 * Measure per-core CPU utilization by diffing os.cpus() times
 */
function getCpuMetrics() {
  const currentCpus = os.cpus();
  const cores = [];
  let totalUser = 0;
  let totalSys = 0;
  let totalIdle = 0;
  let totalTicks = 0;

  if (!prevCpus || prevCpus.length !== currentCpus.length) {
    prevCpus = currentCpus;
    return {
      total: 0,
      user: 0,
      sys: 0,
      idle: 100,
      cores: currentCpus.map((_, i) => ({ core: i, usage: 0 })),
      model: cachedCpuBrand,
      coreCount: currentCpus.length,
      loadAvg: os.loadavg()
    };
  }

  for (let i = 0; i < currentCpus.length; i++) {
    const t1 = prevCpus[i].times;
    const t2 = currentCpus[i].times;

    const u = t2.user - t1.user;
    const n = t2.nice - t1.nice;
    const s = t2.sys - t1.sys;
    const id = t2.idle - t1.idle;
    const ir = t2.irq - t1.irq;

    const coreTotal = u + n + s + id + ir;
    const coreBusy = coreTotal - id;
    const coreUsage = coreTotal > 0 ? (coreBusy / coreTotal) * 100 : 0;

    cores.push({
      core: i,
      usage: Math.max(0, Math.min(100, Math.round(coreUsage * 10) / 10))
    });

    totalUser += u + n;
    totalSys += s + ir;
    totalIdle += id;
    totalTicks += coreTotal;
  }

  prevCpus = currentCpus;

  const totalBusy = totalTicks - totalIdle;
  const totalPercent = totalTicks > 0 ? (totalBusy / totalTicks) * 100 : 0;
  const userPercent = totalTicks > 0 ? (totalUser / totalTicks) * 100 : 0;
  const sysPercent = totalTicks > 0 ? (totalSys / totalTicks) * 100 : 0;

  return {
    total: Math.max(0, Math.min(100, Math.round(totalPercent * 10) / 10)),
    user: Math.round(userPercent * 10) / 10,
    sys: Math.round(sysPercent * 10) / 10,
    idle: Math.max(0, Math.round((100 - totalPercent) * 10) / 10),
    cores,
    model: cachedCpuBrand,
    coreCount: currentCpus.length,
    loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100)
  };
}

/**
 * Extract Apple Silicon GPU telemetry via IOKit IOAccelerator
 */
async function getGpuMetrics() {
  try {
    const { stdout } = await execAsync('ioreg -r -d 1 -c IOAccelerator', {
      timeout: 1200,
      maxBuffer: 10 * 1024 * 1024
    });

    const m = stdout.match(/\"PerformanceStatistics\"\s*=\s*\{([^}]+)\}/);
    if (!m) {
      return {
        deviceUtil: 0,
        rendererUtil: 0,
        tilerUtil: 0,
        allocatedMemoryMb: 0,
        inUseMemoryMb: 0,
        available: true
      };
    }

    const dict = {};
    const pairs = m[1].split(',');
    for (const pair of pairs) {
      const parts = pair.split('=');
      if (parts.length === 2) {
        const k = parts[0].replace(/\"/g, '').trim();
        const v = parts[1].replace(/\"/g, '').trim();
        dict[k] = isNaN(v) ? v : Number(v);
      }
    }

    const deviceUtil = Number(dict['Device Utilization %'] ?? 0);
    const rendererUtil = Number(dict['Renderer Utilization %'] ?? 0);
    const tilerUtil = Number(dict['Tiler Utilization %'] ?? 0);
    const allocBytes = Number(dict['Alloc system memory'] ?? 0);
    const inUseBytes = Number(dict['In use system memory'] ?? 0);

    return {
      deviceUtil: Math.max(0, Math.min(100, deviceUtil)),
      rendererUtil: Math.max(0, Math.min(100, rendererUtil)),
      tilerUtil: Math.max(0, Math.min(100, tilerUtil)),
      allocatedMemoryMb: Math.round(allocBytes / (1024 * 1024)),
      inUseMemoryMb: Math.round(inUseBytes / (1024 * 1024)),
      available: true
    };
  } catch (err) {
    return {
      deviceUtil: 0,
      rendererUtil: 0,
      tilerUtil: 0,
      allocatedMemoryMb: 0,
      inUseMemoryMb: 0,
      available: false,
      error: err.message
    };
  }
}

/**
 * Extract Apple Neural Engine (ANE / NPU) telemetry and active CoreML/ANE clients
 */
async function getNpuMetrics(processList = []) {
  let present = true;
  let powerState = 'Active';
  let aneDaemonsRunning = 0;
  let activeClients = [];

  try {
    const { stdout } = await execAsync("ps -eo pid,comm,pcpu -r | grep -iE 'ane|neural|coreml'", {
      timeout: 800
    });

    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      if (line.includes('grep')) continue;
      const parts = line.trim().split(/\s+/);
      const comm = parts.slice(1, -1).join(' ') || parts[1];
      const cpu = parseFloat(parts[parts.length - 1]) || 0;
      if (line.includes('aned') || line.includes('aneuserd') || line.includes('ANECompiler')) {
        aneDaemonsRunning++;
      } else {
        activeClients.push({ name: comm.split('/').pop(), cpu });
      }
    }
  } catch (e) {
    // Grep returns code 1 if no match found
  }

  // Calculate approximate ANE inference activity percentage
  const aneCpuTotal = activeClients.reduce((acc, c) => acc + c.cpu, 0);
  const estimatedNpuUtil = Math.min(100, Math.round((aneDaemonsRunning > 0 ? 5 : 0) + aneCpuTotal * 3));

  return {
    present,
    name: 'Apple Neural Engine (ANE)',
    powerState,
    utilization: estimatedNpuUtil,
    daemonsActive: aneDaemonsRunning,
    activeClientsCount: activeClients.length,
    activeClients
  };
}

/**
 * Extract Battery, Virtual, and Estimated SoC Die Temperatures
 */
async function getThermalMetrics(cpuTotal = 0, gpuTotal = 0) {
  let batteryTempC = 30.0;
  let virtualTempC = 32.0;
  let batteryCapacity = 100;
  let isCharging = false;
  let thermalPressure = 'Nominal';
  let thermalThrottleWarning = false;

  // 1. Battery & Virtual Temp from AppleSmartBattery
  try {
    const { stdout } = await execAsync('ioreg -n AppleSmartBattery -r', { timeout: 1000 });
    const tempMatch = stdout.match(/\"Temperature\"\s*=\s*(\d+)/);
    const vTempMatch = stdout.match(/\"VirtualTemperature\"\s*=\s*(\d+)/);
    const capMatch = stdout.match(/\"CurrentCapacity\"\s*=\s*(\d+)/);
    const chgMatch = stdout.match(/\"IsCharging\"\s*=\s*([A-Za-z]+)/);

    if (tempMatch) batteryTempC = parseFloat((parseInt(tempMatch[1], 10) / 100).toFixed(1));
    if (vTempMatch) virtualTempC = parseFloat((parseInt(vTempMatch[1], 10) / 100).toFixed(1));
    if (capMatch) batteryCapacity = parseInt(capMatch[1], 10);
    if (chgMatch) isCharging = chgMatch[1].toLowerCase() === 'yes';
  } catch (e) {
    // If not on battery / desktop Mac
  }

  // 2. Thermal pressure & warnings from pmset
  try {
    const { stdout } = await execAsync('pmset -g therm', { timeout: 1000 });
    if (stdout.includes('Thermal Level = 1') || stdout.includes('Fair')) {
      thermalPressure = 'Fair';
    } else if (stdout.includes('Thermal Level = 2') || stdout.includes('Serious')) {
      thermalPressure = 'Serious';
      thermalThrottleWarning = true;
    } else if (stdout.includes('Thermal Level = 3') || stdout.includes('Critical')) {
      thermalPressure = 'Critical';
      thermalThrottleWarning = true;
    }
    if (stdout.includes('CPU power status') && !stdout.includes('No CPU power status')) {
      thermalThrottleWarning = true;
    }
  } catch (e) {
    // Nominal default
  }

  // 3. Physical Silicon Die Temperature calculation with Thermal Inertia:
  // Real physical chips and enclosures have significant thermal capacitance (heat capacity).
  // Instantaneous power dissipation heats the die gradually over time (Newton's law of cooling:
  // dT/dt = (T_target - T) / tau, with tau ≈ 28s).
  const cpuLoadNorm = Math.min(100, Math.max(0, cpuTotal)) / 100;
  const gpuLoadNorm = Math.min(100, Math.max(0, gpuTotal)) / 100;

  const alpha = 28.0; // Max steady-state CPU temp lift above chassis under sustained 100% load
  const beta = 18.0;  // Max steady-state GPU temp lift
  const pressureOffset = thermalPressure === 'Critical' ? 18 : thermalPressure === 'Serious' ? 10 : thermalPressure === 'Fair' ? 4 : 0;

  // Target steady-state temperature for current electrical load
  const targetLift = Math.pow(cpuLoadNorm, 1.15) * alpha + Math.pow(gpuLoadNorm, 1.15) * beta + pressureOffset;
  const targetTempC = virtualTempC + targetLift;

  const now = Date.now();
  const dtSeconds = Math.max(0.2, Math.min(5.0, (now - lastThermalTime) / 1000));
  lastThermalTime = now;

  if (smoothedDieTemp === null) {
    smoothedDieTemp = virtualTempC;
  }

  // Thermal filter: tau = 28 seconds (physically realistic heating/cooling response rate)
  const tau = 28.0;
  const filterAlpha = 1.0 - Math.exp(-dtSeconds / tau);
  smoothedDieTemp = smoothedDieTemp + filterAlpha * (targetTempC - smoothedDieTemp);

  const socDieTempC = parseFloat(smoothedDieTemp.toFixed(1));
  const hardwareTempC = virtualTempC; // Raw physical sensor from Apple PMU

  return {
    socDieTempC,
    hardwareTempC,
    batteryTempC,
    virtualTempC,
    targetTempC: parseFloat(targetTempC.toFixed(1)),
    batteryCapacity,
    isCharging,
    thermalPressure,
    thermalThrottleWarning,
    statusLevel: socDieTempC >= 78 ? 'Critical' : socDieTempC >= 65 ? 'Warning' : 'Normal'
  };
}

/**
 * Get current frontmost active application name via osascript
 */
async function getFrontmostAppName() {
  const now = Date.now();
  if (now - lastFrontmostTime < 1000 && lastFrontmost) {
    return lastFrontmost;
  }
  try {
    const { stdout } = await execAsync(
      "osascript -e 'tell application \"System Events\" to get name of first application process whose frontmost is true'",
      { timeout: 900 }
    );
    lastFrontmost = stdout.trim() || 'Desktop';
    lastFrontmostTime = now;
    return lastFrontmost;
  } catch (e) {
    return lastFrontmost || 'Desktop';
  }
}

/**
 * Parse top processes and classify into:
 * - FOREGROUND: Frontmost windowed app
 * - BACKGROUND_APP: Inactive windowed .app application
 * - BACKGROUND_DAEMON: System daemon or background process
 */
async function getProcessMetrics(frontmostApp = 'Unknown') {
  try {
    const { stdout } = await execAsync('ps -eo pid,%cpu,%mem,comm -r', { timeout: 1200 });
    const lines = stdout.trim().split('\n').slice(1);
    const processes = [];

    const frontmostLower = frontmostApp.toLowerCase();

    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const cpu = parseFloat(match[2]);
      const mem = parseFloat(match[3]);
      const comm = match[4];

      // Clean application name
      let appName = comm.split('/').pop();
      let isAppBundle = comm.includes('.app/');
      let isSystem = comm.startsWith('/System') || comm.startsWith('/usr') || comm.startsWith('/sbin');

      if (isAppBundle) {
        const appMatch = comm.match(/\/([^\/]+)\.app\//);
        if (appMatch) {
          appName = appMatch[1];
        }
      }

      // Classify process type
      let type = 'BACKGROUND_DAEMON';
      let isForeground = false;

      const nameLower = appName.toLowerCase();
      if (nameLower === frontmostLower || (frontmostLower !== 'desktop' && comm.toLowerCase().includes(frontmostLower))) {
        type = 'FOREGROUND';
        isForeground = true;
      } else if (isAppBundle) {
        type = 'BACKGROUND_APP';
      } else {
        type = isSystem ? 'SYSTEM_DAEMON' : 'BACKGROUND_SERVICE';
      }

      // Calculate thermal impact score (CPU% + estimated GPU/wake multiplier)
      const impactScore = parseFloat((cpu * (isForeground ? 1.0 : 1.25) + mem * 0.5).toFixed(1));

      processes.push({
        pid,
        name: appName,
        path: comm,
        cpu,
        mem,
        type,
        isForeground,
        impactScore
      });

      if (processes.length >= 40) break;
    }

    return processes;
  } catch (err) {
    return [];
  }
}

/**
 * Get system memory statistics
 */
function getMemoryMetrics() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usedPercent = Math.round((used / total) * 1000) / 10;

  return {
    totalMb: Math.round(total / (1024 * 1024)),
    usedMb: Math.round(used / (1024 * 1024)),
    freeMb: Math.round(free / (1024 * 1024)),
    usedPercent
  };
}

/**
 * Aggregate all system metrics into a unified snapshot
 */
export async function collectSystemSnapshot() {
  const timestamp = Date.now();
  const [frontmostApp, gpu, mem] = await Promise.all([
    getFrontmostAppName(),
    getGpuMetrics(),
    getMemoryMetrics()
  ]);

  const cpu = getCpuMetrics();
  const thermal = await getThermalMetrics(cpu.total, gpu.deviceUtil);
  const processes = await getProcessMetrics(frontmostApp);
  const npu = await getNpuMetrics(processes);

  return {
    timestamp,
    system: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: Math.round(os.uptime()),
      model: cachedHwModel,
      cpuBrand: cachedCpuBrand
    },
    cpu,
    gpu,
    npu,
    thermal,
    memory: mem,
    frontmostApp,
    processes
  };
}
