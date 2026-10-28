// telemetry.js
//
// The one place that talks to Flask. It owns the Socket.IO subscription and
// every REST call, turns raw events into counters, and re-emits them as
// typed events for the views. Nothing here invents data: every number is a
// count or a mean of events the backend actually emitted.
//
// Correlation: the ESP32 forwards request bytes unchanged (main.cpp talk()),
// and the client puts its own id in the path (client.py: GET /ping/<id>/0),
// so a backend REQUEST event names the exact client request it serves.

import { CLIENT_TIMEOUT_S } from './region-config.js';

const HISTORY_SECONDS = 180;
const LOG_LIMIT = 400;
const REFRESH_MS = 1500;

const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= []).push(fn); }
function emit(evt, data) {
    for (const fn of listeners[evt] || []) {
        try { fn(data); } catch (e) { console.error(`[telemetry] ${evt} listener failed`, e); }
    }
}

const freshRegion = () => ({ sent: 0, ok: 0, non200: 0, timeouts: 0, errors: 0, latSum: 0, latN: 0, lastAt: null, recent: [] });
const freshBackend = () => ({ forwarded: 0, latSum: 0, latN: 0, lastEvent: null, lastEventAt: null });

export const state = {
    socketConnected: false,
    loaded: false,           // first successful REST refresh
    apiReachable: true,
    servers: [],             // /api/servers
    clients: [],             // /api/clients (generators)
    regionOf: store.get('fp-region-map', {}),     // generator id -> region id
    operatorStrategy: store.get('fp-operator-strategy', ''),
    totals: { sent: 0, forwarded: 0, ok: 0, non200: 0, timeouts: 0, errors: 0, latSum: 0, latN: 0 },
    regions: {},             // region id (or 'unassigned') -> counters
    backends: {},            // port -> counters
    buckets: [],             // one per wall-clock second
    inflight: new Map(),     // client request id -> { region, port, sentAt }
    openSessions: new Set(), // request ids between CONNECTING and STOP
    lastForwardAt: null,
    log: [],
};

/* ---------------- helpers ---------------- */

export const generatorOf = cid => String(cid).split('-')[0];
export const regionOfGenerator = gid => state.regionOf[gid] || 'unassigned';

function regionStats(id) { return (state.regions[id] ||= freshRegion()); }
function backendStats(port) { return (state.backends[port] ||= freshBackend()); }

function bucket() {
    const sec = Math.floor(Date.now() / 1000);
    const last = state.buckets[state.buckets.length - 1];
    if (last && last.t === sec) return last;
    // Fill gaps so the x axis stays honest about quiet seconds
    let t = last ? Math.max(last.t + 1, sec - HISTORY_SECONDS) : sec;
    for (; t <= sec; t++) state.buckets.push({ t, sent: 0, forwarded: 0, byPort: {}, latSum: 0, latN: 0, latMax: 0, failed: 0, ok: 0 });
    if (state.buckets.length > HISTORY_SECONDS) state.buckets.splice(0, state.buckets.length - HISTORY_SECONDS);
    return state.buckets[state.buckets.length - 1];
}
// Keep the timeline moving through idle periods
setInterval(() => { bucket(); emit('tick'); }, 1000);

export function recentRate(seconds = 10) {
    const cut = Math.floor(Date.now() / 1000) - seconds;
    const sum = state.buckets.filter(b => b.t > cut).reduce((a, b) => a + b.sent, 0);
    return sum / seconds;
}

export function regionRate(id, seconds = 10) {
    const r = state.regions[id];
    if (!r) return 0;
    const cut = Date.now() - seconds * 1000;
    r.recent = r.recent.filter(t => t > cut);
    return r.recent.length / seconds;
}

/** Generators target a backend port directly, so the ESP32 is not in path. */
export function isDirect(client) {
    return state.servers.some(s => s.port === Number(client.target_port));
}

function clientForRequest(cid) {
    const gid = generatorOf(cid);
    return state.clients.find(c => c.id === gid);
}

function parseStatus(details) {
    const m = /HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(details || '');
    return m ? Number(m[1]) : null;
}

/* ---------------- event log ---------------- */

const CLIENT_TITLES = {
    CONNECTING: 'Connecting', CONNECTED: 'Connected', PING: 'Request sent', PONG: 'Response',
    TIMEOUT: 'Timed out', ERROR: 'Error', DISCONNECTED: 'Closed before response', STOP: 'Request finished',
};
const SERVER_TITLES = {
    START: 'Server started', STOP: 'Server stopping', CONNECT: 'Connection accepted', REQUEST: 'Request received',
    DISCONNECT: 'Connection closed', LATENCY_UPDATE: 'Latency changed', ERROR: 'Server error',
};

function pushLog(entry) {
    entry.seq = (pushLog.seq = (pushLog.seq || 0) + 1);
    state.log.push(entry);
    if (state.log.length > LOG_LIMIT) state.log.shift();
    emit('log', entry);
}

export function logApiError(message) {
    pushLog({ t: Date.now(), kind: 'api', type: 'error', severity: 'crit', title: 'Request to Flask failed', message, raw: { message } });
}

/* ---------------- Socket.IO ---------------- */

const socket = io();

socket.on('connect', () => {
    state.socketConnected = true;
    emit('connection', true);
    refresh();
});

socket.on('disconnect', () => {
    state.socketConnected = false;
    emit('connection', false);
});

socket.on('client_event', data => {
    const cid = data.client_id;
    const gid = generatorOf(cid);
    const region = regionOfGenerator(gid);
    const R = regionStats(region);
    const now = Date.now();
    const t = data.timestamp ? data.timestamp * 1000 : now;
    let type = 'lifecycle', severity = 'info', title = CLIENT_TITLES[data.action] || data.action;
    let port = state.inflight.get(cid)?.port ?? null;

    switch (data.action) {
        case 'CONNECTING':
            state.openSessions.add(cid);
            break;

        case 'PING': {
            type = 'request';
            state.totals.sent++;
            R.sent++;
            R.lastAt = now;
            R.recent.push(now);
            bucket().sent++;
            state.inflight.set(cid, { region, port: null, sentAt: now });
            emit('request:sent', { cid, region, direct: (() => { const c = clientForRequest(cid); return c ? isDirect(c) : false; })() });
            break;
        }

        case 'PONG': {
            type = 'response';
            const status = parseStatus(data.details);
            const ms = typeof data.response_time === 'number' ? data.response_time : null;
            const b = bucket();
            title = status ? `Response ${status}` : 'Response';
            if (status === 200) {
                state.totals.ok++;
                R.ok++;
                b.ok++;
                severity = 'ok';
                // Latency is averaged over 200s only: a 503 from a full
                // ESP32 is fast precisely because nothing was served.
                if (ms != null) {
                    state.totals.latSum += ms; state.totals.latN++;
                    R.latSum += ms; R.latN++;
                    b.latSum += ms; b.latN++; b.latMax = Math.max(b.latMax, ms);
                    if (port != null) { const B = backendStats(port); B.latSum += ms; B.latN++; }
                }
            } else {
                state.totals.non200++;
                R.non200++;
                b.failed++;
                severity = 'warn';
                type = 'error';
            }
            state.inflight.delete(cid);
            emit('request:done', { cid, region, port, outcome: status === 200 ? 'ok' : 'non200', status, ms });
            break;
        }

        case 'TIMEOUT':
            type = 'error'; severity = 'crit';
            state.totals.timeouts++;
            R.timeouts++;
            bucket().failed++;
            state.inflight.delete(cid);
            emit('request:done', { cid, region, port, outcome: 'timeout', status: null, ms: CLIENT_TIMEOUT_S * 1000 });
            break;

        case 'ERROR':
        case 'DISCONNECTED':
            type = 'error'; severity = 'crit';
            state.totals.errors++;
            R.errors++;
            bucket().failed++;
            state.inflight.delete(cid);
            emit('request:done', { cid, region, port, outcome: 'error', status: null, ms: null });
            break;

        case 'STOP':
            state.openSessions.delete(cid);
            state.inflight.delete(cid);
            break;
    }

    pushLog({ t, kind: 'client', type, severity, title, message: data.details || '', region, cid, port, action: data.action, raw: data });
    if (data.action === 'STOP' || data.action === 'ERROR') scheduleRefresh();
});

socket.on('server_event', data => {
    const port = Number(data.server_port);
    const B = backendStats(port);
    const now = Date.now();
    B.lastEvent = data.action;
    B.lastEventAt = now;
    let type = 'lifecycle', severity = 'info', cid = null, region = null;

    if (data.action === 'REQUEST') {
        type = 'request';
        const m = /\/ping\/([^/\s]+)\//.exec(data.details || '');
        cid = m ? m[1] : null;
        state.totals.forwarded++;
        B.forwarded++;
        const b = bucket();
        b.forwarded++;
        b.byPort[port] = (b.byPort[port] || 0) + 1;

        if (cid) {
            const rec = state.inflight.get(cid);
            if (rec) rec.port = port;
            region = rec ? rec.region : regionOfGenerator(generatorOf(cid));
            const client = clientForRequest(cid);
            if (!client || !isDirect(client)) state.lastForwardAt = now;
        }
        emit('request:forwarded', { cid, region, port });
    } else if (data.action === 'ERROR') {
        type = 'error'; severity = 'crit';
    }

    pushLog({ t: data.timestamp ? data.timestamp * 1000 : now, kind: 'server', type, severity, title: SERVER_TITLES[data.action] || data.action, message: data.details || '', region, cid, port, action: data.action, raw: data });
    if (['START', 'STOP', 'LATENCY_UPDATE'].includes(data.action)) scheduleRefresh();
});

/* ---------------- REST ---------------- */

async function request(url, options = {}) {
    try {
        const r = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) {
            const message = body.error || `${r.status} ${r.statusText}`;
            logApiError(message);
            return { ok: false, error: message };
        }
        return { ok: true, data: body };
    } catch (e) {
        const message = `Could not reach Flask (${e.message})`;
        logApiError(message);
        return { ok: false, error: message };
    }
}

let refreshTimer = null;
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 200);
}

export async function refresh() {
    const [s, c] = await Promise.all([
        fetch('/api/servers').then(r => r.json()).catch(() => null),
        fetch('/api/clients').then(r => r.json()).catch(() => null),
    ]);
    state.apiReachable = !!(s && c);
    if (s) state.servers = s.slice().sort((a, b) => a.port - b.port);
    if (c) {
        state.clients = c;
        // Forget mappings for generators that no longer exist. Unknown
        // generators are left unassigned rather than given a guessed region.
        const ids = new Set(c.map(x => x.id));
        let changed = false;
        for (const gid of Object.keys(state.regionOf)) {
            if (!ids.has(gid)) { delete state.regionOf[gid]; changed = true; }
        }
        if (changed) store.set('fp-region-map', state.regionOf);
    }
    if (s && c) state.loaded = true;
    emit('state');
}
setInterval(refresh, REFRESH_MS);

export function assignRegion(gid, regionId) {
    for (const [k, v] of Object.entries(state.regionOf)) if (v === regionId && k !== gid) delete state.regionOf[k];
    if (regionId) state.regionOf[gid] = regionId; else delete state.regionOf[gid];
    store.set('fp-region-map', state.regionOf);
    emit('state');
}

export function generatorForRegion(regionId) {
    const gid = Object.keys(state.regionOf).find(k => state.regionOf[k] === regionId);
    return gid ? state.clients.find(c => c.id === gid) || null : null;
}

export function setOperatorStrategy(kind) {
    state.operatorStrategy = kind;
    store.set('fp-operator-strategy', kind);
    emit('state');
}

export const api = {
    async createServer(port, latency) {
        const r = await request('/api/servers/create', { method: 'POST', body: JSON.stringify({ port, latency }) });
        await refresh();
        return r;
    },
    async startServer(port) { const r = await request(`/api/servers/${port}/start`, { method: 'POST' }); await refresh(); return r; },
    async stopServer(port) { const r = await request(`/api/servers/${port}/stop`, { method: 'POST' }); await refresh(); return r; },
    async deleteServer(port) { const r = await request(`/api/servers/${port}/delete`, { method: 'DELETE' }); await refresh(); return r; },
    async setLatency(port, latency) {
        const r = await request(`/api/servers/${port}/latency`, { method: 'POST', body: JSON.stringify({ latency }) });
        await refresh();
        return r;
    },
    /** Create one generator and, on success, record which region it represents. */
    async createClient(cfg, regionId) {
        const r = await request('/api/clients/create', { method: 'POST', body: JSON.stringify(cfg) });
        if (r.ok && r.data.id && regionId) {
            state.regionOf[r.data.id] = regionId;
            store.set('fp-region-map', state.regionOf);
        }
        await refresh();
        return r;
    },
    async stopClient(id) { const r = await request(`/api/clients/${id}/stop`, { method: 'POST' }); await refresh(); return r; },
    async stopAll() { const r = await request('/api/clients/stop_all', { method: 'POST' }); await refresh(); return r; },
};

export function resetCounters() {
    state.totals = { sent: 0, forwarded: 0, ok: 0, non200: 0, timeouts: 0, errors: 0, latSum: 0, latN: 0 };
    state.regions = {};
    state.backends = {};
    state.buckets = [];
    emit('state');
    emit('tick');
}

refresh();
