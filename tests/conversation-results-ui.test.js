const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const moduleUrl = pathToFileURL(path.resolve(__dirname, '..', 'web', 'src', 'lib', 'conversation-results.js')).href;
const storePath = path.resolve(__dirname, '..', 'web', 'src', 'store.jsx');
const domainPath = path.resolve(__dirname, '..', 'web', 'src', 'domains', 'conversation-generation-domain.js');
const claudeDomainPath = path.resolve(__dirname, '..', 'web', 'src', 'domains', 'claude-chat-domain.js');
const licenseDomainPath = path.resolve(__dirname, '..', 'web', 'src', 'domains', 'license-domain.js');
const accountBulkDomainPath = path.resolve(__dirname, '..', 'web', 'src', 'domains', 'account-bulk-domain.js');

test('visible conversation results include only pending jobs for the active conversation', async () => {
  const { withConversationPendingBatches } = await import(moduleUrl);
  const history = [{ id: 'hist-1', kind: 'result', _hist: true }];
  const visible = withConversationPendingBatches(history, {
    'job-a': {
      conversationId: 'conv-a',
      prompt: 'draw a',
      mode: 'image',
      ratioStr: '1:1',
      startTime: 1000,
      reply: 'working',
      snapshot: { prompt: 'draw a' }
    },
    'job-b': {
      conversationId: 'conv-b',
      prompt: 'draw b',
      mode: 'video',
      ratioStr: '16:9',
      startTime: 2000
    }
  }, 'conv-a', 61000);

  assert.deepEqual(visible.map(b => b.id), ['hist-1', 'job-a']);
  assert.equal(visible[1].kind, 'generating');
  assert.equal(visible[1].elapsed, 60);
  assert.equal(visible[1].reply, 'working');
  assert.equal(visible[1].count, 4);
});

test('pending image placeholder count follows submitted image count when provided', async () => {
  const { pendingJobToBatch } = await import(moduleUrl);
  const batch = pendingJobToBatch('job-count', {
    conversationId: 'conv-a',
    prompt: 'draw four',
    mode: 'image',
    ratioStr: '1:1',
    startTime: 1000,
    count: 3
  }, 61000);

  assert.equal(batch.kind, 'generating');
  assert.equal(batch.count, 3);
});

test('visible conversation results clear old history when switching to an empty conversation', async () => {
  const { withConversationPendingBatches } = await import(moduleUrl);
  const visible = withConversationPendingBatches([], {
    'job-a': { conversationId: 'conv-a', prompt: 'draw a', mode: 'image', ratioStr: '1:1', startTime: 1000 }
  }, 'conv-empty', 61000);

  assert.deepEqual(visible, []);
});

test('pending job placeholder is not appended after switching away during submit', async () => {
  const { appendPendingBatchIfActive } = await import(moduleUrl);
  const visible = appendPendingBatchIfActive(
    [{ id: 'hist-current', kind: 'result', _hist: true }],
    'job-a',
    { conversationId: 'conv-submitted', prompt: 'draw a', mode: 'image', ratioStr: '1:1', startTime: 1000 },
    'conv-current',
    1000
  );

  assert.deepEqual(visible.map(b => b.id), ['hist-current']);
});

test('jobs without conversation ownership no longer match arbitrary active conversations', async () => {
  const { jobMatchesConversation } = await import(moduleUrl);
  assert.equal(jobMatchesConversation({ prompt: 'draw' }, 'conv-a'), false);
  assert.equal(jobMatchesConversation({ conversationId: 'conv-a' }, 'conv-a'), true);
});

test('store keeps stale-load protection through the extracted conversation domain', () => {
  const source = fs.readFileSync(storePath, 'utf8');
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(source, /resultsLoadSeqRef/);
  assert.match(domain, /loadSeq !== resultsLoadSeqRef\.current/);
});

test('selecting the active conversation refreshes its results instead of returning stale UI', () => {
  const source = fs.readFileSync(storePath, 'utf8');

  assert.match(source, /activeConvRef\.current && activeConvRef\.current\.id === id/);
  assert.match(source, /await loadConversationResults\(activeConvRef\.current\)/);
});

test('generation domain guards pending placeholder append by active conversation', () => {
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(domain, /appendPendingBatchIfActive/);
});

test('generation domain rebuilds visible results with the newly submitted pending job', () => {
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(domain, /const next = \{ \.\.\.prev, \[jobId\]: pendingJob \}/);
  assert.match(domain, /rebuildVisibleResults\(activeConvRef\.current,\s*next\)/);
  assert.doesNotMatch(domain, /queueMicrotask\(\(\) => rebuildVisibleResults\(activeConvRef\.current\)\)/);
});

test('conversation domain keeps a completed job visible before persisted history reload finishes', () => {
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(domain, /const doneBatch = \{/);
  assert.match(domain, /setResults\(prev => \{/);
  assert.match(domain, /filter\(item => item\.id !== data\.jobId\)/);
  assert.match(domain, /queueMicrotask\(\(\) => loadConversationResults\(activeConvRef\.current\)\)/);
});
test('conversation domain no longer treats unknown completed jobs as active by default', () => {
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(domain, /const eventConversationId = data\.conversationId \|\| ''/);
  assert.match(domain, /const activeConversationId = activeConvRef\.current\?\.id \|\| ''/);
  assert.match(domain, /const isActiveJob = job \? jobMatchesConversation\(job, activeConversationId\) : \(!!eventConversationId && eventConversationId === activeConversationId\)/);
});

test('generation domain allows accountless custom image platforms to submit without login cookies', () => {
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(domain, /requiresAccount\s*===\s*false/);
  assert.match(domain, /accountId:\s*acct\?\.id\s*\|\|\s*''/);
  assert.match(domain, /supportsAccountlessMode/);
  assert.match(domain, /accountlessReferenceImageMessage/);
});

test('store treats accountless API platforms as connected without login cookies', () => {
  const source = fs.readFileSync(storePath, 'utf8');

  assert.match(source, /accountless\s*=\s*platformCfg\?\.\s*requiresAccount\s*===\s*false/);
  assert.match(source, /setConnected\(accountless\s*\|\|\s*conn\)/);
});

test('generation domain forwards selected image count to image generation requests and pending placeholders', () => {
  const source = fs.readFileSync(storePath, 'utf8');
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(source, /imageCount:\s*1/);
  assert.match(domain, /supportsImageCount/);
  assert.match(domain, /body\.n\s*=\s*imageCount/);
  assert.match(domain, /count:\s*imageCount/);
});

test('input pod shows image count selector for plus and 4k platforms', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'components', 'InputPod.jsx'), 'utf8');

  assert.match(source, /supportsImageCount/);
  assert.match(source, /label="数量"/);
  assert.match(source, /imageCount/);
  assert.match(source, /\[1,\s*2,\s*3,\s*4\]/);
  assert.match(source, /plus/);
  assert.match(source, /4k/);
});

test('store exposes focused selector hooks for high-churn UI surfaces', () => {
  const source = fs.readFileSync(storePath, 'utf8');

  assert.match(source, /export function useCanvasState\(\)/);
  assert.match(source, /export function useInputPodState\(\)/);
  assert.match(source, /export function useNavRailState\(\)/);
});

test('store keeps platform switching and reference image actions defined after generation extraction', () => {
  const source = fs.readFileSync(storePath, 'utf8');

  assert.match(source, /const switchPlatform = useCallback/);
  assert.match(source, /const addRefImageFiles = useCallback/);
  assert.match(source, /const removeRefImage = useCallback/);
  assert.match(source, /const clearRefImages = useCallback/);
  assert.match(source, /switchPlatform,\s*addRefImageFiles,\s*removeRefImage,\s*clearRefImages/);
});

test('generation submit and retry actions live in the extracted conversation domain', () => {
  const source = fs.readFileSync(storePath, 'utf8');
  const domain = fs.readFileSync(domainPath, 'utf8');

  assert.match(domain, /const startGeneration = useCallback/);
  assert.match(domain, /const submitPrompt = useCallback/);
  assert.match(domain, /const retryJob = useCallback/);
  assert.match(domain, /const editJob = useCallback/);
  assert.doesNotMatch(source, /const startGeneration = useCallback/);
  assert.doesNotMatch(source, /const submitPrompt = useCallback/);
});

test('claude chat actions live in the extracted claude domain', () => {
  const source = fs.readFileSync(storePath, 'utf8');
  const domain = fs.readFileSync(claudeDomainPath, 'utf8');

  assert.match(source, /useClaudeChatDomain/);
  assert.match(domain, /export function useClaudeChatDomain/);
  assert.match(domain, /const loadClaudeConfig = useCallback/);
  assert.match(domain, /const sendClaudeMessage = useCallback/);
  assert.match(domain, /const stopClaude = useCallback/);
  assert.match(domain, /const clearClaudeChat = useCallback/);
  assert.doesNotMatch(source, /const sendClaudeMessage = useCallback/);
  assert.doesNotMatch(source, /const clearClaudeChat = useCallback/);
});

test('web conversation api keeps accountId out of conversation scope requests', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'web', 'src', 'lib', 'api.js'), 'utf8');

  assert.match(source, /getConversations\(platform, accountId\)/);
  assert.match(source, /createConversation\(name, platform, accountId\)/);
  assert.doesNotMatch(source, /params\.set\('accountId'/);
  assert.doesNotMatch(source, /post\('\/api\/conversations', \{ name, platform, accountId \}\)/);
});


test('license gate state and actions live in the extracted license domain', () => {
  const source = fs.readFileSync(storePath, 'utf8');
  const domain = fs.readFileSync(licenseDomainPath, 'utf8');

  assert.match(source, /useLicenseDomain/);
  assert.match(domain, /export function useLicenseDomain/);
  assert.match(domain, /const refreshLicense = useCallback/);
  assert.match(domain, /const activateLicense = useCallback/);
  assert.match(domain, /const verifyLicenseNow = useCallback/);
  assert.match(domain, /const onLicenseInvalid = useCallback/);
  assert.match(domain, /setInterval\(refreshLicense,\s*5 \* 60 \* 1000\)/);
  assert.doesNotMatch(source, /const refreshLicense = useCallback/);
  assert.doesNotMatch(source, /const activateLicense = useCallback/);
  assert.doesNotMatch(source, /const verifyLicenseNow = useCallback/);
});


test('bulk account login and backup import state live in the extracted account bulk domain', () => {
  const source = fs.readFileSync(storePath, 'utf8');
  const domain = fs.readFileSync(accountBulkDomainPath, 'utf8');

  assert.match(source, /useAccountBulkDomain/);
  assert.match(domain, /export function useAccountBulkDomain/);
  assert.match(domain, /const startAutoLogin = useCallback/);
  assert.match(domain, /const onAutoLoginProgress = useCallback/);
  assert.match(domain, /const startImportBackup = useCallback/);
  assert.match(domain, /const onImportProgress = useCallback/);
  assert.match(domain, /normalizeAutoLoginProgressItem/);
  assert.doesNotMatch(source, /const startAutoLogin = useCallback/);
  assert.doesNotMatch(source, /const onAutoLoginProgress = useCallback/);
  assert.doesNotMatch(source, /const startImportBackup = useCallback/);
  assert.doesNotMatch(source, /const onImportProgress = useCallback/);
});


