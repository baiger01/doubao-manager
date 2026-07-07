function buildBaseUrl(port) {
  return `http://127.0.0.1:${port}/ext`;
}

function listLanUrls(port) {
  try {
    const os = require('os');
    const nets = os.networkInterfaces();
    const urls = [];
    for (const name of Object.keys(nets)) {
      for (const iface of nets[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          urls.push(`http://${iface.address}:${port}/ext`);
        }
      }
    }
    return urls;
  } catch (e) { return []; }
}

function buildApiAccessData(cfg, { port, lanUrls } = {}) {
  return {
    enabled: cfg.enabled,
    token: cfg.token,
    createdAt: cfg.createdAt,
    lastUsedAt: cfg.lastUsedAt,
    baseUrl: buildBaseUrl(port),
    lanHints: lanUrls || listLanUrls(port)
  };
}

function buildMcpData(cfg, {
  port,
  mcpServerFile,
  isPackaged = false,
  execPath = process.execPath,
  serverExists = false
} = {}) {
  const baseUrl = buildBaseUrl(port);
  const command = isPackaged ? execPath : 'node';
  const baseEnv = { LULU_URL: baseUrl, LULU_TOKEN: cfg.token };
  const env = isPackaged ? Object.assign({ ELECTRON_RUN_AS_NODE: '1' }, baseEnv) : baseEnv;
  const esc = (s) => String(s).replace(/\\/g, '\\\\');

  const claudeSnippet = JSON.stringify({
    mcpServers: {
      lulu: { command, args: [mcpServerFile], env }
    }
  }, null, 2);

  const envToml = Object.entries(env).map(([k, v]) => `${k} = "${esc(v)}"`).join(', ');
  const codexSnippet = [
    '[mcp_servers.lulu]',
    `command = "${esc(command)}"`,
    `args = ["${esc(mcpServerFile)}"]`,
    `env = { ${envToml} }`
  ].join('\n');

  return {
    enabled: cfg.enabled,
    hasToken: !!cfg.token,
    serverPath: mcpServerFile,
    serverExists,
    baseUrl,
    command,
    tools: ['generate_image', 'generate_video', 'chat_doubao', 'get_status', 'list_accounts', 'list_jobs'],
    snippets: {
      claude: claudeSnippet,
      codex: codexSnippet
    }
  };
}

module.exports = {
  buildBaseUrl,
  listLanUrls,
  buildApiAccessData,
  buildMcpData,
};
