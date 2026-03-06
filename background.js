// 初始化右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: "translateSelection", title: "使用 DeepSeek 精准翻译/解释", contexts: ["selection"] });
  });
  
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "translateSelection") chrome.tabs.sendMessage(tab.id, { action: "showDialog", text: info.selectionText });
  });
  
  // 预设的 AI 角色提示词库
// 预设的 AI 角色提示词库
const prompts = {
    normal: {
      single: "你是一个专业翻译。请将非中文文本翻译为简体中文；如果输入已经是简体中文或以中文为主，请原样返回。只输出结果，不要解释。",
      batch: "你是一个网页翻译器。用户提供JSON对象，请将其中以非中文为主的值翻译为流畅的简体中文；如果某个值已经是简体中文或以中文为主，请原样返回。返回相同键名的合法JSON。不可省略键值，不要包裹在markdown代码块中。"
    },
    academic: {
      single: "你是一个顶尖的学术助手。请将外文翻译成极其严谨的中文学术表达。遇到专业术语（如联邦学习、机器学习、入侵检测等）请保留准确的行业黑话。只输出结果，不要解释。",
      batch: "你是一个学术论文翻译器。用户提供JSON对象，请将值翻译为严谨的中文学术表达。返回相同键名的JSON。必须输出合法JSON，不可省略键值，不要包含markdown。"
    },
    summary: {
      single: "请用极其精简的一句中文，概括并解释这段文本的核心意思。只输出一句话概括，不要废话。",
      batch: "你是一个速读摘要助手。用户提供JSON对象，请将每个值用一两句精简的中文概括其核心意思。返回相同键名的JSON。必须输出合法JSON，不可省略键值，不要包含markdown。"
    },
    // 【新增】游戏本地化专属大脑
    game: {
      single: "你是一个资深游戏玩家与本地化翻译专家。请将文本翻译为地道、流畅的中文游戏圈表达。遇到模组(Mod)、道具、技能、UI、前置需求等词汇时，请使用游戏玩家熟悉的专业黑话。只输出结果，不要解释。",
      batch: "你是一个专业的游戏本地化翻译器。用户提供JSON对象，请将值翻译为地道的中文游戏术语和习惯用语。返回相同键名的JSON。必须输出合法JSON，不可省略键值，不要包含markdown。"
    }
  };
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "translate") {
      chrome.storage.local.get(['deepseekApiKey'], async (result) => {
        const apiKey = result.deepseekApiKey;
        if (!apiKey) {
          sendResponse({ success: false, text: "请先点击 ⚙️ 设置 API Key！" });
          return;
        }
  
        // 获取当前选择的模式，默认 normal
        const mode = request.mode || 'normal';
        const systemPrompt = request.type === "single" ? prompts[mode].single : prompts[mode].batch;
        const userContent = request.type === "single" ? request.payload : JSON.stringify(request.payload);
  
        try {
          const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              response_format: request.type === "batch" ? { type: "json_object" } : { type: "text" },
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userContent }
              ]
            })
          });
  
          if (!response.ok) throw new Error(`请求失败 (状态码: ${response.status})`);
  
          const data = await response.json();
          if (data.choices && data.choices.length > 0) {
            let resultText = data.choices[0].message.content;
            
            if (request.type === "batch") {
              try {
                resultText = resultText.replace(/```json/gi, '').replace(/```/g, '').trim();
                sendResponse({ success: true, data: JSON.parse(resultText) });
              } catch (e) {
                sendResponse({ success: false, text: "数据解析异常" });
              }
            } else {
              sendResponse({ success: true, text: resultText });
            }
          } else {
            sendResponse({ success: false, text: "API 返回空数据" });
          }
        } catch (error) {
          sendResponse({ success: false, text: error.message });
        }
      });
      return true; 
    }
  });