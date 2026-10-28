// storefront.js - the Flash sale view: an illustrative storefront plus the
// controls that start and stop the real client generators.
//
// "Starting the sale" means exactly one thing: POST /api/clients/create once
// per selected region, in order, reporting each result. Nothing is started
// behind the user's back, and the countdown never triggers anything.

import { REGIONS, regionInfo } from './region-config.js';
import { state, on, api, generatorForRegion, assignRegion, recentRate } from './telemetry.js';

const PRODUCTS = [
    { name: 'Halden Studio One', spec: 'Over-ear, active noise cancelling', price: 179, was: 299, img: 'headphones' },
    { name: 'Halden Pulse 2', spec: 'Smartwatch, 44 mm aluminium', price: 149, was: 229, img: 'watch' },
    { name: 'Halden Air Buds', spec: 'True wireless, 30 h with case', price: 69, was: 109, img: 'earbuds' },
    { name: 'Halden K75 Keyboard', spec: 'Low-profile mechanical, 75%', price: 89, was: 139, img: 'keyboard' },
    { name: 'Halden Frame M', spec: 'Mirrorless body, 24 MP', price: 649, was: 899, img: 'camera' },
    { name: 'Halden Column', spec: 'Portable speaker, 20 h', price: 99, was: 159, img: 'speaker' },
];

const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const $ = id => document.getElementById(id);

const sale = {
    phase: 'idle',             // idle | launching | running | stopping
    startedAt: store.get('fp-sale-started', null),
    windowMin: store.get('fp-sale-window', 10),
    selected: new Set(store.get('fp-sale-regions', REGIONS.map(r => r.id))),
    rowState: {},              // region id -> { phase: 'starting'|'failed'|'stopping', error }
};

export function initStorefront() {
    renderProducts();
    restoreConfig();
    bindControls();
    on('state', render);
    on('tick', renderDemand);
    setInterval(renderCountdown, 500);
    render();
}

/* ---------------- storefront ---------------- */

function renderProducts() {
    $('products').innerHTML = PRODUCTS.map(p => `
        <article class="product">
            <figure>
                <img src="/static/assets/products/${p.img}.svg" alt="${p.name}" loading="lazy" width="400" height="400">
                <span class="off num">−${Math.round((1 - p.price / p.was) * 100)}%</span>
            </figure>
            <h4>${p.name}</h4>
            <div class="spec">${p.spec}</div>
            <div class="price"><b>$${p.price}</b><s>$${p.was}</s></div>
        </article>`).join('');
}

function activeRegionIds() {
    return REGIONS.filter(r => generatorForRegion(r.id)).map(r => r.id);
}

function renderDemand() {
    const active = activeRegionIds();
    $('d-regions').textContent = active.length;
    $('d-region-dots').innerHTML = REGIONS.map(r => `<i class="${active.includes(r.id) ? 'on' : ''}" style="--c:${r.color}" title="${r.name}"></i>`).join('');
    $('d-requests').textContent = Math.round(recentRate(10) * 10).toLocaleString();
    const cut = Math.floor(Date.now() / 1000) - 60;
    let sum = 0, n = 0;
    for (const b of state.buckets) if (b.t > cut) { sum += b.latSum; n += b.latN; }
    $('d-latency').textContent = n ? `${Math.round(sum / n)} ms` : 'Not measured';
}

function renderCountdown() {
    const el = $('countdown');
    const cap = $('countdown-caption');
    const running = activeRegionIds().length > 0 || state.clients.length > 0;
    if (running && !sale.startedAt) {
        // Generators exist but were not launched from this page, so there is
        // no honest start time to count down from.
        el.innerHTML = '<span class="cd-idle">Sale is live</span>';
        cap.textContent = 'Started outside this page, so there is no window timer.';
        $('hero-kicker').textContent = 'Flash sale is live';
        return;
    }
    if (!sale.startedAt || !running) {
        el.innerHTML = '<span class="cd-idle">Starts when you launch it</span>';
        cap.textContent = 'Use Start flash sale on the right.';
        $('hero-kicker').textContent = 'Flash sale';
        return;
    }
    const end = sale.startedAt + sale.windowMin * 60000;
    const left = end - Date.now();
    if (left <= 0) {
        el.innerHTML = '<span class="cd-idle">Sale window has ended</span>';
        cap.textContent = 'Generators are still running. Stop the sale when you are done.';
        $('hero-kicker').textContent = 'Flash sale ended';
        return;
    }
    const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
    el.innerHTML = `
        <div class="cd-unit"><span class="cd-num">${String(m).padStart(2, '0')}</span><span class="cd-lbl">minutes</span></div>
        <span class="cd-colon">:</span>
        <div class="cd-unit"><span class="cd-num">${String(s).padStart(2, '0')}</span><span class="cd-lbl">seconds</span></div>`;
    cap.textContent = 'Left in the sale window';
    $('hero-kicker').textContent = 'Flash sale is live';
}

/* ---------------- control panel ---------------- */

function restoreConfig() {
    const cfg = store.get('fp-sale-config', null);
    if (cfg) {
        $('cfg-ip').value = cfg.target_ip;
        $('cfg-port').value = cfg.target_port;
        $('cfg-delay').value = cfg.delay;
        $('cfg-timeout').value = cfg.timeout;
    }
    $('cfg-window').value = String(sale.windowMin);
}

function readConfig() {
    const cfg = {
        target_ip: $('cfg-ip').value.trim(),
        target_port: $('cfg-port').value,
        delay: $('cfg-delay').value,
        timeout: $('cfg-timeout').value,
    };
    store.set('fp-sale-config', cfg);
    return cfg;
}

function bindControls() {
    $('sale-start').addEventListener('click', startSale);
    $('sale-stop').addEventListener('click', stopSale);
    $('cfg-window').addEventListener('change', e => {
        sale.windowMin = Number(e.target.value);
        store.set('fp-sale-window', sale.windowMin);
        renderCountdown();
    });

    const stopAll = $('stop-all');
    let armed = null;
    stopAll.addEventListener('click', async () => {
        if (!armed) {
            stopAll.textContent = 'Confirm: stop all';
            stopAll.classList.add('btn--confirm');
            armed = setTimeout(disarm, 3000);
            return;
        }
        disarm();
        sale.phase = 'stopping';
        render();
        await api.stopAll();
        sale.phase = 'idle';
        sale.startedAt = null;
        store.set('fp-sale-started', null);
        render();
    });
    function disarm() {
        clearTimeout(armed);
        armed = null;
        stopAll.textContent = 'Stop all generators';
        stopAll.classList.remove('btn--confirm');
    }

    $('gen-list').addEventListener('change', e => {
        const cb = e.target.closest('input[type=checkbox]');
        if (!cb) return;
        cb.checked ? sale.selected.add(cb.value) : sale.selected.delete(cb.value);
        store.set('fp-sale-regions', [...sale.selected]);
        render();
    });

    $('gen-list').addEventListener('click', async e => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const id = btn.dataset.region;
        if (btn.dataset.act === 'start') await startRegion(id);
        else await stopRegion(id);
        if (!sale.startedAt && activeRegionIds().length) markStarted();
        render();
    });

    $('unassigned').addEventListener('change', e => {
        const sel = e.target.closest('select[data-assign]');
        if (sel && sel.value) assignRegion(sel.dataset.assign, sel.value);
    });
    $('unassigned').addEventListener('click', async e => {
        const btn = e.target.closest('button[data-stop]');
        if (btn) await api.stopClient(btn.dataset.stop);
    });
}

function markStarted() {
    sale.startedAt = Date.now();
    store.set('fp-sale-started', sale.startedAt);
}

async function startRegion(id) {
    if (generatorForRegion(id)) return true;
    sale.rowState[id] = { phase: 'starting' };
    render();
    const r = await api.createClient(readConfig(), id);
    sale.rowState[id] = r.ok ? null : { phase: 'failed', error: r.error };
    return r.ok;
}

async function stopRegion(id) {
    const g = generatorForRegion(id);
    if (!g) return;
    sale.rowState[id] = { phase: 'stopping' };
    render();
    await api.stopClient(g.id);
    sale.rowState[id] = null;
}

async function startSale() {
    const targets = REGIONS.filter(r => sale.selected.has(r.id) && !generatorForRegion(r.id));
    if (!targets.length) return;
    sale.phase = 'launching';
    sale.launch = { done: 0, total: targets.length, failed: 0 };
    render();
    for (const r of targets) {
        const ok = await startRegion(r.id);
        sale.launch.done++;
        if (!ok) sale.launch.failed++;
        if (ok && !sale.startedAt) markStarted();
        render();
    }
    sale.phase = activeRegionIds().length ? 'running' : 'idle';
    render();
}

async function stopSale() {
    sale.phase = 'stopping';
    render();
    for (const r of REGIONS) await stopRegion(r.id);
    sale.phase = 'idle';
    sale.startedAt = null;
    store.set('fp-sale-started', null);
    render();
}

function render() {
    const active = activeRegionIds();
    if (sale.phase === 'running' && !active.length) sale.phase = 'idle';
    if (sale.phase === 'idle' && active.length) sale.phase = 'running';

    // Headline state
    const stateEl = $('sale-state'), sub = $('sale-state-sub');
    if (sale.phase === 'launching') {
        stateEl.textContent = `Starting generators, ${sale.launch.done} of ${sale.launch.total}`;
        sub.textContent = 'Each region is started with its own request to Flask.';
    } else if (sale.phase === 'stopping') {
        stateEl.textContent = 'Stopping generators';
        sub.textContent = '';
    } else if (sale.phase === 'running') {
        stateEl.textContent = `Sale running in ${active.length} of 7 regions`;
        const failed = sale.launch?.failed;
        sub.textContent = failed ? `${failed} region${failed > 1 ? 's' : ''} did not start. See the list below.` : 'Follow the requests on Live traffic.';
    } else {
        stateEl.textContent = 'Sale not running';
        sub.textContent = 'Choose regions, then start the sale to begin sending traffic through the ESP32.';
    }

    const selectedFree = REGIONS.filter(r => sale.selected.has(r.id) && !generatorForRegion(r.id)).length;
    const busy = sale.phase === 'launching' || sale.phase === 'stopping';
    $('sale-start').disabled = busy || !selectedFree || !state.socketConnected || state.clients.length >= 7;
    $('sale-start').textContent = active.length && selectedFree ? `Start ${selectedFree} more region${selectedFree > 1 ? 's' : ''}` : 'Start flash sale';
    $('sale-stop').disabled = busy || !active.length;

    // Preflight notices
    const notes = [];
    if (!state.socketConnected) notes.push(['crit', 'Flask is not reachable. Generators cannot be started until the dashboard reconnects.']);
    const running = state.servers.filter(s => s.running).length;
    if (state.loaded && !running) notes.push(['warn', 'No backend is running. The ESP32 will answer 502 Bad Gateway. <button class="link" type="button" data-goto="live">Start backends on Live traffic</button>']);
    if (state.clients.length >= 7) notes.push(['warn', 'Flask already has 7 generators, its maximum. Stop one before starting another.']);
    $('sale-notices').innerHTML = notes.map(([k, t]) => `<div class="notice notice--${k}">${t}</div>`).join('');

    // Region rows
    $('gen-list').innerHTML = REGIONS.map(r => {
        const g = generatorForRegion(r.id);
        const rs = sale.rowState[r.id];
        const R = state.regions[r.id];
        let detail;
        if (rs?.phase === 'failed') detail = `<span class="err">Could not start: ${escapeHtml(rs.error)}</span>`;
        else if (rs?.phase === 'starting') detail = 'Requesting a generator from Flask';
        else if (rs?.phase === 'stopping') detail = 'Stopping';
        else if (g) detail = `<span class="mono">${g.id}</span><span class="num">${(R?.sent || 0).toLocaleString()} sent</span><span class="num">${R?.latN ? `${Math.round(R.latSum / R.latN)} ms avg` : 'no 200s yet'}</span>`;
        else detail = 'No generator';
        const status = g ? '<span class="status is-ok">Active</span>' : rs?.phase === 'failed' ? '<span class="status is-crit">Failed</span>' : '';
        const btn = g
            ? `<button class="btn btn--sm" type="button" data-act="stop" data-region="${r.id}" ${busy ? 'disabled' : ''}>Stop</button>`
            : `<button class="btn btn--sm" type="button" data-act="start" data-region="${r.id}" ${busy || state.clients.length >= 7 || !state.socketConnected ? 'disabled' : ''}>Start</button>`;
        return `
            <li class="gen ${rs?.phase === 'starting' ? 'is-starting' : ''}">
                <input type="checkbox" value="${r.id}" ${sale.selected.has(r.id) ? 'checked' : ''} aria-label="Include ${r.name} in the sale" ${busy ? 'disabled' : ''}>
                <div class="gen-main">
                    <div class="gen-name"><span class="swatch" style="--c:${r.color}"></span>${r.name}</div>
                    <div class="gen-detail">${detail}</div>
                </div>
                <div class="gen-right">${status}${btn}</div>
            </li>`;
    }).join('');

    // Generators with no known region
    const free = REGIONS.filter(r => !generatorForRegion(r.id));
    const unassigned = state.clients.filter(c => !state.regionOf[c.id]);
    $('unassigned').innerHTML = unassigned.length ? `
        <div class="panel-head" style="margin-top:16px"><h3 class="panel-title" style="font-size:13px">Unassigned generators</h3><span class="panel-meta">Started outside this browser</span></div>
        <ul class="gen-list">${unassigned.map(c => `
            <li class="gen" style="grid-template-columns:minmax(0,1fr) auto">
                <div class="gen-main">
                    <div class="gen-name"><span class="swatch" style="--c:${regionInfo('unassigned').color}"></span><span class="mono">${c.id}</span></div>
                    <div class="gen-detail"><span class="mono">${c.target_ip}:${c.target_port}</span></div>
                </div>
                <div class="gen-right">
                    <select class="select" data-assign="${c.id}" aria-label="Assign ${c.id} to a region" style="height:26px;font-size:11px">
                        <option value="">Assign region</option>${free.map(r => `<option value="${r.id}">${r.name}</option>`).join('')}
                    </select>
                    <button class="btn btn--sm" type="button" data-stop="${c.id}">Stop</button>
                </div>
            </li>`).join('')}</ul>` : '';

    renderDemand();
    renderCountdown();
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
