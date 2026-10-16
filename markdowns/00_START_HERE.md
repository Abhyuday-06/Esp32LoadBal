# Start Here

Total reading time: about 15 minutes.

## Reading order

| # | File | Time |
|---|------|------|
| 1 | `01_hardware_basics.md` | 3 min |
| 2 | `02_architecture.md` | 3 min |
| 3 | `03_esp32_code.md` | 3 min |
| 4 | `04_algorithms.md` | 3 min |
| 5 | `05_results_and_limits.md` | 2 min |
| 6 | `06_interview_cheatsheet.md` | 1 min (read again right before) |

Short on time? Read this page, then file 6.

---

## The project in one paragraph

We turned an **ESP32** (a $4 WiFi microcontroller) into a **load balancer**.

Clients send requests to the ESP32. The ESP32 picks one of several backend servers and forwards the request there. Then it passes the reply back to the client.

The interesting part is **how it picks**. We have three strategies:

1. **Round Robin**: take turns, A → B → C → A...
2. **EMA**: send to whichever server has been fastest lately.
3. **Q-Learning**: a small reinforcement learning agent that learns which server to pick, while it runs.

All of the learning happens **on the ESP32 itself**. There's no cloud, no pre-training, and no laptop doing the thinking.

## The 30-second pitch (say this out loud)

> "We built a Layer-7 reverse proxy on a $4 ESP32 that uses
> on-device Q-learning to route requests to backend servers.
> It learns from real response times as traffic flows.
> On real hardware, with one slow backend, Q-learning cut mean
> latency from about 518 ms to 208 ms and raised throughput
> by about 58% compared to round robin.
> We also found where it *doesn't* win. When backends are
> nearly identical, round robin is the right choice, and
> we documented that honestly."

## The 5 numbers to remember

- **$4**: cost of an ESP32
- **520 KB**: RAM on the ESP32
- **7**: max simultaneous clients (because of the 16-socket limit)
- **518 ms → 208 ms**: mean latency, Round Robin vs Q-Learning (real hardware)
- **6.1 → 9.6 req/s**: throughput, Round Robin vs Q-Learning (real hardware)
