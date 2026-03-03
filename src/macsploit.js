const { EventEmitter } = require("events");
const net = require("net");

const IpcTypes = {
  IPC_EXECUTE: 0,
  IPC_SETTING: 1,
};

const MessageTypes = {
  PRINT: 1,
  ERROR: 2,
};

class Client extends EventEmitter {
  _host = "127.0.0.1";
  _port = 5553;
  _socket = null;

  get socket() {
    return this._socket;
  }

  isAttached() {
    return this._socket ? this._socket.readyState === "open" : false;
  }

  attach(port) {
    return new Promise((resolve, reject) => {
      if (this._socket && this._socket.readyState === "open") {
        reject(new Error("AlreadyInjectedError: Socket is already connected."));
        return;
      }

      if (this._socket && this._socket.readyState !== "open") {
        this._socket = null;
      }

      this._port = port;
      this._socket = net.createConnection(port, this._host);

      let connected = false;
      this._socket.once("connect", () => {
        connected = true;
        resolve();
      });

      this._socket.on("data", (data) => {
        const type = data.at(0);
        const isKnownType = Object.values(MessageTypes).includes(type);
        if (!isKnownType) return;

        const length = data.subarray(8, 16).readBigUInt64LE();
        const message = data.subarray(16, 16 + Number(length)).toString("utf-8");

        this.emit("message", message, type);
      });

      let lastError = null;
      this._socket.on("timeout", (err) => {
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
      });

      this._socket.on("error", (err) => {
        lastError = err;
        if (this.listenerCount("error") > 0) {
          this.emit("error", err);
        }
      });

      this._socket.once("close", (hadError) => {
        if (connected) {
          if (hadError) this.emit("close", lastError);
          else this.emit("close");
        } else if (hadError) {
          if (lastError && lastError.message.includes("connect ECONNREFUSED")) {
            reject(new Error("ConnectionRefusedError: Socket is not open."));
          } else {
            reject(new Error("ConnectionError: Socket closed due to an error."));
          }
        } else {
          reject(new Error("ConnectionError: Socket closed before connect."));
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
      if (!this._socket) {
        reject(new Error("NotInjectedError: Socket is already closed."));
        return;
      }

      this._socket.once("close", (hadError) => {
        if (hadError) {
          reject(new Error("ConnectionError: Socket closed due to an error."));
          return;
        }

        resolve();
        this._socket = null;
      });

      this._socket.destroy();
    });
  }

  _buildHeader(type, length = 0) {
    const data = Buffer.alloc(16 + length + 1);
    data.writeUInt8(type, 0);
    data.writeInt32LE(length, 8);
    return data;
  }

  executeScript(script) {
    if (!this._socket) {
      throw new Error("NotInjectedError: Please attach before executing scripts.");
    }

    const encoded = Buffer.from(script, "utf-8");
    const data = this._buildHeader(IpcTypes.IPC_EXECUTE, encoded.length);
    data.write(script, 16);

    return this._socket.write(data);
  }

  updateSetting(key, value) {
    if (!this._socket) {
      throw new Error("NotInjectedError: Please attach before executing scripts.");
    }

    const payload = `${key} ${value ? "true" : "false"}`;
    const data = this._buildHeader(IpcTypes.IPC_SETTING, payload.length);
    data.write(payload, 16);

    return this._socket.write(data);
  }
}

module.exports = {
  Client,
  IpcTypes,
  MessageTypes,
};
