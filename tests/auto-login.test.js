const test = require('node:test');
const assert = require('node:assert/strict');
const AutoLogin = require('../services/auto-login');

function sessionWithCookies(cookies) {
  return {
    async call(method) {
      assert.equal(method, 'Network.getAllCookies');
      return { cookies };
    }
  };
}

test('auto-login recognises Dola auth cookie variants as logged-in state', async () => {
  const auto = new AutoLogin(null);

  assert.equal(await auto._hasLoginCookie(sessionWithCookies([
    { domain: '.dola.com', name: 'oauth_token', value: 'token' }
  ])), true);

  assert.equal(await auto._hasLoginCookie(sessionWithCookies([
    { domain: '.dola.com', name: 'passport_auth_status_ss', value: '1' }
  ])), true);

  assert.equal(await auto._hasLoginCookie(sessionWithCookies([
    { domain: '.dola.com', name: 'uid_tt_ss', value: 'uid' }
  ])), true);
});

test('auto-login does not treat generic Dola visitor cookies as logged-in state', async () => {
  const auto = new AutoLogin(null);

  assert.equal(await auto._hasLoginCookie(sessionWithCookies([
    { domain: '.dola.com', name: 'msToken', value: 'visitor' },
    { domain: '.dola.com', name: 's_v_web_id', value: 'visitor' }
  ])), false);
});

test('auto-login classifies Google cannot-continue pages as fatal', () => {
  const auto = new AutoLogin(null);

  assert.match(
    auto._getGoogleFatalReason('出了点问题，无法继续。请稍后再试。'),
    /Google/
  );

  assert.match(
    auto._getGoogleFatalReason('This browser or app may not be secure. Try using a different browser.'),
    /Google/
  );
});

test('auto-login does not auto-click risky Google acknowledgement buttons', () => {
  const auto = new AutoLogin(null);

  assert.equal(
    auto._shouldAutoClickGoogleButton('我了解', 'Google 检测到此浏览器或应用可能不安全。点击我了解继续。'),
    false
  );

  assert.equal(
    auto._shouldAutoClickGoogleButton('I understand', "Google hasn't verified this app. Continue only if you understand the risk."),
    false
  );
});

test('auto-login still auto-clicks safe Google consent buttons', () => {
  const auto = new AutoLogin(null);

  assert.equal(auto._shouldAutoClickGoogleButton('继续', 'Dola 想要访问你的 Google 账号信息。'), true);
  assert.equal(auto._shouldAutoClickGoogleButton('Allow', 'Dola wants to access your Google Account.'), true);
  assert.equal(auto._shouldAutoClickGoogleButton('我了解', '请确认你已年满 18 岁。'), true);
});

test('auto-login recognises password-stage google pages from page text before visible input probing succeeds', () => {
  const auto = new AutoLogin(null);

  assert.equal(auto._isGooglePasswordInputVisible('欢迎，请输入您的密码以继续', []), true);
  assert.equal(auto._isGooglePasswordInputVisible('Welcome, Enter your password', []), true);
  assert.equal(auto._isGooglePasswordInputVisible('选择账号继续登录', []), false);
});

test('auto-login intermediate action auto-clicks safe consent pages before password step', () => {
  const auto = new AutoLogin(null);

  assert.deepEqual(
    auto._getGoogleIntermediateAction({
      text: 'Dola 想要访问你的 Google 账号信息。',
      buttons: [{ text: '继续' }]
    }),
    { type: 'click', buttonText: '继续' }
  );
});

test('auto-login intermediate action still blocks risky google acknowledgement pages', () => {
  const auto = new AutoLogin(null);
  const action = auto._getGoogleIntermediateAction({
    text: 'Google 检测到此浏览器或应用可能不安全。点击我了解继续。',
    buttons: [{ text: '我了解' }]
  });

  assert.equal(action.type, 'fatal');
  assert.match(action.message, /Google/);
});
test('auto-login builds manual-attention errors that keep the browser open with stage metadata', () => {
  const auto = new AutoLogin(null);

  const err = auto._manualAttentionError(
    'google_after_password',
    'Google 密码提交后停在验证/风控页面',
    { reason: 'manual_attention_required' }
  );

  assert.equal(err.keepBrowserOpen, true);
  assert.equal(err.stage, 'google_after_password');
  assert.equal(err.reason, 'manual_attention_required');
  assert.match(err.message, /Google 密码提交后/);
  assert.match(err.message, /浏览器已保留/);
});

