// dola 谷歌账户自动登录（纯 CDP 实现，复用 ws，无额外依赖）。
//
// 流程（探针实测）：
//   1. 打开 dola → 点"登录"按钮 → 弹出登录面板
//   2. 点面板里的"用谷歌账号登录" → 主页面跳转 accounts.google.com
//   3. 谷歌：输入邮箱 → 下一步 → 输入密码 → 下一步 →（如有）同意/Continue
//   4. 回调 www.dola.com/auth/callback#access_token=... → /chat/
//   5. 由调用方抓 cookie 保存
//
// 设计要点：
//   - DOM 点击用 Runtime.evaluate 找元素 + 触发原生 click
//   - 文本输入用 Input.insertText（更接近真人，且能触发框架 onChange）
//   - 每步之间加随机人工延迟，模拟人工
//   - 凭据（密码）绝不打印到日志

const http = require('http');
const WebSocket = require('ws');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 随机人工延迟
const humanDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

// ===== 反自动化指纹脚本 =====
// 在每个新文档加载前注入,抹掉常见的 webdriver/headless 指纹,降低被谷歌/dola 风控识别为机器人的概率。
const STEALTH_JS = `(function(){
  try { Object.defineProperty(navigator, 'webdriver', { get: function(){ return undefined; } }); } catch(e){}
  try { delete Object.getPrototypeOf(navigator).webdriver; } catch(e){}
  try { if(!window.chrome){ window.chrome = {}; } if(!window.chrome.runtime){ window.chrome.runtime = {}; } } catch(e){}
  try {
    var orig = navigator.permissions && navigator.permissions.query;
    if (orig) {
      navigator.permissions.query = function(p){
        if (p && p.name === 'notifications') return Promise.resolve({ state: (typeof Notification!=='undefined'?Notification.permission:'default') });
        return orig.call(navigator.permissions, p);
      };
    }
  } catch(e){}
  try { Object.defineProperty(navigator, 'languages', { get: function(){ return ['zh-CN','zh','en']; } }); } catch(e){}
  try { Object.defineProperty(navigator, 'plugins', { get: function(){ return [1,2,3,4,5]; } }); } catch(e){}
})();`;

// 对一个已连接的 CDP 会话施加反检测:
//  - addScriptToEvaluateOnNewDocument:覆盖后续导航/iframe(谷歌登录页脚本运行前生效)
//  - 立即 evaluate 一次:覆盖当前已加载的文档
async function applyStealth(sess) {
  try { await sess.call('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_JS }); } catch (e) {}
  try { await sess.call('Runtime.evaluate', { expression: STEALTH_JS, returnByValue: true }); } catch (e) {}
}


class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (e) => reject(e));
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
          else res(msg.result);
        }
      });
    });
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const mid = ++this.id;
      this.pending.set(mid, { res: resolve, rej: reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }

  // 在页面上下文执行 JS，返回值
  async evaluate(expression, awaitPromise = false) {
    const r = await this.call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise,
    });
    if (r && r.exceptionDetails) {
      throw new Error('eval 异常: ' + (r.exceptionDetails.text || ''));
    }
    return r && r.result && r.result.value;
  }

  close() {
    try { this.ws && this.ws.close(); } catch (e) {}
  }
}

// 拉取某端口下的 CDP page 列表
function getPages(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(); reject(new Error('获取页面列表超时')); });
  });
}

// 等待出现满足 predicate(page) 的 page，返回该 page
async function waitForPage(port, predicate, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = await getPages(port);
      const hit = pages.find(p => p.type === 'page' && predicate(p));
      if (hit) return hit;
    } catch (e) { /* retry */ }
    await sleep(800);
  }
  return null;
}

// 连接到某个页面（按 url 子串匹配，取第一个 page）
async function connectToPage(port, urlIncludes) {
  const pages = await getPages(port);
  let page;
  if (urlIncludes) {
    page = pages.find(p => p.type === 'page' && p.url && p.url.includes(urlIncludes));
  }
  if (!page) page = pages.find(p => p.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) throw new Error('未找到可连接页面');
  const sess = new CdpSession(page.webSocketDebuggerUrl);
  await sess.connect();
  return { sess, page };
}

/**
 * 在页面里按文本/选择器查找可见元素并点击。
 * 返回 true=点到了，false=没找到。
 * matchers: { selectors?: string[], texts?: string[] }
 */
function clickExpr(matchers) {
  const sels = JSON.stringify(matchers.selectors || []);
  const texts = JSON.stringify(matchers.texts || []);
  return `(function(){
    function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'; }
    var selectors=${sels}, texts=${texts};
    // 1. 选择器优先
    for(var i=0;i<selectors.length;i++){
      var nodes=document.querySelectorAll(selectors[i]);
      for(var j=0;j<nodes.length;j++){ if(vis(nodes[j])){ nodes[j].click(); return {ok:true,by:'sel',v:selectors[i]}; } }
    }
    // 2. 文本匹配（button/a/div[role=button]/span）
    if(texts.length){
      var cand=document.querySelectorAll('button,a,[role=button],div,span');
      for(var k=0;k<cand.length;k++){
        var el=cand[k];
        if(!vis(el)) continue;
        if(el.children.length>4) continue;
        var t=(el.innerText||el.textContent||'').trim();
        if(t.length>40) continue;
        for(var m=0;m<texts.length;m++){
          if(t===texts[m]||t.indexOf(texts[m])>-1){
            // 尽量点最内层可点击祖先（button/a）
            var target=el.closest('button,a,[role=button]')||el;
            target.click();
            return {ok:true,by:'text',v:texts[m],hit:t.slice(0,30)};
          }
        }
      }
    }
    return {ok:false};
  })()`;
}

// 查找输入框并聚焦（返回是否找到）
function focusInputExpr(selectors) {
  const sels = JSON.stringify(selectors);
  return `(function(){
    function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; }
    var selectors=${sels};
    for(var i=0;i<selectors.length;i++){
      var nodes=document.querySelectorAll(selectors[i]);
      for(var j=0;j<nodes.length;j++){
        if(vis(nodes[j])){ nodes[j].focus(); nodes[j].click(); return {ok:true,v:selectors[i]}; }
      }
    }
    return {ok:false};
  })()`;
}

class AutoLogin {
  constructor(browserManager, opts = {}) {
    this.bm = browserManager;
    this.log = opts.log || (() => {});       // (msg) => void  进度回调（不含敏感信息）
    this.platform = opts.platform || 'dola';
  }

  // 模拟真人逐字输入到当前聚焦元素。
  // 用 Input.dispatchKeyEvent(keyDown/char/keyUp) 而非 Input.insertText:
  // insertText 不触发真实键盘事件序列,部分风控会据此识别;dispatchKeyEvent 更接近真人击键。
  async typeHuman(sess, text) {
    for (const ch of text) {
      try {
        // keyDown/keyUp 只作为按键事件,【不带 text】——否则 keyDown 会先输入一次字符,
        // 加上 char 事件的一次,就会导致每个字母重复(实测过 "aa" 现象)。
        // 实际字符插入只交给 char 事件。
        await sess.call('Input.dispatchKeyEvent', { type: 'keyDown' });
        await sess.call('Input.dispatchKeyEvent', { type: 'char', text: ch });
        await sess.call('Input.dispatchKeyEvent', { type: 'keyUp' });
      } catch (e) {
        // 个别字符(组合键等)失败时退回 insertText,保证不中断
        try { await sess.call('Input.insertText', { text: ch }); } catch (_) {}
      }
      await humanDelay(55, 165);
    }
  }

  /**
   * 对单个账号执行自动登录。
   * @param {string} accountId
   * @param {{email:string,password:string}} cred
   * @returns {Promise<{success:boolean, error?:string}>}
   */
  async loginOne(accountId, cred) {
    const port = this.bm.getRunningPort(accountId);
    if (!port) throw new Error('浏览器未运行');
    const emailMasked = this._mask(cred.email);

    // === 步骤1：等 dola 首页加载 ===
    this.log(`[${emailMasked}] 等待 dola 加载...`);
    const dolaPage = await waitForPage(port, p => p.url && p.url.includes('dola.com'), 30000);
    if (!dolaPage) throw new Error('dola 页面未加载');
    await humanDelay(1500, 2500);

    // === 步骤1+2：点"登录"唤出登录面板 → 点面板里的谷歌钮 ===
    // 实测(scripts/_diag_after_google.js)dola 首页结构：
    //   - 游客首页默认【不】自动弹登录面板，需先点右上角"登录"(class: semi-button semi-button-primary)。
    //   - 面板里第三方登录是【三个纯图标圆钮】(Google/Facebook/Apple)，48×48 并排，
    //     class 完全相同(button-PgvIWh ...)，无任何文本/aria-label/"google"字样。
    //     谷歌钮的图标是 <img>(base64 png)，Facebook/Apple 是 <svg>。
    //   - 因此【不能】用"含 google 文本"或"页面第一个带 img 的按钮"来找——后者会误点左侧栏的 Dola logo。
    //   正确定位：找一组 class 相同、纯图标、近正方形的小圆钮，其中带 <img> 的即谷歌。
    // 在同一个会话里完成，避免重复 connect 的时序竞争。
    {
      const { sess } = await connectToPage(port, 'dola.com');
      try {
        // 不再调用 Runtime.enable / Network.enable:这两个 domain 一旦 enable 会暴露 CDP 自动化特征,
        // 而 Runtime.evaluate / Network.getAllCookies 本身并不需要先 enable。
        await applyStealth(sess);
        // 已登录检测：用登录态 cookie 判定（游客页也有 textarea，不能用 DOM 判定）
        if (await this._hasLoginCookie(sess)) {
          sess.close();
          this.log(`[${emailMasked}] 已是登录态，跳过`);
          return { success: true, alreadyLoggedIn: true };
        }

        // 谷歌钮定位表达式。find=true 只探测不点击。
        // 策略1:含 google 标识(以防将来 dola 加了 aria-label/alt);
        // 策略2:识别第三方圆钮组——纯图标(无文本)、近正方形、24~90px、class 相同且≥2个一组，
        //        组内按水平位置从左到右排序,取带 <img> 的(谷歌);没有带 img 的则取最左。
        const googleExpr = (find) => `(function(){
          function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'; }
          var all=document.querySelectorAll('button,a,[role=button],div[class*=button],div[class*=btn]');
          // 策略1:含 google 标识
          for(var i=0;i<all.length;i++){
            var el=all[i]; if(!vis(el)) continue;
            var lab=((el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('title')))||'')+' '+(el.innerText||'');
            var im=el.querySelector&&el.querySelector('img');
            var imgInfo=im?((im.getAttribute('alt')||'')+' '+(im.getAttribute('src')||'')):'';
            if(/google|谷歌/i.test(lab+' '+imgInfo)){ if(${find}) return {ok:true,by:'google-label'}; el.click(); return {ok:true,by:'google-label'}; }
          }
          // 策略2:第三方圆钮组
          var cand=[];
          for(var j=0;j<all.length;j++){
            var e=all[j]; if(!vis(e)) continue;
            var t=(e.innerText||e.textContent||'').replace(/\\s+/g,'').trim();
            if(t) continue;                                  // 圆钮无文本
            if(!(e.querySelector&&(e.querySelector('img')||e.querySelector('svg')))) continue;
            var r=e.getBoundingClientRect();
            var ratio=r.width/Math.max(1,r.height);
            if(ratio<0.6||ratio>1.7) continue;               // 近正方形
            if(r.width<24||r.width>90) continue;             // 小圆钮尺寸
            cand.push({el:e, cls:(e.className||'').toString(), left:r.left, hasImg:!!(e.querySelector&&e.querySelector('img'))});
          }
          var byCls={};
          cand.forEach(function(c){ (byCls[c.cls]=byCls[c.cls]||[]).push(c); });
          var group=null;
          Object.keys(byCls).forEach(function(k){ if(byCls[k].length>=2 && (!group||byCls[k].length>group.length)) group=byCls[k]; });
          if(!group) return {ok:false};
          group.sort(function(a,b){ return a.left-b.left; });
          var g=group.filter(function(c){return c.hasImg;})[0] || group[0];
          if(${find}) return {ok:true,by:'iconGroup',n:group.length};
          g.el.click(); return {ok:true,by:'iconGroup',n:group.length};
        })()`;

        // 1) 先探测面板是否已弹(通常没弹)
        this.log(`[${emailMasked}] 检测登录面板...`);
        let panelReady = await this._retryEval(sess, googleExpr(true), 3000);

        // 2) 没弹出就点"登录"唤出它。登录钮 class=semi-button semi-button-primary,文本"登录"。
        if (!panelReady || !panelReady.ok) {
          this.log(`[${emailMasked}] 点击登录按钮...`);
          const clicked = await this._retryEval(sess, `(function(){
            function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); var s=getComputedStyle(el); return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden'; }
            // 先关掉 Cookie 同意条("我知道了"),它有时盖住/挤走右上角登录按钮
            var cands=document.querySelectorAll('button,[role=button]');
            for(var c=0;c<cands.length;c++){ var ce=cands[c]; if(!vis(ce)) continue; var ct=(ce.innerText||'').replace(/\\s+/g,'').trim(); if(ct==='我知道了'||ct==='知道了'||/^(Got it|OK)$/i.test(ct)){ ce.click(); break; } }
            var cand=document.querySelectorAll('button,a,[role=button]');
            // 优先精确匹配
            for(var i=0;i<cand.length;i++){
              var el=cand[i]; if(!vis(el)) continue;
              var t=(el.innerText||el.textContent||'').replace(/\\s+/g,'').trim();
              if(t==='登录'||t==='登陆'||t==='立即登录'||t==='登录/注册'||/^(login|sign\\s?in)$/i.test(t)){
                (el.closest('button,a,[role=button]')||el).click(); return {ok:true,hit:t,by:'exact'};
              }
            }
            // 放宽:短文本(≤6字)包含"登录/登陆/登入"
            for(var j=0;j<cand.length;j++){
              var e2=cand[j]; if(!vis(e2)) continue;
              var t2=(e2.innerText||e2.textContent||'').replace(/\\s+/g,'').trim();
              if(t2.length<=6 && /登录|登陆|登入/.test(t2)){
                (e2.closest('button,a,[role=button]')||e2).click(); return {ok:true,hit:t2,by:'loose'};
              }
            }
            // 兜底:dola 登录钮 class 含 semi-button-primary 且无文本图标情形
            var prim=document.querySelectorAll('button.semi-button-primary,.semi-button-primary');
            for(var k=0;k<prim.length;k++){
              var e3=prim[k]; if(!vis(e3)) continue;
              var t3=(e3.innerText||'').replace(/\\s+/g,'').trim();
              if(/登录|登陆|登入|login|sign/i.test(t3)){ e3.click(); return {ok:true,hit:t3,by:'primaryCls'}; }
            }
            return {ok:false};
          })()`, 45000);
          if (!clicked || !clicked.ok) throw new Error('未找到登录按钮');
          // 等面板动画+第三方钮渲染
          await humanDelay(1500, 2500);
          panelReady = await this._retryEval(sess, googleExpr(true), 8000);
          if (!panelReady || !panelReady.ok) throw new Error('登录面板未出现第三方登录按钮');
        }

        // 3) 点谷歌登录
        this.log(`[${emailMasked}] 选择谷歌登录...`);
        const g = await this._retryEval(sess, googleExpr(false), 8000);
        if (!g || !g.ok) throw new Error('未找到谷歌登录按钮');
      } finally {
        sess.close();
      }
    }

    // === 步骤3：谷歌账号页 —— 输入邮箱 ===
    this.log(`[${emailMasked}] 等待谷歌登录页...`);
    const gPage = await waitForPage(port, p => p.url && p.url.includes('accounts.google.com'), 30000);
    if (!gPage) {
      // 没跳到谷歌页。有一种合法情况：dola 记住了谷歌会话，点谷歌后直接回跳并登录成功。
      // 但【不能】仅凭"dola 页还在"判成功——dola 页自始至终都在(点谷歌是同页跳转)，
      // 那样会把"点击没生效/卡住"误判成功。必须用登录态 cookie 确认确实已登录。
      const { sess } = await connectToPage(port, 'dola.com');
      try {
        if (await this._hasLoginCookie(sess)) {
          sess.close();
          this.log(`[${emailMasked}] 未见谷歌页但已是登录态(记住的会话)`);
          return { success: true };
        }
      } finally {
        sess.close();
      }
      throw new Error('未跳转到谷歌登录页（点击未生效/代理异常）');
    }
    await humanDelay(1500, 2500);

    await this._googleEmail(port, cred.email, emailMasked);
    await humanDelay(1800, 2800);
    await this._googlePassword(port, cred.password, emailMasked);

    // === 步骤4：等待回跳 dola（首次注册有 我了解→Continue→确认18岁 等同意页） ===
    this.log(`[${emailMasked}] 等待授权回跳...`);
    const ok = await this._waitCallback(port, emailMasked, 90000);
    if (!ok) {
      throw this._manualAttentionError(
        'google_after_password',
        'Google 密码提交后未回跳 Dola，可能停在密码错误、二次验证、人工确认或风控页面',
        { reason: 'callback_timeout' }
      );
    }

    // 回到 dola 后，用登录态 cookie 二次确认（避免游客回跳被误判成功）
    await humanDelay(1500, 2500);
    {
      const { sess } = await connectToPage(port, 'dola.com');
      try {
        if (!(await this._hasLoginCookie(sess))) {
          sess.close();
          throw new Error('回跳后未拿到登录态（仍是游客）');
        }
      } finally {
        sess.close();
      }
    }

    this.log(`[${emailMasked}] 登录成功`);
    return { success: true };
  }

  // 检测当前页 cookie 是否含登录态（区分游客 / 已登录）
  async _hasLoginCookie(sess) {
    try {
      const r = await sess.call('Network.getAllCookies', {});
      const cks = (r && r.cookies) || [];
      return cks.some(ck =>
        /dola\.com/.test(ck.domain || '') &&
        /^(sessionid|sessionid_ss|sid_tt|sid_guard|uid_tt|uid_tt_ss|passport_auth_status|passport_auth_status_ss|has_biz_token|sid_ucp_v1|ssid_ucp_v1|oauth_token)$/i.test(ck.name || '')
      );
    } catch (e) {
      return false;
    }
  }

  // 谷歌邮箱页
  async _googleEmail(port, email, emailMasked) {
    const gp = await waitForPage(port, p => p.url && p.url.includes('accounts.google.com'), 15000);
    if (!gp) throw new Error('谷歌邮箱页丢失');
    const { sess } = await connectToPage(port, 'accounts.google.com');
    try {
      await applyStealth(sess);

      // 谷歌可能落在【账号选择页】(signin/accountchooser)而非输入邮箱页——
      // 当浏览器 profile 里已有该谷歌账号的残留会话时就会这样(生产环境二次登录常见)。
      // 此时页面没有邮箱输入框,而是一列已登录账号 + "使用其他账号"。
      // 处理:优先点文本含目标邮箱的账号项;点不到就点"使用其他账号/Use another account"回到输入邮箱页。
      const onChooser = await sess.evaluate(`(function(){
        return /accountchooser/i.test(location.href) || (!document.querySelector('input[type=email],input#identifierId,input[name=identifier]') && /选择账号|选择帐号|Choose an account|使用其他|Use another/i.test(document.body.innerText||''));
      })()`).catch(() => false);

      if (onChooser) {
        this.log(`[${emailMasked}] 账号选择页,尝试选择目标账号...`);
        const emailJson = JSON.stringify(email);
        const picked = await this._retryEval(sess, `(function(){
          function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); return r.width>1&&r.height>1; }
          var target=${emailJson}.toLowerCase();
          var items=document.querySelectorAll('[role=link],[data-identifier],li,div');
          // 1) 找文本/属性含目标邮箱的可点击项
          for(var i=0;i<items.length;i++){ var el=items[i]; if(!vis(el)) continue;
            var di=(el.getAttribute&&el.getAttribute('data-identifier')||'').toLowerCase();
            var t=(el.innerText||'').toLowerCase();
            if(el.children.length<6 && (di===target || (t.indexOf(target)>-1 && t.length<80))){
              (el.closest('[role=link],li,[data-identifier]')||el).click(); return {ok:true,by:'acct'};
            }
          }
          // 2) 点"使用其他账号"回到输入邮箱页
          var all=document.querySelectorAll('[role=link],button,div,li');
          for(var j=0;j<all.length;j++){ var e=all[j]; if(!vis(e)) continue; var tt=(e.innerText||'').trim();
            if(/使用其他账号|使用其他帳號|添加账号|添加帳號|Use another account|Add account/i.test(tt) && tt.length<30){ e.click(); return {ok:true,by:'another'}; }
          }
          return {ok:false};
        })()`, 8000);
        if (picked && picked.by === 'acct') {
          // 直接选中了目标账号 → 通常跳过输入邮箱直达密码页
          this.log(`[${emailMasked}] 已选择目标账号`);
          return;
        }
        // 点了"使用其他账号",等输入邮箱页出现
        await humanDelay(1200, 2000);
      }

      this.log(`[${emailMasked}] 输入邮箱...`);
      const focused = await this._retryEval(sess, focusInputExpr([
        'input[type=email]', 'input#identifierId', 'input[name=identifier]',
      ]), 10000);
      if (!focused || !focused.ok) throw new Error('未找到邮箱输入框');
      await humanDelay(400, 800);
      await this.typeHuman(sess, email);
      await humanDelay(500, 1000);
      // 点"下一步"
      await this._retryClick(sess, {
        selectors: ['#identifierNext button', '#identifierNext', 'button[jsname]'],
        texts: ['下一步', 'Next', '繼續', '继续'],
      }, 8000);
    } finally {
      sess.close();
    }
  }

  // 谷歌密码页
  async _googlePassword(port, password, emailMasked) {
    // 等密码页（出现可见 password 输入框；排除谷歌隐藏的 aria-hidden 框）
    const start = Date.now();
    let pwdPage = null;
    while (Date.now() - start < 25000) {
      const gp = await waitForPage(port, p => p.url && p.url.includes('accounts.google.com'), 4000);
      if (gp) {
        const { sess, page } = await connectToPage(port, 'accounts.google.com');
        try {
          const has = await sess.evaluate(`!!document.querySelector('input[type=password]:not([aria-hidden="true"])')`).catch(() => false);
          if (has) { pwdPage = page; sess.close(); break; }
        } finally { sess.close(); }
      }
      await sleep(1000);
    }
    if (!pwdPage) {
      throw this._manualAttentionError(
        'google_password_page_missing',
        'Google 密码输入页未出现（邮箱可能无效、账号选择异常或需要额外验证）',
        { reason: 'password_page_missing' }
      );
    }

    const { sess } = await connectToPage(port, 'accounts.google.com');
    try {
      await applyStealth(sess);
      this.log(`[${emailMasked}] 输入密码...`);
      // 直接 focus 可见密码框并清空（不用通用可见性检测，谷歌密码框初始动画会被误判不可见）
      const focused = await this._retryEval(sess, `(function(){
        var i=document.querySelector('input[type=password]:not([aria-hidden="true"])');
        if(i){ i.focus(); i.click(); i.value=''; return {ok:true}; }
        return {ok:false};
      })()`, 10000);
      if (!focused || !focused.ok) throw new Error('未找到密码输入框');
      await humanDelay(400, 900);
      await this.typeHuman(sess, password);     // 密码不打印
      await humanDelay(500, 1100);
      const clickedNext = await this._retryClick(sess, {
        selectors: ['#passwordNext button', '#passwordNext', 'button[jsname]'],
        texts: ['下一步', 'Next', '繼續', '继续'],
      }, 8000);
      if (!clickedNext) {
        throw this._manualAttentionError(
          'google_password_next_missing',
          'Google 密码已输入，但没有找到“下一步”按钮或页面未响应',
          { reason: 'password_next_missing' }
        );
      }
    } finally {
      sess.close();
    }
  }

  // 等待回跳 dola，期间若出现谷歌同意页/EDU注册页(我了解/Continue/确认18岁)则自动点
  async _waitCallback(port, emailMasked, timeoutMs) {
    const start = Date.now();
    let lastClicked = '';
    let lastManualHint = '';
    while (Date.now() - start < timeoutMs) {
      let pages = [];
      try { pages = await getPages(port); } catch (e) {}
      const dolaBack = pages.find(p => p.type === 'page' && p.url &&
        p.url.includes('dola.com') && !p.url.includes('accounts.google'));
      if (dolaBack) {
        // 回到 dola，再等一会让 token 落地
        await humanDelay(2000, 3000);
        return true;
      }
      // 谷歌同意/确认页
      const gp = pages.find(p => p.type === 'page' && p.url && p.url.includes('accounts.google.com'));
      if (gp && gp.webSocketDebuggerUrl) {
        const sess = new CdpSession(gp.webSocketDebuggerUrl);
        try {
          await sess.connect();
          await applyStealth(sess);
          const state = await this._readGooglePageState(sess);
          const fatal = this._getGoogleFatalReason(state.text);
          if (fatal) {
            this.log(`[${emailMasked}] ${fatal}`);
            throw this._manualAttentionError('google_fatal', fatal, { reason: 'google_fatal' });
          }

          // 账号/密码错误、账号不存在等可确定失败，直接结束这一条。
          const err = this._getGoogleCredentialError(state.text);
          if (err && /密码|password|错误|wrong|incorrect|找不到|couldn/i.test(err)) {
            this.log(`[${emailMasked}] 谷歌报错: ${err}`);
            throw this._manualAttentionError(
              'google_credential_error',
              `Google 报错: ${err}`,
              { reason: 'credential_error' }
            );
          }

          const action = (state.buttons || []).find(b => this._shouldAutoClickGoogleButton(b.text, state.text));
          const clicked = action ? await this._clickGoogleButtonByText(sess, action.text) : '';
          if (clicked && clicked !== lastClicked) {
            lastClicked = clicked;
            this.log(`[${emailMasked}] 点击: ${clicked}`);
          } else if (!clicked) {
            const riskyAck = (state.buttons || []).find(b => this._isGoogleAckButton(b.text));
            if (riskyAck && riskyAck.text !== lastManualHint) {
              lastManualHint = riskyAck.text;
              const msg = `Google 出现需要人工确认的页面: ${riskyAck.text}。已停止自动点击`;
              this.log(`[${emailMasked}] ${msg},请用「有头可见」窗口手动处理。`);
              throw this._manualAttentionError(
                'google_manual_required',
                msg,
                { reason: 'manual_attention_required' }
              );
            }
          }
        } finally {
          sess.close();
        }
      }

      // chrome://managed-user-profile-notice —— Google Workspace 托管账号(自定义企业域名)登录时
      // Chrome 弹出的原生"贵组织将管理这份资料"拦截页。启动 flag DiceWebSigninInterception 通常已压掉,
      // 这里作为双保险:该页是 WebUI + shadow DOM,穿透 shadowRoot 找"继续/关联数据/Continue"钮点掉放行。
      const mp = pages.find(p => p.type === 'page' && p.url && p.url.includes('managed-user-profile-notice'));
      if (mp && mp.webSocketDebuggerUrl) {
        const sess = new CdpSession(mp.webSocketDebuggerUrl);
        try {
          await sess.connect();
          const clicked = await sess.evaluate(`(function(){
            function vis(el){ if(!el) return false; var r=el.getBoundingClientRect(); return r.width>1&&r.height>1; }
            var re=/继续|繼續|Continue|关联数据|關聯|Link data|添加|Add|确定|確定|OK|同意|Agree|接受|Accept/i;
            // 递归穿透 shadowRoot 收集所有按钮
            function collect(root, out){
              var q=root.querySelectorAll?root.querySelectorAll('cr-button,button,[role=button]'):[];
              for(var i=0;i<q.length;i++) out.push(q[i]);
              var all=root.querySelectorAll?root.querySelectorAll('*'):[];
              for(var j=0;j<all.length;j++){ if(all[j].shadowRoot) collect(all[j].shadowRoot, out); }
            }
            var btns=[]; collect(document, btns);
            // 优先匹配文本含 re 的;其次点最后一个可见按钮(通常"继续"在右)
            var vis_btns=btns.filter(vis);
            for(var k=0;k<vis_btns.length;k++){ var t=(vis_btns[k].innerText||vis_btns[k].textContent||'').trim(); if(t&&re.test(t)){ vis_btns[k].click(); return t.slice(0,20); } }
            if(vis_btns.length){ var last=vis_btns[vis_btns.length-1]; last.click(); return '(末钮)'+((last.innerText||'').trim().slice(0,16)); }
            return '';
          })()`).catch(() => '');
          if (clicked) {
            this.log(`[${emailMasked}] 托管资料页放行: ${clicked}`);
          }
        } finally {
          sess.close();
        }
      }
      await sleep(1500);
    }
    return false;
  }

  async _readGooglePageState(sess) {
    return await sess.evaluate(`(function(){
      function vis(el){
        if(!el) return false;
        var r=el.getBoundingClientRect();
        var s=getComputedStyle(el);
        return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden';
      }
      var text=(document.body&&document.body.innerText||'').replace(/\\s+/g,' ').trim();
      var buttons=[];
      var bs=document.querySelectorAll('button,[role=button]');
      for(var i=0;i<bs.length;i++){
        if(!vis(bs[i])) continue;
        var t=(bs[i].innerText||bs[i].textContent||'').replace(/\\s+/g,' ').trim();
        if(t) buttons.push({ text:t.slice(0,80) });
      }
      return { text:text.slice(0,6000), buttons:buttons };
    })()`).catch(() => ({ text: '', buttons: [] }));
  }

  async _clickGoogleButtonByText(sess, text) {
    const expected = JSON.stringify(String(text || '').trim());
    return await sess.evaluate(`(function(){
      var expected=${expected};
      function vis(el){
        if(!el) return false;
        var r=el.getBoundingClientRect();
        var s=getComputedStyle(el);
        return r.width>1&&r.height>1&&s.display!=='none'&&s.visibility!=='hidden';
      }
      var bs=document.querySelectorAll('button,[role=button]');
      for(var i=0;i<bs.length;i++){
        if(!vis(bs[i])) continue;
        var t=(bs[i].innerText||bs[i].textContent||'').replace(/\\s+/g,' ').trim();
        if(t===expected){
          bs[i].scrollIntoView();
          bs[i].click();
          return t.slice(0,20);
        }
      }
      return '';
    })()`).catch(() => '');
  }

  _normalizePageText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  _getGoogleFatalReason(pageText) {
    const text = this._normalizePageText(pageText);
    if (!text) return '';
    if (/出了点问题|出了點問題|无法继续|無法繼續|Something went wrong|could(?:n'?t| not) complete/i.test(text)) {
      return 'Google 返回“出了点问题，无法继续”，通常是风控或当前浏览器环境被拒绝';
    }
    if (/This browser or app may not be secure|browser or app may not be secure|浏览器或应用可能不安全|瀏覽器或應用程式可能不安全|无法登录|無法登入|could(?:n'?t| not) sign you in/i.test(text)) {
      return 'Google 拒绝当前浏览器/自动化环境登录';
    }
    return '';
  }

  _getGoogleCredentialError(pageText) {
    const text = this._normalizePageText(pageText);
    const match = text.match(/([^。.!?]{0,20}(密码|password|错误|wrong|incorrect|找不到|couldn'?t find)[^。.!?]{0,40})/i);
    return match ? match[1].trim().slice(0, 80) : '';
  }

  _isRiskyGooglePage(pageText) {
    const text = this._normalizePageText(pageText);
    if (!text) return false;
    if (this._getGoogleFatalReason(text)) return true;
    return /hasn'?t verified|not verified|未验证|未驗證|风险|風險|risk|不安全|not secure|suspicious|unusual|blocked/i.test(text);
  }

  _isGoogleAckButton(buttonText) {
    const text = this._normalizePageText(buttonText);
    return /^(我了解|我知道了|了解|I understand|Got it)$/i.test(text);
  }

  _isSafeGoogleAckPage(pageText) {
    const text = this._normalizePageText(pageText);
    if (!text || this._isRiskyGooglePage(text)) return false;
    return /18|年龄|年齡|年满|年滿|age|birth|出生|Dola|dola|权限|權限|permission|access|访问|訪問|服务条款|服務條款|terms|privacy|隐私|隱私/i.test(text);
  }

  _isGooglePasswordInputVisible(pageText, buttons = []) {
    const text = this._normalizePageText(pageText);
    if (!text) return false;
    if (/输入密码|请输入密码|请输入您的密码|請輸入密碼|enter your password|password|show password|forgot password|忘记密码|歡迎|welcome/i.test(text)) return true;
    return Array.isArray(buttons) && buttons.some((b) => /忘记密码|Forgot password/i.test(this._normalizePageText(b.text)));
  }

  _shouldAutoClickGoogleButton(buttonText, pageText) {
    const text = this._normalizePageText(buttonText);
    if (!text || this._isRiskyGooglePage(pageText)) return false;
    if (/^(继续|繼續|Continue|允许|Allow|我同意|同意|Agree|Accept|确认|確認|Confirm|是的|Yes)$/i.test(text)) {
      return true;
    }
    if (this._isGoogleAckButton(text)) {
      return this._isSafeGoogleAckPage(pageText);
    }
    return false;
  }

  _getGoogleIntermediateAction(state = {}) {
    const text = this._normalizePageText(state.text);
    const buttons = Array.isArray(state.buttons) ? state.buttons : [];
    const fatal = this._getGoogleFatalReason(text);
    if (fatal) {
      return { type: 'fatal', stage: 'google_fatal', message: fatal, reason: 'google_fatal' };
    }

    const credentialError = this._getGoogleCredentialError(text);
    if (credentialError && /密码|password|错误|wrong|incorrect|找不到|couldn/i.test(credentialError)) {
      return {
        type: 'manual',
        stage: 'google_credential_error',
        message: 'Google 报错: ' + credentialError,
        reason: 'credential_error'
      };
    }

    const action = buttons.find((b) => this._shouldAutoClickGoogleButton(b.text, text));
    if (action) return { type: 'click', buttonText: action.text };

    const riskyAck = buttons.find((b) => this._isGoogleAckButton(b.text));
    if (riskyAck) {
      return {
        type: 'manual',
        stage: 'google_manual_required',
        message: 'Google 出现需要人工确认的页面: ' + riskyAck.text + '。已停止自动点击',
        reason: 'manual_attention_required'
      };
    }

    if (this._isGooglePasswordInputVisible(text, buttons)) {
      return { type: 'password_ready' };
    }

    return { type: 'wait' };
  }

  _manualAttentionError(stage, message, meta = {}) {
    const base = String(message || 'Google 登录需要人工处理').trim();
    const suffix = /浏览器已保留/.test(base)
      ? ''
      : '；浏览器已保留，请查看当前页面确认具体原因';
    const err = new Error(base + suffix);
    err.keepBrowserOpen = true;
    err.stage = stage || 'google_manual_attention';
    err.reason = meta.reason || 'manual_attention_required';
    return err;
  }

  // 反复尝试点击直到成功或超时
  async _retryClick(sess, matchers, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await sess.evaluate(clickExpr(matchers)).catch(() => null);
      if (r && r.ok) return true;
      await sleep(600);
    }
    return false;
  }

  // 反复尝试 eval 直到返回 .ok 或超时
  async _retryEval(sess, expr, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const r = await sess.evaluate(expr).catch(() => null);
      if (r && r.ok) return r;
      await sleep(600);
    }
    return null;
  }

  // 邮箱脱敏：前3位 + ***@域名
  _mask(email) {
    if (!email || email.indexOf('@') < 0) return '***';
    const [u, d] = email.split('@');
    return u.slice(0, 3) + '***@' + d;
  }
}

module.exports = AutoLogin;






