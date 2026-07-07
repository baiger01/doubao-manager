const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const {
  buildPortCandidates,
  listenWithPortFallback,
  resolveListenOptions
} = require('../server');

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('bundled server config listens on loopback by default', () => {
  const configPath = path.resolve(__dirname, '..', 'config', 'config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  assert.equal(config.server.host, '127.0.0.1');
});

test('server startup normalizes legacy wildcard host and prepares fallback ports', () => {
  const options = resolveListenOptions({
    server: {
      port: 9527,
      host: '0.0.0.0'
    }
  }, {});

  assert.equal(options.host, '127.0.0.1');
  assert.equal(options.port, 9527);
  assert.equal(options.fallbackCount, 20);
  assert.deepEqual(buildPortCandidates(options.port, 3), [9527, 9528, 9529, 9530]);
});

test('embedded server falls back when preferred port is already occupied', async () => {
  const blocker = http.createServer((_req, res) => res.end('busy'));
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busyPort = blocker.address().port;
  const server = http.createServer((_req, res) => res.end('ok'));

  try {
    const result = await listenWithPortFallback(server, {
      port: busyPort,
      host: '127.0.0.1',
      fallbackCount: 5
    });

    assert.notEqual(result.port, busyPort);
    assert.ok(result.port > busyPort);
    assert.ok(result.port <= busyPort + 5);

    const response = await fetch(`http://127.0.0.1:${result.port}/`);
    assert.equal(await response.text(), 'ok');
  } finally {
    await closeServer(server);
    await closeServer(blocker);
  }
});
