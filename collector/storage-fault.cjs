// Isolated test-only preload; never loaded by the collector in production.
const fs = require('node:fs');
const target = process.env.FAULT_TELEMETRY_FILE;
const mode = process.env.FAULT_MODE;
const tracked = new Set();
let fired = false;
const open = fs.openSync, close = fs.closeSync, write = fs.writeSync, sync = fs.fsyncSync;
fs.openSync = function (path, ...args) {
  const fd = open.call(this, path, ...args);
  if (path === target) tracked.add(fd);
  return fd;
};
fs.closeSync = function (fd, ...args) { tracked.delete(fd); return close.call(this, fd, ...args); };
fs.writeSync = function (fd, data, offset, length, ...args) {
  if (!fired && tracked.has(fd) && (mode === 'short' || mode === 'partial')) {
    fired = true;
    const n = Math.min(8, length);
    const written = write.call(this, fd, data, offset, n, ...args);
    if (mode === 'partial') throw Error('injected partial append');
    return written;
  }
  return write.call(this, fd, data, offset, length, ...args);
};
fs.fsyncSync = function (fd, ...args) {
  if (!fired && tracked.has(fd) && mode === 'fsync') { fired = true; throw Error('injected fsync failure'); }
  return sync.call(this, fd, ...args);
};
