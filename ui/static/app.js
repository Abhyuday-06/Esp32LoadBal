// app.js - FLASHPOINT bootstrap.
//
// Wires the views to telemetry.js (the single owner of Socket.IO and the
// REST API): navigation, the metric strip, and the gateway / backend panel.
// The map, charts, event stream and storefront live in their own modules.

import { state, on, api, isDirect, recentRate, resetCounters, setOperatorStrategy } from './telemetry.js';
import { TrafficMap } from './world-map.js';
import { initCharts } from './charts.js';
import { initEventStream } from './event-stream.js';
import { initStorefront } from './storefront.js';
import { regionInfo, serverColor, FIRMWARE_BACKEND_PORTS, ESP32_MAX_SESSIONS, CLIENT_TIMEOUT_S, STRATEGY_NAMES } from './region-config.js';

const $ = id => document.getElementById(id);
const fmt = n => Math.round(n).toLocaleString();

/* ================================================================ *
 *  Views
 * ================================================================ */

let map;

function showView() {
    const view = location.hash === '#sale' ? 'sale' : 'live';
    document.querySelectorAll('[data-view]').forEach(v => { v.hidden = v.dataset.view !== view; });
    document.querySelectorAll('[data-view-link]').forEach(a => {
        if (a.dataset.viewLink === view) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    });
    if (view === 'live' && map) requestAnimationFrame(() => map.relayout());
}
window.addEventListener('hashchange', showView);
document.addEventListener('click', e => {
    const go = e.target.closest('[data-goto]');
    if (go) location.hash = go.dataset.goto;
});

/* ================================================================ *
 *  Navigation status
 * ================================================================ */

function gatewayStatus() {
    if (!state.clients.length) return { cls: '', text: 'Idle, no generators' };
    if (state.clients.every(isDirect)) return { cls: 'is-warn', text: 'Not in path' };
    if (state.lastForwardAt) {
        const ago = (Date.now() - state.lastForwardAt) / 1000;
        if (ago <= 10) return { cls: 'is-ok', text: 'Forwarding observed' };
        return { cls: '', text: `Last forward ${ago < 120 ? `${Math.round(ago)} s` : `${Math.round(ago / 60)} min`} ago` };
    }
    return { cls: '', text: 'Unverified' };
}

function renderNav() {
    const s = $('nav-socket');
    s.className = `status ${state.socketConnected ? 'is-ok' : 'is-crit'}`;
    s.innerHTML = `<span class="status-label">Dashboard </span>${state.socketConnected ? 'connected' : 'disconnected'}`;
    const g = gatewayStatus();
    const e = $('nav-esp32');
    e.className = `status ${g.cls}`;
    e.innerHTML = `<span class="status-label">ESP32 </span>${g.text.charAt(0).toLowerCase() + g.text.slice(1)}`;
}

/* ================================================================ *
 *  Metrics strip
 * ================================================================ */

const generatorHistory = [];

function drawSpark(canvas, values, color) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const vals = values.map(v => (v == null ? null : v));
    const max = Math.max(1, ...vals.filter(v => v != null));
    g.strokeStyle = color;
    g.lineWidth = 1.25;
    g.lineJoin = 'round';
    g.beginPath();
    let started = false;
    vals.forEach((v, i) => {
        if (v == null) { started = false; return; }
        const x = (i / Math.max(1, vals.length - 1)) * (w - 2) + 1;
        const y = h - 2 - (v / max) * (h - 4);
        if (started) g.lineTo(x, y); else { g.moveTo(x, y); started = true; }
    });
    g.stroke();
}

function setMetric(key, value, sub, spark, color = '#8B98A8', empty = false) {
    const m = document.querySelector(`[data-metric="${key}"]`);
    m.querySelector('[data-value]').innerHTML = value;
    if (sub != null) m.querySelector('[data-sub]').textContent = sub;
    m.classList.toggle('is-empty', empty);
    drawSpark(m.querySelector('[data-spark]'), spark, color);
}

function renderMetrics() {
    const T = state.totals;
    const b60 = state.buckets.slice(-60);

    setMetric('sent', fmt(T.sent), state.totals.forwarded ? `${fmt(T.forwarded)} received by backends` : 'By generators, this session', b60.map(b => b.sent));

    const rolling = b60.map((_, i) => {
        const win = b60.slice(Math.max(0, i - 9), i + 1);
        return win.reduce((a, b) => a + b.sent, 0) / 10;
    });
    const rate = recentRate(10);
    setMetric('rate', `${rate.toFixed(1)}<small>req/s</small>`, null, rolling);

    let ls = 0, ln = 0;
    for (const b of b60) { ls += b.latSum; ln += b.latN; }
    setMetric('latency', ln ? `${fmt(ls / ln)}<small>ms</small>` : 'Not measured', null, b60.map(b => (b.latN ? b.latSum / b.latN : null)), '#E8EDF2', !ln);

    const completed = T.ok + T.non200 + T.timeouts + T.errors;
    setMetric('ok', fmt(T.ok), completed ? `${((T.ok / completed) * 100).toFixed(1)}% of completed requests` : 'Awaiting traffic', b60.map(b => b.ok), '#35B98F');

    const failed = T.non200 + T.timeouts + T.errors;
    const parts = [];
    if (T.timeouts) parts.push(`${fmt(T.timeouts)} timeouts`);
    if (T.non200) parts.push(`${fmt(T.non200)} non-200`);
    if (T.errors) parts.push(`${fmt(T.errors)} errors`);
    setMetric('failed', fmt(failed), parts.length ? parts.join(', ') : 'Timeouts, errors and non-200 responses', b60.map(b => b.failed), failed ? '#E36D70' : '#8B98A8');

    setMetric('generators', `${state.clients.length}<small>of 7</small>`, state.loaded ? (state.clients.length ? `${state.clients.filter(c => state.regionOf[c.id]).length} mapped to a region` : 'Start them on Flash sale') : 'Loading', generatorHistory);
}

/* ================================================================ *
 *  Gateway + backends panel
 * ================================================================ */

function renderGateway() {
    const g = gatewayStatus();
    const el = $('gw-status');
    el.className = `status ${g.cls}`;
    el.textContent = g.text;

    const targets = [...new Set(state.clients.map(c => `${c.target_ip}:${c.target_port}`))];
    $('gw-target').innerHTML = targets.length
        ? targets.map(t => `<span class="mono">${t}</span>`).join('<br>') + (state.clients.every(isDirect) ? '<br><span class="muted">That is a backend port, so requests skip the ESP32.</span>' : '')
        : '<span class="muted">No generators running</span>';

    const open = Math.min(ESP32_MAX_SESSIONS, state.openSessions.size);
    const slots = $('gw-slots');
    slots.classList.toggle('is-full', open >= ESP32_MAX_SESSIONS);
    slots.innerHTML = Array.from({ length: ESP32_MAX_SESSIONS }, (_, i) => `<span class="${i < open ? 'on' : ''}"></span>`).join('');
    $('gw-slots-text').textContent = `${open} of 7 open from this dashboard`;

    const sel = $('gw-strategy');
    if (sel.value !== state.operatorStrategy) sel.value = state.operatorStrategy;
}

let backendKey = '';

function backendStructureKey() {
    return state.servers.map(s => `${s.port}:${s.running}:${s.latency}`).join('|');
}

function renderBackends() {
    const box = $('backends');
    const key = backendStructureKey();
    if (key !== backendKey) {
        backendKey = key;
        if (!state.servers.length) {
            box.innerHTML = `<p class="empty-line">${state.loaded ? 'No backends yet. Add one below for each port the ESP32 forwards to.' : 'Loading backends'}</p>`;
        } else {
            box.innerHTML = state.servers.map(s => {
                const addedMs = Math.round((s.latency / 100) * CLIENT_TIMEOUT_S * 1000);
                const offFirmware = !FIRMWARE_BACKEND_PORTS.includes(s.port);
                return `
                <div class="be ${s.running ? '' : 'is-stopped'}" data-backend-row="${s.port}" style="--c:${serverColor(s.port)}">
                    <span class="be-anchor" data-anchor="backend" data-port="${s.port}"></span>
                    <div class="be-top">
                        <span class="be-port">:${s.port}</span>
                        <span class="be-ip">${s.ip}</span>
                        <span class="status ${s.running ? 'is-ok' : ''}">${s.running ? 'Running' : 'Stopped'}</span>
                        <span class="be-actions">
                            ${s.running
                                ? `<button class="btn btn--sm" type="button" data-be="stop" data-port="${s.port}" title="Stop server :${s.port}"><svg class="icon"><use href="#i-power"/></svg>Stop</button>`
                                : `<button class="btn btn--sm" type="button" data-be="start" data-port="${s.port}" title="Start server :${s.port}"><svg class="icon"><use href="#i-power"/></svg>Start</button>`}
                            <button class="btn btn--sm btn--icon btn--danger" type="button" data-be="delete" data-port="${s.port}" aria-label="Remove server :${s.port}" title="Remove server"><svg class="icon"><use href="#i-trash"/></svg></button>
                        </span>
                    </div>
                    <div class="be-share"><div class="bar"><i data-be-bar></i></div><span class="num" data-be-count>0 req</span></div>
                    <div class="be-meta">
                        <label class="lat-ctl"><span class="lbl">Configured</span>
                            <input class="input num" type="number" min="0" max="100" value="${s.latency}" data-be-latency="${s.port}" aria-label="Added latency for :${s.port}, percent of timeout">
                            <span class="val">% <span class="lbl-inline">+${addedMs} ms</span></span>
                        </label>
                        <div class="measured"><span class="lbl">Measured</span><span class="val" data-be-measured>Not measured</span></div>
                    </div>
                    ${offFirmware ? '<div class="be-warn">The firmware does not forward to this port. It only receives direct traffic.</div>' : ''}
                </div>`;
            }).join('');
        }
        suggestPort();
        if (map) requestAnimationFrame(() => map.relayout());
    }

    // Live numbers, updated in place so inputs keep focus
    const total = state.servers.reduce((a, s) => a + (state.backends[s.port]?.forwarded || 0), 0);
    $('be-total').textContent = `${fmt(state.totals.forwarded)} requests received`;
    for (const s of state.servers) {
        const row = box.querySelector(`[data-backend-row="${s.port}"]`);
        if (!row) continue;
        const B = state.backends[s.port] || {};
        const n = B.forwarded || 0;
        const pct = total ? (n / total) * 100 : 0;
        row.querySelector('[data-be-bar]').style.width = `${pct}%`;
        row.querySelector('[data-be-count]').textContent = `${fmt(n)} req${total ? `, ${pct.toFixed(0)}%` : ''}`;
        row.querySelector('[data-be-measured]').textContent = B.latN ? `${fmt(B.latSum / B.latN)} ms avg` : 'Not measured';
    }
}

function suggestPort() {
    const input = $('new-port');
    if (document.activeElement === input) return;
    const used = new Set(state.servers.map(s => s.port));
    const next = FIRMWARE_BACKEND_PORTS.find(p => !used.has(p));
    input.placeholder = next ? String(next) : '8085';
    if (!input.value || used.has(Number(input.value))) input.value = next || '';
}

function bindBackendControls() {
    const box = $('backends');
    const armed = new Map();

    box.addEventListener('click', async e => {
        const btn = e.target.closest('button[data-be]');
        if (!btn) return;
        const port = Number(btn.dataset.port);
        const act = btn.dataset.be;
        if (act === 'delete') {
            if (!armed.has(port)) {
                btn.classList.add('btn--confirm');
                btn.classList.remove('btn--icon');
                btn.textContent = 'Remove?';
                armed.set(port, setTimeout(() => { armed.delete(port); backendKey = ''; renderBackends(); }, 3000));
                return;
            }
            clearTimeout(armed.get(port));
            armed.delete(port);
        }
        btn.disabled = true;
        if (act === 'start') await api.startServer(port);
        else if (act === 'stop') await api.stopServer(port);
        else if (act === 'delete') await api.deleteServer(port);
    });

    box.addEventListener('change', e => {
        const input = e.target.closest('[data-be-latency]');
        if (!input) return;
        const v = Math.max(0, Math.min(100, Number(input.value) || 0));
        api.setLatency(Number(input.dataset.beLatency), v);
    });

    box.addEventListener('mouseover', e => {
        const row = e.target.closest('[data-backend-row]');
        map?.setHighlightPort(row ? Number(row.dataset.backendRow) : null);
    });
    box.addEventListener('mouseleave', () => map?.setHighlightPort(null));

    $('add-backend').addEventListener('submit', async e => {
        e.preventDefault();
        const port = Number($('new-port').value);
        const latency = Number($('new-latency').value) || 0;
        const r = await api.createServer(port, latency);
        if (r.ok) $('new-port').value = '';
        suggestPort();
    });

    $('gw-strategy').addEventListener('change', e => setOperatorStrategy(e.target.value));
}

/* ================================================================ *
 *  Map toolbar
 * ================================================================ */

function bindMapToolbar() {
    const btn = $('toggle-anim');
    const sync = () => {
        btn.setAttribute('aria-pressed', String(map.paused));
        btn.querySelector('span').textContent = map.paused ? 'Resume animations' : 'Pause animations';
        btn.querySelector('use').setAttribute('href', map.paused ? '#i-play' : '#i-pause');
    };
    btn.addEventListener('click', () => { map.setPaused(!map.paused); sync(); });
    sync();

    $('stage').addEventListener('focuschange', e => {
        const chip = $('focus-chip');
        chip.hidden = !e.detail;
        if (e.detail) $('focus-name').textContent = `Showing ${regionInfo(e.detail).name}`;
    });
    $('focus-clear').addEventListener('click', () => map.focus && map.setFocus(map.focus));
    $('routing').addEventListener('scroll', () => map.relayout(), { passive: true });
}

/* ================================================================ *
 *  Boot
 * ================================================================ */

map = new TrafficMap($('stage'));
map.load('/static/vendor/countries-110m.json');
initCharts();
initEventStream($('stream'));
initStorefront();
bindBackendControls();
bindMapToolbar();

$('reset-counters').addEventListener('click', () => resetCounters());

function renderAll() {
    renderNav();
    renderMetrics();
    renderGateway();
    renderBackends();
}

on('state', renderAll);
on('connection', renderAll);
on('tick', () => {
    generatorHistory.push(state.clients.length);
    if (generatorHistory.length > 60) generatorHistory.shift();
    renderAll();
});

// Keep counters responsive between ticks without re-rendering on every event
let dirty = false;
['request:sent', 'request:forwarded', 'request:done'].forEach(evt => on(evt, () => { dirty = true; }));
setInterval(() => {
    if (!dirty) return;
    dirty = false;
    renderMetrics();
    renderBackends();
    renderGateway();
}, 250);

showView();
renderAll();

// Exposed for operators poking at the console during a demo
window.flashpoint = { state, api, strategyNames: STRATEGY_NAMES };
