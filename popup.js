document.addEventListener('DOMContentLoaded', async () => {
    const apiKeyInput = document.getElementById('apiKey');
    const autoToggle = document.getElementById('autoToggle');
    const siteDomainSpan = document.getElementById('siteDomain');
  
    // 获取当前活跃网页的域名
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let domain = "未知网站";
    if (tab && tab.url && tab.url.startsWith('http')) {
      domain = new URL(tab.url).hostname;
      siteDomainSpan.textContent = domain;
    } else {
      siteDomainSpan.textContent = "无法在该页使用";
      autoToggle.disabled = true;
    }
  
    // 加载数据：API Key 和 自动翻译网站白名单
    chrome.storage.local.get(['deepseekApiKey', 'autoTranslateDomains'], (result) => {
      if (result.deepseekApiKey) apiKeyInput.value = result.deepseekApiKey;
      const autoDomains = result.autoTranslateDomains || [];
      autoToggle.checked = autoDomains.includes(domain);
    });
  
    // 保存 API Key
    document.getElementById('saveBtn').addEventListener('click', () => {
      chrome.storage.local.set({ deepseekApiKey: apiKeyInput.value.trim() }, () => {
        const status = document.getElementById('status');
        status.textContent = 'Key 保存成功！';
        setTimeout(() => { status.textContent = ''; }, 2000);
      });
    });
  
    // 监听当前网站自动翻译开关变化
    autoToggle.addEventListener('change', () => {
      chrome.storage.local.get(['autoTranslateDomains'], (result) => {
        let autoDomains = result.autoTranslateDomains || [];
        if (autoToggle.checked) {
          if (!autoDomains.includes(domain)) autoDomains.push(domain);
        } else {
          autoDomains = autoDomains.filter(d => d !== domain);
        }
        chrome.storage.local.set({ autoTranslateDomains: autoDomains });
      });
    });
  });