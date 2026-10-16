# 5. Results and Limitations

## A. Real hardware benchmark (measured)

Setup: 3 backends, 5 clients, 120 seconds, real ESP32.

- 8080 is healthy (0% latency)
- 8081 is **degraded** (45%, about 0.9 s)
- 8082 is healthy (5%, about 0.1 s)

| | RR | Q-L | EMA |
|-|----|-----|-----|
| Requests served | 737 | **1156** | 731 |
| Mean latency | 518 ms | **208 ms** | 515 ms |
| p95 latency | 1186 ms | **473 ms** | 1185 ms |
| Throughput | 6.1/s | **9.6/s** | 6.1/s |
| Timeouts | 0 | 6 | 3 |

**Where traffic went:**

- RR: 246 / 246 / 245, a perfect even split, including to the slow server.
- Q-L: 1113 / 21 / 24, mostly to the fastest server.
- EMA: 123 / 206 / 405. It didn't converge well here (see the cheat sheet for why).

**Takeaway:** Q-Learning had about **60% lower mean latency** and about **58% more throughput** than Round Robin.

---

## B. Simulation results

These come from the browser simulator, averaged over **8 random seeds**.

### The metric: goodput

**Goodput** is the % of requests that got a real answer. Timeouts **and** 503 rejections count as failures.

Why not just average latency? Because average latency hides failures. If a request was rejected, it never gets a latency at all, so a bad strategy can still look "fast". Goodput can't be gamed this way.

### Three real-world scenarios

| Scenario | RR | Q-L | EMA |
|----------|----|-----|-----|
| Smart factory | 86.1 | **100** | 96.3 |
| Rural clinic | 92.0 | **100** | 98.7 |
| Retail POS outage | 84.9 | 74.5 | **97.2** |

Q-learning wins 2 of 3. **It loses retail**, and we show that openly.

### Headline finding: it depends on how different the servers are

Two backends with an increasing speed gap ("spread"):

| Spread | RR | Q-L | EMA |
|--------|----|-----|-----|
| 1x–3x | 100 | 100 | 100 |
| 5x | 100 | 99.8 | 99.7 |
| 8x | 71.3 | **99.1** | 94.8 |
| 12x | 49.8 | **93.7** | 87.2 |

- **Small gap (under ~5x):** all are equal, so Round Robin is the right choice (it's free).
- **Big gap (8x+):** Round Robin collapses, while Q-learning holds above 93%.

> Our claim isn't "RL is always better". It's this: **RL earns its complexity when backends differ, and we measured the threshold.**

---

## C. Known weakness: the retail scenario

**What happens:** Q-learning gets 74.5% vs Round Robin's ~85%.

**Why (two reasons):**

1. **Exploration dies too early.** Epsilon hits its 5% floor after about 59 updates, but the server only degrades later in the scenario. By then the agent is almost fully "greedy" and slow to notice the change.
2. **The servers start almost identical** (55 ms vs 60 ms). There's no real signal to learn from, so it latches onto one server and overloads it.

**Partial fix tested:** raising the minimum epsilon from 0.05 to **0.15** lifts goodput to **85.5%**.

**Future work:**

- **Epsilon resurgence:** raise exploration again when rewards suddenly drop.
- **Auto-fallback to Round Robin** when servers look identical.
- **Save the Q-table to flash (NVS)** so a reboot doesn't erase learning.

---

## D. Honest limitations

- **7 clients max** (16-socket hardware limit). This is a real ceiling, not a tuning issue.
- **No HTTPS/TLS.** The ESP32 is too slow to do TLS while also proxying.
- **Q-table lost on reboot.**
- Built for **low-traffic, high-value** use (sensors, kiosks, POS terminals), **not** for general websites.

## E. Why use an ESP32 at all?

| | ESP32 | Raspberry Pi 4 |
|-|-------|----------------|
| Cost | ~$4 | ~$45 |
| Power | ~0.4–0.8 W | ~2.7–6.4 W |
| Boot | ~1 s | ~22 s |
| OS to hack | none | full Linux |
| Storage | flash | SD card (wears out) |

Because it's this cheap, you can deploy **3 ESP32s for redundancy** for less than a tenth of one Pi's price.
