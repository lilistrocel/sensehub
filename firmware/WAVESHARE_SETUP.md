# Waveshare ESP32-S3-Relay-6CH — SenseHub Integration Guide

## Overview

The Waveshare ESP32-S3-Relay-6CH is a 6-channel relay board with RS485 communication. To work with SenseHub via standard Modbus RTU, the factory firmware must be replaced with a custom Modbus RTU slave firmware.

### Why Custom Firmware?

The factory firmware does **NOT** use standard Modbus protocol. It uses:
- Hardcoded 8-byte command matching (not standard Modbus framing)
- `0x5500` as a "toggle" value (standard Modbus uses `0xFF00` ON / `0x0000` OFF)
- No response messages (factory firmware never replies to commands)

The custom firmware implements full standard Modbus RTU with bidirectional communication:
- **FC01** — Read Coils (read relay states)
- **FC05** — Write Single Coil (control individual relay)
- **FC0F** — Write Multiple Coils (control multiple relays at once)
- **FC03** — Read Holding Registers (device info)

---

## Hardware Specifications

| Component | Detail |
|-----------|--------|
| MCU | ESP32-S3 |
| Relays | 6 channels, active HIGH |
| RS485 | Auto-direction (no DE/RE pin needed) |
| RS485 TX | GPIO 17 |
| RS485 RX | GPIO 18 |
| Buzzer | GPIO 21 |
| RGB LED | GPIO 38 |
| Relay CH1 | GPIO 1 |
| Relay CH2 | GPIO 2 |
| Relay CH3 | GPIO 41 |
| Relay CH4 | GPIO 42 |
| Relay CH5 | GPIO 45 |
| Relay CH6 | GPIO 46 |

---

## Setup Procedure

### Step 1: Flash Custom Firmware

Connect the Waveshare to the Raspberry Pi via USB.

```bash
cd /home/noobcity/code/SenseHub/sensehub/firmware
./flash_waveshare.sh <SLAVE_ID>
```

Each device on the RS485 bus needs a **unique slave ID** (1-247).

| Device | Slave ID |
|--------|----------|
| First Waveshare | 1 |
| Second Waveshare | 2 |
| Third Waveshare | 3 |
| ... | ... |

If the upload fails, put the device in download mode:
1. Hold the **BOOT** button
2. Press **RESET** while holding BOOT
3. Release **BOOT**
4. Run the flash script again

The device will **beep twice** on startup to confirm the Modbus firmware is running.

### Step 2: Connect to RS485 Bus

1. Disconnect USB from the Waveshare
2. Wire RS485 A/B terminals:
   - Waveshare RS485-A → USR-DR134 RS485-A (or daisy chain)
   - Waveshare RS485-B → USR-DR134 RS485-B (or daisy chain)
   - GND → GND (shared ground recommended)
3. Power the Waveshare via its DC input (not USB)

### Step 3: Configure USR-DR134 Gateway

**This is critical.** The USR-DR134 must be in **Modbus TCP-to-RTU gateway mode**.

Access the gateway web UI at `http://192.168.1.7` (default credentials: admin/admin).

#### Required Settings

**Modbus Settings** (`/modbus.shtml`):
| Setting | Value | Notes |
|---------|-------|-------|
| Modbus Mode (mdm) | **1** (Modbus TCP to RTU) | **MUST be 1, NOT 0** |
| Response Timeout (mdpt) | 200 ms | Time to wait for slave response |
| Polling Interval (mdpi) | 100 ms | Minimum time between polls |

Or configure via curl:
```bash
curl -u admin:admin "http://192.168.1.7/modbus.cgi?sspe=0&mdm=1&mdpt=200&mdpi=100&mde=0"
```

Then reboot the gateway:
```bash
curl -u admin:admin "http://192.168.1.7/manage.cgi?reset=1&rup=0&rfp=0"
```

**Serial Port Settings** (must match firmware):
| Setting | Value |
|---------|-------|
| Baud Rate | 9600 |
| Data Bits | 8 |
| Stop Bits | 1 |
| Parity | None |

#### Why mdm=1 is Critical

| Mode | What Happens | Result |
|------|-------------|--------|
| mdm=0 (Close) | Gateway passes raw TCP data to RS485 | **BROKEN** — MBAP headers corrupt RTU frames |
| mdm=1 (TCP-RTU) | Gateway strips MBAP header, adds CRC16 | **CORRECT** — Valid Modbus RTU on RS485 |
| mdm=2 (Multi-host) | Multi-master mode | Works but unnecessary for SenseHub |

When `mdm=0`, the 6-byte Modbus TCP MBAP header is included in the RS485 data, which the Waveshare's ModbusRTUSlave library cannot parse. Setting `mdm=1` makes the gateway properly convert between Modbus TCP and Modbus RTU protocols.

### Step 4: Add Device in SenseHub

In the SenseHub web UI, go to **Equipment** and add a new device:

| Field | Value |
|-------|-------|
| Name | Waveshare Relay Unit 1 (or descriptive name) |
| Type | relay |
| Protocol | modbus |
| Address | 192.168.1.7:502 |
| Slave ID | (the slave ID you flashed) |
| Polling Interval | 5000 ms |

**Register Mappings** — Add 6 coil registers:

| Name | Register Address | Type | Data Type | Access |
|------|-----------------|------|-----------|--------|
| Relay 1 | 1 | coil | bool | readwrite |
| Relay 2 | 2 | coil | bool | readwrite |
| Relay 3 | 3 | coil | bool | readwrite |
| Relay 4 | 4 | coil | bool | readwrite |
| Relay 5 | 5 | coil | bool | readwrite |
| Relay 6 | 6 | coil | bool | readwrite |

You can also use the **"Waveshare ESP32-S3 6CH Relay"** device template if available.

---

## Daisy-Chaining Multiple Devices

RS485 is a multi-drop bus — multiple devices share the same two wires (A and B). Each device must have a **unique slave ID**.

### Wiring Diagram

```
USR-DR134 Gateway (192.168.1.7:502)
    │
    ├── RS485-A ──┬──────────┬──────────┬── ...
    │             │          │          │
    └── RS485-B ──┼──────────┼──────────┼── ...
                  │          │          │
            Waveshare #1  Waveshare #2  Waveshare #3
            Slave ID: 1   Slave ID: 2   Slave ID: 3
```

### How It Works

1. All devices share the same RS485 A/B wires
2. The gateway addresses each device by its unique slave ID
3. Only the device matching the slave ID in the Modbus frame responds
4. SenseHub polls each device independently using the same gateway IP but different slave IDs

### Adding a New Device to an Existing Bus

1. **Flash firmware** with the next available slave ID:
   ```bash
   ./flash_waveshare.sh 2    # Second device
   ```

2. **Wire RS485** A/B to the existing bus (parallel connection)

3. **Add in SenseHub** with the same gateway address but the new slave ID:
   - Address: `192.168.1.7:502` (same gateway)
   - Slave ID: `2` (unique per device)

### RS485 Bus Limits

| Parameter | Limit |
|-----------|-------|
| Max devices per bus | 32 (standard RS485) |
| Max cable length | 1200m (at 9600 baud) |
| Termination | 120 ohm resistor at each end for long runs |

### Polling Considerations

Each device is polled sequentially by the gateway. With the default 5-second polling interval per device and 200ms response timeout:
- 1 device: ~200ms per poll cycle
- 5 devices: ~1s per poll cycle
- 10 devices: ~2s per poll cycle

Relay control commands (FC05) are handled immediately regardless of polling.

---

## Troubleshooting

### Relays don't click when sending commands

1. **Check gateway Modbus mode**: Must be `mdm=1`
   ```bash
   curl -s -u admin:admin "http://192.168.1.7/modbus.shtml" | grep "var mdm"
   # Should show: var mdm = 1;
   ```

2. **Check RS485 wiring**: A↔A, B↔B, verify with multimeter

3. **Check baud rate match**: Gateway serial port must be 9600, 8N1

4. **Check slave ID**: Verify the device was flashed with the correct ID and SenseHub equipment is configured with the same ID

5. **Check gateway serial TX counter**:
   ```bash
   curl -s -u admin:admin "http://192.168.1.7/status.shtml" | grep tx_rx
   ```
   If TX bytes increase but RX stays at 0, the device isn't responding (check wiring or firmware).

### Device shows "offline" in SenseHub

- Verify the Waveshare is powered and connected to RS485
- Check that the gateway is reachable: `ping 192.168.1.7`
- Restart the SenseHub backend: `docker restart sensehub-backend`

### Firmware verification

After flashing, the device should beep twice. If no beep:
- The flash may have failed — retry with the device in download mode
- Check USB connection

To verify over Modbus, read holding register 2 (slave address):
```bash
# From SenseHub API (replace token):
curl -X POST http://localhost:3003/api/modbus/read/holding-registers \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"host":"192.168.1.7","port":502,"unitId":1,"address":0,"quantity":4}'
```
Response should include: firmware version (1), channels (6), slave ID, 0.

---

## Firmware Source

The firmware source is at:
```
sensehub/firmware/waveshare_modbus_slave/waveshare_modbus_slave.ino
```

### Modbus Register Map

**Coils (FC01/FC05/FC0F):**
| Address | Function |
|---------|----------|
| 1 | Relay Channel 1 |
| 2 | Relay Channel 2 |
| 3 | Relay Channel 3 |
| 4 | Relay Channel 4 |
| 5 | Relay Channel 5 |
| 6 | Relay Channel 6 |

**Holding Registers (FC03):**
| Address | Function | Default |
|---------|----------|---------|
| 0 | Firmware version | 1 |
| 1 | Number of channels | 6 |
| 2 | Slave address | (configured) |
| 3 | Reserved | 0 |

### Dependencies

- Arduino ESP32 board support (`esp32:esp32` v3.x)
- ModbusRTUSlave library (v3.1.2+)
