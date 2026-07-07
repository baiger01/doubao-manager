const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function importWebModule(rel) {
  const file = path.resolve(__dirname, '..', rel);
  return import(pathToFileURL(file).href + '?t=' + Date.now());
}

test('accounts modal contract keeps a primary add-account action in the header', async () => {
  const contract = await importWebModule('web/src/lib/accounts-modal-contract.js');

  assert.equal(contract.ADD_ACCOUNT_MAIN_CLASS, 'btn-add-account-main');
  assert.equal(contract.ADD_ACCOUNT_MAIN_LABEL, '+ 添加账号');
  assert.equal(
    contract.getDefaultAddAccountPlatform('dola', [{ key: 'doubao' }]),
    'dola'
  );
  assert.equal(
    contract.getDefaultAddAccountPlatform('', [{ key: 'plus' }]),
    'plus'
  );
  assert.equal(contract.getDefaultAddAccountPlatform('', []), 'doubao');
});

test('accounts modal contract hides normal add-account action for Orion and exposes local auth actions', async () => {
  const contract = await importWebModule('web/src/lib/accounts-modal-contract.js');
  const orion = {
    key: 'orion',
    label: 'Orion',
    requiresAccount: false,
    hasVideoApi: true,
    supportsVideo: true,
    supportsImage: false,
  };
  const plus = {
    key: 'plus',
    label: 'plus',
    requiresAccount: false,
    hasImageApi: true,
    supportsImage: true,
    supportsVideo: false,
  };
  const doubao = {
    key: 'doubao',
    label: '豆包',
    requiresAccount: true,
    supportsImage: true,
    supportsVideo: true,
  };

  assert.equal(contract.platformRequiresAccount(orion), false);
  assert.equal(contract.shouldShowPlatformAddAccount(orion), false);
  assert.equal(contract.shouldShowOrionAuthActions(orion), true);
  assert.equal(contract.getAccountlessPlatformHint(orion), 'Orion 使用本地授权，不需要添加账号');

  assert.equal(contract.platformRequiresAccount(plus), false);
  assert.equal(contract.shouldShowPlatformAddAccount(plus), false);
  assert.equal(contract.shouldShowOrionAuthActions(plus), false);

  assert.equal(contract.platformRequiresAccount(doubao), true);
  assert.equal(contract.shouldShowPlatformAddAccount(doubao), true);
  assert.equal(contract.shouldShowOrionAuthActions(doubao), false);
});

test('accounts modal contract limits batch auto-login to Dola', async () => {
  const contract = await importWebModule('web/src/lib/accounts-modal-contract.js');
  const platforms = [
    { key: 'doubao', label: '豆包' },
    { key: 'dola', label: 'Dola' },
    { key: 'plus', label: 'Plus' },
  ];

  assert.deepEqual(contract.getAutoLoginPlatforms(platforms), [{ key: 'dola', label: 'Dola' }]);
  assert.deepEqual(contract.getAutoLoginTarget(platforms), { key: 'dola', label: 'Dola' });
  assert.deepEqual(contract.getAutoLoginTarget([]), { key: 'dola', label: 'Dola' });
  assert.equal(contract.AUTO_LOGIN_HINT, '仅支持 Dola 谷歌账号自动登录');
});

test('auto-login progress contract preserves kept-open failure details', async () => {
  const contract = await importWebModule('web/src/lib/accounts-modal-contract.js');
  const item = contract.normalizeAutoLoginProgressItem({
    email: 'a@example.com',
    status: 'failed',
    message: '登录失败，停在验证码页',
    accountId: 'acc-1',
    browserKeptOpen: true,
    stage: 'google_login',
    reason: 'captcha',
  });

  assert.deepEqual(item, {
    email: 'a@example.com',
    status: 'failed',
    message: '登录失败，停在验证码页',
    accountId: 'acc-1',
    browserKeptOpen: true,
    stage: 'google_login',
    reason: 'captcha',
  });
  assert.equal(contract.shouldShowKeptBrowserBadge(item), true);
  assert.equal(contract.getAutoLoginMessageTitle(item), '登录失败，停在验证码页');
  assert.equal(contract.AUTO_LOGIN_KEPT_BROWSER_BADGE_LABEL, '浏览器已保留');
});

test('auto-login failure message CSS allows full details instead of ellipsis', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'styles', 'global.css'), 'utf8');
  const aliMsgRule = css.match(/\.auto-login-item \.ali-msg\s*\{[^}]+\}/)?.[0] || '';

  assert.match(aliMsgRule, /white-space:\s*normal/);
  assert.doesNotMatch(aliMsgRule, /text-overflow:\s*ellipsis/);
});
