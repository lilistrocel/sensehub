/**
 * Modbus TCP Device Scanner
 *
 * Scans the local network for Modbus TCP devices by probing common ports (502, 503)
 * on IP ranges. Discovers devices like RS485-to-Ethernet converters that expose
 * Modbus TCP endpoints.
 */

const net = require('net');
const os = require('os');

// Common Modbus TCP ports
const MODBUS_PORTS = [502, 503];

// Default scan timeout per IP:port (in ms)
const SCAN_TIMEOUT = 1000;

// Maximum concurrent connections during scan
const MAX_CONCURRENT = 50;

/**
 * Get local network information to determine scan range
 * @returns {Array} Array of network interfaces with IP and subnet info
 */
function getLocalNetworks() {
  const interfaces = os.networkInterfaces();
  const networks = [];

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const addr of addresses) {
      // Only consider IPv4, non-internal addresses
      if (addr.family === 'IPv4' && !addr.internal) {
        networks.push({
          interface: name,
          address: addr.address,
          netmask: addr.netmask,
          cidr: addr.cidr || `${addr.address}/${netmaskToCIDR(addr.netmask)}`
        });
      }
    }
  }

  return networks;
}

/**
 * Convert netmask to CIDR notation
 * @param {string} netmask - e.g., "255.255.255.0"
 * @returns {number} CIDR value, e.g., 24
 */
function netmaskToCIDR(netmask) {
  return netmask.split('.').reduce((acc, octet) => {
    return acc + (parseInt(octet, 10).toString(2).match(/1/g) || []).length;
  }, 0);
}

/**
 * Generate IP range from network address
 * @param {string} ip - Base IP address
 * @param {string} netmask - Network mask
 * @returns {Array} Array of IP addresses in the range
 */
function generateIPRange(ip, netmask) {
  const ipParts = ip.split('.').map(Number);
  const maskParts = netmask.split('.').map(Number);

  // Calculate network address
  const networkParts = ipParts.map((part, i) => part & maskParts[i]);

  // Calculate broadcast address
  const broadcastParts = networkParts.map((part, i) => part | (~maskParts[i] & 255));

  const ips = [];

  // Generate all IPs in range (excluding network and broadcast)
  // For large ranges, limit to prevent overwhelming the system
  const maxHosts = 254; // Limit to /24 network size for safety

  // Calculate range based on last octet (common case for /24)
  const startIP = networkParts[3] + 1;
  const endIP = Math.min(broadcastParts[3], startIP + maxHosts);

  for (let i = startIP; i < endIP; i++) {
    ips.push(`${networkParts[0]}.${networkParts[1]}.${networkParts[2]}.${i}`);
  }

  return ips;
}

/**
 * Probe a single IP:port combination for Modbus TCP
 * @param {string} ip - IP address to probe
 * @param {number} port - Port number (typically 502 or 503)
 * @param {number} timeout - Connection timeout in ms
 * @returns {Promise} Resolves with device info or null
 */
function probeModbusDevice(ip, port, timeout = SCAN_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let deviceInfo = null;
    let responseReceived = false;
    let connected = false;

    socket.setTimeout(timeout);

    socket.on('connect', () => {
      connected = true;
      // Connection successful - this is likely a Modbus device
      // Try to send a Modbus identification request (Function Code 43, MEI Type 14)
      // Read Device Identification request
      const identificationRequest = Buffer.from([
        0x00, 0x01,  // Transaction ID
        0x00, 0x00,  // Protocol ID (Modbus)
        0x00, 0x05,  // Length
        0x01,        // Unit ID
        0x2B,        // Function Code 43 (Read Device Identification)
        0x0E,        // MEI Type 14 (Device Identification)
        0x01,        // Read Device ID Code (Basic)
        0x00         // Object ID (starting from VendorName)
      ]);

      socket.write(identificationRequest);
    });

    socket.on('data', (data) => {
      responseReceived = true;

      // Parse Modbus response if possible
      deviceInfo = {
        ip,
        port,
        protocol: 'modbus_tcp',
        responsive: true,
        deviceInfo: null
      };

      // Check if we got a valid Modbus response
      if (data.length >= 8) {
        const functionCode = data[7];

        if (functionCode === 0x2B && data.length > 8) {
          // Valid Device Identification response
          try {
            deviceInfo.deviceInfo = parseDeviceIdentification(data);
          } catch (err) {
            console.log(`Error parsing device ID from ${ip}:${port}:`, err.message);
          }
        } else if (functionCode & 0x80) {
          // Exception response - device is there but doesn't support identification
          deviceInfo.deviceInfo = {
            note: 'Device responded with Modbus exception (Function code not supported)'
          };
        }
      }

      socket.destroy();
      resolve(deviceInfo);
    });

    socket.on('timeout', () => {
      socket.destroy();
      // If we connected but got no Modbus response, the port is open
      // (e.g. a Modbus gateway with no RS485 slaves responding).
      // Still report the device as discovered.
      if (connected && !responseReceived) {
        resolve({
          ip,
          port,
          protocol: 'modbus_tcp',
          responsive: true,
          deviceInfo: {
            note: 'TCP port open but no Modbus response (gateway/converter with no active slaves)'
          }
        });
      } else {
        resolve(null);
      }
    });

    socket.on('error', (err) => {
      // Connection refused means port is closed, anything else might be interesting
      socket.destroy();

      if (err.code === 'ECONNREFUSED') {
        resolve(null);
      } else if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH') {
        resolve(null);
      } else {
        // Some other error - might still be a device
        resolve(null);
      }
    });

    socket.on('close', () => {
      if (!responseReceived && deviceInfo === null && !connected) {
        resolve(null);
      }
    });

    socket.connect(port, ip);
  });
}

/**
 * Parse Modbus Device Identification response
 * @param {Buffer} data - Raw response buffer
 * @returns {Object} Parsed device information
 */
function parseDeviceIdentification(data) {
  const info = {};

  // Skip Modbus TCP header (7 bytes) + function code (1 byte) + MEI type (1 byte)
  let offset = 9;

  if (data.length < offset + 2) return info;

  const deviceIdCode = data[offset++];
  const conformityLevel = data[offset++];

  if (data.length < offset + 1) return info;

  const numObjects = data[offset++];

  const objectNames = {
    0x00: 'VendorName',
    0x01: 'ProductCode',
    0x02: 'MajorMinorRevision',
    0x03: 'VendorUrl',
    0x04: 'ProductName',
    0x05: 'ModelName',
    0x06: 'UserApplicationName'
  };

  for (let i = 0; i < numObjects && offset < data.length - 2; i++) {
    const objectId = data[offset++];
    const objectLength = data[offset++];

    if (offset + objectLength <= data.length) {
      const objectValue = data.slice(offset, offset + objectLength).toString('ascii');
      const objectName = objectNames[objectId] || `Object_${objectId}`;
      info[objectName] = objectValue.trim();
      offset += objectLength;
    }
  }

  info.conformityLevel = conformityLevel;

  return info;
}

/**
 * Scan network for Modbus TCP devices
 * @param {Object} options - Scan options
 * @param {string} options.subnet - Optional specific subnet to scan (e.g., "192.168.1.0/24")
 * @param {Array} options.ports - Ports to scan (default: [502, 503])
 * @param {number} options.timeout - Timeout per probe in ms
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<Array>} Array of discovered devices
 */
async function scanNetwork(options = {}) {
  const {
    subnet,
    ports = MODBUS_PORTS,
    timeout = SCAN_TIMEOUT,
    onProgress
  } = options;

  // Get networks to scan
  let networks = [];

  if (subnet) {
    // Parse provided subnet
    const [ip, cidr] = subnet.split('/');
    const bits = parseInt(cidr) || 24;
    const mask = bits >= 24 ? '255.255.255.0' : '255.255.0.0';
    networks = [{ address: ip, netmask: mask }];
  } else {
    // Auto-detect local networks
    networks = getLocalNetworks();
  }

  if (networks.length === 0) {
    return [];
  }

  // Generate list of IPs to scan
  const allIPs = [];
  for (const network of networks) {
    const ips = generateIPRange(network.address, network.netmask);
    allIPs.push(...ips);
  }

  // Create list of all IP:port combinations to probe
  const probes = [];
  for (const ip of allIPs) {
    for (const port of ports) {
      probes.push({ ip, port });
    }
  }

  const discovered = [];
  let completed = 0;
  const total = probes.length;

  // Process probes in batches
  for (let i = 0; i < probes.length; i += MAX_CONCURRENT) {
    const batch = probes.slice(i, i + MAX_CONCURRENT);

    const results = await Promise.all(
      batch.map(({ ip, port }) => probeModbusDevice(ip, port, timeout))
    );

    for (const result of results) {
      if (result !== null) {
        discovered.push(result);
      }
    }

    completed += batch.length;

    if (onProgress) {
      onProgress({
        completed,
        total,
        discovered: discovered.length,
        percentage: Math.round((completed / total) * 100)
      });
    }
  }

  return discovered;
}

/**
 * Quick scan - only scan a specific IP or small range
 * @param {string} target - IP address or range (e.g., "192.168.1.100" or "192.168.1.100-110")
 * @param {Object} options - Scan options
 * @returns {Promise<Array>} Array of discovered devices
 */
async function quickScan(target, options = {}) {
  const { ports = MODBUS_PORTS, timeout = SCAN_TIMEOUT } = options;

  let ips = [];

  if (target.includes('-')) {
    // Range specified (e.g., "192.168.1.100-110")
    const [base, end] = target.split('-');
    const baseParts = base.split('.');
    const startNum = parseInt(baseParts[3]);
    const endNum = parseInt(end);

    for (let i = startNum; i <= endNum; i++) {
      ips.push(`${baseParts[0]}.${baseParts[1]}.${baseParts[2]}.${i}`);
    }
  } else {
    // Single IP
    ips = [target];
  }

  const probes = [];
  for (const ip of ips) {
    for (const port of ports) {
      probes.push({ ip, port });
    }
  }

  const results = await Promise.all(
    probes.map(({ ip, port }) => probeModbusDevice(ip, port, timeout))
  );

  return results.filter(r => r !== null);
}

module.exports = {
  scanNetwork,
  quickScan,
  getLocalNetworks,
  MODBUS_PORTS,
  SCAN_TIMEOUT
};
