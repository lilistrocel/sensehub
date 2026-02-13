/*
 * Waveshare ESP32-S3-Relay-6CH — Modbus RTU Slave Firmware
 *
 * Implements a full Modbus RTU slave on RS485 for SenseHub integration.
 * Slave address: 6 (matches 6-channel convention)
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
 */

#include <ModbusRTUSlave.h>

// --- Pin definitions ---
#define RS485_TX     17
#define RS485_RX     18
#define BUZZER_PIN   21

// Relay GPIO pins (active HIGH), indexed 0-5
const uint8_t RELAY_PINS[] = {1, 2, 41, 42, 45, 46};
const uint8_t NUM_RELAYS = 6;

// --- Modbus config ---
#define SLAVE_ADDR   6
#define BAUD_RATE    9600

// Coil array: index 0 is unused (dummy), indices 1-6 map to CH1-CH6
// This matches the Waveshare addressing convention (CH1 = coil address 1)
#define NUM_COILS    8
bool coils[NUM_COILS] = {false};

// Holding registers for device info
// Reg 0: firmware version (1)
// Reg 1: number of channels (6)
// Reg 2: slave address (6)
#define NUM_HOLDING_REGS 4
uint16_t holdingRegisters[NUM_HOLDING_REGS] = {1, 6, SLAVE_ADDR, 0};

// RS485 serial — ModbusRTUSlave wraps the Stream
ModbusRTUSlave modbus(Serial1);

void setup() {
  // Init relay pins as outputs, all OFF
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
  for (int i = 0; i < 2; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(80);
    digitalWrite(BUZZER_PIN, LOW);
    delay(80);
  }
}

void loop() {
  // Process incoming Modbus requests and update coil array
  modbus.poll();

  // Sync coil states to relay GPIOs
  // coils[1] → RELAY_PINS[0] (CH1), coils[2] → RELAY_PINS[1] (CH2), etc.
  for (uint8_t i = 0; i < NUM_RELAYS; i++) {
    digitalWrite(RELAY_PINS[i], coils[i + 1] ? HIGH : LOW);
  }
}
