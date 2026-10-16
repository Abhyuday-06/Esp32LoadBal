# 2. Architecture

## The big picture

```
 Clients          ESP32            Backends
(laptop)      (load balancer)      (laptop)

 client ─┐                     ┌─► :8080
 client ─┼──► port 80 ─► pick ─┼─► :8081
 client ─┘                     └─► :8082
```

Everything except the ESP32 runs on the **laptop**. The backends are just Python servers on different ports (8080–8084).

## What is a "reverse proxy"?

The ESP32 sits **in the middle**:

- To the **client**, the ESP32 looks like the server.
- To the **server**, the ESP32 looks like a client.

The client never talks to the backend directly. The ESP32 copies bytes both ways.

## Why "Layer 7"?

Network layers, simply put:

- **Layer 4** (TCP) only looks at IPs and ports.
- **Layer 7** (application) looks at the actual **content**.

Our ESP32 reads the bytes it forwards. It scans them for an `END` control string and closes the session when it sees it. Looking inside the payload is what makes it Layer 7.

## Life of one request

1. A client opens a TCP connection to the ESP32 on port 80.
2. The ESP32 finds a free **session slot** (there are 7).
3. It asks the **strategy**: "which backend?"
4. It connects to that backend. If the connection fails, it asks again and tries the next pick.
5. It copies bytes client → backend and backend → client.
6. The client gets its reply and disconnects.
7. The ESP32 measures **how long the session took**.
8. It converts that time into a **reward** and gives it to the strategy, so the strategy can learn.
9. The slot is freed.

## The repository layout

```
esp32/            ESP32 firmware (C++)
server-client/    Python backend server + mock client
ui/               Flask web dashboard
benchmarks/       Scripts that measure real performance
data/             project_data.json (all numbers)
presentation/     Script that builds the PPT
```

## The Python side (laptop)

### `server-client/server.py`: fake backends

- `ManagedServer` is a **threaded TCP server**.
- Each one listens on a port (8080, 8081...).
- It replies `HTTP/1.1 200 OK ... Hello from Server on port X`.
- It has a **latency** setting, as a percentage. It sleeps for `latency% × 2 seconds` before replying.
  - 0% means instant.
  - 45% means 0.9 s, which is a "degraded" server.
- This lets us make one server slow on purpose and see if the ESP32 notices.

### `server-client/client.py`: fake clients

- `MockClient` connects to the ESP32 and sends one `GET /ping/...` request.
- It waits up to **2 seconds** for a reply (its timeout).
- It records the response time, then closes.

### `ui/app.py`: the dashboard (Flask)

- A web page at `localhost:5000`.
- Buttons to **start/stop backends**, change their latency, and **spawn clients**.
- Uses **Socket.IO** (WebSockets) to push live events to the browser, which draws charts with Chart.js.
- Caps clients at 7 to match the ESP32 limit.
- `/scenarios` page: runs **simulations** in the browser (see below).

### `ui/static/sim-engine.js`: the simulator

- A **line-for-line JavaScript copy** of the ESP32 algorithms, with the same constants.
- It lets us test many scenarios quickly without hardware.
- It uses fixed random **seeds**, so the results are reproducible.

### `benchmarks/run_benchmark.py`: real hardware test

- Starts 3 backends with a fixed latency profile:
  - 8080 at 0% (healthy)
  - 8081 at 45% (degraded)
  - 8082 at 5% (healthy)
- Sends traffic from 5 clients for 120 seconds through the **real ESP32**.
- Writes results to `data/project_data.json`.
- It's run once per strategy, rebooting the ESP32 between runs.

### `data/project_data.json`: single source of truth

- Every number in the slides and UI comes from here.
- Each value is tagged `measured`, `cited`, `modelled`, or `pending_measurement`. That way we never present a guess as a fact.

## Side note: `hubb/messager.cpp`

This is an **early test sketch**, a simple ping server with an LED. It's not part of the final build. It's where we started.
