# 6. Interview Cheat Sheet

Read this one last, right before the interview.

## Likely questions and short answers

**Q: What does your project do?**
A $4 ESP32 acts as a load balancer between clients and backend servers. It uses on-device Q-learning to choose the fastest backend, and it learns live from response times.

**Q: Why an ESP32 and not a Raspberry Pi?**
It's about 10x cheaper and about 7x lower power, boots in about 1 second, and has no OS to attack. That makes it good for edge sites like factories, clinics, and shops.

**Q: Why is the limit 7 clients?**
The ESP32 allows 16 sockets. One is for listening and each client needs 2 (client side plus backend side). (16−1)/2 = 7.

**Q: How do you handle 7 clients without threads?**
With a single-threaded, non-blocking loop. Each `loop()` checks every slot, copies whatever bytes are ready, and moves on. It's like an event loop, and it saves RAM.

**Q: What are the state, action, and reward?**
- State is the number of active sessions (0–7).
- Action is which backend to pick.
- Reward is `1000/(duration_ms+1)`, or −50 if it took 2 s or more (a timeout).

**Q: Why is the reward `1000/time`?**
Faster replies give a much bigger reward. The reciprocal curve makes a big gap between 40 ms and 900 ms. A timeout gets a strong negative so the agent learns to avoid it.

**Q: What are alpha, gamma, and epsilon?**
- α = 0.3 is the learning rate.
- γ = 0.5 is how much future states matter.
- ε starts at 1.0 and is multiplied by 0.95 after each update, down to a 0.05 floor. That's the explore vs exploit balance.

**Q: How big is the Q-table?**
8 states × N backends. With 3 backends that's 24 floats, about 96 bytes.

**Q: Why not use a neural network (Deep Q-Learning)?**
The state space is tiny (8 states), so a table is exact, fast, and fits easily in memory. A neural net would be overkill for a 520 KB device.

**Q: How is EMA different from Q-learning?**
EMA keeps one running score per server and always picks the best one. It ignores load and never explores randomly. Q-learning considers load (the state) and keeps 5% exploration.

**Q: Why did EMA do badly on the real hardware?**
A likely explanation: EMA only learns when a session *ends*. Meanwhile, several clients arrive at once and they all get sent to the same "best" server before any feedback comes back. It also has no random exploration, so once a server's score drops it may rarely get retried. Q-learning's state and its exploration help it avoid this.

**Q: Where does your approach fail?**
In the retail scenario. Exploration decays before the server degrades, and the servers were nearly identical, so there was nothing to learn. Raising min-ε to 0.15 helps (74.5% → 85.5%).

**Q: What's goodput and why use it?**
Goodput is the % of requests that got a real answer. Average latency hides rejected requests. Goodput counts them as failures.

**Q: Why Layer 7?**
The ESP32 inspects the payload. It looks for an `END` control string to close sessions, not just IPs and ports.

**Q: What happens if a backend is down?**
The ESP32 asks the strategy again and tries another backend. If all of them fail, it returns **502 Bad Gateway**. If all 7 slots are full, it returns **503**.

**Q: How do you know the simulation matches the hardware?**
`sim-engine.js` is a line-for-line port of the C++ with the same constants. Runs use fixed seeds, so they're reproducible. Simulated results are always labelled as simulated.

**Q: How is the ESP32 configured?**
WiFi goes through a captive portal (the WiFiManager library). The laptop IP is saved in flash (Preferences/NVS). The backend count and strategy are typed into the Serial Monitor at boot.

**Q: What's the novelty?**
On-device RL load balancing on a sub-$5 microcontroller, with no cloud, no coordinator, and no pre-training. Published RL load-balancing work assumes at least a Linux-class machine.

**Q: What would you improve?**
- Save the Q-table to flash.
- Boost exploration when rewards suddenly drop.
- Fall back to Round Robin automatically when servers look identical.

## Tech stack in one line

C++ / Arduino / PlatformIO on the ESP32 · Python (sockets, threads) for backends and clients · Flask + Socket.IO + Chart.js for the dashboard · JavaScript simulator · JSON as the single data source.

## If you get stuck

Fall back to the honest framing. Interviewers like it:

> "RL isn't magic. It wins when backends really
> differ, and round robin wins when they don't.
> We measured exactly where that line is."
