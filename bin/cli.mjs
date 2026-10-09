#!/usr/bin/env node

/**
 * PulseMac CLI & Terminal TUI Runner
 */
import { startServer } from '../server.mjs';
import { collectSystemSnapshot } from '../lib/collector.mjs';
import { SpikeAttributionEngine } from '../lib/attribution.mjs';
import { AlertManager } from '../lib/alerts.mjs';

const args = process.argv.slice(2);
const isTui = args.includes('--tui') || args.includes('-t');
const isHelp = args.includes('--help') || args.includes('-h');

if (isHelp) {
  console.log(`
⚡ PulseMac - macOS Hardware, Thermal & Spike Attribution Monitor

Usage:
  pulsemac [options]

Options:
  --open, -o      Open the web dashboard in your default browser (Default)
  --tui, -t       Run lightweight live Terminal TUI dashboard
  --port, -p      Specify web dashboard port (Default: 3888)
  --help, -h      Show this help message
`);
  process.exit(0);
}

if (isTui) {
  runTerminalTui();
} else {
  const portIdx = args.findIndex(a => a === '--port' || a === '-p');
  const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1], 10) : 3888;
  const shouldOpen = !args.includes('--no-open');
  startServer(port, shouldOpen);
}

/**
 * Terminal TUI Dashboard
 */
async function runTerminalTui() {
  const attribution = new SpikeAttributionEngine(60);
  const alertManager = new AlertManager();

  // Clear screen and hide cursor
  process.stdout.write('\x1b[?25l');
  process.on('exit', () => process.stdout.write('\x1b[?25h'));
  process.on('SIGINT', () => {
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  });

  async function renderFrame() {
    try {
      const snap = await collectSystemSnapshot();
      const analysis = attribution.analyze(snap);
      const { persistence } = alertManager.processAnalysis(analysis, snap);

      // ANSI colors
      const cyan = '\x1b[36m';
      const purple = '\x1b[35m';
      const amber = '\x1b[33m';
      const red = '\x1b[31m';
      const green = '\x1b[32m';
      const gray = '\x1b[90m';
      const bold = '\x1b[1m';
      const reset = '\x1b[0m';

      let out = '\x1b[H\x1b[2J'; // Clear screen & home cursor

      out += `${bold}${cyan}⚡ PULSEMAC${reset} ${gray}• macOS Hardware & Thermal Intelligence Monitor${reset}\n`;
      out += `${gray}System:${reset} ${snap.system.cpuBrand || 'Apple Silicon'} (${snap.cpu.coreCount} Cores) | ${gray}Frontmost App:${reset} ${bold}${cyan}${snap.frontmostApp}${reset}\n`;
      out += `${gray}───────────────────────────────────────────────────────────────────────────────────${reset}\n\n`;

      // Telemetry Cards
      const cpuBar = createAsciiBar(snap.cpu.total, 100, 16);
      const gpuBar = createAsciiBar(snap.gpu.deviceUtil, 100, 16);
      const npuBar = createAsciiBar(snap.npu.utilization, 100, 16);
      const tempBar = createAsciiBar(Math.max(0, snap.thermal.socDieTempC - 30), 60, 16);

      out += `  ${bold}CPU LOAD${reset}         [${cyan}${cpuBar}${reset}]  ${bold}${snap.cpu.total.toFixed(1)}%${reset}  ${gray}(User: ${snap.cpu.user}%, Sys: ${snap.cpu.sys}%)${reset}\n`;
      out += `  ${bold}GPU METAL${reset}        [${purple}${gpuBar}${reset}]  ${bold}${snap.gpu.deviceUtil}%${reset}   ${gray}(Renderer: ${snap.gpu.rendererUtil}%, VRAM: ${snap.gpu.inUseMemoryMb}MB)${reset}\n`;
      out += `  ${bold}NPU / ANE${reset}        [${amber}${npuBar}${reset}]  ${bold}${snap.npu.utilization}%${reset}   ${gray}(Daemons: ${snap.npu.daemonsActive}, Clients: ${snap.npu.activeClientsCount})${reset}\n`;
      
      const tempColor = snap.thermal.socDieTempC >= 75 ? red : (snap.thermal.socDieTempC >= 65 ? amber : green);
      out += `  ${bold}SOC THERMALS${reset}     [${tempColor}${tempBar}${reset}]  ${bold}${tempColor}${snap.thermal.socDieTempC}°C${reset}  ${gray}(Batt: ${snap.thermal.batteryTempC}°C, PMU: ${snap.thermal.virtualTempC}°C)${reset}\n\n`;

      // Persistent Watchdog Banner
      const elMin = Math.floor(persistence.elapsedSeconds / 60);
      const elSec = persistence.elapsedSeconds % 60;
      const targetMin = Math.floor(persistence.targetSeconds / 60);
      const statusIcon = persistence.isAlertFired ? `${red}🚨 ALERT` : (persistence.isAboveThreshold ? `${amber}⏳ ELEVATED` : `${green}✅ NORMAL`);
      out += `  ${bold}PERSISTENT WATCHDOG${reset}  ${statusIcon}${reset} ${gray}•${reset} Above ${persistence.threshold}°C for: ${bold}${elMin}m ${String(elSec).padStart(2, '0')}s / ${targetMin}m 00s${reset} ${gray}(Alerts trigger only after >${persistence.durationMinutes}m)${reset}\n\n`;

      // Attribution & Culprit Spotlight
      out += `${gray}── ${bold}THERMAL SPIKE & CULPRIT INTELLIGENCE${reset} ${gray}──────────────────────────────────────────${reset}\n`;
      out += `  ${analysis.statusMessage}\n`;
      if (analysis.primaryCulprit) {
        const c = analysis.primaryCulprit;
        const roleStr = c.isForeground ? `${cyan}[FOREGROUND ACTIVE]${reset}` : `${amber}[BACKGROUND APP]${reset}`;
        out += `  Offending Process: ${bold}${c.name}${reset} (PID ${c.pid}) ${roleStr} ${gray}•${reset} CPU: ${bold}${c.cpu}%${reset} ${gray}•${reset} Surge: ${amber}+${c.deltaCpu}%${reset}\n`;
      }
      out += `\n`;

      // Top Processes Table
      out += `${gray}── ${bold}TOP PROCESSES BY RESOURCE IMPACT${reset} ${gray}─────────────────────────────────────────────${reset}\n`;
      out += `  ${gray}${'PID'.padEnd(8)}${'ROLE'.padEnd(22)}${'NAME'.padEnd(28)}${'CPU %'.padEnd(10)}${'RAM %'.padEnd(10)}${'IMPACT'}${reset}\n`;

      const topProcs = (snap.processes || []).slice(0, 10);
      for (const p of topProcs) {
        let role = 'DAEMON';
        let rColor = gray;
        if (p.isForeground) {
          role = 'FOREGROUND';
          rColor = cyan;
        } else if (p.type === 'BACKGROUND_APP') {
          role = 'BACKGROUND APP';
          rColor = amber;
        }

        const name = (p.name.length > 25 ? p.name.substring(0, 22) + '...' : p.name).padEnd(28);
        const pid = String(p.pid).padEnd(8);
        const roleFmt = `${rColor}${role.padEnd(20)}${reset}`;
        const cpu = `${bold}${p.cpu.toFixed(1)}%${reset}`.padEnd(18);
        const mem = `${p.mem.toFixed(1)}%`.padEnd(10);
        const impact = `${p.impactScore > 20 ? red : gray}${p.impactScore.toFixed(1)}${reset}`;

        out += `  ${pid}${roleFmt}${name}${cpu}${mem}${impact}\n`;
      }

      out += `\n${gray}Press Ctrl+C to exit • Switch to Web Dashboard with: npm start${reset}\n`;

      process.stdout.write(out);
    } catch (err) {
      console.error(err);
    }
  }

  setInterval(renderFrame, 1000);
  renderFrame();
}

function createAsciiBar(value, max, length) {
  const filled = Math.min(length, Math.max(0, Math.round((value / max) * length)));
  return '█'.repeat(filled) + '░'.repeat(length - filled);
}
