const test = require('node:test');
const assert = require('node:assert/strict');

const ProxyPolicy = require('../services/proxy-policy');

test('proxy policy keeps doubao direct even when a proxy is present in config', () => {
  const config = {
    platforms: {
      doubao: { proxy: 'http://127.0.0.1:7897', proxyMode: 'manual' },
      dola: { proxy: 'http://127.0.0.1:7897', proxyMode: 'manual' }
    }
  };
  const policy = new ProxyPolicy(config);

  assert.equal(policy.isProxyAllowed('doubao'), false);
  assert.equal(policy.getProxy('doubao'), '');
  assert.equal(policy.getPublicConfig('doubao').proxy, '');
  assert.equal(policy.getPublicConfig('doubao').mode, 'none');
});

test('proxy policy allows only Dola to use configured proxy', () => {
  const config = {
    platforms: {
      doubao: { proxy: 'http://127.0.0.1:7897' },
      dola: { proxy: 'http://127.0.0.1:7897' }
    }
  };
  const policy = new ProxyPolicy(config);

  assert.equal(policy.getProxy('dola'), 'http://127.0.0.1:7897');
  assert.equal(policy.getPublicConfig('dola').mode, 'manual');
});

test('proxy policy auto-detect stores the first working Dola candidate only', async () => {
  const config = {
    platforms: {
      dola: {
        proxyMode: 'auto',
        proxyCandidates: ['http://127.0.0.1:7890', 'http://127.0.0.1:7897']
      }
    }
  };
  const attempts = [];
  const policy = new ProxyPolicy(config);

  const result = await policy.detect('dola', async (candidate) => {
    attempts.push(candidate);
    return candidate.endsWith(':7897');
  });

  assert.deepEqual(attempts, ['http://127.0.0.1:7890', 'http://127.0.0.1:7897']);
  assert.deepEqual(result, { proxy: 'http://127.0.0.1:7897' });
  assert.equal(config.platforms.dola.proxy, 'http://127.0.0.1:7897');
  assert.equal(config.platforms.dola.proxyMode, 'auto');
});

test('proxy policy rejects proxy mutation for doubao', () => {
  const policy = new ProxyPolicy({ platforms: { doubao: {} } });

  assert.throws(
    () => policy.setProxy('doubao', 'http://127.0.0.1:7897', 'manual'),
    /豆包不允许配置代理/
  );
});
