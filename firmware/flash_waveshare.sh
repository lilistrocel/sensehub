#!/bin/bash
#
# Flash Modbus RTU Slave Firmware to Waveshare ESP32-S3-Relay-6CH
#
# Usage:
#   ./flash_waveshare.sh <SLAVE_ID> [USB_PORT]
#
# Examples:
#   ./flash_waveshare.sh 1              # Flash with slave ID 1, auto-detect port
#   ./flash_waveshare.sh 2 /dev/ttyACM0 # Flash with slave ID 2 on specific port
#
# Prerequisites:
#   - arduino-cli installed with ESP32 board support
#   - ModbusRTUSlave library (v3.1.2+) installed
#   - USB cable connected to Waveshare ESP32-S3-Relay-6CH
#
# The device must be in download mode:
#   Hold BOOT button → Press RESET → Release BOOT
#   (Some boards enter download mode automatically)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FIRMWARE_DIR="$SCRIPT_DIR/waveshare_modbus_slave"
FIRMWARE_FILE="$FIRMWARE_DIR/waveshare_modbus_slave.ino"
BOARD_FQBN="esp32:esp32:esp32s3"
BAUD_RATE=921600

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_banner() {
    echo -e "${CYAN}"
    echo "============================================"
    echo "  Waveshare ESP32-S3-Relay-6CH Flasher"
    echo "  SenseHub Modbus RTU Slave Firmware"
    echo "============================================"
    echo -e "${NC}"
}

# Validate arguments
if [ -z "$1" ]; then
    print_banner
    echo -e "${RED}Error: Slave ID is required${NC}"
    echo ""
    echo "Usage: $0 <SLAVE_ID> [USB_PORT]"
    echo ""
    echo "  SLAVE_ID  Modbus slave address (1-247)"
    echo "            Each device on the RS485 bus must have a unique ID."
    echo "            Recommended: start at 1 and increment for each device."
    echo ""
    echo "  USB_PORT  (Optional) Serial port, e.g. /dev/ttyACM0"
    echo "            Auto-detected if not specified."
    echo ""
    echo "Examples:"
    echo "  $0 1              # First device, slave ID 1"
    echo "  $0 2              # Second device, slave ID 2"
    echo "  $0 3 /dev/ttyACM1 # Third device on specific port"
    exit 1
fi

SLAVE_ID="$1"
USB_PORT="$2"

# Validate slave ID range
if [ "$SLAVE_ID" -lt 1 ] || [ "$SLAVE_ID" -gt 247 ] 2>/dev/null; then
    echo -e "${RED}Error: Slave ID must be between 1 and 247${NC}"
    exit 1
fi

print_banner
echo -e "Slave ID:  ${GREEN}${SLAVE_ID}${NC}"

# Auto-detect USB port if not specified
if [ -z "$USB_PORT" ]; then
    echo -e "${YELLOW}Auto-detecting USB port...${NC}"
    # Look for common ESP32-S3 USB serial devices
    for port in /dev/ttyACM* /dev/ttyUSB*; do
        if [ -e "$port" ]; then
            USB_PORT="$port"
            break
        fi
    done
    if [ -z "$USB_PORT" ]; then
        echo -e "${RED}Error: No USB serial device found.${NC}"
        echo "Connect the Waveshare via USB and try again."
        echo "You can also specify the port manually: $0 $SLAVE_ID /dev/ttyACM0"
        exit 1
    fi
fi

echo -e "USB Port:  ${GREEN}${USB_PORT}${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v arduino-cli &>/dev/null; then
    echo -e "${RED}Error: arduino-cli not found. Install it first:${NC}"
    echo "  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh"
    exit 1
fi

# Check ESP32 board support
if ! arduino-cli board listall 2>/dev/null | grep -q "esp32s3"; then
    echo -e "${RED}Error: ESP32 board support not installed. Run:${NC}"
    echo "  arduino-cli core install esp32:esp32"
    exit 1
fi

# Check ModbusRTUSlave library
if ! arduino-cli lib list 2>/dev/null | grep -q "ModbusRTUSlave"; then
    echo -e "${YELLOW}Installing ModbusRTUSlave library...${NC}"
    arduino-cli lib install ModbusRTUSlave
fi

echo -e "${GREEN}Prerequisites OK${NC}"
echo ""

# Create a temporary copy of the firmware with the specified slave ID
TEMP_DIR=$(mktemp -d)
TEMP_FIRMWARE_DIR="$TEMP_DIR/waveshare_modbus_slave"
mkdir -p "$TEMP_FIRMWARE_DIR"
cp "$FIRMWARE_FILE" "$TEMP_FIRMWARE_DIR/"

# Patch the slave ID in the temporary copy
sed -i "s/#define SLAVE_ADDR.*/#define SLAVE_ADDR   ${SLAVE_ID}/" "$TEMP_FIRMWARE_DIR/waveshare_modbus_slave.ino"

# Verify the patch
PATCHED_ID=$(grep "#define SLAVE_ADDR" "$TEMP_FIRMWARE_DIR/waveshare_modbus_slave.ino" | awk '{print $3}')
if [ "$PATCHED_ID" != "$SLAVE_ID" ]; then
    echo -e "${RED}Error: Failed to patch slave ID${NC}"
    rm -rf "$TEMP_DIR"
    exit 1
fi

echo -e "${CYAN}Compiling firmware (slave ID = ${SLAVE_ID})...${NC}"
arduino-cli compile \
    --fqbn "$BOARD_FQBN" \
    --build-property "build.extra_flags=-DARDUINO_USB_MODE=1 -DARDUINO_USB_CDC_ON_BOOT=1" \
    "$TEMP_FIRMWARE_DIR/waveshare_modbus_slave.ino"

echo ""
echo -e "${CYAN}Uploading firmware to ${USB_PORT}...${NC}"
echo -e "${YELLOW}If upload fails, put the device in download mode:${NC}"
echo -e "${YELLOW}  Hold BOOT → Press RESET → Release BOOT${NC}"
echo ""

arduino-cli upload \
    --fqbn "$BOARD_FQBN" \
    --port "$USB_PORT" \
    --input-dir "$TEMP_FIRMWARE_DIR/build/esp32.esp32.esp32s3" 2>&1 || {
    # Retry with esptool directly if arduino-cli upload fails
    echo ""
    echo -e "${YELLOW}Retrying with esptool...${NC}"
    BUILD_DIR="$TEMP_FIRMWARE_DIR/build/esp32.esp32.esp32s3"
    if [ -f "$BUILD_DIR/waveshare_modbus_slave.ino.bin" ]; then
        esptool.py --chip esp32s3 --port "$USB_PORT" --baud "$BAUD_RATE" \
            --before default_reset --after hard_reset \
            write_flash -z \
            --flash_mode dio --flash_freq 80m --flash_size detect \
            0x0 "$BUILD_DIR/waveshare_modbus_slave.ino.bootloader.bin" \
            0x8000 "$BUILD_DIR/waveshare_modbus_slave.ino.partitions.bin" \
            0xe000 "$HOME/.arduino15/packages/esp32/hardware/esp32/"*/tools/partitions/boot_app0.bin \
            0x10000 "$BUILD_DIR/waveshare_modbus_slave.ino.bin"
    else
        echo -e "${RED}Error: Compiled binary not found${NC}"
        rm -rf "$TEMP_DIR"
        exit 1
    fi
}

# Cleanup
rm -rf "$TEMP_DIR"

echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  Firmware flashed successfully!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  Device:    Waveshare ESP32-S3-Relay-6CH"
echo -e "  Slave ID:  ${GREEN}${SLAVE_ID}${NC}"
echo -e "  Baud:      9600, 8N1"
echo -e "  Protocol:  Modbus RTU"
echo ""
echo -e "  Coil Addresses: 1-6 (one per relay channel)"
echo -e "  Holding Regs:   0-3 (firmware ver, channels, slave ID)"
echo ""
echo -e "${CYAN}Next steps:${NC}"
echo "  1. Disconnect USB and connect to RS485 bus"
echo "  2. Add device in SenseHub Equipment page:"
echo "     - Protocol: Modbus"
echo "     - Address: <gateway_ip>:502 (e.g. 192.168.1.7:502)"
echo "     - Slave ID: ${SLAVE_ID}"
echo "     - Register mappings: 6 coils at addresses 1-6"
echo ""
echo "  The device will beep twice on startup to confirm"
echo "  the Modbus firmware is running."
