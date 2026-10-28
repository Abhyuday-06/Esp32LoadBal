// charts.js - Chart.js views over telemetry.state.buckets (one per second).

import { state, on } from './telemetry.js';
import { serverColor } from './region-config.js';

const WINDOW_S = 120;

Chart.defaults.color = '#8B98A8';
Chart.defaults.font.family = "'Geist', 'Inter', system-ui, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.borderColor = '#1C2733';
Chart.defaults.animation = false;

// Relative labels: a clock time like 16:52 is ambiguous next to mm:ss.
const fmtAgo = (t, now) => (t >= now ? 'now' : `−${now - t} s`);

function baseOptions(unit, { stacked = false, legend = false } = {}) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: { display: legend, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8, usePointStyle: true, pointStyle: 'rect', padding: 10 } },
            tooltip: {
                backgroundColor: '#17212B', borderColor: '#263341', borderWidth: 1, titleColor: '#E8EDF2', bodyColor: '#C5CFDA',
                padding: 10, boxPadding: 4, titleFont: { weight: '500' },
                callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y == null ? 'no data' : `${Number(c.parsed.y).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`}` },
            },
        },
        elements: { point: { radius: 0, hoverRadius: 3 }, line: { borderWidth: 1.5, tension: 0.25 } },
        scales: {
            x: { stacked, grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } },
            y: { stacked, beginAtZero: true, grace: '10%', grid: { color: '#18222D' }, border: { display: false }, ticks: { maxTicksLimit: 5, precision: 0 }, title: { display: true, text: unit } },
        },
    };
}

export function initCharts() {
    const throughput = new Chart(document.getElementById('chart-throughput'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Sent by generators', data: [], borderColor: '#8B98A8', backgroundColor: '#8B98A8' },
                { label: 'Received by backends', data: [], borderColor: '#4C9AFF', backgroundColor: '#4C9AFF' },
            ],
        },
        options: baseOptions('req/s', { legend: true }),
    });

    const distribution = new Chart(document.getElementById('chart-distribution'), {
        type: 'bar',
        data: { labels: [], datasets: [] },
        options: baseOptions('req/s', { stacked: true, legend: true }),
    });
    distribution.options.datasets = { bar: { barPercentage: 1, categoryPercentage: 0.9, borderRadius: 0 } };

    const latency = new Chart(document.getElementById('chart-latency'), {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Mean', data: [], borderColor: '#E8EDF2', backgroundColor: '#E8EDF2', spanGaps: true },
                { label: 'Slowest in second', data: [], borderColor: '#D9A441', backgroundColor: '#D9A441', borderDash: [3, 3], spanGaps: true },
            ],
        },
        options: baseOptions('ms', { legend: true }),
    });

    const emptyThroughput = document.querySelector('[data-empty="throughput"]');
    const emptyDistribution = document.querySelector('[data-empty="distribution"]');
    const emptyLatency = document.querySelector('[data-empty="latency"]');

    function setEmpty(node, show, text) {
        node.hidden = !show;
        if (show) node.textContent = text;
    }

    function update() {
        const buckets = state.buckets.slice(-WINDOW_S);
        const nowSec = Math.floor(Date.now() / 1000);
        const labels = buckets.map(b => fmtAgo(b.t, nowSec));
        const offline = !state.socketConnected;

        throughput.data.labels = labels;
        throughput.data.datasets[0].data = buckets.map(b => b.sent);
        throughput.data.datasets[1].data = buckets.map(b => b.forwarded);

        const ports = [...new Set([...state.servers.map(s => s.port), ...buckets.flatMap(b => Object.keys(b.byPort).map(Number))])].sort((a, b) => a - b);
        distribution.data.labels = labels;
        distribution.data.datasets = ports.map(port => ({
            label: `:${port}`,
            data: buckets.map(b => b.byPort[port] || 0),
            backgroundColor: serverColor(port),
            borderWidth: 0,
        }));

        latency.data.labels = labels;
        latency.data.datasets[0].data = buckets.map(b => (b.latN ? b.latSum / b.latN : null));
        latency.data.datasets[1].data = buckets.map(b => (b.latN ? b.latMax : null));

        const anySent = buckets.some(b => b.sent || b.forwarded);
        const anyFwd = buckets.some(b => b.forwarded);
        const anyLat = buckets.some(b => b.latN);
        const offlineText = 'Telemetry disconnected. Reconnecting to Flask';
        setEmpty(emptyThroughput, offline || !anySent, offline ? offlineText : 'Awaiting traffic. Start generators on the Flash sale page.');
        setEmpty(emptyDistribution, offline || !anyFwd, offline ? offlineText : 'No requests have reached a backend in the last 2 minutes.');
        setEmpty(emptyLatency, offline || !anyLat, offline ? offlineText : 'Not measured yet. Appears once a request gets an HTTP 200.');

        throughput.update('none');
        distribution.update('none');
        latency.update('none');
    }

    on('tick', update);
    on('connection', update);
    update();
}
