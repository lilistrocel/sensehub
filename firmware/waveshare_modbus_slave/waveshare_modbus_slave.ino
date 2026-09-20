/*
 * Waveshare ESP32-S3-Relay-6CH — Modbus RTU Slave Firmware (v2, fail-safe)
 *
 * Implements a full Modbus RTU slave on RS485 for SenseHub integration.
 * Slave address: 6 (patched per-board by flash_waveshare.sh)
 * Baud rate: 9600, 8N1
 *
 * Supported function codes:
 *   FC01 - Read Coils (relay states)
 *   FC05 - Write Single Coil (ON=0xFF00, OFF=0x0000)
 *   FC0F - Write Multiple Coils
 *   FC03 - Read Holding Registers (device info)
 *
 * Coil addressing (matches factory firmware):
 *   Address 0x0001 → CH1 (GPIO 1)
 *   Address 0x0002 → CH2 (GPIO 2)
 *   Address 0x0003 → CH3 (GPIO 41)
 *   Address 0x0004 → CH4 (GPIO 42)
 *   Address 0x0005 → CH5 (GPIO 45)
 *   Address 0x0006 → CH6 (GPIO 46)
 *
 * Hardware: Waveshare ESP32-S3-Relay-6CH
 * RS485: TX=GPIO17, RX=GPIO18 (auto direction control)
 *
 * ── v2 changes vs v1 ────────────────────────────────────────────────
 *   1. COMMS-LOSS FAIL-SAFE: if no valid Modbus request addressed to this
 *      slave is seen for COMMS_TIMEOUT_MS, every relay is forced OFF and
 *      latched off until communication returns. Protects against a dead
 *      bus / gateway / host leaving pumps or chillers stuck ON — the exact
 *      failure the server-side watchdog cannot fix, because it can no
 *      longer reach the board.
 *   2. HARDWARE TASK WATCHDOG: auto-reboot if loop() ever hangs. Relays
 *      power up OFF, so a reboot fails safe.
 *   3. Firmware-version register (holding 0) bumped 1 → 2 so SenseHub can
 *      tell a fail-safe board from a v1 board over Modbus.
 *
 *   Requires Arduino-ESP32 core 3.x (esp_task_wdt config-struct API) and
 *   ModbusRTUSlave v3.1.2+ (poll() returns bytes-sent).
 *
 *   SAFE STATE = all relays OFF. Every load on these boards (pumps,
 *   chillers, fans, dosing) is safe de-energized. If a channel ever needs
 *   a different safe state, change allRelaysOff() — that is the single
 *   place the fail-safe decides what "safe" means.
 */

#include <ModbusRTUSlave.h>
#include "esp_task_wdt.h"

// --- Pin definitions ---
#define RS485_TX     17
#define RS485_RX     18
#define BUZZER_PIN   21

// Relay GPIO pins (active HIGH), indexed 0-5
const uint8_t RELAY_PINS[] = {1, 2, 41, 42, 45, 46};
const uint8_t NUM_RELAYS = 6;

// --- Modbus config ---
#define SLAVE_ADDR   6      // patched per-board by flash_waveshare.sh — keep this line format
#define BAUD_RATE    9600

// --- Fail-safe config ---
// No valid Modbus request addressed to this slave for this long → force all
// relays OFF. SenseHub polls each board (FC01) every 15 s, so any live bus
// keeps refreshing this window; only real comms loss lets it expire.
// 60 s ≈ 4 missed 15 s polls before tripping (tolerates retries/hiccups).
#define COMMS_TIMEOUT_MS   60000UL
// Hardware watchdog: reboot if loop() stops feeding it (a genuine firmware hang).
#define WDT_TIMEOUT_MS     8000

// Coil array: index 0 is unused (dummy), indices 1-6 map to CH1-CH6
// This matches the Waveshare addressing convention (CH1 = coil address 1)
#define NUM_COILS    8
bool coils[NUM_COILS] = {false};

// Holding registers for device info
// Reg 0: firmware version (2 = fail-safe build)
// Reg 1: number of channels (6)
// Reg 2: slave address
// Reg 3: reserved
#define NUM_HOLDING_REGS 4
uint16_t holdingRegisters[NUM_HOLDING_REGS] = {2, 6, SLAVE_ADDR, 0};

// RS485 serial — ModbusRTUSlave wraps the Stream
ModbusRTUSlave modbus(Serial1);

// Fail-safe state
uint32_t lastCommsMs = 0;      // millis() of the last request answered for us
bool failsafeActive = false;   // latched true while comms are lost

// Force every relay coil to the safe state (OFF).
static void allRelaysOff() {
  for (uint8_t i = 1; i <= NUM_RELAYS; i++) {
    coils[i] = false;
  }
}

// Blocking buzzer helper (used only at boot and on fail-safe edges).
static void beep(uint16_t onMs, uint8_t times) {
  for (uint8_t i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(onMs);
    digitalWrite(BUZZER_PIN, LOW);
    if (i + 1 < times) delay(onMs);
  }
}

void setup() {
  // Init relay pins as outputs, all OFF (de-energized = safe default)
  for (uint8_t i = 0; i < NUM_RELAYS; i++) {
    pinMode(RELAY_PINS[i], OUTPUT);
    digitalWrite(RELAY_PINS[i], LOW);
  }

  // Buzzer pin
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Init RS485 UART on correct pins
  Serial1.begin(BAUD_RATE, SERIAL_8N1, RS485_RX, RS485_TX);

  // Configure Modbus data tables
  modbus.configureCoils(coils, NUM_COILS);
  modbus.configureHoldingRegisters(holdingRegisters, NUM_HOLDING_REGS);

  // Start Modbus slave
  modbus.begin(SLAVE_ADDR, BAUD_RATE, SERIAL_8N1);

  // Startup beep — two short beeps to indicate Modbus firmware
  beep(80, 2);

  // Hardware Task Watchdog. On Arduino-ESP32 core 3.x the TWDT may already be
  // initialized by the core, so esp_task_wdt_init() can return
  // ESP_ERR_INVALID_STATE — in that case reconfigure the existing instance.
  esp_task_wdt_config_t twdt = {
    .timeout_ms = WDT_TIMEOUT_MS,
    .idle_core_mask = 0,        // don't watch the idle tasks
    .trigger_panic = true,      // panic → reboot on hang (relays boot OFF = safe)
  };
  if (esp_task_wdt_init(&twdt) == ESP_ERR_INVALID_STATE) {
    esp_task_wdt_reconfigure(&twdt);
  }
  esp_task_wdt_add(NULL);       // subscribe this (loop) task
  esp_task_wdt_reset();

  // Give the board a full timeout window after boot before the fail-safe can
  // trip. Relays are already OFF here, so this is belt-and-suspenders.
  lastCommsMs = millis();
}

void loop() {
  // Feed the hardware watchdog every iteration.
  esp_task_wdt_reset();

  // Process incoming Modbus requests and update the coil array.
  // poll() returns the number of response bytes sent; >0 means a valid request
  // addressed to THIS slave was answered — use that as the comms heartbeat.
  if (modbus.poll() > 0) {
    lastCommsMs = millis();
    if (failsafeActive) {
      failsafeActive = false;   // communication restored
    }
  }

  // Comms-loss fail-safe. Unsigned subtraction is millis()-rollover safe.
  if ((uint32_t)(millis() - lastCommsMs) > COMMS_TIMEOUT_MS) {
    if (!failsafeActive) {
      failsafeActive = true;    // rising edge
      allRelaysOff();
      beep(200, 1);             // one long beep = entered fail-safe (comms lost)
      esp_task_wdt_reset();     // beep() blocks ~200 ms; keep the WDT happy
    } else {
      allRelaysOff();           // stay latched OFF until comms return
    }
  }

  // Sync coil states to relay GPIOs
  // coils[1] → RELAY_PINS[0] (CH1), coils[2] → RELAY_PINS[1] (CH2), etc.
  for (uint8_t i = 0; i < NUM_RELAYS; i++) {
    digitalWrite(RELAY_PINS[i], coils[i + 1] ? HIGH : LOW);
  }
}
