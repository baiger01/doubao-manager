function createNullNativeBridge() {
  return {
    canPickDir() { return false; },
    canOpenPath() { return false; },
    hasWebviewSession() { return false; },
    async pickDirectory() { throw new Error('no_native'); },
    async openPath() { throw new Error('no_native'); },
    async setCookie() { throw new Error('no_native'); },
    async getCookies() { return []; },
    async removeCookie() {}
  };
}

function createElectronNativeBridge({ dialog, shell, session } = {}) {
  function getPartition(partition) {
    if (!session || typeof session.fromPartition !== 'function') {
      throw new Error('no_native_session');
    }
    return session.fromPartition(partition);
  }

  return {
    canPickDir() {
      return !!(dialog && typeof dialog.showOpenDialog === 'function');
    },
    canOpenPath() {
      return !!(shell && typeof shell.openPath === 'function');
    },
    hasWebviewSession() {
      return !!(session && typeof session.fromPartition === 'function');
    },
    pickDirectory(options) {
      if (!this.canPickDir()) return Promise.reject(new Error('no_native'));
      return dialog.showOpenDialog(options);
    },
    openPath(dir) {
      if (!this.canOpenPath()) return Promise.reject(new Error('no_native'));
      return shell.openPath(dir);
    },
    setCookie(partition, cookie) {
      return getPartition(partition).cookies.set(cookie);
    },
    getCookies(partition, filter) {
      return getPartition(partition).cookies.get(filter || {});
    },
    removeCookie(partition, url, name) {
      return getPartition(partition).cookies.remove(url, name);
    }
  };
}

module.exports = {
  createNullNativeBridge,
  createElectronNativeBridge
};
