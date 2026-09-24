/**
 * ModbusTcpClient - Backend service for Modbus TCP communication
 *
 * Handles connection pooling, request queuing, timeout management,
 * and automatic reconnection for reliable device communication.
 */

const ModbusRTU = require('modbus-serial');

// Connection pool entry
class ModbusConnection {
  constructor(host, port, unitId = 1, connectTimeout = 3000) {
    this.host = host;
    this.port = port;
    this.unitId = unitId;
    this.client = new ModbusRTU();
    this.connected = false;
    this.lastActivity = Date.now();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 1000; // ms
    // Upper bound on the TCP connect itself. modbus-serial's connectTCP has no
    // bounded connect timeout (its `timeout` option is a persistent socket idle
    // timer), and a SYN to a dead host can otherwise hang for the kernel's
    // tcp_syn_retries window (~2 min).
    this.connectTimeout = connectTimeout;
    // In-flight connect promise so concurrent callers (e.g. several boards on
    // one gateway being written in parallel) share a single connectTCP instead
    // of racing multiple sockets on the same ModbusRTU instance.
    this._connecting = null;
  }

  async connect() {
    if (this.connected) return true;
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      let timer = null;
      try {
        const connectPromise = this.client.connectTCP(this.host, { port: this.port });
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            const err = new Error(`TCP connect to ${this.host}:${this.port} timed out after ${this.connectTimeout}ms`);
            err.code = 'ECONNTIMEOUT';
            reject(err);
          }, this.connectTimeout);
        });
        try {
          await Promise.race([connectPromise, timeoutPromise]);
        } catch (err) {
          if (err.code === 'ECONNTIMEOUT') {
            // Tear the half-open socket down so a late connect can't leak.
            connectPromise.catch(() => {});
            try { this.client.destroy(() => {}); } catch (e) {}
          }
          throw err;
        }
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
      } finally {
        if (timer) clearTimeout(timer);
        this._connecting = null;
      }
    })();

    return this._connecting;
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
      connectTimeout: options.connectTimeout || 3000,
      maxPoolSize: options.maxPoolSize || 10,
      idleTimeout: options.idleTimeout || 60000, // Close idle connections after 1 minute
      ...options
    };

    // Per-unit inter-request gap. Map<"host:port:unit", ms> — a device that
    // drops back-to-back frames (SEKO) gets a pause before every request to
    // it, whoever issues it (poller, /api/modbus, relay writes).
    this.unitGaps = new Map();
    // Map<"host:port:unit", ms timestamp> when the last request to that unit
    // finished (resolved, rejected or timed out).
    this.lastRequestEnd = new Map();
    // Injectable clock/sleep so the gap timing is unit-testable.
    this._now = typeof options.now === 'function' ? options.now : () => Date.now();
    this._sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise(resolve => setTimeout(resolve, ms));

    // Start idle connection cleanup (unref: never keeps a process alive on its own)
    this.cleanupInterval = setInterval(() => this.cleanupIdleConnections(), 30000);
    if (this.cleanupInterval && typeof this.cleanupInterval.unref === 'function') this.cleanupInterval.unref();
  }

  /** Key for the per-unit gap bookkeeping. */
  getUnitKey(host, port, unitId = 1) {
    return `${host}:${port}:${unitId}`;
  }

  /**
   * Set the minimum pause (ms) between consecutive requests to one unit.
   * 0 (or anything non-positive) removes the gap.
   */
  setRequestGap(host, port, unitId, gapMs) {
    const key = this.getUnitKey(host, port, unitId);
    const ms = Number(gapMs);
    if (Number.isFinite(ms) && ms > 0) this.unitGaps.set(key, ms);
    else this.unitGaps.delete(key);
  }

  getRequestGap(host, port, unitId) {
    return this.unitGaps.get(this.getUnitKey(host, port, unitId)) || 0;
  }

  /**
   * Wait until at least gap ms have passed since the last request to this
   * unit finished. Resolves immediately when no gap is configured.
   */
  async waitForUnitGap(unitKey) {
    const gap = this.unitGaps.get(unitKey);
    if (!gap) return 0;
    const last = this.lastRequestEnd.get(unitKey);
    if (last === undefined) return 0;
    const remaining = gap - (this._now() - last);
    if (remaining <= 0) return 0;
    await this._sleep(remaining);
    return remaining;
  }

  markRequestEnd(unitKey) {
    this.lastRequestEnd.set(unitKey, this._now());
  }

  /**
   * Generate a unique key for a connection.
   * Uses host:port only (not unitId) so all devices on the same gateway
   * share one TCP connection and one request queue. This prevents RS485
   * bus collisions when daisy-chaining multiple devices.
   */
  getConnectionKey(host, port, unitId) {
    return `${host}:${port}`;
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

      connection = new ModbusConnection(host, port, unitId, this.config.connectTimeout);
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
      request.unitKey = this.getUnitKey(host, port, unitId);

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

    const unitKey = request.unitKey || null;

    while (request.attempts < request.retries) {
      request.attempts++;

      // Honour the per-unit inter-request gap (before every attempt, so a
      // retry after a timeout also gives the device its breathing room).
      if (unitKey) await this.waitForUnitGap(unitKey);

      let timer = null;
      try {
        // Set up timeout
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Request timeout')), request.timeout);
        });

        // Execute the operation
        const result = await Promise.race([
          request.operation(connection.client),
          timeoutPromise
        ]);

        if (timer) clearTimeout(timer);
        if (unitKey) this.markRequestEnd(unitKey);
        connection.updateActivity();
        request.resolve(result);
        return;
      } catch (error) {
        if (timer) clearTimeout(timer);
        if (unitKey) this.markRequestEnd(unitKey);
        console.error(`[Modbus] Request failed (attempt ${request.attempts}/${request.retries}):`, error.message);

        // A Modbus exception response is the device deliberately refusing
        // the request (illegal address/function/value). Retrying gets the
        // same answer, so surface it right away.
        if (error && error.modbusCode !== undefined && error.modbusCode !== null) {
          request.reject(error);
          return;
        }

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
      client.setID(unitId);
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
      client.setID(unitId);
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
      client.setID(unitId);
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
      client.setID(unitId);
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
      client.setID(unitId);
      await client.writeCoil(address, value);
      return { address, value };
    }, options);
  }

  /**
   * FC05 - Write Single Coil (Fire and Forget / Write-Only mode)
   * Sends the write command and assumes success even if the device doesn't respond.
   * Used for devices where the RS485 transceiver can't send responses back.
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Coil address
   * @param {boolean} value - Coil value (true = ON, false = OFF)
   * @returns {Promise<{address, value, writeOnly: true}>}
   */
  async writeSingleCoilFireAndForget(host, port = 502, unitId = 1, address, value) {
    const key = this.getConnectionKey(host, port, unitId);

    // Ensure connection exists
    const connection = await this.getConnection(host, port, unitId);

    return new Promise((resolve, reject) => {
      const request = new QueuedRequest(
        async (client) => {
          client.setID(unitId);
          // Save the original timeout and set a short one
          const originalTimeout = client._timeout;
          client.setTimeout(1500); // Short timeout — we just need TCP write to go through
          try {
            await client.writeCoil(address, value);
            return { address, value, writeOnly: true, confirmed: true };
          } catch (err) {
            // Timeout is expected for write-only devices — the TCP data was already sent
            if (err.message.includes('Timed out') || err.message.includes('Request timeout') || err.message.includes('timeout')) {
              console.log(`[Modbus] Write-only FC05: addr=${address} val=${value} to ${host}:${port}:${unitId} (timeout expected)`);
              return { address, value, writeOnly: true, confirmed: false };
            }
            throw err; // Re-throw real errors (connection refused, etc.)
          } finally {
            client.setTimeout(originalTimeout || 5000);
          }
        },
        resolve,
        reject,
        3000, // timeout for the whole operation
        1     // only 1 attempt — no retries for fire-and-forget
      );
      request.unitKey = this.getUnitKey(host, port, unitId);

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
   * FC15 - Write Multiple Coils (Fire and Forget / Write-Only mode)
   * @param {string} host - Device IP address
   * @param {number} port - TCP port (default 502)
   * @param {number} unitId - Modbus unit ID
   * @param {number} address - Starting coil address
   * @param {boolean[]} values - Array of coil values
   * @returns {Promise<{address, quantity, writeOnly: true}>}
   */
  async writeMultipleCoilsFireAndForget(host, port = 502, unitId = 1, address, values) {
    const key = this.getConnectionKey(host, port, unitId);

    const connection = await this.getConnection(host, port, unitId);

    return new Promise((resolve, reject) => {
      const request = new QueuedRequest(
        async (client) => {
          client.setID(unitId);
          const originalTimeout = client._timeout;
          client.setTimeout(1500);
          try {
            await client.writeCoils(address, values);
            return { address, quantity: values.length, writeOnly: true, confirmed: true };
          } catch (err) {
            if (err.message.includes('Timed out') || err.message.includes('Request timeout') || err.message.includes('timeout')) {
              console.log(`[Modbus] Write-only FC15: addr=${address} qty=${values.length} to ${host}:${port}:${unitId} (timeout expected)`);
              return { address, quantity: values.length, writeOnly: true, confirmed: false };
            }
            throw err;
          } finally {
            client.setTimeout(originalTimeout || 5000);
          }
        },
        resolve,
        reject,
        3000,
        1
      );
      request.unitKey = this.getUnitKey(host, port, unitId);

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
      client.setID(unitId);
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
      client.setID(unitId);
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
      client.setID(unitId);
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
