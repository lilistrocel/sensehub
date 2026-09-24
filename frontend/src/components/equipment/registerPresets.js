// Modbus register-mapping presets and mapping helpers shared by the add/edit
// equipment forms (RegisterMappingEditor) and the detail/relay views.
//
// Waveshare relay modules use:
// - Coil addresses 0x0000-0x001F for relay control
// - Holding register 0x2000 (8192) for baud rate configuration
// - Holding register 0x4000 (16384) for device address configuration

const generateRelayMappings = (channelCount) => {
  const mappings = [];
  for (let i = 0; i < channelCount; i++) {
    mappings.push({
      name: `Relay ${i + 1}`,
      register: String(i),
      type: 'coil',
      dataType: 'bool',
      access: 'readwrite'
    });
  }
  mappings.push({
    name: 'Baud Rate Config',
    register: '8192', // 0x2000
    type: 'holding',
    dataType: 'uint16',
    access: 'readwrite'
  });
  mappings.push({
    name: 'Device Address Config',
    register: '16384', // 0x4000
    type: 'holding',
    dataType: 'uint16',
    access: 'readwrite'
  });
  return mappings;
};

export const REGISTER_PRESETS = {
  waveshare_4ch_relay: {
    name: 'Waveshare 4-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 4-channel relay module with configuration registers',
    mappings: generateRelayMappings(4)
  },
  waveshare_6ch_relay: {
    name: 'Waveshare 6-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 6-channel relay module with configuration registers',
    mappings: generateRelayMappings(6)
  },
  waveshare_8ch_relay: {
    name: 'Waveshare 8-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 8-channel relay module with configuration registers',
    mappings: generateRelayMappings(8)
  },
  waveshare_16ch_relay: {
    name: 'Waveshare 16-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 16-channel relay module with configuration registers',
    mappings: generateRelayMappings(16)
  },
  waveshare_32ch_relay: {
    name: 'Waveshare 32-Channel Relay',
    category: 'waveshare',
    description: 'Waveshare Modbus RTU 32-channel relay module with configuration registers',
    mappings: generateRelayMappings(32)
  },
  generic_temp_humidity: {
    name: 'Temperature/Humidity Sensor',
    category: 'sensor',
    description: 'Generic temperature and humidity sensor',
    mappings: [
      { name: 'Temperature', register: '0', type: 'input', dataType: 'int16', access: 'read' },
      { name: 'Humidity', register: '1', type: 'input', dataType: 'uint16', access: 'read' },
    ]
  },
  generic_power_meter: {
    name: 'Power Meter',
    category: 'meter',
    description: 'Generic power meter with voltage, current, power and energy readings',
    mappings: [
      { name: 'Voltage', register: '0', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Current', register: '2', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Power', register: '4', type: 'input', dataType: 'float32', access: 'read' },
      { name: 'Energy', register: '6', type: 'input', dataType: 'float32', access: 'read' },
    ]
  },
  generic_vfd: {
    name: 'Variable Frequency Drive (VFD)',
    category: 'controller',
    description: 'Generic VFD with frequency control and monitoring',
    mappings: [
      { name: 'Frequency Setpoint', register: '0', type: 'holding', dataType: 'uint16', access: 'readwrite' },
      { name: 'Actual Frequency', register: '1', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Motor Current', register: '2', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Motor Voltage', register: '3', type: 'input', dataType: 'uint16', access: 'read' },
      { name: 'Run/Stop Command', register: '0', type: 'coil', dataType: 'bool', access: 'readwrite' },
    ]
  }
};

// Derive the default register quantity (word count) from a Modbus data type.
// 16-bit and boolean values occupy 1 register; 32-bit values occupy 2.
export const defaultQuantityForType = (dataType) => {
  switch (dataType) {
    case 'uint32':
    case 'int32':
    case 'float32':
      return 2;
    case 'uint16':
    case 'int16':
    case 'bool':
    default:
      return 1;
  }
};

/** A blank mapping row with every editable field present. */
export const newMapping = () => ({
  name: '',
  label: '',
  register: '',
  type: 'holding',
  dataType: 'uint16',
  access: 'read',
  quantity: defaultQuantityForType('uint16'),
  scale: 1,
  offset: 0,
  unit: '',
  byteOrder: 'ABCD'
});

/**
 * Normalise mappings coming from a JSON import (either a bare array or a
 * `{ mappings: [...] }` wrapper). Rows without a name or register are dropped.
 * Returns null when the payload is not a mapping list at all.
 */
export function normalizeImportedMappings(importData) {
  const mappings = Array.isArray(importData) ? importData : importData?.mappings;
  if (!Array.isArray(mappings)) return null;
  return mappings
    .filter(m => m && typeof m === 'object' && m.name && m.register !== undefined)
    .map(m => {
      const dataType = m.dataType || 'uint16';
      const out = {
        name: m.name || '',
        label: m.label || '',
        register: String(m.register ?? ''),
        type: m.type || 'holding',
        dataType,
        access: m.access || 'read',
        quantity: m.quantity != null ? m.quantity : defaultQuantityForType(dataType),
        scale: m.scale != null ? m.scale : 1,
        offset: m.offset != null ? m.offset : 0,
        unit: m.unit || '',
        byteOrder: m.byteOrder || 'ABCD',
        functionCode: m.functionCode,
        enabled: m.enabled !== false
      };
      if (m.interlockWith !== undefined && m.interlockWith !== null && m.interlockWith !== '') out.interlockWith = m.interlockWith;
      if (m.unverified === true) out.unverified = true;
      return out;
    });
}

export const REGISTER_TYPE_LABELS = {
  holding: 'Holding',
  input: 'Input',
  coil: 'Coil',
  discrete: 'Discrete',
};

/** Modbus function code implied by a register type (read side). */
export const FC_FOR_TYPE = { coil: 'FC01', discrete: 'FC02', holding: 'FC03', input: 'FC04' };
