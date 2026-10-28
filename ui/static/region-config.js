// region-config.js
//
// The seven simulated regions. Each one is a label for one mock client
// generator running on this laptop - the coordinates only place a marker on
// the map. No request actually originates from these places.

export const REGIONS = [
    { id: 'na', name: 'North America', city: 'New York', lon: -74.0, lat: 40.7, color: '#7FB2E5' },
    { id: 'sa', name: 'South America', city: 'São Paulo', lon: -46.6, lat: -23.5, color: '#8FD0C2' },
    { id: 'eu', name: 'Europe', city: 'Frankfurt', lon: 8.7, lat: 50.1, color: '#B7A3E8' },
    { id: 'af', name: 'Africa', city: 'Lagos', lon: 3.4, lat: 6.5, color: '#E4C77B' },
    { id: 'me', name: 'Middle East', city: 'Dubai', lon: 55.3, lat: 25.2, color: '#EFA27A' },
    { id: 'sas', name: 'South Asia', city: 'Mumbai', lon: 72.9, lat: 19.1, color: '#E79BC4' },
    { id: 'ap', name: 'Asia-Pacific', city: 'Singapore', lon: 103.8, lat: 1.35, color: '#A9C8F0' },
];

export const REGION_BY_ID = Object.fromEntries(REGIONS.map(r => [r.id, r]));

// Generators whose region is not known (created elsewhere, or before this
// page existed) are shown under this pseudo-region rather than guessed.
export const UNASSIGNED = { id: 'unassigned', name: 'Unassigned', city: 'No region set', color: '#8B98A8' };

export function regionInfo(id) {
    return REGION_BY_ID[id] || UNASSIGNED;
}

// The firmware forwards to these ports (main.cpp: backend_ports[]).
export const FIRMWARE_BACKEND_PORTS = [8080, 8081, 8082, 8083, 8084];
export const ESP32_MAX_SESSIONS = 7;           // main.cpp: MAX_CLIENTS
export const CLIENT_TIMEOUT_S = 2.0;            // server.py: max_timeout

export const SERVER_COLORS = ['#4C9AFF', '#4FC1B5', '#D6A658', '#9C8CF0', '#C47FB0'];

export function serverColor(port) {
    const i = FIRMWARE_BACKEND_PORTS.indexOf(Number(port));
    return SERVER_COLORS[(i >= 0 ? i : Number(port)) % SERVER_COLORS.length];
}

export const STRATEGY_NAMES = {
    round_robin: 'Round Robin',
    q_learning: 'Q-Learning',
    ema: 'EMA Response Time',
};
