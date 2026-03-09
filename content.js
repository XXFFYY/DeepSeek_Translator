const currentDomain = normalizeDomain(window.location.hostname);
let isTranslating = false;
let autoTranslateEnabled = false;
let isPageTranslated = false; // [新增] 记录页面是否处于已翻译状态
let isManualRestored = false; // [新增] 记录用户是否手动撤回了翻译
let abortCurrentTranslation = false; // [新增] 随时中止翻译的信号
let successTimer = null;

// ================= 1. 右键消息监听器 (修复核心) =================
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "showDialog") {
    showDraggableDialog(request.text);
    sendResponse({ status: "ok" });
  }
});

// ================= 2. 核心状态与记忆库 =================
const MAX_CACHE_SIZE = 5000;
let translationCache = {};
let dsStats = { translatedChars: 0, cacheHits: 0, tokensSaved: 0 };
let currentMode = 'normal';

const gameDomains = ['nexusmods.com', 'steampowered.com', 'epicgames.com', 'ign.com', 'fandom.com', 'curseforge.com'];
const academicDomains = ['github.com', 'arxiv.org', 'stackoverflow.com', 'nature.com', 'ieee.org', 'sciencedirect.com'];

function normalizeDomain(hostname) {
  return (hostname || '').replace(/^www\./, '');
}

function isDomainMatched(savedDomains, hostname) {
  const host = (hostname || '').replace(/^www\./, '');
  return savedDomains.some(d => {
    const domain = (d || '').replace(/^www\./, '');
    return host === domain || host.endsWith('.' + domain);
  });
}

function analyzeTextLang(text) {
  const clean = (text || '')
    .replace(/\s+/g, ' ')
    .replace(/[0-9]/g, '')
    .trim();

  if (!clean || clean.length < 2) {
    return { shouldTranslate: false, reason: 'too_short' };
  }

  const chineseMatches = clean.match(/[\u4e00-\u9fff]/g) || [];
  const latinMatches = clean.match(/[A-Za-z]/g) || [];
  const japaneseKanaMatches = clean.match(/[\u3040-\u30ff]/g) || [];
  const koreanMatches = clean.match(/[\uac00-\ud7af]/g) || [];

  const zhCount = chineseMatches.length;
  const enCount = latinMatches.length;
  const jpCount = japaneseKanaMatches.length;
  const koCount = koreanMatches.length;

  const letterLikeCount = zhCount + enCount + jpCount + koCount;

  if (letterLikeCount === 0) {
    return { shouldTranslate: false, reason: 'no_letters' };
  }

  const zhRatio = zhCount / letterLikeCount;
  const nonZhForeignCount = enCount + jpCount + koCount;

  // 规则：
  // 1) 中文占比很高，不翻
  // 2) 外文字符太少，不翻
  // 3) 纯短标签/按钮尽量跳过
  if (zhRatio >= 0.45) {
    return { shouldTranslate: false, reason: 'mostly_chinese' };
  }

  if (nonZhForeignCount < 3) {
    return { shouldTranslate: false, reason: 'too_little_foreign_text' };
  }

  return { shouldTranslate: true, reason: 'foreign_text' };
}

function shouldTranslateText(text) {
  return analyzeTextLang(text).shouldTranslate;
}

function getCacheKey(text) { return currentMode + "|||" + text; }

chrome.storage.local.get(['dsTransCache', 'dsStats', 'dsPromptMode'], (result) => {
  translationCache = result.dsTransCache || {};
  if (result.dsStats) dsStats = result.dsStats;
  const savedMode = result.dsPromptMode || 'auto';
  if (savedMode === 'auto') {
    if (gameDomains.some(domain => currentDomain.includes(domain))) currentMode = 'game';
    else if (academicDomains.some(domain => currentDomain.includes(domain))) currentMode = 'academic';
    else currentMode = 'normal';
  } else { currentMode = savedMode; }
});

function saveCache(original, translated) {
  translationCache[getCacheKey(original)] = translated;
  const keys = Object.keys(translationCache);
  if (keys.length > MAX_CACHE_SIZE) {
    const keysToDelete = keys.slice(0, 500);
    keysToDelete.forEach(key => delete translationCache[key]);
  }
  chrome.storage.local.set({ dsTransCache: translationCache });
}

function updateStats(charCount, isCacheHit) {
  if (isCacheHit) {
    dsStats.cacheHits += 1;
    dsStats.tokensSaved += Math.floor(charCount * 1.5);
  } else {
    dsStats.translatedChars += charCount;
  }
  chrome.storage.local.set({ dsStats: dsStats });
}

// ================= 3. 视觉装甲 (CSS) 顶部区域 =================
const iconTranslate = `<svg viewBox="0 0 24 24"><path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>`;
const iconSuccess = `<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));"><path d="M20 6L9 17l-5-5"/></svg>`; 
const iconRestore = `<svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C20.76 11.03 17 8 12.5 8z" fill="white"/></svg>`;

const style = document.createElement('style');
style.textContent = `
  /* 基础容器 */
  .ds-fab-container { 
    position: fixed; width: 60px; z-index: 2147483647; display: flex; flex-direction: column; gap: 12px; font-family: -apple-system, sans-serif;
    transition: left 0.4s cubic-bezier(0.23, 1, 0.32, 1), top 0.4s cubic-bezier(0.23, 1, 0.32, 1);
  }
  .ds-fab-container.is-dragging { transition: none !important; }
  .ds-anim-item { opacity: 0; pointer-events: none; transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275); transform: scale(0.8); }
  .ds-fab-container:hover .ds-anim-item { opacity: 1; pointer-events: auto; transform: scale(1); }
  
  /* 基础悬浮球 */
  .ds-fab { 
    height: 48px; background: rgba(0, 123, 255, 0.7); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    cursor: grab; box-shadow: -2px 0 15px rgba(0,0,0,0.1); border: 1px solid rgba(255,255,255,0.2);
    transition: all 0.5s cubic-bezier(0.23, 1, 0.32, 1); position: relative; overflow: hidden; display: flex; justify-content: center; align-items: center;
  }
  .ds-fab:active { cursor: grabbing; }
  .ds-fab svg { position: absolute; fill: white; width: 18px; height: 18px; top: 50%; left: 50%; transform: translate(-50%, -50%); transition: all 0.3s ease; }

  /* 状态 1：吸附在右侧 (默认) */
  .ds-fab-container.snap-right { align-items: flex-end; }
  /* [修改] 稍微加宽基础宽度，并把 translateX 从 12px 减小到 4px，让它多露出 8 像素 */
  .ds-fab-container.snap-right .ds-fab { width: 30px; border-radius: 24px 0 0 24px; transform: translateX(4px); border-right: none; }
  .ds-fab-container.snap-right:hover .ds-fab { width: 48px; border-radius: 24px; transform: translateX(0); background: #007bff; }
  /* [修改] 翻译完成变成绿色时的状态也同步调整 */
  .ds-fab-container.snap-right .ds-fab.is-complete { width: 34px; transform: translateX(4px); }
  .ds-fab-container.snap-right:hover .ds-fab.is-complete { width: 52px; transform: translateX(0); }

  /* 状态 2：吸附在左侧 */
  .ds-fab-container.snap-left { align-items: flex-start; }
  /* [修改] 加宽基础宽度，并把 translateX 从 -12px 改为 -4px，让它多露出 8 像素，与右侧对称 */
  .ds-fab-container.snap-left .ds-fab { width: 30px; border-radius: 0 24px 24px 0; transform: translateX(-4px); border-left: none; box-shadow: 2px 0 15px rgba(0,0,0,0.1); }
  .ds-fab-container.snap-left:hover .ds-fab { width: 48px; border-radius: 24px; transform: translateX(0); background: #007bff; }
  /* [修改] 翻译完成变成绿色时的状态也同步调整 */
  .ds-fab-container.snap-left .ds-fab.is-complete { width: 34px; transform: translateX(-4px); }
  .ds-fab-container.snap-left:hover .ds-fab.is-complete { width: 52px; transform: translateX(0); }

  /* 状态 3：自由悬浮在页面中间 */
  .ds-fab-container.floating { align-items: center; }
  .ds-fab-container.floating .ds-fab { width: 48px; border-radius: 24px; transform: translateX(0); box-shadow: 0 6px 20px rgba(0,0,0,0.25); }
  .ds-fab-container.floating:hover .ds-fab { background: #007bff; transform: scale(1.08); }
  .ds-fab-container.floating .ds-fab.is-complete { width: 52px; }

  /* 其他 UI 组件保持不变 */
  .ds-settings-btn { width: 32px; height: 32px; border-radius: 50%; background: #fff; display: flex; justify-content: center; align-items: center; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  .ds-toggle-wrapper { background: #fff; padding: 6px; border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.12); }
  .ds-trans-result { display: block; color: #16a085; font-size: 0.95em; margin: 4px 0 10px 0; font-weight: normal; border-left: 3px solid #16a085; padding-left: 10px; line-height: 1.6; width: fit-content; max-width: 100%; word-break: break-word; flex-shrink: 0; box-sizing: border-box; }
  .ds-switch { position: relative; display: inline-block; width: 34px; height: 20px; }
  .ds-switch input { opacity: 0; width: 0; height: 0; }
  .ds-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 20px; }
  .ds-slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 2px; bottom: 2px; background-color: white; transition: .4s; border-radius: 50%; }
  input:checked + .ds-slider { background-color: #34c759; }
  input:checked + .ds-slider:before { transform: translateX(14px); }
  .ds-toast { position: fixed; top: -50px; left: 50%; transform: translateX(-50%); padding: 10px 24px; border-radius: 30px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); z-index: 2147483647; font-size: 14px; color: white; transition: top 0.4s; }
  #ds-translate-modal { position: fixed; top: 120px; left: 50%; transform: translateX(-50%); background: white; width: 440px; border-radius: 16px; box-shadow: 0 25px 60px rgba(0,0,0,0.3); z-index: 2147483647; font-family: sans-serif; border: 1px solid #e2e8f0; overflow: hidden; }
`;
document.head.appendChild(style);

// ================= 4. 翻译引擎逻辑 =================
function showToast(msg, isError = false) {
  const existing = document.getElementById('ds-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'ds-toast';
  toast.className = 'ds-toast';
  toast.style.background = isError ? '#dc3545' : '#28a745';
  toast.innerText = msg;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.top = '20px'; }, 10);
  setTimeout(() => { toast.style.top = '-50px'; setTimeout(() => toast.remove(), 400); }, 3000);
}

function showSuccessFab(force = false, isSilent = false) {
  if (!force && isTranslating === false) return;
  if (abortCurrentTranslation) return;

  if (successTimer) {
    clearTimeout(successTimer);
    successTimer = null;
  }

  fab.style.background = '';
  fab.classList.add('is-complete');
  fab.innerHTML = iconSuccess;

  if (!isSilent) {
    showToast('✅ 网页翻译完成！');
  }

  successTimer = setTimeout(() => {
    if (abortCurrentTranslation) return;

    isTranslating = false;
    isPageTranslated = true;

    fab.classList.remove('is-complete');
    fab.innerHTML = iconRestore;
    fab.style.background = 'linear-gradient(135deg, #64748b, #475569)';

    successTimer = null;
  }, 1200);
}

function resetFab() {
  if (successTimer) {
    clearTimeout(successTimer);
    successTimer = null;
  }

  isTranslating = false;
  isPageTranslated = false;
  fab.classList.remove('is-complete');
  fab.style.background = '';
  fab.innerHTML = iconTranslate;
}

// [修改] 恢复网页的函数 (增加强制中止能力)
function restorePage() {
  abortCurrentTranslation = true; // [核心] 触发中止信号，让后续的异步任务全部失效
  
  const translatedNodes = document.querySelectorAll('.ds-translated');
  translatedNodes.forEach(node => node.remove());
  
  isTranslating = false;   // 强制重置状态
  isPageTranslated = false;
  isManualRestored = true; // 标记用户手动干预，暂停自动翻译
  
  resetFab();
  showToast('已停止翻译并恢复原网页');
}

function getSemanticLineGroups() {
  const inlineTags = new Set(['A', 'SPAN', 'STRONG', 'B', 'I', 'EM', 'FONT', 'LABEL', 'Q']);
  const ignoreTags = new Set([
    'SCRIPT', 'STYLE', 'FOOTER', 'HEADER', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION',
    'SVG', 'NOSCRIPT', 'IMG', 'PRE', 'CODE', 'KBD', 'SAMP'
  ]);
  const blockTags = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'TD', 'TR', 'TH', 'DD', 'DT', 'FIGURE', 'UL', 'OL', 'NAV', 'ASIDE', 'BUTTON']);

  const groups = [];
  let currentGroup = [];
  const viewportCenterY = window.scrollY + (window.innerHeight / 2);

function isElementVisible(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;

  const rect = el.getBoundingClientRect();
  if (rect.width <= 2 || rect.height <= 2) return false;

  // 只处理视口上下各扩展 800px 范围内的元素
  const buffer = 800;
  if (rect.bottom < -buffer || rect.top > window.innerHeight + buffer) return false;

  return true;
}

  function flush() {
    if (currentGroup.length > 0) {
      const text = currentGroup.map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length >= 2 && shouldTranslateText(text)) {
        const lastNode = currentGroup[currentGroup.length - 1];
        if (!(lastNode.nextSibling?.classList?.contains('ds-trans-result'))) {
          const firstNode = currentGroup[0];
          const parent = firstNode.parentElement || firstNode.parentNode;
          if (parent && isElementVisible(parent)) {
            const rect = parent.getBoundingClientRect();
            groups.push({ nodes: currentGroup, text: text, distance: Math.abs(rect.top + window.scrollY - viewportCenterY) });
          }
        }
      }
      currentGroup = [];
    }
  }

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) { if (node.nodeValue.trim().length > 0) currentGroup.push(node); }
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toUpperCase();
    if (ignoreTags.has(tag) || node.classList.contains('ds-trans-result')) return;

    if (
      node.closest('.ds-fab-container') ||
      node.closest('#ds-translate-modal') ||
      node.closest('#ds-settings-modal') ||
      node.closest('#ds-hover-tooltip') ||
      node.closest('pre') ||
      node.closest('code') ||
      node.closest('.highlight') ||
      node.closest('.snippet-clipboard-content') ||
      node.closest('.react-code-text') ||
      node.closest('[data-testid*="code"]')
    ) return;
      if (!isElementVisible(node)) return;
      if (tag === 'BR') { flush(); }
      else if (blockTags.has(tag)) { flush(); Array.from(node.childNodes).forEach(child => walk(child)); flush(); }
      else if (inlineTags.has(tag)) { currentGroup.push(node); }
      else { flush(); Array.from(node.childNodes).forEach(child => walk(child)); flush(); }
    }
  }
  walk(document.body);
  groups.sort((a, b) => a.distance - b.distance);
  return groups;
}

async function translateWholePage(isSilent = false, forceRetranslate = false) {
  if (isTranslating) return;
  if (isPageTranslated && !forceRetranslate) return;
  const groups = getSemanticLineGroups();
  if (groups.length === 0) { if (!isSilent) showSuccessFab(true, isSilent); return; }
  
  const uncachedGroups = [];
  let cacheUsed = false;
  groups.forEach(group => {
    const cachedText = translationCache[getCacheKey(group.text)];
    if (cachedText) {
      updateStats(group.text.length, true);
      injectTranslation(group, cachedText);
      cacheUsed = true;
    } else { uncachedGroups.push(group); }
  });
  // [修改] 传递 isSilent
  if (uncachedGroups.length === 0) { if (!isSilent && cacheUsed) showSuccessFab(true, isSilent); return; }
  
  isTranslating = true;
  abortCurrentTranslation = false;
  fab.style.background = 'linear-gradient(135deg, #f39c12, #e67e22)';
  
  if(!isSilent) {
    const modeMap = { 'normal': '🌐 常规', 'academic': '🎓 学术', 'game': '🎮 游戏' };
    const modeName = modeMap[currentMode] || '✨ 智能嗅探';
    showToast(`[${modeName}模式] 正在翻译 ${uncachedGroups.length} 处内容...`);
  }
  
  const batchSize = 12;
  const batches = [];
  for (let i = 0; i < uncachedGroups.length; i += batchSize) batches.push(uncachedGroups.slice(i, i + batchSize));
  const maxConcurrent = 4;
  let active = 0, currentIndex = 0, completed = 0;
  
  const next = () => {
    if (abortCurrentTranslation) return; 

    if (currentIndex >= batches.length && active === 0) { 
      showSuccessFab(true, isSilent); // [修改] 传递 isSilent 避免滚动时乱弹完成通知
      return; 
    }
    while (active < maxConcurrent && currentIndex < batches.length) {
      if (abortCurrentTranslation) break; 
      
      const batchGroups = batches[currentIndex++];
      active++;
      translateBatch(batchGroups).finally(() => {
        active--; completed++;
        if (!abortCurrentTranslation) { 
          fab.innerHTML = `<span style="font-size:11px; font-weight:bold; color:white;">${completed}/${batches.length}</span>`;
        }
        next();
      });
    }
  };
  next();
}

// 在 translateBatch 函数中拦截渲染：
async function translateBatch(groupArray) {
  const payload = {};
  groupArray.forEach((group, index) => { payload[index] = group.text; });
  try {
    const response = await new Promise(res => {
      chrome.runtime.sendMessage({ action: "translate", type: "batch", payload: payload, mode: currentMode }, res);
      setTimeout(() => res({ success: false }), 35000);
    });
    
    if (abortCurrentTranslation) return; // [核心] 如果 API 终于返回了，但此时用户已经点击了停止，直接把数据扔掉，不要上屏！

    if (response?.success && response.data) {
      groupArray.forEach((group, index) => {
        const trans = response.data[index];
        if (trans && trans !== group.text) {
          saveCache(group.text, trans); 
          updateStats(group.text.length, false); 
          injectTranslation(group, trans);
        }
      });
    }
  } catch (e) { console.error(e); }
}

function injectTranslation(group, translatedText) {
  const lastNode = group.nodes[group.nodes.length - 1];
  if (!lastNode?.parentNode || lastNode.nextSibling?.classList?.contains('ds-trans-result')) return;
  const transDiv = document.createElement('div');
  transDiv.className = 'ds-trans-result ds-translated';
  transDiv.innerText = translatedText;
  lastNode.parentNode.insertBefore(transDiv, lastNode.nextSibling);
}

// ================= 5. 精准翻译弹窗 (修复核心) =================
function showDraggableDialog(originalText) {
  const existing = document.getElementById('ds-translate-modal'); 
  if (existing) existing.remove();
  
  const dialog = document.createElement('div');
  dialog.id = 'ds-translate-modal';
  dialog.innerHTML = `
    <div id="ds-modal-header" style="background: #f8fafc; padding: 14px 22px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; border-radius: 16px 16px 0 0; cursor: grab; user-select: none;">
      <strong style="font-size: 14px; color: #0f172a;">🔍 深度解析</strong>
      <span id="ds-modal-close" style="cursor: pointer; font-size: 22px; color: #94a3b8; line-height: 1;">&times;</span>
    </div>
    <div style="padding: 24px;">
      <div style="font-size: 12px; color: #64748b; margin-bottom: 16px; border-bottom: 1px dashed #e2e8f0; padding-bottom: 12px; line-height: 1.5;">${originalText}</div>
      <div id="ds-modal-result" style="font-size: 15px; color: #1e293b; line-height: 1.6; font-weight: 500;">✨ 解析中...</div>
    </div>`;
  document.body.appendChild(dialog);

  document.getElementById('ds-modal-close').onclick = () => dialog.remove();

  const header = document.getElementById('ds-modal-header');
  let isDragging = false, offsetX, offsetY;
  header.onmousedown = (e) => {
    isDragging = true; header.style.cursor = 'grabbing';
    offsetX = e.clientX - dialog.offsetLeft;
    offsetY = e.clientY - dialog.offsetTop;
    dialog.style.transform = 'none';
  };
  window.onmousemove = (e) => {
    if (!isDragging) return;
    dialog.style.left = (e.clientX - offsetX) + 'px';
    dialog.style.top = (e.clientY - offsetY) + 'px';
  };
  window.onmouseup = () => { isDragging = false; header.style.cursor = 'grab'; };

  chrome.runtime.sendMessage({ action: "translate", type: "single", payload: originalText, mode: currentMode }, (res) => {
    const box = document.getElementById('ds-modal-result');
    if (box) box.innerText = res?.success ? res.text : "解析失败";
  });
}

// ================= 6. UI 交互逻辑 =================
const container = document.createElement('div');
container.className = 'ds-fab-container snap-right'; 

// [修复] 使用 clientWidth/clientHeight 剔除滚动条的干扰
container.style.top = (document.documentElement.clientHeight / 2 - 50) + 'px';
container.style.left = (document.documentElement.clientWidth - 60) + 'px';

const settingsBtn = document.createElement('div');
settingsBtn.className = 'ds-settings-btn ds-anim-item';
settingsBtn.innerHTML = '⚙️';
const fab = document.createElement('div');
fab.className = 'ds-fab';
fab.innerHTML = iconTranslate;
const toggleWrapper = document.createElement('div');
toggleWrapper.className = 'ds-toggle-wrapper ds-anim-item';
toggleWrapper.innerHTML = `<label class="ds-switch"><input type="checkbox" id="ds-auto-switch"><span class="ds-slider"></span></label>`;
container.appendChild(settingsBtn);
container.appendChild(fab);
container.appendChild(toggleWrapper);
document.body.appendChild(container);


// ================= 拖拽核心逻辑 =================
let isDraggingFab = false;
let dragStartX, dragStartY;
let containerStartX, containerStartY;
let hasDragged = false; 

fab.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return; 
  isDraggingFab = true;
  hasDragged = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  
  const rect = container.getBoundingClientRect();
  containerStartX = rect.left;
  containerStartY = rect.top;
  
  container.classList.add('is-dragging');
  container.style.top = containerStartY + 'px';
  container.style.left = containerStartX + 'px';
  
  document.body.style.userSelect = 'none'; 
});

window.addEventListener('mousemove', (e) => {
  if (!isDraggingFab) return;
  
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;
  
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasDragged = true;
  
  let newLeft = containerStartX + dx;
  let newTop = containerStartY + dy;
  
  // [修复] 使用可视区域真实宽高进行边界保护
  const clientWidth = document.documentElement.clientWidth;
  const clientHeight = document.documentElement.clientHeight;
  const rect = container.getBoundingClientRect();
  
  if (newLeft < 0) newLeft = 0;
  if (newTop < 0) newTop = 0;
  if (newLeft + rect.width > clientWidth) newLeft = clientWidth - rect.width;
  if (newTop + rect.height > clientHeight) newTop = clientHeight - rect.height;
  
  container.style.left = newLeft + 'px';
  container.style.top = newTop + 'px';
});

window.addEventListener('mouseup', (e) => {
  if (!isDraggingFab) return;
  isDraggingFab = false;
  document.body.style.userSelect = '';
  container.classList.remove('is-dragging');
  
  const rect = container.getBoundingClientRect();
  const snapThreshold = 50; 
  const clientWidth = document.documentElement.clientWidth; // [修复] 获取真实宽度
  
  container.classList.remove('snap-left', 'snap-right', 'floating');
  
  // 磁吸判定逻辑
  if (rect.left < snapThreshold) {
    container.style.left = '0px';
    container.classList.add('snap-left');
  } else if (rect.left + rect.width > clientWidth - snapThreshold) {
    // [修复] 靠右吸附时，贴紧真实边缘
    container.style.left = (clientWidth - rect.width) + 'px';
    container.classList.add('snap-right');
  } else {
    container.classList.add('floating');
  }
});

// 防止窗口缩放导致的偏移
window.addEventListener('resize', () => {
  if (container.classList.contains('snap-right')) {
    const rect = container.getBoundingClientRect();
    // [修复] 窗口拉伸时也使用真实宽度
    container.style.left = (document.documentElement.clientWidth - rect.width) + 'px';
  }
});

// ================= 点击逻辑（附带拖拽拦截） =================
fab.addEventListener('click', (e) => { 
  if (hasDragged) return; // 【核心防御】如果是拖拽松手，绝对不触发翻译操作
  
  if (isTranslating) {
    restorePage();
    return;
  }
  
  if (isPageTranslated) {
    restorePage(); 
  } else {
    isManualRestored = false; 
    abortCurrentTranslation = false; 
    translateWholePage(false); 
  }
});


// ================= 自动开关与监听逻辑 =================
const autoSwitch = toggleWrapper.querySelector('#ds-auto-switch');
chrome.storage.local.get(['autoTranslateDomains'], (result) => {
  let domains = (result.autoTranslateDomains || []).map(normalizeDomain);
  if (isDomainMatched(domains, currentDomain)) {
    autoSwitch.checked = true;
    autoTranslateEnabled = true;
    requestAnimationFrame(() => translateWholePage(false));
    startMutationObserver();
  }
});

autoSwitch.addEventListener('change', (e) => {
  chrome.storage.local.get(['autoTranslateDomains'], (result) => {
    let domains = (result.autoTranslateDomains || []).map(normalizeDomain);

    if (e.target.checked) {
      if (!domains.includes(currentDomain)) domains.push(currentDomain);
      autoTranslateEnabled = true;
      startMutationObserver();
      showToast('✅ 已开启当前网页自动翻译');
      translateWholePage();
    } else {
      domains = domains.filter(d => d !== currentDomain);
      autoTranslateEnabled = false;
      if (observer) observer.disconnect();
      showToast('❌ 已关闭当前网页自动翻译');
    }

    chrome.storage.local.set({ autoTranslateDomains: domains });
  });
});

let observer;
let typingTimeout;
let lastKnownUrl = window.location.href;
let routeChangeTimer = null;

function scheduleRouteRetranslate() {
  if (!autoTranslateEnabled) return;
  clearTimeout(routeChangeTimer);
  routeChangeTimer = setTimeout(() => {
    if (!autoTranslateEnabled || isTranslating || document.hidden) return;
    abortCurrentTranslation = false;
    isManualRestored = false;
    isPageTranslated = false;
    translateWholePage(true, true);
  }, 900);
}

function handleRouteChangeIfNeeded() {
  const nextUrl = window.location.href;
  if (nextUrl === lastKnownUrl) return;
  lastKnownUrl = nextUrl;

  // Remove stale injected translations after SPA navigation.
  const translatedNodes = document.querySelectorAll('.ds-translated');
  translatedNodes.forEach(node => node.remove());

  abortCurrentTranslation = true;
  isTranslating = false;
  isPageTranslated = false;
  isManualRestored = false;
  resetFab();
  abortCurrentTranslation = false;

  scheduleRouteRetranslate();
}

function installNavigationWatcher() {
  const notifyRouteChange = () => setTimeout(handleRouteChangeIfNeeded, 0);

  ['pushState', 'replaceState'].forEach(method => {
    const original = history[method];
    if (typeof original !== 'function' || original.__dsWrapped) return;
    const wrapped = function(...args) {
      const result = original.apply(this, args);
      notifyRouteChange();
      return result;
    };
    wrapped.__dsWrapped = true;
    history[method] = wrapped;
  });

  window.addEventListener('popstate', notifyRouteChange);
  window.addEventListener('hashchange', notifyRouteChange);
}

installNavigationWatcher();

function startMutationObserver() {
  if (observer) observer.disconnect();

  observer = new MutationObserver((mutations) => {
    if (isTranslating || isManualRestored) return;
    handleRouteChangeIfNeeded();

    const isInternal = mutations.some(m => {
      const added = Array.from(m.addedNodes).some(
        n => n.nodeType === 1 && (n.classList?.contains('ds-trans-result') || n.id?.startsWith('ds-'))
      );
      const removed = Array.from(m.removedNodes).some(
        n => n.nodeType === 1 && (n.classList?.contains('ds-trans-result') || n.id?.startsWith('ds-'))
      );
      return added || removed;
    });

    if (isInternal) return;

    const hasMeaningfulNewNodes = mutations.some(m =>
      Array.from(m.addedNodes).some(n => {
        if (n.nodeType === Node.TEXT_NODE) {
          return n.nodeValue && n.nodeValue.trim().length >= 2;
        }
        if (n.nodeType === Node.ELEMENT_NODE) {
          const el = n;
          if (el.classList?.contains('ds-trans-result')) return false;
          if (el.id?.startsWith('ds-')) return false;
          return !!el.innerText?.trim();
        }
        return false;
      })
    );

    if (!hasMeaningfulNewNodes) return;

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      if (autoTranslateEnabled && !isTranslating && !document.hidden && !isManualRestored) {
        isPageTranslated = false;
        translateWholePage(true);
      }
    }, 1200);
  });

  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

// ================= 7. 悬停翻译 (Alt + Hover) =================
let hoverTooltip = document.getElementById('ds-hover-tooltip') || document.createElement('div');
if (!hoverTooltip.id) {
  hoverTooltip.id = 'ds-hover-tooltip';
  hoverTooltip.style.cssText = `position: fixed; z-index: 2147483647; background: rgba(15, 23, 42, 0.9); color: #10b981; padding: 10px 14px; border-radius: 8px; font-size: 14px; max-width: 350px; line-height: 1.6; box-shadow: 0 8px 24px rgba(0,0,0,0.25); pointer-events: none; display: none; backdrop-filter: blur(8px); transition: opacity 0.2s; opacity: 0; word-wrap: break-word; border: 1px solid rgba(255,255,255,0.1);`;
  document.body.appendChild(hoverTooltip);
}

let hoverTarget = null;
document.addEventListener('mousemove', (e) => {
  if (hoverTooltip.style.display === 'block') {
    const rect = hoverTooltip.getBoundingClientRect();
    let left = e.clientX + 15, top = e.clientY + 15;
    if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 15;
    if (top + rect.height > window.innerHeight) top = e.clientY - rect.height - 15;
    hoverTooltip.style.left = left + 'px'; hoverTooltip.style.top = top + 'px';
  }
});

document.addEventListener('mouseover', async (e) => {
  if (!e.altKey) return;
  const target = e.target;
  if (['SCRIPT', 'STYLE', 'BODY', 'HTML', 'IMG', 'SVG', 'INPUT', 'TEXTAREA'].includes(target.tagName)) return;
  const text = target.innerText?.trim();
  if (!text || hoverTarget === target || !shouldTranslateText(text)) return;
  
  hoverTarget = target;
  hoverTooltip.style.display = 'block';
  hoverTooltip.innerText = "✨ 正在解析...";
  hoverTooltip.style.color = '#94a3b8';
  setTimeout(() => { if(hoverTarget === target) hoverTooltip.style.opacity = '1'; }, 10);
  
  const cached = translationCache[getCacheKey(text)];
  if (cached) {
    updateStats(text.length, true);
    hoverTooltip.innerText = cached; hoverTooltip.style.color = '#10b981'; return;
  }
  chrome.runtime.sendMessage({ action: "translate", type: "single", payload: text, mode: currentMode }, (res) => {
    if (res?.success && hoverTarget === target) {
      saveCache(text, res.text); updateStats(text.length, false);
      hoverTooltip.innerText = res.text; hoverTooltip.style.color = '#10b981';
    }
  });
});

document.addEventListener('mouseout', (e) => {
  if (hoverTarget && e.target === hoverTarget) {
    hoverTarget = null; hoverTooltip.style.opacity = '0';
    setTimeout(() => { if (!hoverTarget) hoverTooltip.style.display = 'none'; }, 200);
  }
});

// ================= 8. 设置面板逻辑 =================
settingsBtn.addEventListener('click', () => {
  const existing = document.getElementById('ds-settings-modal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ds-settings-modal';
  overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.4); z-index: 2147483647; display: flex; justify-content: center; align-items: center; backdrop-filter: blur(2px);`;
  const dialog = document.createElement('div');
  dialog.style.cssText = `background: white; width: 340px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); overflow: hidden; font-family: sans-serif;`;
  dialog.innerHTML = `
    <div style="background: #f8f9fa; padding: 12px 20px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center;">
      <strong style="color: #333; font-size: 15px;">DeepSeek 设置看板</strong>
      <span id="ds-settings-close" style="cursor: pointer; font-size: 20px; color: #999;">&times;</span>
    </div>
    <div style="padding: 20px;">
      <div class="ds-stats-board">
        <div class="ds-stat-item"><span class="ds-stat-val">${(dsStats.translatedChars/1000).toFixed(1)}k</span><span class="ds-stat-label">累计翻译</span></div>
        <div class="ds-stat-item"><span class="ds-stat-val" style="color:#28a745;">${dsStats.cacheHits}</span><span class="ds-stat-label">记忆秒开</span></div>
        <div class="ds-stat-item"><span class="ds-stat-val" style="color:#f39c12;">${(dsStats.tokensSaved/1000).toFixed(1)}k</span><span class="ds-stat-label">节省Token</span></div>
      </div>
      <label style="font-size: 13px; color: #555; display: block; margin-bottom: 6px; font-weight:bold;">AI 角色模式:</label>
      <select id="ds-mode-select" style="width: 100%; padding: 8px; margin-bottom: 15px; border-radius: 6px; border: 1px solid #ddd; color: #333; background: #fff; font-weight: 500;">
        <option value="auto">✨ 智能嗅探</option>
        <option value="normal">🌐 常规模式</option>
        <option value="academic">🎓 学术模式</option>
        <option value="game">🎮 游戏模式</option>
      </select>
      <label style="font-size: 13px; color: #555; display: block; margin-bottom: 6px; font-weight:bold;">API Key:</label>
      <input type="password" id="ds-api-input" style="width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 15px; color: #333; background: #fff;">
      <button id="ds-api-save" style="width: 100%; padding: 10px; background: #007bff; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;">保存配置</button>
    </div>`;
  overlay.appendChild(dialog); document.body.appendChild(overlay);
  chrome.storage.local.get(['deepseekApiKey', 'dsPromptMode'], (res) => {
    if (res.deepseekApiKey) document.getElementById('ds-api-input').value = res.deepseekApiKey;
    document.getElementById('ds-mode-select').value = res.dsPromptMode || 'auto';
  });
  document.getElementById('ds-api-save').onclick = () => {
    const key = document.getElementById('ds-api-input').value.trim();
    const mode = document.getElementById('ds-mode-select').value;
    chrome.storage.local.set({ deepseekApiKey: key, dsPromptMode: mode }, () => { showToast("已保存设置"); overlay.remove(); });
  };
  document.getElementById('ds-settings-close').onclick = () => overlay.remove();
});
