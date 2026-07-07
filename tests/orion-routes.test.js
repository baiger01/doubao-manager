const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function buildUpstream(handler) {
  const app = express();
  app.use(express.json());
  app.all('*', handler);
  return app;
}

function buildRouter(config) {
  const buildOrionRoutes = require('../routes/orion');
  const app = express();
  app.use(express.json());
  app.use('/api/orion', buildOrionRoutes(config));
  return app;
}

test('orion status reports cookie availability and login url from local health', async () => {
  await withServer(buildUpstream((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/health');
    res.json({
      ok: true,
      default_cookie_file_exists: true,
      default_login_url: 'https://effect.douyin.com/ac/login-orion'
    });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            authBaseUrl: `http://127.0.0.1:${upstreamPort}`,
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/status`);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.authenticated, true);
      assert.equal(payload.data.loginUrl, 'https://effect.douyin.com/ac/login-orion');
    });
  });
});

test('orion status does not treat a cookie file without login cookies as authenticated', async () => {
  await withServer(buildUpstream((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/health');
    res.json({
      ok: true,
      default_cookie_file_exists: true,
      default_cookie_login_ready: false,
      default_cookie_login_cookie_names: [],
      default_login_url: 'https://effect.douyin.com/ac/login-orion'
    });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            authBaseUrl: `http://127.0.0.1:${upstreamPort}`,
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/status`);
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.authenticated, false);
      assert.equal(payload.data.cookieFileExists, true);
      assert.equal(payload.data.hasLoginCookie, false);
      assert.match(payload.data.action, /回传登录态|手动 Cookie/);
    });
  });
});

test('orion routes proxy open-login to configured local Orion auth API', async () => {
  const requests = [];
  await withServer(buildUpstream((req, res) => {
    requests.push({ method: req.method, path: req.path, body: req.body });
    res.json({ ok: true, opened: true });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            type: 'orion-local',
            authBaseUrl: `http://127.0.0.1:${upstreamPort}`,
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/open-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browser: 'chrome', profile: 'Default' })
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.deepEqual(payload.data, { ok: true, opened: true });
    });
  });

  assert.deepEqual(requests, [{
    method: 'POST',
    path: '/auth/open-login',
    body: { browser: 'chrome', profile: 'Default' },
  }]);
});

test('orion routes translate unfinished login export errors into actionable Chinese guidance', async () => {
  await withServer(buildUpstream((req, res) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/auth/export-browser-cookies');
    res.status(500).json({
      error: "ValueError('not logged in: no sessionid/sid_tt/uid_tt cookie found; complete Douyin login in the opened login page, then retry export')"
    });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            authBaseUrl: `http://127.0.0.1:${upstreamPort}`,
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/export-browser-cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.equal(payload.success, false);
      assert.match(payload.error, /Orion 登录未完成/);
      assert.match(payload.action, /手机确认|验证码登录|手动 Cookie/);
      assert.match(payload.data.rawError, /not logged in/);
    });
  });
});

test('orion routes proxy manual set-cookie to local Orion auth API', async () => {
  const requests = [];
  await withServer(buildUpstream((req, res) => {
    requests.push({ method: req.method, path: req.path, body: req.body });
    res.json({ ok: true, cookie_file: 'orion_cookie.json', cookie_count: 3, source: 'api' });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            authBaseUrl: `http://127.0.0.1:${upstreamPort}`,
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/set-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookieHeader: 'sessionid=abc; sid_tt=def; uid_tt=ghi' })
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.cookie_count, 3);
    });
  });

  assert.deepEqual(requests, [{
    method: 'POST',
    path: '/auth/set-cookie',
    body: { cookie_header: 'sessionid=abc; sid_tt=def; uid_tt=ghi' },
  }]);
});

test('orion routes reject empty manual cookie before calling local API', async () => {
  let called = false;
  await withServer(buildUpstream((_req, res) => {
    called = true;
    res.json({ ok: true });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            authBaseUrl: `http://127.0.0.1:${upstreamPort}`,
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/set-cookie`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookieHeader: '' })
      });
      const payload = await response.json();

      assert.equal(response.status, 400);
      assert.equal(payload.success, false);
      assert.match(payload.error, /Cookie/);
    });
  });

  assert.equal(called, false);
});

test('orion routes proxy export-browser-cookies using endpoint origin when authBaseUrl is omitted', async () => {
  const requests = [];
  await withServer(buildUpstream((req, res) => {
    requests.push({ method: req.method, path: req.path, body: req.body });
    res.json({ ok: true, cookie_count: 20, domains: ['douyin.com'] });
  }), async (upstreamPort) => {
    const config = {
      platforms: {
        orion: {
          videoApi: {
            type: 'orion-local',
            endpoint: `http://127.0.0.1:${upstreamPort}/generate`,
          }
        }
      }
    };

    await withServer(buildRouter(config), async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/orion/export-browser-cookies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.success, true);
      assert.equal(payload.data.cookie_count, 20);
      assert.deepEqual(payload.data.domains, ['douyin.com']);
    });
  });

  assert.deepEqual(requests, [{
    method: 'POST',
    path: '/auth/export-browser-cookies',
    body: { browser: 'chrome', profile: 'Default' },
  }]);
});
