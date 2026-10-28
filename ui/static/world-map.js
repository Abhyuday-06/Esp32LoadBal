// world-map.js
//
// The traffic map. Geography on the left (SVG, Equal Earth projection),
// schematic routing on the right: routes leave each region marker and run
// into the routing panel, where the ESP32 and the backends live.
//
// Every animation is a consequence of a telemetry event:
//   PING     -> pulse from the region to the gateway
//   REQUEST  -> pulse from the gateway to the backend named in the request
//   PONG/... -> return pulse, coloured by what actually came back
// A leg with no event behind it is never drawn. The gateway's position is a
// diagram, not a location.

import { REGIONS, UNASSIGNED, regionInfo } from './region-config.js';
import { on, state, regionRate, generatorForRegion } from './telemetry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_PULSES = 260;
const LEG_MS = { region: 900, bus: 360 };
const COLORS = { ok: '#E8EDF2', non200: '#D9A441', fail: '#E36D70' };
const LABEL_SIDE = { na: 'left', sa: 'right', eu: 'up', af: 'left', me: 'up', sas: 'down', ap: 'right', unassigned: 'right' };

const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
};

function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class TrafficMap {
    constructor(stage) {
        this.stage = stage;
        this.pane = stage.querySelector('[data-map-pane]');
        this.geo = stage.querySelector('[data-geo]');
        this.routeLayer = stage.querySelector('[data-routes]');
        this.canvas = stage.querySelector('[data-pulses]');
        this.ctx = this.canvas.getContext('2d');
        this.labels = stage.querySelector('[data-labels]');
        this.tooltip = stage.querySelector('[data-tooltip]');
        this.legend = stage.querySelector('[data-legend]');

        this.paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.focus = null;
        this.highlightPort = null;
        this.points = {};       // region id -> {x, y}
        this.routes = {};       // region id -> { path, lut }
        this.buses = {};        // port -> { path, lut }
        this.tokens = new Map();
        this.pulses = [];
        this.marks = [];        // rings and failure crosses
        this.running = false;

        this.world = null;
        new ResizeObserver(() => this.relayout()).observe(stage);
        this.bindEvents();
    }

    async load(url) {
        try {
            this.world = await (await fetch(url)).json();
        } catch (e) {
            console.warn('Map geometry unavailable', e);
            this.pane.dataset.geoError = 'true';
        }
        this.relayout();
    }

    /* ------------------------------------------------------------ *
     *  Layout
     * ------------------------------------------------------------ */

    relayout() {
        const sr = this.stage.getBoundingClientRect();
        const pr = this.pane.getBoundingClientRect();
        if (!sr.width || !pr.width) return;
        this.sr = sr;
        this.dpr = Math.min(window.devicePixelRatio || 1, 2);
        this.canvas.width = Math.round(sr.width * this.dpr);
        this.canvas.height = Math.round(sr.height * this.dpr);
        this.routeLayer.setAttribute('viewBox', `0 0 ${sr.width} ${sr.height}`);

        const legendH = this.legend.offsetHeight;
        this.pane.style.setProperty('--legend-h', `${legendH}px`);
        const w = pr.width, h = pr.height - legendH;
        this.geo.setAttribute('viewBox', `0 0 ${w} ${h}`);
        this.geo.style.height = `${h}px`;
        this.drawGeography(w, h);

        // Pane-relative to stage-relative
        const ox = pr.left - sr.left, oy = pr.top - sr.top;
        for (const r of REGIONS) {
            const p = this.projection ? this.projection([r.lon, r.lat]) : [w * (r.lon + 180) / 360, h * (90 - r.lat) / 180];
            this.points[r.id] = { x: p[0] + ox, y: p[1] + oy, px: p[0], py: p[1] };
        }
        this.points.unassigned = { x: ox + 28, y: oy + h - 28, px: 28, py: h - 28 };

        this.drawMarkers();
        this.drawRoutes();
        this.renderLabels();
        this.renderLegend();
    }

    anchor(selector) {
        const a = this.stage.querySelector(selector);
        if (!a || !this.sr) return null;
        const r = a.getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return { x: r.left + r.width / 2 - this.sr.left, y: r.top + r.height / 2 - this.sr.top };
    }

    drawGeography(w, h) {
        this.geo.innerHTML = '';
        if (!this.world || !window.d3 || !window.topojson) { this.projection = null; return; }
        const world = this.world;
        const geoms = world.objects.countries.geometries;
        const land = topojson.merge(world, geoms.filter(g => g.id !== '010'));   // drop Antarctica
        const borders = topojson.mesh(world, world.objects.countries, (a, b) => a !== b);
        const pad = 12;
        this.projection = d3.geoEqualEarth().fitExtent([[pad, pad], [w - pad, h - pad]], land);
        const path = d3.geoPath(this.projection);

        el('path', { d: path({ type: 'Sphere' }), class: 'geo-sphere' }, this.geo);
        el('path', { d: path(d3.geoGraticule10()), class: 'geo-graticule' }, this.geo);
        el('path', { d: path(land), class: 'geo-land' }, this.geo);
        el('path', { d: path(borders), class: 'geo-border' }, this.geo);
        this.markerLayer = el('g', { class: 'geo-markers' }, this.geo);
    }

    drawMarkers() {
        if (!this.markerLayer) this.markerLayer = el('g', { class: 'geo-markers' }, this.geo);
        this.markerLayer.innerHTML = '';
        for (const r of [...REGIONS, UNASSIGNED]) {
            const p = this.points[r.id];
            const g = el('g', { class: 'marker', 'data-region': r.id, transform: `translate(${p.px},${p.py})` }, this.markerLayer);
            if (r.id === 'unassigned') {
                el('rect', { x: -3.5, y: -3.5, width: 7, height: 7, class: 'marker-dot', fill: r.color }, g);
            } else {
                el('circle', { r: 7, class: 'marker-halo', fill: r.color }, g);
                el('circle', { r: 3.5, class: 'marker-dot', fill: r.color }, g);
            }
            el('circle', { r: 14, class: 'marker-hit' }, g);
        }
        this.syncMarkerState();
    }

    drawRoutes() {
        const L = this.routeLayer;
        L.innerHTML = '';
        this.routes = {};
        this.buses = {};
        const inlet = this.anchor('[data-anchor="gateway-in"]');
        const outlet = this.anchor('[data-anchor="gateway-out"]');
        this.gatewayPoint = inlet;
        if (!inlet) return;

        // Side-by-side layout: routes run right into the panel. Stacked
        // layout (narrow screens): the panel is below, so routes run down.
        const stacked = inlet.y > this.pane.getBoundingClientRect().bottom - this.sr.top - 1;
        const ids = [...REGIONS.map(r => r.id), 'unassigned'];
        ids.forEach((id, i) => {
            const p = this.points[id];
            let d;
            if (stacked) {
                const ix = inlet.x + (i - 3) * 4;
                const dy = inlet.y - p.y;
                d = `M${p.x},${p.y} C${p.x},${p.y + dy * 0.5} ${ix},${inlet.y - dy * 0.32} ${ix},${inlet.y}`;
            } else {
                const iy = inlet.y + (i - 3) * 4;
                const dx = inlet.x - p.x;
                d = `M${p.x},${p.y} C${p.x + dx * 0.5},${p.y} ${inlet.x - dx * 0.32},${iy} ${inlet.x},${iy}`;
            }
            const path = el('path', { d, class: 'route', 'data-region': id, stroke: regionInfo(id).color }, L);
            this.routes[id] = { path, lut: sample(path) };
        });

        if (!outlet) return;
        this.stage.querySelectorAll('[data-anchor="backend"]').forEach(a => {
            const port = Number(a.dataset.port);
            const b = this.anchor(`[data-anchor="backend"][data-port="${port}"]`);
            if (!b) return;
            const r = Math.min(8, Math.abs(b.y - outlet.y) / 2);
            const d = `M${outlet.x},${outlet.y} L${outlet.x},${b.y - r} Q${outlet.x},${b.y} ${outlet.x + r},${b.y} L${b.x},${b.y}`;
            const path = el('path', { d, class: 'bus', 'data-port': port }, L);
            this.buses[port] = { path, lut: sample(path) };
        });
        this.syncRouteState();
    }

    /* ------------------------------------------------------------ *
     *  Labels, legend, tooltip, state classes
     * ------------------------------------------------------------ */

    visibleRegions() {
        const hasUnassigned = state.clients.some(c => !state.regionOf[c.id]) || (state.regions.unassigned?.sent > 0);
        return hasUnassigned ? [...REGIONS, UNASSIGNED] : REGIONS;
    }

    regionStatus(id) {
        if (id === 'unassigned') {
            const n = state.clients.filter(c => !state.regionOf[c.id]).length;
            return n ? { active: true, text: `${n} generator${n > 1 ? 's' : ''}` } : { active: false, text: 'None' };
        }
        const g = generatorForRegion(id);
        return g ? { active: true, text: 'Generator running', gid: g.id } : { active: false, text: 'No generator' };
    }

    renderLabels() {
        this.labels.innerHTML = '';
        const pr = this.pane.getBoundingClientRect();
        for (const r of this.visibleRegions()) {
            const p = this.points[r.id];
            const side = LABEL_SIDE[r.id];
            const d = document.createElement('div');
            d.className = `map-label side-${side}`;
            d.dataset.region = r.id;
            d.style.left = `${p.px}px`;
            d.style.top = `${p.py}px`;
            d.innerHTML = `<span class="ml-name">${r.name}</span><span class="ml-stat" data-stat></span>`;
            this.labels.appendChild(d);
        }
        this.labels.style.width = `${pr.width}px`;
        this.updateStats();
    }

    renderLegend() {
        const regions = this.visibleRegions();
        this.legend.innerHTML = regions.map(r => `
            <button type="button" class="legend-item" data-region="${r.id}" aria-pressed="${this.focus === r.id}">
                <span class="swatch" style="--c:${r.color}"></span>
                <span class="li-name">${r.name}</span>
                <span class="li-state" data-legend-state></span>
            </button>`).join('');
        this.updateStats();
    }

    updateStats() {
        for (const r of this.visibleRegions()) {
            const R = state.regions[r.id];
            const st = this.regionStatus(r.id);
            const label = this.labels.querySelector(`.map-label[data-region="${r.id}"]`);
            if (label) {
                const stat = label.querySelector('[data-stat]');
                if (!R || !R.sent) {
                    stat.textContent = st.active ? 'Awaiting traffic' : 'No generator';
                } else {
                    const avg = R.latN ? `${Math.round(R.latSum / R.latN)} ms` : 'no 200s';
                    stat.innerHTML = `<span class="num">${R.sent.toLocaleString()}</span> req <span class="sep"></span><span class="num">${avg}</span>`;
                }
                label.classList.toggle('is-idle', !st.active);
            }
            const li = this.legend.querySelector(`.legend-item[data-region="${r.id}"] [data-legend-state]`);
            if (li) li.textContent = st.active ? `${regionRate(r.id).toFixed(1)}/s` : 'Idle';
        }
        this.syncMarkerState();
    }

    syncMarkerState() {
        if (!this.markerLayer) return;
        this.markerLayer.querySelectorAll('.marker').forEach(m => {
            const id = m.dataset.region;
            const st = this.regionStatus(id);
            m.classList.toggle('is-active', st.active);
            m.classList.toggle('is-dim', !!this.focus && this.focus !== id);
            m.style.display = id === 'unassigned' && !this.visibleRegions().includes(UNASSIGNED) ? 'none' : '';
        });
        this.labels.querySelectorAll('.map-label').forEach(l => l.classList.toggle('is-dim', !!this.focus && this.focus !== l.dataset.region));
    }

    syncRouteState() {
        this.routeLayer.querySelectorAll('.route').forEach(p => {
            const id = p.dataset.region;
            const st = this.regionStatus(id);
            p.classList.toggle('is-active', st.active);
            p.classList.toggle('is-dim', !!this.focus && this.focus !== id);
            p.classList.toggle('is-focus', this.focus === id);
            p.style.display = id === 'unassigned' && !this.visibleRegions().includes(UNASSIGNED) ? 'none' : '';
        });
        this.routeLayer.querySelectorAll('.bus').forEach(p => {
            p.classList.toggle('is-highlight', this.highlightPort === Number(p.dataset.port));
        });
        this.stage.dataset.focus = this.focus || '';
    }

    setFocus(id) {
        this.focus = this.focus === id ? null : id;
        this.legend.querySelectorAll('.legend-item').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.region === this.focus)));
        this.syncMarkerState();
        this.syncRouteState();
        this.stage.dispatchEvent(new CustomEvent('focuschange', { detail: this.focus }));
    }

    setHighlightPort(port) {
        this.highlightPort = port;
        this.syncRouteState();
    }

    setPaused(paused) {
        this.paused = paused;
        if (paused) { this.tokens.clear(); this.pulses = []; this.marks = []; this.clearCanvas(); }
    }

    showTooltip(id, x, y) {
        const r = regionInfo(id);
        const R = state.regions[id] || {};
        const st = this.regionStatus(id);
        const fails = (R.non200 || 0) + (R.timeouts || 0) + (R.errors || 0);
        const last = R.lastAt ? `${Math.max(0, Math.round((Date.now() - R.lastAt) / 1000))} s ago` : 'None yet';
        this.tooltip.innerHTML = `
            <div class="tt-head"><span class="swatch" style="--c:${r.color}"></span><b>${r.name}</b></div>
            <p class="tt-note">${id === 'unassigned' ? 'Generators with no region recorded in this browser.' : `Simulated region. Its generator runs on this laptop; ${r.city} only places the marker.`}</p>
            <dl>
                <div><dt>Generator</dt><dd class="mono">${st.gid || st.text}</dd></div>
                <div><dt>Requests sent</dt><dd class="num">${(R.sent || 0).toLocaleString()}</dd></div>
                <div><dt>HTTP 200</dt><dd class="num">${(R.ok || 0).toLocaleString()}</dd></div>
                <div><dt>Not served</dt><dd class="num">${fails.toLocaleString()}</dd></div>
                <div><dt>Avg response</dt><dd class="num">${R.latN ? `${Math.round(R.latSum / R.latN)} ms` : 'Not measured'}</dd></div>
                <div><dt>Last request</dt><dd>${last}</dd></div>
            </dl>
            <p class="tt-hint">${this.focus === id ? 'Click to clear focus' : 'Click to focus this region'}</p>`;
        this.tooltip.hidden = false;
        const pr = this.pane.getBoundingClientRect();
        const tw = this.tooltip.offsetWidth, th = this.tooltip.offsetHeight;
        let left = x + 16, top = y - th / 2;
        if (left + tw > pr.width - 8) left = x - tw - 16;
        top = Math.max(8, Math.min(pr.height - th - 8, top));
        this.tooltip.style.left = `${left}px`;
        this.tooltip.style.top = `${top}px`;
    }

    bindEvents() {
        const regionFrom = e => e.target.closest('[data-region]')?.dataset.region;
        const move = e => {
            const id = regionFrom(e);
            if (!id || e.target.closest('.legend-item')) { this.tooltip.hidden = true; return; }
            const pr = this.pane.getBoundingClientRect();
            const p = this.points[id];
            this.showTooltip(id, p ? p.px : e.clientX - pr.left, p ? p.py : e.clientY - pr.top);
        };
        this.pane.addEventListener('mousemove', move);
        this.pane.addEventListener('mouseleave', () => { this.tooltip.hidden = true; });
        this.pane.addEventListener('click', e => {
            const id = regionFrom(e);
            if (id) this.setFocus(id);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.focus) this.setFocus(this.focus); });

        on('request:sent', ({ cid, region, direct }) => this.onSent(cid, region, direct));
        on('request:forwarded', ({ cid, port }) => this.onForwarded(cid, port));
        on('request:done', ({ cid, region, outcome }) => this.onDone(cid, region, outcome));
        on('state', () => { this.renderLegendIfChanged(); this.updateStats(); this.syncRouteState(); });
        on('tick', () => this.updateStats());
    }

    renderLegendIfChanged() {
        const key = this.visibleRegions().map(r => r.id).join();
        if (key !== this.legendKey) {
            this.legendKey = key;
            this.renderLabels();
            this.renderLegend();
            this.drawMarkers();
        }
    }

    /* ------------------------------------------------------------ *
     *  Request lifecycle -> legs
     * ------------------------------------------------------------ */

    onSent(cid, region, direct) {
        this.pingMarker(region);
        if (this.paused || !this.routes[region]) return;
        if (this.tokens.size > MAX_PULSES) return;
        const tok = { cid, region, direct, stage: 'toGateway', port: null, outcome: null, born: performance.now() };
        this.tokens.set(cid, tok);
        this.leg(this.routes[region].lut, 1, regionInfo(region).color, LEG_MS.region, region, null, () => this.atGateway(tok));
    }

    onForwarded(cid, port) {
        this.flashBackend(port);
        const tok = cid && this.tokens.get(cid);
        if (!tok || tok.port != null) return;
        tok.port = port;
        if (tok.stage === 'atGateway') this.toBackend(tok);
    }

    onDone(cid, region, outcome) {
        const tok = this.tokens.get(cid);
        if (!tok) {
            if (outcome !== 'ok' && !this.paused) this.markAt(this.points[region], outcome);
            return;
        }
        tok.outcome = outcome;
        if (tok.stage === 'atGateway') this.back(tok, false);
        else if (tok.stage === 'atBackend') this.back(tok, true);
    }

    atGateway(tok) {
        if (!this.tokens.has(tok.cid)) return;
        tok.stage = 'atGateway';
        if (!tok.direct) this.flashGateway();
        if (tok.port != null) this.toBackend(tok);
        else if (tok.outcome) this.back(tok, false);
    }

    toBackend(tok) {
        const bus = this.buses[tok.port];
        if (!bus) { tok.stage = 'atBackend'; if (tok.outcome) this.back(tok, false); return; }
        tok.stage = 'toBackend';
        this.leg(bus.lut, 1, regionInfo(tok.region).color, LEG_MS.bus, tok.region, tok.port, () => {
            if (!this.tokens.has(tok.cid)) return;
            tok.stage = 'atBackend';
            if (tok.outcome) this.back(tok, true);
        });
    }

    back(tok, fromBackend) {
        tok.stage = 'returning';
        const color = tok.outcome === 'ok' ? COLORS.ok : tok.outcome === 'non200' ? COLORS.non200 : COLORS.fail;
        const route = this.routes[tok.region];
        const bus = fromBackend && this.buses[tok.port];
        if (tok.outcome === 'timeout' || tok.outcome === 'error') {
            const at = bus ? this.anchor(`[data-anchor="backend"][data-port="${tok.port}"]`) : this.gatewayPoint;
            this.markAt(at, tok.outcome);
        }
        const home = () => {
            if (!route) { this.tokens.delete(tok.cid); return; }
            this.leg(route.lut, -1, color, LEG_MS.region, tok.region, null, () => {
                this.ring(this.points[tok.region], color);
                this.tokens.delete(tok.cid);
            }, 0.75);
        };
        if (bus) this.leg(bus.lut, -1, color, LEG_MS.bus, tok.region, tok.port, home, 0.75);
        else home();
    }

    /* ------------------------------------------------------------ *
     *  DOM flashes (these run even when animations are paused:
     *  they are state, not decoration)
     * ------------------------------------------------------------ */

    flashGateway() {
        const g = this.stage.querySelector('[data-gateway]');
        if (!g) return;
        g.classList.remove('is-hit');
        void g.offsetWidth;
        g.classList.add('is-hit');
    }

    flashBackend(port) {
        const row = this.stage.querySelector(`[data-backend-row="${port}"]`);
        if (!row) return;
        row.classList.remove('is-hit');
        void row.offsetWidth;
        row.classList.add('is-hit');
    }

    pingMarker(region) {
        const m = this.markerLayer?.querySelector(`.marker[data-region="${region}"]`);
        if (!m) return;
        m.classList.remove('is-hit');
        void m.getBoundingClientRect();
        m.classList.add('is-hit');
    }

    /* ------------------------------------------------------------ *
     *  Canvas primitives
     * ------------------------------------------------------------ */

    leg(lut, dir, color, dur, region, port, done, alpha = 1) {
        if (this.pulses.length >= MAX_PULSES) { done && done(); return; }
        this.pulses.push({ lut, dir, color, dur, region, port, done, alpha, t: 0 });
        this.start();
    }

    ring(p, color) {
        if (!p || this.paused) return;
        this.marks.push({ kind: 'ring', x: p.x, y: p.y, color, life: 0, dur: 700 });
        this.start();
    }

    markAt(p, outcome) {
        if (!p || this.paused) return;
        this.marks.push({ kind: 'cross', x: p.x, y: p.y, color: outcome === 'non200' ? COLORS.non200 : COLORS.fail, life: 0, dur: 1400 });
        this.start();
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.last = performance.now();
        requestAnimationFrame(t => this.frame(t));
    }

    clearCanvas() {
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    }

    frame(now) {
        const dt = Math.min(64, now - this.last);
        this.last = now;

        const finished = [];
        this.pulses = this.pulses.filter(p => {
            p.t += dt / p.dur;
            if (p.t >= 1) { finished.push(p); return false; }
            return true;
        });
        finished.forEach(p => p.done && p.done());
        this.marks = this.marks.filter(m => (m.life += dt) < m.dur);
        for (const [cid, tok] of this.tokens) if (now - tok.born > 12000) this.tokens.delete(cid);

        this.draw();
        if (this.pulses.length || this.marks.length) {
            requestAnimationFrame(t => this.frame(t));
        } else {
            this.running = false;
            this.clearCanvas();
        }
    }

    draw() {
        const { ctx } = this;
        this.clearCanvas();
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.lineCap = 'round';

        for (const p of this.pulses) {
            if (this.focus && p.region !== this.focus) continue;
            if (this.highlightPort != null && p.port != null && p.port !== this.highlightPort) continue;
            const t = ease(p.t);
            const head = p.dir > 0 ? t : 1 - t;
            const tail = 0.09;
            const from = p.dir > 0 ? Math.max(0, head - tail) : Math.min(1, head + tail);
            const SEG = 6;
            let prev = at(p.lut, from);
            ctx.lineWidth = 1.5;
            for (let i = 1; i <= SEG; i++) {
                const q = at(p.lut, from + (head - from) * (i / SEG));
                ctx.strokeStyle = rgba(p.color, p.alpha * (i / SEG));
                ctx.beginPath();
                ctx.moveTo(prev.x, prev.y);
                ctx.lineTo(q.x, q.y);
                ctx.stroke();
                prev = q;
            }
            ctx.fillStyle = rgba(p.color, p.alpha);
            ctx.beginPath();
            ctx.arc(prev.x, prev.y, 2, 0, Math.PI * 2);
            ctx.fill();
        }

        for (const m of this.marks) {
            const k = m.life / m.dur;
            ctx.strokeStyle = rgba(m.color, 1 - k);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            if (m.kind === 'ring') {
                ctx.arc(m.x, m.y, 4 + k * 10, 0, Math.PI * 2);
            } else {
                const s = 5;
                ctx.moveTo(m.x - s, m.y - s); ctx.lineTo(m.x + s, m.y + s);
                ctx.moveTo(m.x + s, m.y - s); ctx.lineTo(m.x - s, m.y + s);
            }
            ctx.stroke();
        }
    }
}

/* ---------------- path sampling ---------------- */

function sample(path, n = 72) {
    const len = path.getTotalLength();
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const p = path.getPointAtLength((len * i) / n);
        pts.push({ x: p.x, y: p.y });
    }
    return pts;
}

function at(lut, t) {
    const f = Math.max(0, Math.min(1, t)) * (lut.length - 1);
    const i = Math.floor(f), k = f - i;
    const a = lut[i], b = lut[Math.min(lut.length - 1, i + 1)];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

const ease = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
