'use strict';

/*
 * Second Monitor Top Bar — GNOME Shell 42 (legacy extension API)
 *
 * Creates a top panel on every non-primary monitor:
 *
 *   [ app icon + focused app name ... clock ... CPU RAM NET ]
 *
 * Mirrors how the shell itself builds the primary panel:
 *   - actor named 'panel' so the theme's #panel rules apply
 *   - added via Main.layoutManager.addChrome() with affectsStruts, which
 *     the shell converts into a per-monitor strut when the actor spans a
 *     monitor's top edge (see ui/layout.js _updateRegions in 42.9)
 *   - clock driven by GnomeDesktop.WallClock, exactly like the primary
 *     panel's date menu
 *
 * The primary panel (Main.panel / layoutManager.panelBox) is never touched.
 */

const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const GnomeDesktop = imports.gi.GnomeDesktop;
const Clutter = imports.gi.Clutter;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Pango = imports.gi.Pango;
const St = imports.gi.St;

const ByteArray = imports.byteArray;
const Main = imports.ui.main;

const _PREFIX = 'second-monitor-top-bar';

// Toggle panel contents here. (A prefs dialog can come later; restart the
// shell after editing: Alt-F2 -> r.)
const Config = {
    showApp: true,           // app icon + app name of this monitor's focused window
    showCpu: true,
    showRam: true,
    showNet: true,           // download / upload rates
    showClockIcon: true,     // small clock icon left of the time
    updateIntervalSec: 2,    // system info sampling period
    iconSize: 16,            // app icon size in px
    infoIconSize: 14,        // size of the CPU/RAM/NET/clock symbolic icons
};

function _log(msg) {
    global.log(`[${_PREFIX}] ${msg}`);
}

function _formatRate(bytesPerSec) {
    if (bytesPerSec >= 1048576)
        return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
    if (bytesPerSec >= 1024)
        return `${Math.round(bytesPerSec / 1024)} KB/s`;
    return `${Math.round(bytesPerSec)} B/s`;
}

/*
 * Samples CPU / memory / network from /proc. One instance is shared by all
 * panels; callbacks fire on a single timeout source.
 */
var SystemInfoSampler = class SystemInfoSampler {
    constructor(intervalSec, callback) {
        this._intervalSec = Math.max(1, intervalSec);
        this._callback = callback;
        this._cpu = SystemInfoSampler.readCpuTimes();
        this._net = SystemInfoSampler.readNetTotals();
        this._lastMonotonic = GLib.get_monotonic_time(); // microseconds
        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, this._intervalSec, this._tick.bind(this));
    }

    _tick() {
        try {
            const now = GLib.get_monotonic_time();
            const dt = Math.max(1, now - this._lastMonotonic) / 1000000.0;
            const cpu = SystemInfoSampler.readCpuTimes();
            const net = SystemInfoSampler.readNetTotals();

            const sample = {
                cpu: SystemInfoSampler.cpuPercent(this._cpu, cpu),
                mem: SystemInfoSampler.memPercent(),
                downBps: Math.max(0, (net.rx - this._net.rx) / dt),
                upBps: Math.max(0, (net.tx - this._net.tx) / dt),
            };

            this._cpu = cpu;
            this._net = net;
            this._lastMonotonic = now;

            if (this._callback)
                this._callback(sample);
        } catch (e) {
            global.logError(e);
        }
        return GLib.SOURCE_CONTINUE;
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        this._callback = null;
    }

    // "cpu  user nice system idle iowait irq softirq steal ..." -> {idle, total}
    static readCpuTimes() {
        try {
            const [, bytes] = GLib.file_get_contents('/proc/stat');
            const first = ByteArray.toString(bytes).split('\n', 1)[0];
            const fields = first.trim().split(/\s+/).slice(1).map(Number);
            let idle = (fields[3] || 0) + (fields[4] || 0); // idle + iowait
            let total = 0;
            for (let i = 0; i < 8 && i < fields.length; i++)
                total += fields[i] || 0;
            return { idle, total };
        } catch (e) {
            return null;
        }
    }

    static cpuPercent(prev, cur) {
        if (!prev || !cur)
            return null;
        const dTotal = cur.total - prev.total;
        const dIdle = cur.idle - prev.idle;
        if (dTotal <= 0)
            return null;
        return Math.round(Math.min(100, Math.max(0, 100 * (1 - dIdle / dTotal))));
    }

    static memPercent() {
        try {
            const [, bytes] = GLib.file_get_contents('/proc/meminfo');
            const info = {};
            ByteArray.toString(bytes).split('\n').some(line => {
                const m = line.match(/^(MemTotal|MemAvailable):\s+(\d+)/);
                if (m)
                    info[m[1]] = Number(m[2]);
                return info.MemTotal !== undefined && info.MemAvailable !== undefined;
            });
            if (!info.MemTotal || info.MemAvailable === undefined)
                return null;
            return Math.round(100 * (1 - info.MemAvailable / info.MemTotal));
        } catch (e) {
            return null;
        }
    }

    // Sum rx/tx bytes over real interfaces (skips lo, veth*, docker*).
    static readNetTotals() {
        try {
            const [, bytes] = GLib.file_get_contents('/proc/net/dev');
            let rx = 0, tx = 0;
            for (const line of ByteArray.toString(bytes).split('\n').slice(2)) {
                const parts = line.split(':');
                if (parts.length !== 2)
                    continue;
                const iface = parts[0].trim();
                if (iface === 'lo' || iface.startsWith('veth') || iface.startsWith('docker'))
                    continue;
                const fields = parts[1].trim().split(/\s+/).map(Number);
                rx += fields[0] || 0;
                tx += fields[8] || 0;
            }
            return { rx, tx };
        } catch (e) {
            return { rx: 0, tx: 0 };
        }
    }
};

/*
 * The panel actor. Left/center/right slots are allocated manually in
 * vfunc_allocate — the same technique the shell's own ui/panel.js Panel
 * class uses. (A layout-manager approach — Clutter.BinLayout + per-child
 * x_align — proved unreliable on 42.9: all children ended up stacked at
 * center. Manual allocation also guarantees the three slots can never
 * overlap, whatever the theme does.)
 */
var SecondaryPanelBox = GObject.registerClass(
class SecondaryPanelBox extends St.Widget {
    _init() {
        super._init({
            name: 'panel',
            style_class: 'panel',
            reactive: true, // block click-through to windows underneath
        });

        this.leftBox = new St.BoxLayout({ name: 'panelLeft' });
        this.centerBox = new St.BoxLayout({ name: 'panelCenter' });
        this.rightBox = new St.BoxLayout({ name: 'panelRight' });
        this.add_child(this.leftBox);
        this.add_child(this.centerBox);
        this.add_child(this.rightBox);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);

        const allocWidth = box.x2 - box.x1;
        const allocHeight = box.y2 - box.y1;

        const [, leftNat] = this.leftBox.get_preferred_width(-1);
        const [, centerNat] = this.centerBox.get_preferred_width(-1);
        const [, rightNat] = this.rightBox.get_preferred_width(-1);

        // Side boxes share the space not used by the centered clock.
        const sideWidth = Math.max(0, (allocWidth - centerNat) / 2);

        // Left slot, clamped so it never reaches past the clock.
        this._allocateSide(this.leftBox, 0, Math.min(leftNat, sideWidth), allocHeight);

        // Clock: dead center of the monitor.
        const centerX1 = Math.ceil((allocWidth - centerNat) / 2);
        this._allocateSide(this.centerBox, centerX1, centerX1 + centerNat, allocHeight);

        // Right slot, clamped against the clock's right edge.
        this._allocateSide(this.rightBox,
            Math.max(allocWidth - Math.min(rightNat, sideWidth), centerX1 + centerNat),
            allocWidth, allocHeight);
    }

    // Allocate @child the horizontal range [x1, x2) at its natural height,
    // vertically centered in the panel — no reliance on child-meta layout
    // properties.
    _allocateSide(child, x1, x2, allocHeight) {
        const width = Math.max(0, x2 - x1);
        const [, natHeight] = child.get_preferred_height(width);
        const childBox = new Clutter.ActorBox();
        childBox.x1 = x1;
        childBox.x2 = x1 + width;
        childBox.y1 = Math.floor((allocHeight - natHeight) / 2);
        childBox.y2 = childBox.y1 + natHeight;
        child.allocate(childBox);
    }
});

var SecondaryPanel = class SecondaryPanel {
    /**
     * @param {Meta.Monitor} monitor  a monitor from Main.layoutManager.monitors
     * @param {GnomeDesktop.WallClock} wallClock  shared clock source
     */
    constructor(monitor, wallClock) {
        this.monitor = monitor;

        // Window tracking state
        this._window = null;
        this._unmanagedId = 0;

        // Same actor shape as ui/panel.js: name 'panel' -> theme #panel
        // rules (background, height, font). Slot layout is handled by
        // SecondaryPanelBox's custom allocation.
        this.actor = new SecondaryPanelBox();
        this._leftBox = this.actor.leftBox;
        this._centerBox = this.actor.centerBox;
        this._rightBox = this.actor.rightBox;

        // ---- center: clock ------------------------------------------------
        this._clockLabel = new St.Label({
            style_class: 'clock',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        // Same binding the primary panel's date menu uses; the label then
        // tracks clock-format / show-date / show-seconds settings for free.
        this._clockBinding = wallClock.bind_property(
            'clock', this._clockLabel, 'text', GObject.BindingFlags.SYNC_CREATE);
        if (Config.showClockIcon) {
            const clockIcon = this._makeIcon('preferences-system-time-symbolic');
            clockIcon.add_style_class_name('smtb-clockicon');
            this._centerBox.add_child(clockIcon);
        }
        this._centerBox.add_child(this._clockLabel);

        // ---- left: focused window (this monitor) --------------------------
        this._appIcon = null;
        this._titleLabel = new St.Label({
            style_class: 'smtb-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._leftBox.add_child(this._titleLabel);
        this._leftBox.visible = false; // until a window is focused here

        // ---- right: system info -------------------------------------------
        // Each metric is an icon + value group (icon names verified against
        // the installed icon theme; symbolic icons recolor with the theme).
        this._cpuGroup = Config.showCpu
            ? this._makeInfoGroup('speedometer-symbolic') : null;
        this._ramGroup = Config.showRam
            ? this._makeInfoGroup('media-flash-symbolic') : null;
        this._netGroup = Config.showNet
            ? this._makeInfoGroup('network-transmit-receive-symbolic') : null;

        // Position like layoutManager._updateBoxes() positions panelBox:
        // top-left of the monitor, full width, theme-driven height.
        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, -1);
        this._updateVisible();

        // Chrome == above normal windows; affectsStruts reserves the strip
        // so maximized windows on this monitor stop below the panel.
        Main.layoutManager.addChrome(this.actor, {
            affectsStruts: true,
            affectsInputRegion: true,
        });
    }

    // GNOME 42 has no sessionMode.hasPanel (GNOME 45+; assigning it to
    // actor.visible silently coerces undefined to false and hides the
    // panel). The 42 shell's own panel is always visible — hide ours only
    // while locked, since chrome actors added after startup paint above the
    // lock-screen shield. `!== true` keeps us visible if in doubt.
    _updateVisible() {
        if (this.actor)
            this.actor.visible = Main.sessionMode.isLocked !== true;
    }

    _makeIcon(iconName) {
        const icon = new St.Icon({
            icon_name: iconName,
            icon_size: Config.infoIconSize,
            y_align: Clutter.ActorAlign.CENTER,
        });
        return icon;
    }

    _makeInfoGroup(iconName) {
        const icon = this._makeIcon(iconName);
        icon.add_style_class_name('smtb-infoicon');
        const label = new St.Label({
            style_class: 'smtb-infoval',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rightBox.add_child(icon);
        this._rightBox.add_child(label);
        return { icon, label };
    }

    updateInfo(sample) {
        if (!sample)
            return;
        if (this._cpuGroup) {
            const ok = sample.cpu !== null;
            this._cpuGroup.icon.visible = ok;
            this._cpuGroup.label.visible = ok;
            this._cpuGroup.label.text = `${sample.cpu}%`;
        }
        if (this._ramGroup) {
            const ok = sample.mem !== null;
            this._ramGroup.icon.visible = ok;
            this._ramGroup.label.visible = ok;
            this._ramGroup.label.text = `${sample.mem}%`;
        }
        if (this._netGroup)
            this._netGroup.label.text =
                `↓ ${_formatRate(sample.downBps)}  ↑ ${_formatRate(sample.upBps)}`;
    }

    /**
     * Show @window's icon/title if it lives on this monitor. Called on
     * every focus change; other monitors' windows are ignored so each bar
     * keeps the last title focused on its own screen.
     */
    trackWindow(window) {
        if (!window ||
            window.get_window_type() !== Meta.WindowType.NORMAL ||
            window.get_monitor() !== this.monitor.index)
            return;

        if (this._window === window)
            return;
        this._disconnectWindow();
        this._window = window;
        this._unmanagedId = window.connect('unmanaged', () => this._clearWindow());
        this._syncAppInfo();
    }

    // Left slot: the focused window's application icon + application name
    // (not the window title — e.g. "Visual Studio Code", not the open
    // folder/file name). The app can't change for a given window, so this
    // only runs when the tracked window changes.
    _syncAppInfo() {
        if (this._appIcon) {
            this._appIcon.destroy();
            this._appIcon = null;
        }
        if (!this._window || !Config.showApp) {
            this._titleLabel.text = '';
            this._leftBox.visible = false;
            return;
        }
        try {
            // GNOME 42: the tracker is a Shell singleton — there is no
            // Main.windowTracker export (that's newer shells; using it
            // throws "TypeError: Main.windowTracker is undefined").
            const app = Shell.WindowTracker.get_default().get_window_app(this._window);
            const name = app ? (app.get_name() || '') : '';
            this._titleLabel.text = name;
            this._leftBox.visible = !!name;
            if (app && name) {
                this._appIcon = app.create_icon_texture(Config.iconSize);
                this._appIcon.y_align = Clutter.ActorAlign.CENTER;
                this._appIcon.add_style_class_name('smtb-appicon');
                this._leftBox.insert_child_at_index(this._appIcon, 0);
            }
        } catch (e) {
            global.logError(e);
        }
    }

    _clearWindow() {
        this._disconnectWindow();
        this._window = null;
        if (this._appIcon) {
            this._appIcon.destroy();
            this._appIcon = null;
        }
        this._titleLabel.text = '';
        this._leftBox.visible = false;
    }

    _disconnectWindow() {
        if (this._window && this._unmanagedId)
            this._window.disconnect(this._unmanagedId);
        this._unmanagedId = 0;
    }

    destroy() {
        if (!this.actor)
            return;
        this._disconnectWindow();
        try {
            Main.layoutManager.removeChrome(this.actor);
        } catch (e) {
            _log(`removeChrome failed (ignoring): ${e.message}`);
        }
        if (this._clockBinding) {
            this._clockBinding.unbind();
            this._clockBinding = null;
        }
        this.actor.destroy();
        this.actor = null;
    }
};

var PanelManager = class PanelManager {
    constructor() {
        this._panels = [];
        this._wallClock = null;
        this._sampler = null;
        this._lastSample = null;
        this._monitorsChangedId = 0;
        this._sessionModeUpdatedId = 0;
        this._focusWindowId = 0;
        this._rebuildIdleId = 0;
    }

    enable() {
        this._wallClock = new GnomeDesktop.WallClock();

        if (Config.showCpu || Config.showRam || Config.showNet)
            this._sampler = new SystemInfoSampler(
                Config.updateIntervalSec, s => this._onSample(s));

        this._monitorsChangedId = Main.layoutManager.connect(
            'monitors-changed', () => this._queueRebuild());
        this._sessionModeUpdatedId = Main.sessionMode.connect(
            'updated', () => this._updateVisibility());
        this._focusWindowId = global.display.connect(
            'notify::focus-window', () => this._updateFocus());

        this._rebuild();
    }

    disable() {
        if (this._rebuildIdleId) {
            GLib.source_remove(this._rebuildIdleId);
            this._rebuildIdleId = 0;
        }
        if (this._sampler) {
            this._sampler.destroy();
            this._sampler = null;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        if (this._sessionModeUpdatedId) {
            Main.sessionMode.disconnect(this._sessionModeUpdatedId);
            this._sessionModeUpdatedId = 0;
        }
        if (this._focusWindowId) {
            global.display.disconnect(this._focusWindowId);
            this._focusWindowId = 0;
        }
        this._destroyPanels();
        if (this._wallClock) {
            this._wallClock.run_dispose();
            this._wallClock = null;
        }
        this._lastSample = null;
    }

    // Monitor configuration changes can arrive in bursts (XRANDR churn,
    // primary switch, fractional-scale changes); coalesce into one rebuild
    // on the next idle, after layoutManager has settled its own boxes.
    _queueRebuild() {
        if (this._rebuildIdleId)
            return;
        this._rebuildIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._rebuildIdleId = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rebuild() {
        this._destroyPanels();

        const lm = Main.layoutManager;
        if (!lm.monitors || lm.monitors.length < 2) {
            _log('single monitor — nothing to do');
            return;
        }

        lm.monitors.forEach((monitor, index) => {
            if (index === lm.primaryIndex)
                return;
            try {
                this._panels.push(new SecondaryPanel(monitor, this._wallClock));
            } catch (e) {
                _log(`panel for monitor ${index} failed: ${e.message}`);
                global.logError(e);
            }
        });

        _log(`active: ${this._panels.length} secondary panel(s), ` +
             `primaryIndex=${lm.primaryIndex}`);

        if (this._lastSample)
            this._panels.forEach(panel => panel.updateInfo(this._lastSample));
        this._updateFocus();
    }

    _destroyPanels() {
        this._panels.forEach(panel => panel.destroy());
        this._panels = [];
    }

    _onSample(sample) {
        this._lastSample = sample;
        this._panels.forEach(panel => panel.updateInfo(sample));
    }

    _updateFocus() {
        const window = global.display.get_focus_window();
        this._panels.forEach(panel => panel.trackWindow(window));
    }

    // Follow lock state: panels hide while the session is locked.
    _updateVisibility() {
        this._panels.forEach(panel => panel._updateVisible());
    }
};

let _manager = null;

function init() {
    // Nothing to set up at import time.
}

function enable() {
    if (_manager)
        return;
    _manager = new PanelManager();
    try {
        _manager.enable();
    } catch (e) {
        global.logError(e);
        _manager.disable();
        _manager = null;
    }
}

function disable() {
    if (!_manager)
        return;
    _manager.disable();
    _manager = null;
}
