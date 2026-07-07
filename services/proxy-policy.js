const DEFAULT_CANDIDATES = Object.freeze([
  'http://127.0.0.1:7897',
  'http://127.0.0.1:7890',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:1080'
]);

class ProxyPolicy {
  constructor(config) {
    this.config = config || {};
  }

  getPlatform(platform) {
    const platforms = this.config.platforms || {};
    return platforms[platform] || null;
  }

  isProxyAllowed(platform) {
    return platform === 'dola';
  }

  normalizeMode(platform, pc) {
    if (!this.isProxyAllowed(platform)) return 'none';
    const mode = pc && pc.proxyMode;
    if (mode === 'auto' || mode === 'manual' || mode === 'none') return mode;
    return pc && pc.proxy ? 'manual' : 'auto';
  }

  getProxy(platform) {
    const pc = this.getPlatform(platform);
    if (!pc || !this.isProxyAllowed(platform)) return '';
    if (this.normalizeMode(platform, pc) === 'none') return '';
    return String(pc.proxy || '').trim();
  }

  getCandidates(platform) {
    const pc = this.getPlatform(platform);
    if (!this.isProxyAllowed(platform)) return [];
    const configured = Array.isArray(pc?.proxyCandidates) ? pc.proxyCandidates : [];
    const candidates = [...configured, ...(pc?.proxy ? [pc.proxy] : []), ...DEFAULT_CANDIDATES]
      .map(v => String(v || '').trim())
      .filter(Boolean);
    return [...new Set(candidates)];
  }

  validateProxyUrl(value) {
    const proxy = String(value || '').trim();
    if (!proxy) return '';
    let parsed;
    try {
      parsed = new URL(proxy);
    } catch (e) {
      throw new Error('代理地址格式不对，应形如 http://127.0.0.1:7897');
    }
    if (parsed.protocol !== 'http:') {
      throw new Error('当前仅支持 HTTP 代理，例如 http://127.0.0.1:7897');
    }
    return proxy;
  }

  setProxy(platform, proxy, mode = 'manual') {
    const pc = this.getPlatform(platform);
    if (!pc) throw new Error('平台不存在');
    if (!this.isProxyAllowed(platform)) throw new Error('豆包不允许配置代理，必须直连');
    if (mode !== 'auto' && mode !== 'manual' && mode !== 'none') throw new Error('无效的代理模式');

    pc.proxyMode = mode;
    if (mode === 'none') {
      delete pc.proxy;
      return { platform, mode, proxy: '' };
    }

    const val = this.validateProxyUrl(proxy);
    if (val) pc.proxy = val;
    else delete pc.proxy;
    return { platform, mode, proxy: pc.proxy || '' };
  }

  async detect(platform, tester) {
    const pc = this.getPlatform(platform);
    if (!pc) throw new Error('平台不存在');
    if (!this.isProxyAllowed(platform)) throw new Error('豆包不允许配置代理，必须直连');
    if (typeof tester !== 'function') throw new Error('缺少代理检测器');

    for (const candidate of this.getCandidates(platform)) {
      if (await tester(candidate)) {
        pc.proxyMode = 'auto';
        pc.proxy = candidate;
        return { proxy: candidate };
      }
    }
    return null;
  }

  getPublicConfig(platform) {
    const pc = this.getPlatform(platform) || {};
    const allowed = this.isProxyAllowed(platform);
    return {
      platform,
      allowed,
      mode: allowed ? this.normalizeMode(platform, pc) : 'none',
      proxy: allowed ? this.getProxy(platform) : '',
      candidates: allowed ? this.getCandidates(platform) : []
    };
  }
}

module.exports = ProxyPolicy;
