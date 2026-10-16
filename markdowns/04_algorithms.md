# 4. The Three Algorithms

All three live in one firmware. The strategy is picked at boot.

---

## 1. Round Robin (the baseline)

```cpp
selected = current_idx;
current_idx = (current_idx + 1) % num_backends;
```

- It takes turns: 0, 1, 2, 0, 1, 2...
- It **ignores** how fast servers are and has no memory.
- **Good when** all servers are the same, since it's free and fair.
- **Bad when** one server is slow, because it still gets 1/3 of the traffic.

---

## 2. EMA Response Time

EMA stands for **Exponential Moving Average**: a running average where recent values count more.

Each backend has a score. After each request:

```
score = 0.3 × new_reward + 0.7 × old_score
```

- `alpha = 0.3` means each new result counts for 30% and history counts for 70%.
- It **always picks the backend with the highest score**.
- **Optimistic start:** every score starts at **1000**, which is much higher than any real reward. Once a backend gets tried, its score drops, so the untried ones look better. This forces it to **try every server once** before settling.

**Weakness:** it has no idea how busy the system is. It also has no random exploration. In ML terms it's a simple **multi-armed bandit**.

---

## 3. Q-Learning (the star)

Reinforcement learning means an **agent** takes **actions** in a **state**, gets a **reward**, and learns which action is best in each state.

### Our setup

| RL term | Our meaning |
|---------|-------------|
| **State** | Number of active sessions (0–7) |
| **Action** | Which backend to pick |
| **Reward** | `1000/(ms+1)`, or −50 on timeout |

### The Q-table

A small 2D array: **8 states × N backends**.

```
         8080   8081   8082
state 0  12.1    1.0    8.3
state 1  10.4    0.7    7.9
...
state 7   ...
```

Each cell means: "how good is picking this backend when this many sessions are active?" It starts at all zeros. With 3 backends that's only 24 floats, about 96 bytes, so it fits easily.

### Choosing a backend: epsilon-greedy

```cpp
if (random < epsilon)
    return random backend;      // EXPLORE
else
    return best in q_table[state]; // EXPLOIT
```

- **Explore** means trying something random, in case it's better.
- **Exploit** means using what we already know is best.
- `epsilon` starts at **1.0** (100% random).
- After each update: `epsilon × 0.95`.
- It never goes below **0.05** (5% random forever).
- It reaches the floor after about **59 requests**.

### Learning: the Bellman equation

After each session ends:

```
Q[s][a] = Q[s][a] + α × (reward + γ × maxQ[s'] − Q[s][a])
```

In plain words: **new estimate = old estimate + a step towards (what I got now + a bit of what I expect next)**.

| Symbol | Value | Meaning |
|--------|-------|---------|
| α (alpha) | 0.3 | Learning rate: how fast to update |
| γ (gamma) | 0.5 | How much the future matters |
| s | | State when the session ended |
| s' | s − 1 | State after it ends (one fewer session) |

### Why Q-learning over EMA?

- **It's state-aware.** It can learn that the best server at 1 active session differs from the best at 6, when the fast server is overloaded.
- **It keeps exploring** (5%), so it can notice when things change.
- EMA has neither of these.

### Online learning

- There's **no pre-training** and no dataset.
- It learns **live**, from real traffic.
- It's useful from the first request and gets better as it goes.

---

## Quick comparison

| | RR | EMA | Q-L |
|-|----|-----|-----|
| Uses speed info | ✗ | ✓ | ✓ |
| Uses load (state) | ✗ | ✗ | ✓ |
| Random exploration | ✗ | ✗ | ✓ |
| Memory | none | N floats | 8×N floats |
| Best for | equal servers | stable servers | servers that differ |
