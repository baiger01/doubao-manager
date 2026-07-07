class ResultPersistenceService {
  constructor(conversationManager, mediaDownloader) {
    this.conversationManager = conversationManager;
    this.mediaDownloader = mediaDownloader;
  }

  async saveResult({ conversationId, platform, accountId, prompt, type, results }) {
    const submittedConv = conversationId && typeof this.conversationManager.getById === 'function'
      ? this.conversationManager.getById(conversationId)
      : null;
    if (conversationId && !submittedConv) return false;
    const targetPlatform = (submittedConv && Object.prototype.hasOwnProperty.call(submittedConv, 'platform')) ? (submittedConv.platform || 'doubao') : (platform || 'doubao');
    const targetAccountId = submittedConv && Object.prototype.hasOwnProperty.call(submittedConv, 'accountId') ? (submittedConv.accountId || '') : (accountId || '');
    const conv = submittedConv || this.conversationManager.ensureActive(targetPlatform, targetAccountId);
    if (!conv) return false;

    let urls = type === 'video' ? (results.videos || []) : (results.images || []);
    if (this.mediaDownloader && urls.length > 0) {
      try {
        urls = await this.mediaDownloader.downloadUrls(urls, {
          platform: targetPlatform,
          accountId: targetAccountId,
          type
        });
      } catch (e) {
        // 下载整体失败时保留原始 CDN 链接兜底，避免落库流程把生成结果吞掉。
      }
    }

    this.conversationManager.addResult(conv.id, {
      prompt,
      type,
      platform: targetPlatform,
      accountId: targetAccountId,
      urls,
      brief: results.brief || ''
    });
    return true;
  }
}

module.exports = ResultPersistenceService;
