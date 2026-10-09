import { exec } from 'node:child_process';

export class AlertManager {
  constructor() {
    this.settings = {
      tempThreshold: 68.0,      // Degrees C threshold
      durationMinutes: 5.0,     // Required persistent duration in minutes
      sensorMode: 'die',        // 'die' (realistic thermal model) or 'raw' (raw PMU sensor)
      soundEnabled: true,
      desktopNotify: true
    };

    this.alertLog = [];
    this.maxLogs = 60;
    this.highTempStartTime = null;
    this.isAlertFired = false;
    this.lastNotifyTime = 0;
    this.notifyCooldownMs = 60000; // 60s cooldown between repeated notifications
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(newSettings) {
    if (newSettings.tempThreshold !== undefined) {
      this.settings.tempThreshold = Math.max(35, Math.min(100, Number(newSettings.tempThreshold)));
    }
    if (newSettings.durationMinutes !== undefined) {
      this.settings.durationMinutes = Math.max(0.5, Math.min(60, Number(newSettings.durationMinutes)));
    }
    if (newSettings.sensorMode !== undefined) {
      this.settings.sensorMode = newSettings.sensorMode === 'raw' ? 'raw' : 'die';
    }
    if (newSettings.soundEnabled !== undefined) {
      this.settings.soundEnabled = Boolean(newSettings.soundEnabled);
    }
    if (newSettings.desktopNotify !== undefined) {
      this.settings.desktopNotify = Boolean(newSettings.desktopNotify);
    }
    return this.settings;
  }

  getAlertHistory() {
    return this.alertLog.slice().reverse();
  }

  /**
   * Dismiss active alert and reset persistent timer calculations to 0
   */
  dismissAlert() {
    const now = Date.now();
    this.highTempStartTime = now; // Restarts timer from 0 right now
    this.isAlertFired = false;
    this.lastNotifyTime = now;
    return {
      success: true,
      message: 'Alert dismissed and persistent duration timer reset to 0s.'
    };
  }

  /**
   * Reset time calculations completely
   */
  resetTimer() {
    this.highTempStartTime = null;
    this.isAlertFired = false;
    return {
      success: true,
      message: 'Persistent watchdog timer reset.'
    };
  }

  /**
   * Evaluate temperature against persistent time duration
   */
  processAnalysis(analysis, snapshot) {
    const now = Date.now();
    const thermal = snapshot?.thermal || {};
    
    // Choose temperature according to selected sensor mode
    const currentTemp = this.settings.sensorMode === 'raw' 
      ? (thermal.hardwareTempC ?? thermal.virtualTempC ?? 30.0)
      : (thermal.socDieTempC ?? 32.0);

    const isAbove = currentTemp >= this.settings.tempThreshold;
    const targetMs = this.settings.durationMinutes * 60 * 1000;
    let elapsedMs = 0;
    let newAlertEntry = null;

    if (isAbove) {
      if (!this.highTempStartTime) {
        this.highTempStartTime = now;
      }
      elapsedMs = now - this.highTempStartTime;

      // Condition met: Persistently above threshold for >= user-defined minutes
      if (elapsedMs >= targetMs && !this.isAlertFired) {
        this.isAlertFired = true;
        const culprit = analysis.primaryCulprit;

        const role = culprit ? (culprit.isForeground ? 'Foreground Active' : (culprit.type === 'BACKGROUND_APP' ? 'Background App' : 'System Daemon')) : 'System';
        const msg = `🚨 Persistent High Temperature Alert! SoC temperature has stayed at ${currentTemp}°C (above ${this.settings.tempThreshold}°C) for over ${this.settings.durationMinutes} minutes. ${culprit ? `Primary culprit: ${culprit.name} [${role}] using ${culprit.cpu}% CPU.` : ''}`;

        newAlertEntry = {
          id: 'alert_' + now + '_' + Math.random().toString(36).substring(2, 6),
          timestamp: now,
          type: 'PERSISTENT_HIGH_TEMP',
          severity: 'CRITICAL',
          temperature: currentTemp,
          threshold: this.settings.tempThreshold,
          durationMinutes: this.settings.durationMinutes,
          culprit: culprit ? {
            name: culprit.name,
            pid: culprit.pid,
            cpu: culprit.cpu,
            isForeground: culprit.isForeground,
            type: culprit.type
          } : null,
          message: msg
        };

        this.alertLog.push(newAlertEntry);
        if (this.alertLog.length > this.maxLogs) {
          this.alertLog.shift();
        }

        if (this.settings.desktopNotify && (now - this.lastNotifyTime > this.notifyCooldownMs)) {
          this.sendMacNotification(
            `High Temp Alert (${currentTemp}°C > ${this.settings.tempThreshold}°C for ${this.settings.durationMinutes}m)`,
            culprit ? `${culprit.name} [${role}] at ${culprit.cpu}% CPU` : msg
          );
          this.lastNotifyTime = now;
        }
      }
    } else {
      // Temperature dropped below threshold: reset persistence timer
      if (this.isAlertFired) {
        const resolvedEntry = {
          id: 'alert_' + now + '_res',
          timestamp: now,
          type: 'COOLDOWN_RESOLVED',
          severity: 'NORMAL',
          temperature: currentTemp,
          message: `❄️ Temperature cooled back down to ${currentTemp}°C (below ${this.settings.tempThreshold}°C threshold).`
        };
        this.alertLog.push(resolvedEntry);
        if (this.alertLog.length > this.maxLogs) this.alertLog.shift();
      }

      this.highTempStartTime = null;
      this.isAlertFired = false;
      elapsedMs = 0;
    }

    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const targetSeconds = Math.round(this.settings.durationMinutes * 60);
    const progressPercent = Math.min(100, Math.round((elapsedMs / targetMs) * 100));
    const remainingSeconds = Math.max(0, targetSeconds - elapsedSeconds);

    const persistenceInfo = {
      isAboveThreshold: isAbove,
      currentTemp,
      threshold: this.settings.tempThreshold,
      durationMinutes: this.settings.durationMinutes,
      elapsedSeconds,
      targetSeconds,
      remainingSeconds,
      progressPercent,
      isAlertFired: this.isAlertFired
    };

    return {
      newAlert: newAlertEntry,
      persistence: persistenceInfo
    };
  }

  sendMacNotification(title, message) {
    const safeTitle = title.replace(/"/g, '\\"');
    const safeMsg = message.replace(/"/g, '\\"');
    const cmd = `osascript -e 'display notification "${safeMsg}" with title "PulseMac" subtitle "${safeTitle}" sound name "Sosumi"'`;
    exec(cmd, { timeout: 2000 }, () => {});
  }
}
