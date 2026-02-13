/**
 * ModbusTcpClient - Backend service for Modbus TCP communication
 *
 * Handles connection pooling, request queuing, timeout management,
 * and automatic reconnection for reliable device communication.
 */

const ModbusRTU = require('modbus-serial');

// Connection pool entry
class ModbusConnection {
  constructor(host, port, unitId = 1) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.client = new ModbusRTU();
    this.connected = false;
    this.lastActivity = Date.now();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // ms
  }

  async connect() {
    if (this.connected) return true;

    try {
      await this.client.connectTCP(this.host, { port: this.port });
      this.client.setID(this.unitId);
      this.client.setTimeout(5000); // 5 second timeout
      this.connected = true;
      this.reconnectAttempts = 0;
      console.log(`[Modbus] Connected to ${this.host}:${this.port} (unit ${this.unitId})`);
      return true;
    } catch (error) {
      console.error(`[Modbus] Connection failed to ${this.host}:${this.port}:`, error.message);
      this.connected = false;
      throw error;
    }
  }

  async disconnect() {
    if (!this.connected) return;

    try {
      this.client.close();
      this.connected = false;
      console.log(`[Modbus] Disconnected from ${this.host}:${this.port}`);
    } catch (error) {
      console.error(`[Modbus] Disconnect error:`, error.message);
    }
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      throw new Error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached for ${this.host}:${this.port}`);
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[Modbus] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    await new Promise(resolve => setTimeout(resolve, delay));

    this.connected = false;
    return this.connect();
  }
}

// Request queue item
class QueuedRequest {
  constructor(operation, resolve, reject, timeout = 5000, retries = 3) {
    this.operation = operation;
    this.resolve = resolve;
    this.reject = reject;
    this.timeout = timeout;
    this.retries = retries;
    this.attempts = 0;
    this.createdAt = Date.now();
  }
}

/**
 * ModbusTcpClient - Main service class for Modbus TCP communication
 */
class ModbusTcpClient {
  constructor(options = {}) {
    // Connection pool: Map<connectionKey, ModbusConnection>
    this.connectionPool = new Map();

    // Request queues per connection: Map<connectionKey, QueuedRequest[]>
    this.requestQueues = new Map();

    // Processing status per connection
    this.processing = new Map();

    // Configuration
    this.config = {
      defaultTimeout: options.timeout || 5000,
      defaultRetries: options.retries || 3,
      maxPoolSize: options.maxPoolSize || 10,
      idleTimeout: options.idleTimeout || 60000, // Close idle connections after 1 minute
      ...options
    };

    // Start idle connection cleanup
    this.cleanupInterval = setInterval(() => this.cleanupIdleConnections(), 30000);
  }

  /**
   * Generate a unique key for a connection
   */
  getConnectionKey(host, port, unitId) {
    return `${host}:${port}:${unitId}`;
  }

  /**
   * Get or create a connection from the pool
   */
  async getConnection(host, port, unitId = 1) {
    const key = this.getConnectionKey(host, port, unitId);

    let connection = this.connectionPool.get(key);

    if (!connection) {
      // Check pool size limit
      if (this.connectionPool.size >= this.config.maxPoolSize) {
        // Remove oldest idle connection
        this.removeOldestIdleConnection();
      }

      connection = new ModbusConnection(host, port, unitId);
      this.connectionPool.set(key, connection);
      this.requestQueues.set(key, []);
      this.processing.set(key, false);
    }

    if (!connection.connected) {
      await connection.connect();
    }

    return connection;
  }

  /**
   * Remove the oldest idle connection from the pool
   */
  removeOldestIdleConnection() {
    let oldestKey = null;
    let oldestTime = Date.now();

    for (const [key, connection] of this.connectionPool) {
      if (connection.lastActivity < oldestTime && !this.processing.get(key)) {
        oldestTime = connection.lastActivity;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const connection = this.connectionPool.get(oldestKey);
      connection.disconnect();
      this.connectionPool.delete(oldestKey);
      this.requestQueues.delete(oldestKey);
      this.processing.delete(oldestKey);
      console.log(`[Modbus] Removed oldest idle connection: ${oldestKey}`);
    }
  }

  /**
   * Clean up idle connections
   */
  cleanupIdleConnections() {
    const now = Date.now();
    for (const [key, connection] of this.connectionPool) {
      if (now - connection.lastActivity > this.config.idleTimeout && !this.processing.get(key)) {
        connection.disconnect();
        this.connectionPool.delete(key);
        this.requestQueues.delete(key);
        this.processing.delete(key);
        console.log(`[Modbus] Cleaned up idle connection: ${key}`);
      }
    }
  }

  /**
   * Queue a request for execution
   */
  async queueRequest(host, port, unitId, operation, options = {}) {
    const key = this.getConnectionKey(host, port, unitId);

    // Ensure connection exists
    await this.getConnection(host, port, unitId);

    return new Promise((resolve, reject) => {
      const request = new QueuedRequest(
        operation,
        resolve,
        reject,
        options.timeout || this.config.defaultTimeout,
        options.retries || this.config.defaultRetries
      );

      let queue = this.requestQueues.get(key);
      if (!queue) {
        queue = [];
        this.requestQueues.set(key, queue);
      }

      queue.push(request);
      this.processQueue(key);
    });
  }

  /**
   * Process the request queue for a connection
   */
  async processQueue(key) {
    if (this.processing.get(key)) return;

    const queue = this.requestQueues.get(key);
    if (!queue || queue.length === 0) return;

    this.processing.set(key, true);

    while (queue.length > 0) {
      const request = queue.shift();
      await this.executeRequest(key, request);
    }

    this.processing.set(key, false);
  }

  /**
   * Execute a single request with retry logic
   */
  async executeRequest(key, request) {
    const connection = this.connectionPool.get(key);
    if (!connection) {
      request.reject(new Error('Connection not found'));
      return;
    }

    while (request.attempts < request.retries) {
      request.attempts++;

      try {
        // Set up timeout
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('Request timeout')), request.timeout);
        });

        // Execute the operation
        const result = await Promise.race([
          request.operation(connection.client),
          timeoutPromise
        ]);

        connection.updateActivity();
        request.resolve(result);
        return;
      } catch (error) {
        console.error(`[Modbus] Request failed (attempt ${request.attempts}/${request.retries}):`, error.message);

        // Handle connection errors
        if (error.message.includes('Port Not Open') ||
            error.message.includes('ECONNRESET') ||
            error.message.includes('ETIMEDOUT')) {
          try {
            await connection.reconnect();
          } catch (reconnectError) {
            console.error(`[Modbus] Reconnect failed:`, reconnectError.message);
            if (request.attempts >= request.retries) {
              request.reject(reconnectError);
              return;
            }
          }
        }

        if (request.attempts >= request.retries) {
          request.reject(error);
          return;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  // ==========================================
  // Modbus Read Functions
  // ==========================================

  /**
   * FC01 - Read Coils
   * Reads the status of discrete coils in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting coil address
   * @param {number} quantity - Number of coils to read
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<boolean[]>} Array of coil values
   */
  async readCoils(host, port = 502, unitId = 1, address, quantity, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      const result = await client.readCoils(address, quantity);
      return result.data;
    }, options);
  }

  /**
   * FC02 - Read Discrete Inputs
   * Reads the status of discrete inputs in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting input address
   * @param {number} quantity - Number of inputs to read
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<boolean[]>} Array of input values
   */
  async readDiscreteInputs(host, port = 502, unitId = 1, address, quantity, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      const result = await client.readDiscreteInputs(address, quantity);
      return result.data;
    }, options);
  }

  /**
   * FC03 - Read Holding Registers
   * Reads the contents of holding registers in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting register address
   * @param {number} quantity - Number of registers to read
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<number[]>} Array of register values
   */
  async readHoldingRegisters(host, port = 502, unitId = 1, address, quantity, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      const result = await client.readHoldingRegisters(address, quantity);
      return result.data;
    }, options);
  }

  /**
   * FC04 - Read Input Registers
   * Reads the contents of input registers in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting register address
   * @param {number} quantity - Number of registers to read
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<number[]>} Array of register values
   */
  async readInputRegisters(host, port = 502, unitId = 1, address, quantity, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      const result = await client.readInputRegisters(address, quantity);
      return result.data;
    }, options);
  }

  // ==========================================
  // Modbus Write Functions
  // ==========================================

  /**
   * FC05 - Write Single Coil
   * Writes a single coil to ON or OFF in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Coil address
   * @param {boolean} value - Coil value (true = ON, false = OFF)
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<void>}
   */
  async writeSingleCoil(host, port = 502, unitId = 1, address, value, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      await client.writeCoil(address, value);
      return { address, value };
    }, options);
  }

  /**
   * FC06 - Write Single Register
   * Writes a single holding register in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Register address
   * @param {number} value - Register value (0-65535)
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<void>}
   */
  async writeSingleRegister(host, port = 502, unitId = 1, address, value, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      await client.writeRegister(address, value);
      return { address, value };
    }, options);
  }

  /**
   * FC15 - Write Multiple Coils
   * Writes multiple coils in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting coil address
   * @param {boolean[]} values - Array of coil values
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<void>}
   */
  async writeMultipleCoils(host, port = 502, unitId = 1, address, values, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      await client.writeCoils(address, values);
      return { address, quantity: values.length };
    }, options);
  }

  /**
   * FC16 - Write Multiple Registers
   * Writes multiple holding registers in a remote device
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting register address
   * @param {number[]} values - Array of register values
   * @param {object} options - Request options (timeout, retries)
   * @returns {Promise<void>}
   */
  async writeMultipleRegisters(host, port = 502, unitId = 1, address, values, options = {}) {
    return this.queueRequest(host, port, unitId, async (client) => {
      await client.writeRegisters(address, values);
      return { address, quantity: values.length };
    }, options);
  }

  // ==========================================
  // Connection Management
  // ==========================================

  /**
   * Get connection status for a device
   */
  getConnectionStatus(host, port, unitId = 1) {
    const key = this.getConnectionKey(host, port, unitId);
    const connection = this.connectionPool.get(key);

    if (!connection) {
      return { connected: false, exists: false };
    }

    return {
      connected: connection.connected,
      exists: true,
      lastActivity: connection.lastActivity,
      reconnectAttempts: connection.reconnectAttempts
    };
  }

  /**
   * Get all active connections
   */
  getActiveConnections() {
    const connections = [];
    for (const [key, connection] of this.connectionPool) {
      connections.push({
        key,
        host: connection.host,
        port: connection.port,
        unitId: connection.unitId,
        connected: connection.connected,
        lastActivity: connection.lastActivity
      });
    }
    return connections;
  }

  /**
   * Force disconnect a specific connection
   */
  async disconnectDevice(host, port, unitId = 1) {
    const key = this.getConnectionKey(host, port, unitId);
    const connection = this.connectionPool.get(key);

    if (connection) {
      await connection.disconnect();
      this.connectionPool.delete(key);
      this.requestQueues.delete(key);
      this.processing.delete(key);
      return true;
    }

    return false;
  }

  /**
   * Disconnect all connections and cleanup
   */
  async shutdown() {
    console.log('[Modbus] Shutting down ModbusTcpClient...');

    // Clear cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Disconnect all connections
    for (const [key, connection] of this.connectionPool) {
      await connection.disconnect();
    }

    // Clear all maps
    this.connectionPool.clear();
    this.requestQueues.clear();
    this.processing.clear();

    console.log('[Modbus] ModbusTcpClient shutdown complete');
  }
}

// Create singleton instance
const modbusTcpClient = new ModbusTcpClient();

// Export both the class and singleton
module.exports = {
  ModbusTcpClient,
  modbusTcpClient
};
