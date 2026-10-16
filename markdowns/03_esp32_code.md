# 3. ESP32 Code Walkthrough

Main file: `esp32/MyFirstESP32/src/main.cpp` (~280 lines)

Algorithms: `esp32/MyFirstESP32/lib/LoadBalancerAlgorithms/src/`

## Key global variables

```cpp
int backend_ports[5] = {8080, ..., 8084};
const int listen_port = 80;
uint8_t buffer[1024];      // bytes being copied
WiFiServer publicServer(80);
const int MAX_CLIENTS = 7;
```

### The session struct

```cpp
struct ProxySession {
    WiFiClient client;    // socket to the client
    WiFiClient backend;   // socket to the backend
    int backend_idx;      // which backend we chose
    unsigned long start_time;
    bool active;
};
ProxySession sessions[7];
```

That gives **7 fixed slots**. There's no dynamic list, which keeps memory predictable on a tiny chip.

---

## `setup()`: runs once at boot

1. **Start Serial** at 115200.
2. **Load the saved laptop IP** from flash (`Preferences`).
3. **Connect to WiFi** with `WiFiManager.autoConnect()`.
   - If it has saved credentials, it connects.
   - If not, it opens the "ESP32 Web Portal" hotspot for setup.
4. **Start listening** on port 80.
5. **Ask the user over Serial**:
   - Laptop IP? (press Enter to keep the old one)
   - How many backends? (1–5)
   - Which strategy? 1 = Round Robin, 2 = Q-Learning, 3 = EMA
6. **Create the strategy object**:

```cpp
if (choice == 1) lb_strategy = new RoundRobin(n);
else if (choice == 2) lb_strategy = new QLearning(n, 7);
else lb_strategy = new EmaResponseTime(n);
```

---

## `loop()`: runs forever

It has two parts.

### Part 1: accept new clients

```cpp
WiFiClient newClient = publicServer.available();
if (newClient) {
  // find a free slot
  // state = number of active sessions
  // ask strategy for backend
  // try to connect; on fail, ask again
}
```

- **No free slot?** It sends `503 Service Unavailable`.
- **All backends down?** It sends `502 Bad Gateway`.

### Part 2: move data for every slot

```cpp
for each active session:
  if both sides still connected:
     talk(client, backend);  // client → backend
     talk(backend, client);  // backend → client
  else:
     // session is over → compute reward
```

### When a session ends

```cpp
duration = millis() - start_time;
if (duration >= 2000) reward = -50;  // timeout
else reward = 1000.0 / (duration + 1);
lb_strategy->provideFeedback(backend_idx,
                             state, next_state,
                             reward);
```

- A fast reply gives a big reward. 50 ms gives about 20.
- A slow reply gives a small reward. 900 ms gives about 1.1.
- A timeout (2 s, which is the client's timeout) gives **−50**, a heavy punishment.

---

## `talk(c1, c2)`: the byte copier

```cpp
int len = c1.available();     // bytes waiting?
if (len > 0) {
  c1.read(buffer, len);       // read up to 1 KB
  c2.write(buffer, len);      // forward it
  // scan for "END" → close session
}
```

It never waits. If nothing has arrived, it returns right away.

## Important design point: single-threaded, non-blocking

- There are **no threads** and no `async`.
- One `loop()` quickly visits all 7 slots, over and over.
- Each visit copies whatever bytes are ready and moves on.
- This is like a hand-written **event loop** (similar to how `select()` or Node.js works).
- **Why:** threads cost RAM, and the chip has 520 KB.

---

## The strategy interface (OOP)

`LoadBalancerStrategy.h` is an **abstract base class**:

```cpp
class LoadBalancerStrategy {
  virtual int getNextBackend(int state) = 0;
  virtual void provideFeedback(int backend,
        int state, int next_state, float reward) {}
};
```

All three algorithms **inherit** from it. `main.cpp` only calls these two functions, so it doesn't care which algorithm is running. This is the **Strategy design pattern**. Adding a new algorithm means writing a new class and changing nothing else.

## Persisted vs not persisted

- **Saved in flash:** WiFi credentials, laptop IP.
- **Lost on reboot:** the Q-table / EMA values. It relearns in a few dozen requests. (Saving it is listed as future work.)
