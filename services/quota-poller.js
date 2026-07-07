const { WS_EVENTS } = require('./ws-events');

class QuotaPoller {
  constructor(cdpManager, accountManager, config) {
    this.accounts = accountManager;
    this.config = config;
    this.interval = null;
    this.wss = null;
  }

  // 启动（目前只做额度耗尽检查，不主动轮询doubao页面）
  start(wss) {
    this.wss = wss;
    const intervalMs = this.config.polling.intervalMs || 60000;

    // 定时检查是否有账号额度耗尽需要切换
    this.interval = setInterval(() => {
      this.checkExhausted();
    }, intervalMs);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  // 检查是否有账号标记为额度耗尽，触发自动切换
  checkExhausted() {
    const active = this.accounts.getActive();
    if (!active) return;

    // 如果当前活跃账号已耗尽，自动切换
    if (active.status === 'quota_exhausted' && this.config.polling.autoSwitchOnExhausted) {
      const next = this.accounts.autoSwitch();
      if (next) {
        this.broadcast({
          type: WS_EVENTS.ACCOUNT_SWITCH,
          data: {
            reason: 'quota_exhausted',
            previousId: active.id,
            newAccount: { id: next.id, name: next.name }
          }
        });
      } else {
        this.broadcast({
          type: WS_EVENTS.ALL_EXHAUSTED,
          data: { message: '所有账号额度已耗尽' }
        });
      }
    }
  }

  // 外部调用：当生成结果中解析到额度信息时更新
  updateFromResponse(accountId, quota) {
    if (quota === null || quota === undefined) return;

    const prevAccount = this.accounts.getById(accountId);
    const prevQuota = prevAccount?.quota?.videoRemaining;

    this.accounts.updateQuota(accountId, { videoRemaining: quota });

    // 额度变化时通知前端
    if (prevQuota !== quota) {
      this.broadcast({
        type: WS_EVENTS.QUOTA_UPDATE,
        data: { accountId, quota }
      });
    }

    // 额度耗尽处理
    if (quota === 0 && this.config.polling.autoSwitchOnExhausted) {
      this.accounts.markExhausted(accountId);
      // 只在同平台内切换，避免串到别的平台账号
      const platform = prevAccount?.platform || 'doubao';
      const next = this.accounts.autoSwitch(platform);
      if (next) {
        this.broadcast({
          type: WS_EVENTS.ACCOUNT_SWITCH,
          data: {
            reason: 'quota_exhausted',
            previousId: accountId,
            newAccount: { id: next.id, name: next.name }
          }
        });
      } else {
        this.broadcast({
          type: WS_EVENTS.ALL_EXHAUSTED,
          data: { message: '所有账号额度已耗尽' }
        });
      }
    }
  }

  // 广播消息到所有WebSocket客户端
  broadcast(message) {
    if (!this.wss) return;
    const data = JSON.stringify(message);
    this.wss.clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(data);
      }
    });
  }

  // 获取所有账号额度状态
  getQuotaStatus() {
    return this.accounts.getAll().map(a => ({
      id: a.id,
      name: a.name,
      status: a.status,
      quota: a.quota,
      isActive: a.isActive
    }));
  }
}

module.exports = QuotaPoller;
