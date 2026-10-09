/**
 * Temperature Spike & Culprit Attribution Engine
 * Correlates temperature increases with per-process CPU/GPU surges
 */
export class SpikeAttributionEngine {
  constructor(historyLimit = 60) {
    this.historyLimit = historyLimit;
    this.snapshots = [];
    this.warningThreshold = 68.0;
    this.criticalThreshold = 78.0;
  }

  setThresholds(warning, critical) {
    if (warning) this.warningThreshold = Number(warning);
    if (critical) this.criticalThreshold = Number(critical);
  }

  /**
   * Add a new system snapshot and compute attribution diagnostics
   */
  analyze(currentSnapshot) {
    this.snapshots.push(currentSnapshot);
    if (this.snapshots.length > this.historyLimit) {
      this.snapshots.shift();
    }

    const currentTemp = currentSnapshot.thermal.socDieTempC;
    const len = this.snapshots.length;

    // Default attribution when there's not enough history
    if (len < 3) {
      return {
        isSpike: false,
        delta5s: 0,
        delta30s: 0,
        trend: 'STABLE',
        primaryCulprit: null,
        topCulprits: [],
        statusMessage: `Thermals baseline initializing at ${currentTemp}°C`,
        severity: 'NORMAL'
      };
    }

    // Look back ~5-10 samples (5-10s) and ~30 samples
    const snap5s = this.snapshots[Math.max(0, len - 5)];
    const snap30s = this.snapshots[Math.max(0, len - 30)];

    const delta5s = parseFloat((currentTemp - snap5s.thermal.socDieTempC).toFixed(1));
    const delta30s = parseFloat((currentTemp - snap30s.thermal.socDieTempC).toFixed(1));

    // Determine trend
    let trend = 'STABLE';
    if (delta5s >= 0.8 || delta30s >= 2.5) {
      trend = 'RISING_RAPID';
    } else if (delta5s >= 0.3 || delta30s >= 1.0) {
      trend = 'RISING_MODERATE';
    } else if (delta5s <= -0.5 || delta30s <= -1.5) {
      trend = 'COOLING';
    }

    // Determine if thermal conditions warrant a spike alert
    const isExceedingWarning = currentTemp >= this.warningThreshold;
    const isExceedingCritical = currentTemp >= this.criticalThreshold;
    const isRapidClimb = delta5s >= 1.2 || delta30s >= 3.5;
    const isSpike = isRapidClimb || isExceedingWarning;

    // Severity rating
    let severity = 'NORMAL';
    if (isExceedingCritical || (isExceedingWarning && isRapidClimb)) {
      severity = 'CRITICAL';
    } else if (isExceedingWarning || isRapidClimb) {
      severity = 'WARNING';
    } else if (trend.startsWith('RISING')) {
      severity = 'ELEVATED';
    }

    // Correlate culprit processes
    // Compare current process CPU vs 5-10 seconds ago
    const prevProcMap = new Map();
    if (snap5s && snap5s.processes) {
      for (const p of snap5s.processes) {
        prevProcMap.set(p.pid, p.cpu);
      }
    }

    const scoredProcesses = [];
    const procs = currentSnapshot.processes || [];

    for (const p of procs) {
      const prevCpu = prevProcMap.get(p.pid) ?? (p.cpu * 0.7);
      const deltaCpu = Math.max(0, p.cpu - prevCpu);

      // Scoring formula:
      // Weight CPU heavily. Weight background apps higher because unexpected
      // heat generation usually stems from background runaway tasks.
      const bgMultiplier = p.isForeground ? 1.0 : (p.type === 'BACKGROUND_APP' ? 1.4 : 1.2);
      const heatScore = (p.cpu * 0.7 + deltaCpu * 1.5) * bgMultiplier;

      if (p.cpu > 1.0 || deltaCpu > 2.0) {
        scoredProcesses.push({
          pid: p.pid,
          name: p.name,
          type: p.type,
          isForeground: p.isForeground,
          cpu: p.cpu,
          deltaCpu: parseFloat(deltaCpu.toFixed(1)),
          mem: p.mem,
          heatScore: parseFloat(heatScore.toFixed(1))
        });
      }
    }

    // Sort descending by heatScore
    scoredProcesses.sort((a, b) => b.heatScore - a.heatScore);

    const primaryCulprit = scoredProcesses[0] || null;
    const topCulprits = scoredProcesses.slice(0, 4);

    // Generate human-friendly attribution diagnosis
    let statusMessage = '';
    if (severity === 'CRITICAL') {
      if (primaryCulprit) {
        const role = primaryCulprit.isForeground ? 'active foreground window' : 'background process';
        statusMessage = `🚨 Critical temperature (${currentTemp}°C)! ${primaryCulprit.name} (${role}) is driving heavy thermal load with ${primaryCulprit.cpu}% CPU.`;
      } else {
        statusMessage = `🚨 Critical temperature (${currentTemp}°C)! High total hardware power consumption detected.`;
      }
    } else if (severity === 'WARNING') {
      if (primaryCulprit) {
        const role = primaryCulprit.isForeground ? 'foreground app' : 'background app';
        statusMessage = `⚠️ High temperature (${currentTemp}°C, +${delta5s}°C/5s). Chief culprit: ${primaryCulprit.name} [${role}] using ${primaryCulprit.cpu}% CPU.`;
      } else {
        statusMessage = `⚠️ High temperature warning (${currentTemp}°C). Sustained system load.`;
      }
    } else if (isRapidClimb && primaryCulprit) {
      const role = primaryCulprit.isForeground ? 'foreground' : 'background';
      statusMessage = `🔥 Temperature climbing (+${delta5s}°C in 5s). Spiked by ${primaryCulprit.name} [${role}] at ${primaryCulprit.cpu}% CPU.`;
    } else if (trend === 'COOLING') {
      statusMessage = `❄️ System cooling down (${currentTemp}°C, ${delta5s}°C/5s). Thermals normalizing.`;
    } else {
      statusMessage = `✨ Thermals nominal at ${currentTemp}°C. System operating comfortably.`;
    }

    return {
      isSpike,
      delta5s,
      delta30s,
      trend,
      severity,
      currentTemp,
      warningThreshold: this.warningThreshold,
      criticalThreshold: this.criticalThreshold,
      primaryCulprit,
      topCulprits,
      statusMessage
    };
  }
}
