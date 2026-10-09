# ⚡ PulseMac

> **High-Precision macOS Hardware & Thermal Intelligence Monitor (Progressive Web App)**

**PulseMac** is an end-to-end telemetry dashboard built natively for macOS (optimized for Apple Silicon M-series, including M1, M2, M3, M4, and M5). It monitors CPU, GPU, and NPU (Neural Engine) workloads in real time, tracks silicon die and battery thermal levels, alerts you when temperatures climb, and correlates spikes with background or foreground applications.

It runs on a **single command** and can be installed directly as a standalone **Progressive Web App (PWA)** into your macOS Dock.

---

## 🚀 Quickstart (Single Command)

To run PulseMac on your Mac:

```bash
git clone https://github.com/apurvashekhar96/PulseMac.git
cd PulseMac
npm start
```
*(or run `./start.sh` or double-click `run.command` in Finder)*

This will:
1. Start the zero-dependency Node.js telemetry server on `http://127.0.0.1:3888`.
2. Automatically open the dashboard in your default browser.
3. Stream real-time hardware telemetry and attribution analysis.

---

## 📲 Install as a Standalone macOS App (PWA)

PulseMac is a fully compliant Progressive Web App with offline caching and standalone display mode. You can run it without browser tabs or address bars:

### In Google Chrome / Brave / Edge:
- Click the **"📲 Install App"** button in the top-right header of the PulseMac dashboard (or click the install icon in the browser address bar).
- PulseMac will instantly become an independent desktop application with its own window, full window controls, and its own icon in your macOS Dock.

### In Safari (macOS Sonoma & Sequoia):
- Click **File** in the menu bar $\to$ **Add to Dock...**
- PulseMac is added directly to your macOS Dock and Launchpad as a standalone web app!

---

## ✨ Features

- **⚡ CPU Multi-Core Engine**:
  - Live aggregate CPU % load (User vs System vs Idle).
  - 10-Core load matrix visualizing per-core load across Performance & Efficiency clusters in real time.
  - Load average (1m, 5m, 15m).

- **🎮 GPU Metal & VRAM Telemetry**:
  - Device Utilization %, Renderer %, and Tiler % queried directly from Apple Silicon `IOAccelerator`.
  - Allocated GPU memory and in-use VRAM.

- **🧠 NPU / Apple Neural Engine (ANE)**:
  - Real-time ANE hardware status and power state.
  - Active CoreML/ANE daemon tracking (`aned`, `aneuserd`, `ANECompilerService`).
  - Active inference client count and estimated neural dispatch rate.

- **🌡️ Precision Thermal Intelligence**:
  - Real-time Battery Casing Temperature and PMU Virtual Temperature via `AppleSmartBattery`.
  - Apple Silicon SoC Silicon Die Temperature with a 28s Physical Thermal Inertia filter (eliminates unrealistic instantaneous spikes).
  - Toggle between **SoC Die Model** and **Raw Apple PMU Sensor** in settings.
  - macOS Thermal Pressure Level monitoring (`Nominal`, `Fair`, `Serious`, `Critical`).

- **⏱️ Persistent High-Temperature Watchdog**:
  - Eliminates false alarms caused by brief 2-second CPU bursts.
  - Alerts are sent **only** when temperature stays continuously above the user's chosen threshold for longer than the persistent time span (default: 5.0 minutes, configurable from 0.5 to 30 minutes in the UI).
  - Live persistence countdown timer and visual progress bar shows elapsed time vs target time.
  - Dismissing an alert resets the calculation timer back to $0\text{s}$.

- **🎯 Foreground vs. Background Spike Attribution**:
  - Identifies frontmost focused application vs background applications vs system daemons.
  - Sliding-window time-series correlation engine calculates rate of thermal change ($\Delta T / 5\text{s}$) and detects heat spikes.
  - Pinpoints the **primary culprit application** driving temperature surges (e.g., *"Google Chrome Helper [BACKGROUND APP] is consuming 42% CPU"*).
  - One-click process termination with safety confirmation modal.

- **🎨 Minimalist, Colorful Dashboard**:
  - Dark glassmorphism interface inspired by Linear and Apple design systems.
  - Neon accent signatures: Cyan (CPU), Purple (GPU), Amber (NPU), Emerald (Memory), and Heat Spectrum (Thermals).
  - High-DPI 60-second real-time rolling canvas timeline chart with smooth Bézier curves.
  - Web Audio API chime alerts + macOS desktop notifications.
  - Celsius (°C) and Fahrenheit (°F) instant toggle.

- **📟 Terminal TUI Mode**:
  - Want a terminal-only experience? Run `npm run tui` for an interactive, ANSI-colored live terminal dashboard!

---

## 🔍 How to Verify Temperature & Hardware Data on macOS

You can verify the data shown in PulseMac against your Mac's kernel and hardware sensors at any time using standard macOS Terminal commands:

### 1. Verify Raw Apple PMU & Battery Temperature
```bash
ioreg -n AppleSmartBattery -r | grep -iE "Temperature|VirtualTemperature"
```
*Note: macOS outputs temperatures in centidegrees (e.g. `3058` = 30.58°C, `3259` = 32.59°C). This directly matches PulseMac's raw sensor readouts.*

### 2. Verify Thermal Warning & CPU Throttling
```bash
pmset -g therm
```
*Shows whether macOS kernel has recorded thermal pressure or CPU speed reduction.*

### 3. Verify Apple Silicon Hardware Telemetry (Privileged)
```bash
sudo powermetrics -n 1 -s thermal,cpu_power
```
*Reports SoC power consumption, die temperature sensors, and thermal pressure level.*

---

## 🛠️ CLI Options

```bash
# Start Web PWA Dashboard and open in default browser
npm start

# Run in background without auto-opening browser
npm run serve

# Run on a custom port
node server.mjs --port 8080

# Launch interactive Terminal TUI live monitor
npm run tui
```
