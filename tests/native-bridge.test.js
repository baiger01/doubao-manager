const test = require('node:test');
const assert = require('node:assert/strict');

const { createNullNativeBridge, createElectronNativeBridge } = require('../services/native-bridge');

test('null native bridge reports unavailable native capabilities', async () => {
  const bridge = createNullNativeBridge();

  assert.equal(bridge.canPickDir(), false);
  assert.equal(bridge.canOpenPath(), false);
  assert.equal(bridge.hasWebviewSession(), false);
  await assert.rejects(() => bridge.pickDirectory({}), /no_native/);
});

test('electron native bridge wraps dialog, shell, and partition cookies', async () => {
  const calls = [];
  const cookies = {
    async set(cookie) { calls.push({ method: 'set', cookie }); },
    async get(filter) { calls.push({ method: 'get', filter }); return [{ name: 'sid' }]; },
    async remove(url, name) { calls.push({ method: 'remove', url, name }); }
  };
  const bridge = createElectronNativeBridge({
    dialog: {
      async showOpenDialog(options) {
        calls.push({ method: 'showOpenDialog', options });
        return { canceled: false, filePaths: ['D:\\Downloads'] };
      }
    },
    shell: {
      async openPath(dir) {
        calls.push({ method: 'openPath', dir });
        return '';
      }
    },
    session: {
      fromPartition(partition) {
        calls.push({ method: 'fromPartition', partition });
        return { cookies };
      }
    }
  });

  assert.equal(bridge.canPickDir(), true);
  assert.equal(bridge.canOpenPath(), true);
  assert.equal(bridge.hasWebviewSession(), true);
  assert.deepEqual(await bridge.pickDirectory({ title: 'Pick' }), { canceled: false, filePaths: ['D:\\Downloads'] });
  await bridge.openPath('D:\\Downloads');
  await bridge.setCookie('persist:test', { name: 'sid', value: '1' });
  assert.deepEqual(await bridge.getCookies('persist:test', {}), [{ name: 'sid' }]);
  await bridge.removeCookie('persist:test', 'https://example.com/', 'sid');

  assert.deepEqual(calls.map(call => call.method), [
    'showOpenDialog',
    'openPath',
    'fromPartition',
    'set',
    'fromPartition',
    'get',
    'fromPartition',
    'remove'
  ]);
});
