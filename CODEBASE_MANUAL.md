# PulseMac: Complete Architecture, Code Flow & Developer Manual (PWA Edition)

This document provides a line-level, file-by-file breakdown of the **PulseMac** Progressive Web App codebase, details the end-to-end telemetry and event loop data flow, and provides instructions on how to manually customize every aspect of the tool.

---

## 1. Directory Structure

```
AppMonitoringTool/
├── server.mjs                  # Node.js HTTP, SSE, PWA & REST API Server
├── package.json                # Project dependencies, metadata & npm run scripts
├── start.sh                    # Single-command shell launcher script
├── run.command                 # Double-clickable macOS Finder script
├── bin/
│   └── cli.mjs                 # CLI entry point (Web runner & live Terminal TUI)
├── lib/
│   ├── collector.mjs           # Hardware telemetry (CPU, GPU, NPU, Thermals, Process tree)
│   ├── attribution.mjs         # Thermal spike correlator & foreground/background classifier
│   └── alerts.mjs              # Persistent watchdog & threshold duration evaluator
└── public/
    ├── index.html              # PWA Dashboard markup (Gauges, matrix, canvas, tables, modals)
    ├── app.js                  # Frontend controller (SSE, Canvas 2D charts, Web Audio, PWA install)
    ├── style.css               # Minimalist dark theme styles (SF Pro typography, neon accents)
    ├── manifest.json           # Web App Manifest for PWA standalone installation
    ├── sw.js                   # Service Worker for asset caching & standalone display
    └── icons/
        ├── icon-192.png        # 192x192 PWA & Apple Touch Icon
        └── icon-512.png        # 512x512 PWA High-Resolution Icon
```

---

## 2. End-to-End System Data Flow

```mermaid
flowchart TD
    subgraph macOS Subsystems
        K1[os.cpus Mach Host Ticks]
        K2[IOKit IOAccelerator GPU]
        K3[ps & aned daemons]
        K4[AppleSmartBattery & pmset]
        K5[osascript System Events]
    end

    subgraph Backend Telemetry Engine (server.mjs)
        C[lib/collector.mjs] -->|Telemetry Snapshot| AT[lib/attribution.mjs]
        AT -->|Thermal Rate & Culprits| AL[lib/alerts.mjs]
        AL -->|Persistence Watchdog Status| BROADCAST[Server-Sent Events Broadcast]
        K1 & K2 & K3 & K4 & K5 --> C
    end

    subgraph Progressive Web App Client
        SW[Service Worker sw.js] --> CACHE[Offline Asset Cache]
        UI[public/app.js & index.html] --> RENDER[Gauges, 60 FPS Canvas, Load Matrix]
    end

    BROADCAST -->|Stream /events| UI
```

1. **Sampling Tick (Every 1000ms)**:
   - `server.mjs` triggers `collectSystemSnapshot()` in `lib/collector.mjs`.
2. **Kernel Telemetry Extraction**:
   - `getCpuMetrics()` calculates differential delta ticks across all 10 cores.
   - `getGpuMetrics()` parses Apple Silicon GPU performance counters via `ioreg`.
   - `getNpuMetrics()` inspects Apple Neural Engine daemons (`aned`, `ANECompilerService`).
   - `getThermalMetrics()` samples battery & PMU sensors, applying a $28\text{s}$ low-pass thermal inertia filter.
   - `getFrontmostAppName()` & `getProcessMetrics()` classify all active processes into `FOREGROUND`, `BACKGROUND_APP`, and `SYSTEM_DAEMON`.
3. **Correlation & Attribution**:
   - `lib/attribution.mjs` computes 5s and 30s thermal rates ($\Delta T / 5\text{s}$) and scores each process's heat contribution.
4. **Persistent Watchdog Evaluation**:
   - `lib/alerts.mjs` checks if temperature is $\ge \text{threshold}$. If elevated for $\ge \text{duration}$ continuous minutes, it fires an alert. Dismissing resets the timer back to $0\text{s}$.
5. **Distribution & Rendering**:
   - `server.mjs` broadcasts the snapshot as JSON via Server-Sent Events (`/events`) to `public/app.js`.
   - `app.js` drives SVG circular gauges, 60 FPS Canvas timeline curves, multi-core matrix, audio alerts, and the process table.
6. **Progressive Web App (PWA)**:
   - When opened in Chrome/Edge, the "Install App" button prompts to install it as an independent standalone window with its own Dock icon.
   - In Safari (macOS Sonoma/Sequoia), selecting "File -> Add to Dock" installs it directly into the macOS Dock.

---

## 3. File-by-File Breakdown

### `server.mjs` (Telemetry Server & REST API)
- **Role**: Core application backend. Serves static frontend assets, PWA manifest, and service worker, runs the 1-second monitoring loop, maintains SSE connections, and provides REST endpoints.
- **Key Components**:
  - `clients = Set()`: Maintains active Server-Sent Events HTTP connections.
  - `startMonitoringLoop()`: Runs `setInterval(async () => { ... }, 1000)` to collect data, analyze it, and broadcast to all connected clients.
  - `GET /events`: SSE endpoint providing continuous real-time telemetry stream.
  - `GET /api/status`: Returns current snapshot and alert state as JSON.
  - `POST /api/settings`: Updates thresholds, duration, and sensor mode on the fly.
  - `POST /api/alerts/dismiss`: Resets the persistent watchdog timer back to $0\text{s}$.
  - `POST /api/kill`: Safely terminates a process by PID using `process.kill(pid, SIGTERM)`.

### `lib/collector.mjs` (Hardware Telemetry Engine)
- **Role**: Directly communicates with macOS system interfaces and IOKit to gather hardware metrics.
- **Key Functions**:
  - `getCpuMetrics()`: Subtracts previous `os.cpus()` ticks (`user`, `nice`, `sys`, `idle`, `irq`) from current ticks to obtain true differential utilization for every individual core without shell overhead.
  - `getGpuMetrics()`: Executes `ioreg -r -d 1 -c IOAccelerator` to extract `PerformanceStatistics` (`Device Utilization %`, `Renderer Utilization %`, `Tiler Utilization %`, and allocated VRAM).
  - `getNpuMetrics()`: Queries `ps` for active Apple Neural Engine clients and CoreML compiler daemons (`aned`, `aneuserd`, `ANECompilerService`).
  - `getThermalMetrics()`: Reads `AppleSmartBattery` (`Temperature`, `VirtualTemperature`) via `ioreg` and `pmset -g therm`.
    - **Thermal Inertia Model**: Uses a 1st-order differential equation:
      $$\frac{dT}{dt} = \frac{T_{\text{target}} - T}{\tau} \quad (\tau = 28\text{s})$$
      Eliminates impossible instantaneous spikes while mirroring physical chip heat capacity.
  - `getFrontmostAppName()`: Uses `osascript` to query macOS `System Events` for the frontmost focused application.
  - `getProcessMetrics()`: Reads `ps -eo pid,%cpu,%mem,comm -r`, extracts `.app` bundle names, tags processes as `FOREGROUND`, `BACKGROUND_APP`, or `SYSTEM_DAEMON`, and calculates a Thermal Impact Score.

### `lib/attribution.mjs` (Spike Attribution Engine)
- **Role**: Sliding-window time-series engine attributing thermal changes to specific processes.
- **Key Components**:
  - `snapshots`: Ring buffer holding the last 60 seconds of telemetry.
  - `delta5s` & `delta30s`: Rate of temperature climb over 5 and 30 seconds.
  - **Culprit Scoring Formula**:
    $$\text{HeatScore} = (0.7 \times \text{CPU} + 1.5 \times \Delta\text{CPU}_{5\text{s}}) \times \text{Multiplier}$$
    *(Multiplier is $1.0\times$ for foreground apps, $1.4\times$ for background apps to flag unexpected background heat hogs).*
  - `statusMessage`: Human-readable summary (e.g. *"High temperature (+1.2°C/5s). Chief culprit: Google Chrome Helper [background app] using 42% CPU"*).

### `lib/alerts.mjs` (Persistent Watchdog & Alert Manager)
- **Role**: Enforces the continuous-duration temperature rule.
- **Key Components**:
  - `settings`: Holds `tempThreshold` (default 68°C), `durationMinutes` (default 5.0m), `sensorMode` (`die` vs `raw`), `soundEnabled`, and `desktopNotify`.
  - `highTempStartTime`: Timestamp when temperature first exceeded threshold.
  - `processAnalysis()`:
    - If $T \ge \text{threshold}$, measures elapsed time $t - t_0$.
    - If elapsed time $\ge \text{duration} \times 60$, sets `isAlertFired = true` and dispatches notifications.
    - If temperature drops below threshold, resets $t_0 = \text{null}$ and `isAlertFired = false`.
  - `dismissAlert()`: Called when user clicks "Dismiss" or "Reset Timer". Sets `highTempStartTime = Date.now()` and `isAlertFired = false`, restarting the continuous window from $0\text{s}$.
  - `sendMacNotification()`: Sends native macOS notification banners via `osascript`.

### `public/manifest.json` (PWA Manifest)
- **Role**: Declares the app name, standalone display mode, background color (`#0a0c10`), theme color, and high-DPI maskable icons for installation into the macOS Dock and Application launcher.

### `public/sw.js` (Service Worker)
- **Role**: Caches static assets for lightning-fast loads, handles standalone PWA compliance, and bypasses live SSE and REST endpoints.

### `public/index.html` (Dashboard Layout)
- **Role**: Semantic structure of the dashboard with PWA meta tags, circular dials, watchdog progress bars, and modals.

### `public/app.js` (Frontend Controller)
- **Role**: Drives UI updates, animations, charts, audio synthesizer, and handles the `beforeinstallprompt` PWA install flow.

### `public/style.css` (Visual Design System)
- **Role**: Dark minimalist styling inspired by Linear and macOS Sonoma with neon accent color tokens.

### `bin/cli.mjs` (Terminal CLI & TUI)
- **Role**: Command-line runner supporting both web dashboard mode (`pulsemac`) and terminal dashboard mode (`pulsemac --tui`).

---

## 4. How to Change Things Manually

### A. Change the Server Port (Default: 3888)
1. In `server.mjs`:
   Change line 14:
   ```javascript
   const PORT = process.env.PORT || 3888; // Change 3888 to your desired port
   ```
2. Or run from terminal:
   ```bash
   PORT=8080 npm start
   ```

### B. Change the Polling Frequency (Default: 1000ms / 1s)
1. In `server.mjs`:
   Change line 53:
   ```javascript
   setInterval(async () => {
     // ...
   }, 1000); // Change 1000 to 500 (2Hz) or 2000 (0.5Hz)
   ```

### C. Change Thermal Inertia ($\tau = 28\text{s}$)
1. In `lib/collector.mjs`:
   Change line 268:
   ```javascript
   const tau = 28.0; // Lower (e.g. 15.0) for faster response; higher (e.g. 45.0) for slower response
   ```

### D. Change Default Alert Thresholds
1. In `lib/alerts.mjs`:
   Change lines 6–8:
   ```javascript
   this.settings = {
     tempThreshold: 68.0,      // Default alert temperature (°C)
     durationMinutes: 5.0,     // Default required continuous duration (minutes)
     sensorMode: 'die',        // 'die' or 'raw'
     soundEnabled: true,
     desktopNotify: true
   };
   ```

### E. Change UI Accent Colors
1. In `public/style.css`:
   Change lines 15–25:
   ```css
   --accent-cyan: #00e5ff;    /* CPU color */
   --accent-purple: #b388ff;  /* GPU color */
   --accent-amber: #ffd166;   /* NPU color */
   --accent-crimson: #ff0054; /* Thermal color */
   --accent-emerald: #10b981; /* Memory color */
   ```
