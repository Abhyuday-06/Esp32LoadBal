// event-stream.js - the filterable request activity console.

import { state, on } from './telemetry.js';
import { regionInfo, REGIONS } from './region-config.js';

const MAX_ROWS = 250;

export function initEventStream(root) {
    const list = root.querySelector('[data-stream-list]');
    const typeSel = root.querySelector('[data-stream-type]');
    const sourceSel = root.querySelector('[data-stream-source]');
    const pauseBtn = root.querySelector('[data-stream-pause]');
    const clearBtn = root.querySelector('[data-stream-clear]');
    const countEl = root.querySelector('[data-stream-count]');

    let paused = false;
    let clearedAt = 0;
    let pending = 0;

    function sourceKey(e) {
        if (e.kind === 'server') return `port:${e.port}`;
        if (e.kind === 'client') return `region:${e.region}`;
        return 'system';
    }

    function matches(e) {
        if (e.seq <= clearedAt) return false;
        const type = typeSel.value;
        if (type !== 'all' && e.type !== type) return false;
        const src = sourceSel.value;
        if (src !== 'all') {
            if (src.startsWith('region:') && !(e.region === src.slice(7))) return false;
            if (src.startsWith('port:') && Number(src.slice(5)) !== e.port) return false;
        }
        return true;
    }

    function sourceLabel(e) {
        if (e.kind === 'server') return { text: `:${e.port}`, mono: true, color: null };
        if (e.kind === 'client') { const r = regionInfo(e.region); return { text: r.name, mono: false, color: r.color }; }
        return { text: 'Dashboard', mono: false, color: null };
    }

    function row(e) {
        const li = document.createElement('li');
        li.className = `ev sev-${e.severity}`;
        const src = sourceLabel(e);
        const time = new Date(e.t);
        const ts = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}.${String(time.getMilliseconds()).padStart(3, '0')}`;
        li.innerHTML = `
            <button type="button" class="ev-row" aria-expanded="false">
                <span class="ev-time mono">${ts}</span>
                <span class="ev-sev" aria-hidden="true"></span>
                <span class="ev-src ${src.mono ? 'mono' : ''}">${src.color ? `<span class="swatch" style="--c:${src.color}"></span>` : ''}${escapeHtml(src.text)}</span>
                <span class="ev-title">${escapeHtml(e.title)}</span>
                <span class="ev-msg">${escapeHtml(e.message)}</span>
            </button>
            <pre class="ev-detail mono" hidden>${escapeHtml(JSON.stringify(e.raw, null, 2))}</pre>`;
        li.querySelector('.ev-row').addEventListener('click', ev => {
            const btn = ev.currentTarget;
            const open = btn.getAttribute('aria-expanded') === 'true';
            btn.setAttribute('aria-expanded', String(!open));
            li.querySelector('.ev-detail').hidden = open;
        });
        return li;
    }

    function rerender() {
        list.innerHTML = '';
        const rows = state.log.filter(matches).slice(-MAX_ROWS);
        const frag = document.createDocumentFragment();
        rows.forEach(e => frag.appendChild(row(e)));
        list.appendChild(frag);
        renderEmpty();
        if (!paused) list.scrollTop = list.scrollHeight;
        updateCount();
    }

    function renderEmpty() {
        if (list.childElementCount) return;
        const li = document.createElement('li');
        li.className = 'ev-empty';
        li.textContent = state.log.some(e => e.seq > clearedAt) ? 'No events match these filters.' : 'No events yet. Activity from generators and backends appears here as it happens.';
        list.appendChild(li);
    }

    function updateCount() {
        countEl.textContent = paused && pending ? `${pending} new while paused` : '';
    }

    // Batch DOM work: events can arrive dozens per second
    let queue = [];
    on('log', e => { queue.push(e); });
    setInterval(() => {
        if (!queue.length) return;
        const batch = queue.filter(matches);
        queue = [];
        if (!batch.length) return;
        list.querySelector('.ev-empty')?.remove();
        const frag = document.createDocumentFragment();
        batch.slice(-MAX_ROWS).forEach(e => frag.appendChild(row(e)));
        list.appendChild(frag);
        while (list.childElementCount > MAX_ROWS) list.firstElementChild.remove();
        if (paused) pending += batch.length;
        else list.scrollTop = list.scrollHeight;
        updateCount();
    }, 200);

    // Scrolling up pauses following; returning to the bottom resumes it
    list.addEventListener('scroll', () => {
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 8;
        if (!atBottom && !paused) setPaused(true);
    });

    function setPaused(p) {
        paused = p;
        pending = 0;
        pauseBtn.setAttribute('aria-pressed', String(p));
        pauseBtn.textContent = p ? 'Resume scrolling' : 'Pause scrolling';
        if (!p) list.scrollTop = list.scrollHeight;
        updateCount();
    }

    pauseBtn.addEventListener('click', () => setPaused(!paused));
    clearBtn.addEventListener('click', () => {
        clearedAt = state.log.length ? state.log[state.log.length - 1].seq : 0;
        rerender();
    });
    typeSel.addEventListener('change', rerender);
    sourceSel.addEventListener('change', rerender);

    function renderSources() {
        const prev = sourceSel.value;
        const ports = state.servers.map(s => s.port);
        sourceSel.innerHTML = `<option value="all">All sources</option>
            <optgroup label="Regions">${REGIONS.map(r => `<option value="region:${r.id}">${r.name}</option>`).join('')}<option value="region:unassigned">Unassigned</option></optgroup>
            <optgroup label="Backends">${ports.map(p => `<option value="port:${p}">:${p}</option>`).join('')}</optgroup>`;
        if ([...sourceSel.options].some(o => o.value === prev)) sourceSel.value = prev;
    }
    let portsKey = '';
    on('state', () => {
        const k = state.servers.map(s => s.port).join();
        if (k !== portsKey) { portsKey = k; renderSources(); }
    });

    renderSources();
    rerender();
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
