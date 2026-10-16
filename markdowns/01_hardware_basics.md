# 1. Hardware and Arduino Basics

Read this if you're not comfortable with microcontrollers.

## What is an ESP32?

It's a tiny, cheap chip with a CPU and **built-in WiFi**.

Think of it as a very small computer, but:

- It has **no operating system** like Linux or Windows.
- It runs **one program** that you flash onto it.
- That program starts the moment it gets power.

Our board is the **ESP32-WROOM-32 DevKit V1**.

| Spec | Value |
|------|-------|
| CPU | Dual-core, 240 MHz |
| RAM | 520 KB (yes, kilobytes) |
| Flash storage | 4 MB |
| WiFi | Built in |
| Cost | ~$4 / ₹350 |
| Power | ~0.4–0.8 W |

For comparison, a Raspberry Pi 4 has 2 GB RAM, runs full Linux, costs ~$45, and draws ~3–6 W.

## How is it connected?

There's very little wiring:

- A **USB cable** from the laptop to the ESP32.
  - It powers the board.
  - It's used to upload (flash) the code.
  - It's the **Serial Monitor**, a text console where the ESP32 prints logs and we type commands.
- **WiFi** connects the ESP32 to the same network as the laptop.

No sensors and no breadboard circuits are involved. The "hardware" here is the ESP32 acting as a network device.

## What is "Arduino" here?

Arduino is a **framework**, a set of easy C++ libraries for microcontrollers. We use the Arduino framework *on* the ESP32.

Every Arduino program has two functions:

```cpp
void setup() {
  // runs ONCE when the board powers on
}

void loop() {
  // runs FOREVER, again and again
}
```

That's the whole model. There's no `main()` you write yourself. The framework calls `setup()` once, then calls `loop()` endlessly.

## Useful Arduino terms

- **`Serial.begin(115200)`** opens the USB text console. 115200 is the speed (baud rate). Both sides must match.
- **`Serial.println("hi")`** prints a line to the laptop's monitor.
- **`Serial.read()`** reads what the user typed.
- **`millis()`** gives milliseconds since boot. We use it to time requests.
- **`delay(10)`** pauses for 10 ms.
- **Watchdog timer** is a safety timer that reboots the chip if code gets stuck in a tight loop. That's why our input loops have a small `delay(10)`.

## Libraries we use

- **`WiFi.h`** connects to WiFi and opens TCP sockets.
  - `WiFiServer` listens for incoming connections (like a server).
  - `WiFiClient` is one TCP connection (like a socket).
- **`WiFiManager`** gives us a **captive portal**. If the ESP32 doesn't know any WiFi password, it creates its own hotspot called "ESP32 Web Portal". You connect with your phone and type in the WiFi name, password, and laptop IP.
- **`Preferences`** saves small values in flash (called **NVS**, non-volatile storage), so they survive a reboot. We store the laptop IP there.

## PlatformIO

We don't use the Arduino IDE. We use **PlatformIO**, a VS Code extension for embedded projects.

Config lives in `esp32/MyFirstESP32/platformio.ini`:

- `board = esp32doit-devkit-v1`: which board
- `framework = arduino`: use Arduino libraries
- `monitor_speed = 115200`: serial speed
- `lib_deps = WiFiManager`: auto-downloads that library

## Key hardware limit: 16 sockets

The ESP32's network stack (called **lwIP**) allows only **16 open sockets** at once.

- 1 socket is used to **listen** for new clients.
- Each proxied client needs **2** sockets: one to the client, one to the backend.
- (16 − 1) / 2 = **7 clients max** at the same time.

This number comes up a lot. If an 8th client arrives, it gets **HTTP 503 Service Unavailable**.
