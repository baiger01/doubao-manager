const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function cloneDefault(value) {
  return JSON.parse(JSON.stringify(value));
}

function canAtomicWrite(fsImpl) {
  return typeof fsImpl.openSync === 'function'
    && typeof fsImpl.fsyncSync === 'function'
    && typeof fsImpl.closeSync === 'function'
    && typeof fsImpl.renameSync === 'function';
}

function ensureDir(filePath, fsImpl) {
  const dir = path.dirname(filePath);
  if (typeof fsImpl.mkdirSync !== 'function') return dir;
  if (!fsImpl.existsSync || !fsImpl.existsSync(dir)) {
    fsImpl.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function fsyncPath(targetPath, fsImpl) {
  if (!canAtomicWrite(fsImpl)) return;
  let fd = null;
  try {
    fd = fsImpl.openSync(targetPath, 'r');
    fsImpl.fsyncSync(fd);
  } catch (e) {
    // Directory fsync is best effort on Windows and some filesystems.
  } finally {
    if (fd !== null) {
      try { fsImpl.closeSync(fd); } catch (e) {}
    }
  }
}

function atomicWriteTextFile(filePath, content, options = {}) {
  const fsImpl = options.fs || fs;
  const encoding = options.encoding || 'utf-8';
  const dir = ensureDir(filePath, fsImpl);

  if (!canAtomicWrite(fsImpl)) {
    fsImpl.writeFileSync(filePath, content, encoding);
    return;
  }

  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fsImpl.writeFileSync(tmp, content, encoding);
  fsyncPath(tmp, fsImpl);

  if (fsImpl.existsSync(filePath)) {
    try {
      fsImpl.copyFileSync(filePath, filePath + '.bak');
      fsyncPath(filePath + '.bak', fsImpl);
    } catch (e) {
      try { fsImpl.unlinkSync(tmp); } catch (e2) {}
      throw e;
    }
  }

  fsImpl.renameSync(tmp, filePath);
  fsyncPath(dir, fsImpl);
}

function atomicWriteJsonFile(filePath, value, options = {}) {
  const space = options.space === undefined ? 2 : options.space;
  atomicWriteTextFile(filePath, JSON.stringify(value, null, space), options);
}

function readJsonRaw(filePath, fsImpl) {
  return JSON.parse(fsImpl.readFileSync(filePath, 'utf-8'));
}

function preserveCorruptFile(filePath, fsImpl) {
  if (!fsImpl.existsSync || !fsImpl.existsSync(filePath)) return;
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf-8');
    fsImpl.writeFileSync(filePath + '.corrupt', raw, 'utf-8');
  } catch (e) {
    // Preserve is best effort; never hide the original parse failure path.
  }
}

function readJsonFile(filePath, defaultValue, options = {}) {
  const fsImpl = options.fs || fs;
  if (!fsImpl.existsSync || !fsImpl.existsSync(filePath)) return cloneDefault(defaultValue);

  try {
    return readJsonRaw(filePath, fsImpl);
  } catch (primaryError) {
    preserveCorruptFile(filePath, fsImpl);
    const backup = filePath + '.bak';
    if (fsImpl.existsSync && fsImpl.existsSync(backup)) {
      try {
        const restored = readJsonRaw(backup, fsImpl);
        atomicWriteJsonFile(filePath, restored, { ...options, fs: fsImpl });
        return restored;
      } catch (backupError) {
        // Fall through to the caller-provided default.
      }
    }
    return cloneDefault(defaultValue);
  }
}

function ensureJsonFile(filePath, defaultValue, options = {}) {
  const fsImpl = options.fs || fs;
  if (!fsImpl.existsSync || !fsImpl.existsSync(filePath)) {
    atomicWriteJsonFile(filePath, defaultValue, { ...options, fs: fsImpl });
    return cloneDefault(defaultValue);
  }

  try {
    return readJsonRaw(filePath, fsImpl);
  } catch (e) {
    preserveCorruptFile(filePath, fsImpl);
    atomicWriteJsonFile(filePath, defaultValue, { ...options, fs: fsImpl });
    return cloneDefault(defaultValue);
  }
}

module.exports = {
  atomicWriteTextFile,
  atomicWriteJsonFile,
  readJsonFile,
  ensureJsonFile,
};
