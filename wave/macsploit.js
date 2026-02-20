const { EventEmitter } = require('events');
const net = require('net');

// MacSploit API (CommonJS port of the provided ESM client)
exports.IpcTypes = {
  IPC_EXECUTE: 0,
  IPC_SETTING: 1
};

exports.MessageTypes = {
  PRINT: 1,
  ERROR: 2
};

class Client extends EventEmitter {
  _host = '127.0.0.1';
  _port = 5553;
  _socket = null;

  constructor() {
    super();
  }

  get socket() {
    return this._socket;
  }

  isAttached() {
    return this._socket ? this._socket.readyState === 'open' : false;
  }

  attach(port) {
    return new Promise((resolve, reject) => {
      if (this._socket) return reject(new Error('AlreadyInjectedError: Socket is already connected.'));

      this._port = port;
      this._socket = net.createConnection(port, this._host);

      let connected = false;
      this._socket.once('connect', () => {
        connected = true;
        resolve();
      });

      this._socket.on('data', (data) => {
        const type = data.at(0);
        if (!type || !Object.values(exports.MessageTypes).includes(type)) return; // unknown type

        // Note: server side may use different header size; follow original client behaviour
        let length = 0n;
        try {
          length = data.subarray(8, 16).readBigUInt64LE();
        } catch (e) {
          // fallback if readBigUInt64LE not available / header differs
          length = BigInt(data.length - 16);
        }

        const message = data.subarray(16, 16 + Number(length)).toString('utf-8');
        this.emit('message', message, type);
      });

      let lastError = null;
      this._socket.on('timeout', console.error);
      this._socket.on('error', (err) => {
        lastError = err;
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
      });
      this._socket.once('close', (hadError) => {
        if (connected) {
          if (hadError) this.emit('close', lastError);
          else this.emit('close');
        } else if (hadError) {
          if (lastError && lastError.message && lastError.message.includes('connect ECONNREFUSED')) {
            reject(new Error('ConnectionRefusedError: Socket is not open.'));
          } else {
            reject(new Error('ConnectionError: Socket closed due to an error.'));
          }
        } else {
          reject();
        }
        this._socket = null;
      });
    });
  }

  reattach() {
    return this.attach(this._port);
  }

  detach() {
    return new Promise((resolve, reject) => {
      if (!this._socket) return resolve(); // already closed, resolve silently

      this._socket.once('close', (hadError) => {
        this._socket = null;
        if (hadError) return reject(new Error('ConnectionError: Socket closed due to an error.'));
        resolve();
      });
      this._socket.destroy();
    });
  }

  _buildHeader(type, length = 0) {
    const data = Buffer.alloc(16 + length);
    data.writeUInt8(type, 0);
    // MacSploit uses an 8-byte little-endian length field.
    data.writeBigUInt64LE(BigInt(length), 8);
    return data;
  }

  executeScript(script) {
    if (!this._socket) throw new Error('NotInjectedError: Please attach before executing scripts.');

    const scriptBuf = Buffer.from(script, 'utf8');
    const data = this._buildHeader(exports.IpcTypes.IPC_EXECUTE, scriptBuf.length);
    scriptBuf.copy(data, 16);

    return this._socket.write(data);
  }

  updateSetting(key, value) {
    if (!this._socket) throw new Error('NotInjectedError: Please attach before executing scripts.');

    const payloadBuf = Buffer.from(`${key} ${value ? 'true' : 'false'}`, 'utf8');
    const data = this._buildHeader(exports.IpcTypes.IPC_SETTING, payloadBuf.length);
    payloadBuf.copy(data, 16);

    return this._socket.write(data);
  }
}

exports.Client = Client;
