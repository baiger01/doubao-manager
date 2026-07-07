const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const logModuleUrl = pathToFileURL(path.resolve(__dirname, '..', 'web', 'src', 'lib', 'status-log.js')).href;
const storePath = path.resolve(__dirname, '..', 'web', 'src', 'store.jsx');
const appPath = path.resolve(__dirname, '..', 'web', 'src', 'App.jsx');
const navRailPath = path.resolve(__dirname, '..', 'web', 'src', 'components', 'NavRail.jsx');
const logPanelPath = path.resolve(__dirname, '..', 'web', 'src', 'components', 'LogPanel.jsx');

test('status log appends bounded timestamped entries', async () => {
  const { appendStatusLog, MAX_STATUS_LOG_ITEMS } = await import(logModuleUrl);
  let items = [];
  for (let i = 0; i < MAX_STATUS_LOG_ITEMS + 5; i++) {
    items = appendStatusLog(items, { type: 'ready', text: `状态 ${i}`, source: 'test' }, 1000 + i);
  }

  assert.equal(items.length, MAX_STATUS_LOG_ITEMS);
  assert.equal(items[0].text, '状态 5');
  assert.equal(items.at(-1).time, 1000 + MAX_STATUS_LOG_ITEMS + 4);
});

test('store records status and toast messages for the log view', () => {
  const source = fs.readFileSync(storePath, 'utf8');

  assert.match(source, /useLogPanelState/);
  assert.match(source, /statusLog/);
  assert.match(source, /appendStatusLog/);
  assert.match(source, /clearStatusLog/);
  assert.match(source, /source:\s*'toast'/);
  assert.match(source, /source:\s*'status'/);
});

test('left rail exposes grok and keeps logs as the last rail item', () => {
  const app = fs.readFileSync(appPath, 'utf8');
  const nav = fs.readFileSync(navRailPath, 'utf8');
  const panel = fs.readFileSync(logPanelPath, 'utf8');
  const tools = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'lib', 'webTools.jsx'), 'utf8');

  assert.match(app, /import LogPanel/);
  assert.match(app, /view === 'logs'/);
  assert.match(tools, /key: 'grok'/);
  assert.match(tools, /label: 'Grok'/);
  assert.match(nav, /setView\('logs'\)/);
  assert.match(nav, /setView\('claude'\)/);
  assert.ok(nav.indexOf('key="claude"') < nav.indexOf('key="logs"'));
  assert.ok(nav.indexOf("setView('claude')") < nav.indexOf("setView('logs')"));
  assert.match(panel, /log-panel/);
  assert.match(panel, /clearStatusLog/);
});


