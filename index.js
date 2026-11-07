/*
 * 思源笔记插件：中文翻译助手
 *
 * 交互沿用右键菜单：
 *   1. 在笔记中选中文字
 *   2. 右键 -> "翻译中…" 菜单项
 *   3. 译文直接显示在菜单项里
 *   4. 点击该项复制译文到剪贴板
 *
 * 引擎：微软 Edge 免费端点（默认，国内可直连）-> Google 免费端点 -> 有道智云（需自备 Key）
 */

const { Plugin } = require("siyuan");

// 思源原生消息提示（部分版本可能未导出，取不到时回落到自绘 toast）
let nativeShowMessage = null;
try {
    if (typeof require("siyuan").showMessage === "function") {
        nativeShowMessage = require("siyuan").showMessage;
    }
} catch (e) {
    // 忽略，走自绘 toast
}

const STORAGE_NAME = "config.json";
// 选区超过该长度时拒绝翻译，避免误把整篇文档送进翻译接口
const MAX_SELECT_LENGTH = 20000;
// 单次请求的最大字符数，超出则按句子边界切块
const MAX_CHUNK_LENGTH = 4000;

const DEFAULT_CONFIG = {
    engine: "auto", // auto | edge | google | youdao
    targetMode: "auto", // auto | en | zh
    youdaoAppKey: "",
    youdaoAppSecret: "",
};

// 逻辑语种 -> 各引擎自己的语种代码
const LANGUAGES = {
    zhHans: {label: "简体中文", edge: "zh-Hans", google: "zh-CN", youdao: "zh-CHS"},
    zhHant: {label: "繁體中文", edge: "zh-Hant", google: "zh-TW", youdao: "zh-CHT"},
    en: {label: "English", edge: "en", google: "en", youdao: "en"},
};

const ENGINE_LABELS = {
    edge: "微软 Edge",
    google: "Google",
    youdao: "有道智云",
};

/* ------------------------------------------------------------------ *
 * 纯工具函数
 * ------------------------------------------------------------------ */

/**
 * 粗略判断文本主语言：zh / en / other
 */
function detectLang(text) {
    const cjk = (text.match(/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    if (cjk === 0 && latin === 0) return "other";
    if (cjk === 0) return "en";
    if (latin === 0) return "zh";
    // 中英混排：以汉字占比 30% 为界
    return cjk / (cjk + latin) >= 0.3 ? "zh" : "en";
}

/**
 * 依据识别到的语种和用户设置决定翻译方向
 */
function resolveDirection(lang, targetMode) {
    if (targetMode === "en") {
        return {from: lang === "zh" ? "zhHans" : "auto", to: "en"};
    }
    if (targetMode === "zh") {
        return {from: lang === "en" ? "en" : "auto", to: "zhHans"};
    }
    if (lang === "zh") return {from: "zhHans", to: "en"};
    if (lang === "en") return {from: "en", to: "zhHans"};
    return {from: "auto", to: "en"};
}

/**
 * 按句子边界切块，尽量不切断句子
 */
function splitText(text, maxChars) {
    if (!maxChars || maxChars <= 0) return [text];
    if (text.length <= maxChars) return [text];

    const separators = ["\n", "。", "！", "？", "；", ". ", "! ", "? ", "; ", "，", ", "];
    const chunks = [];
    let rest = text;

    while (rest.length > maxChars) {
        const window = rest.substring(0, maxChars);
        let bestIndex = -1;
        let bestLength = 0;
        for (const sep of separators) {
            const index = window.lastIndexOf(sep);
            if (index > bestIndex) {
                bestIndex = index;
                bestLength = sep.length;
            }
        }
        // 找不到合适的断点（或者断点太靠前）就硬切
        let cut;
        if (bestIndex > maxChars * 0.3) {
            cut = bestIndex + bestLength;
        } else {
            cut = maxChars;
        }
        chunks.push(rest.substring(0, cut));
        rest = rest.substring(cut);
    }
    if (rest.length > 0) chunks.push(rest);
    return chunks;
}

/**
 * 拼接分块译文：硬切导致的英文单词被拆开时补一个空格
 */
function joinChunks(results) {
    let out = "";
    for (const piece of results) {
        if (!piece) continue;
        if (out) {
            const last = out.charAt(out.length - 1);
            const first = piece.charAt(0);
            if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first)) out += " ";
        }
        out += piece;
    }
    return out;
}

function toHex(buffer) {
    const bytes = new Uint8Array(buffer);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
}

/**
 * SHA-256（纯 JS 实现），在 WebCrypto 不可用时兜底
 */
function sha256HexSync(str) {
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let H = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    const bytes = new TextEncoder().encode(str);
    const bitLength = bytes.length * 8;
    const size = ((bytes.length + 8) >> 6 << 6) + 64;
    const buf = new Uint8Array(size);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    for (let i = 0; i < 8; i++) {
        buf[size - 1 - i] = Math.floor(bitLength / Math.pow(2, i * 8)) & 0xff;
    }

    const w = new Array(64);
    const rotr = (v, a) => (v >>> a) | (v << (32 - a));

    for (let offset = 0; offset < size; offset += 64) {
        for (let i = 0; i < 16; i++) {
            w[i] = (buf[offset + i * 4] << 24) | (buf[offset + i * 4 + 1] << 16) |
                (buf[offset + i * 4 + 2] << 8) | buf[offset + i * 4 + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }

        let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;
            h = g;
            g = f;
            f = e;
            e = (d + temp1) | 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) | 0;
        }
        H[0] = (H[0] + a) | 0;
        H[1] = (H[1] + b) | 0;
        H[2] = (H[2] + c) | 0;
        H[3] = (H[3] + d) | 0;
        H[4] = (H[4] + e) | 0;
        H[5] = (H[5] + f) | 0;
        H[6] = (H[6] + g) | 0;
        H[7] = (H[7] + h) | 0;
    }
    return H.map((v) => (v >>> 0).toString(16).padStart(8, "0")).join("");
}

/**
 * SHA-256，优先用 WebCrypto，不可用时回落到纯 JS 实现
 */
async function sha256Hex(str) {
    const subtle = globalThis.crypto && globalThis.crypto.subtle;
    if (subtle && typeof subtle.digest === "function") {
        try {
            const buffer = await subtle.digest("SHA-256", new TextEncoder().encode(str));
            return toHex(buffer);
        } catch (e) {
            console.warn("[中文翻译] WebCrypto 计算 SHA-256 失败，改用内置实现：" + e);
        }
    }
    return sha256HexSync(str);
}

function genSalt() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }
    return String(Date.now()) + Math.random().toString(36).slice(2, 10);
}

/* ------------------------------------------------------------------ *
 * 翻译引擎
 * ------------------------------------------------------------------ */

const ENGINES = {
    /**
     * 微软 Edge 浏览器内置的翻译端点，2026-08 起无需鉴权，国内可直连。
     * 支持一次传入数组批量翻译。
     */
    edge: {
        label: ENGINE_LABELS.edge,
        async translate(chunks, from, to) {
            const url = "https://edge.microsoft.com/translate/translatetext"
                + "?from=" + encodeURIComponent(from === "auto" ? "" : LANGUAGES[from].edge)
                + "&to=" + encodeURIComponent(LANGUAGES[to].edge)
                + "&isEnterpriseClient=false";
            const resp = await fetch(url, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify(chunks),
            });
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            if (!Array.isArray(data)) throw new Error("返回格式异常");
            return data.map((item) => {
                if (!item || !item.translations || !item.translations[0] || !item.translations[0].text) {
                    throw new Error("返回内容为空");
                }
                return item.translations[0].text;
            });
        },
    },

    /**
     * Google Translate 免费端点，无需 Key，但国内通常不通。
     */
    google: {
        label: ENGINE_LABELS.google,
        async translate(chunks, from, to) {
            const results = [];
            const sl = from === "auto" ? "auto" : LANGUAGES[from].google;
            for (const chunk of chunks) {
                const url = "https://translate.googleapis.com/translate_a/single?client=gtx"
                    + "&sl=" + encodeURIComponent(sl)
                    + "&tl=" + encodeURIComponent(LANGUAGES[to].google)
                    + "&dt=t&q=" + encodeURIComponent(chunk);
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const data = await resp.json();
                if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("返回格式异常");
                let text = "";
                for (const segment of data[0]) {
                    if (segment && segment[0]) text += segment[0];
                }
                if (!text) throw new Error("返回内容为空");
                results.push(text);
            }
            return results;
        },
    },

    /**
     * 有道智云文本翻译 API，签名 v3（SHA-256），需要在控制台申请 AppKey / AppSecret。
     */
    youdao: {
        label: ENGINE_LABELS.youdao,
        async translate(chunks, from, to, config) {
            if (!config.youdaoAppKey || !config.youdaoAppSecret) {
                throw new Error("未配置有道 AppKey / AppSecret");
            }
            const results = [];
            const source = from === "auto" ? "auto" : LANGUAGES[from].youdao;
            const target = LANGUAGES[to].youdao;
            for (const chunk of chunks) {
                const salt = genSalt();
                const curtime = Math.floor(Date.now() / 1000);
                const input = chunk.length > 20
                    ? chunk.substring(0, 10) + chunk.length + chunk.substring(chunk.length - 10)
                    : chunk;
                const sign = await sha256Hex(config.youdaoAppKey + input + salt + curtime + config.youdaoAppSecret);
                const body = new URLSearchParams();
                body.append("q", chunk);
                body.append("from", source);
                body.append("to", target);
                body.append("appKey", config.youdaoAppKey);
                body.append("salt", salt);
                body.append("sign", sign);
                body.append("signType", "v3");
                body.append("curtime", String(curtime));
                const resp = await fetch("https://openapi.youdao.com/api", {
                    method: "POST",
                    headers: {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
                    body: body.toString(),
                });
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                const data = await resp.json();
                if (data.errorCode) throw new Error("有道错误码 " + data.errorCode);
                if (Array.isArray(data.translation)) {
                    results.push(data.translation.join("\n"));
                } else if (typeof data.translation === "string") {
                    results.push(data.translation);
                } else {
                    throw new Error("返回内容为空");
                }
            }
            return results;
        },
    },
};

/**
 * 按配置生成引擎调用顺序
 */
function engineChain(config) {
    switch (config.engine) {
        case "edge":
            return ["edge"];
        case "google":
            return ["google"];
        case "youdao":
            return ["youdao"];
        default: {
            const chain = ["edge", "google"];
            if (config.youdaoAppKey && config.youdaoAppSecret) chain.push("youdao");
            return chain;
        }
    }
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */

module.exports = class TranslatorPlugin extends Plugin {
    async onload() {
        this.addIcons(`<symbol id="iconTranslate" viewBox="0 0 24 24">
      <path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0014.07 6H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"></path>
    </symbol>`);

        const saved = await this.loadData(STORAGE_NAME);
        this.config = Object.assign({}, DEFAULT_CONFIG, saved || {});
        this.cache = new Map();

        this._onOpenMenuContent = this.onOpenMenuContent.bind(this);
        this.eventBus.on("open-menu-content", this._onOpenMenuContent);
    }

    onunload() {
        this.eventBus.off("open-menu-content", this._onOpenMenuContent);
        if (this._overlay) {
            this._overlay.remove();
            this._overlay = null;
        }
        if (this._styleElement) {
            this._styleElement.remove();
            this._styleElement = null;
        }
        if (this._toastBox) {
            this._toastBox.remove();
            this._toastBox = null;
        }
    }

    onOpenMenuContent(event) {
        const detail = event.detail || {};
        const menu = detail.menu;
        if (!menu) return;

        const text = this.getSelectedText(detail);
        if (!text) return;

        const self = this;
        let state = "loading";
        let translated = "";

        menu.addItem({
            icon: "iconTranslate",
            label: "翻译中…",
            click: function () {
                if (state === "success") {
                    self.copyText(translated).then(function (ok) {
                        self.toast(ok ? "译文已复制到剪贴板" : "复制失败，请手动选中译文复制");
                    });
                } else {
                    // 翻译失败时点击直接打开设置，方便换引擎或填 Key
                    self.openSettings();
                }
            },
            bind: function (el) {
                const labelEl = el.querySelector(".b3-menu__label");
                if (!labelEl) return;
                self.translate(text).then(function (result) {
                    state = "success";
                    translated = result.text;
                    labelEl.textContent = result.text;
                    labelEl.title = "点击复制译文（由 " + result.engine + " 翻译）";
                    self.wrapLabel(labelEl);
                }).catch(function (err) {
                    state = "error";
                    const message = err && err.message ? err.message : "未知错误";
                    labelEl.textContent = "⚠ 翻译失败：" + message;
                    labelEl.title = "点击打开翻译设置";
                    self.wrapLabel(labelEl);
                });
            },
        });

        menu.addItem({
            icon: "iconSettings",
            label: "翻译设置…",
            click: function () {
                self.openSettings();
            },
        });
    }

    /**
     * 取当前选中的文本
     */
    getSelectedText(detail) {
        let text = "";
        const range = detail.range;
        if (range && typeof range.toString === "function") {
            text = range.toString();
        }
        if (!text && window.getSelection) {
            text = window.getSelection().toString() || "";
        }
        return (text || "").trim();
    }

    /**
     * 长译文在菜单里换行显示
     */
    wrapLabel(labelEl) {
        labelEl.style.whiteSpace = "normal";
        labelEl.style.wordBreak = "break-word";
        labelEl.style.maxWidth = "420px";
        labelEl.style.lineHeight = "1.4";
    }

    /**
     * 翻译文本，自动在多个引擎之间容错
     */
    async translate(text) {
        if (text.length > MAX_SELECT_LENGTH) {
            throw new Error("选区过长（" + text.length + " 字符），请只选中要翻译的段落");
        }

        const cacheKey = this.config.engine + "|" + this.config.targetMode + "|" + text;
        if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

        const lang = detectLang(text);
        const direction = resolveDirection(lang, this.config.targetMode);
        const chunks = splitText(text, MAX_CHUNK_LENGTH);
        const chain = engineChain(this.config);

        let lastError = null;
        for (const id of chain) {
            try {
                const results = await ENGINES[id].translate(chunks, direction.from, direction.to, this.config);
                const result = {
                    text: joinChunks(results),
                    engine: ENGINES[id].label,
                    from: direction.from,
                    to: direction.to,
                };
                this.cache.set(cacheKey, result);
                if (this.cache.size > 200) {
                    this.cache.delete(this.cache.keys().next().value);
                }
                return result;
            } catch (err) {
                lastError = err;
                console.warn("[中文翻译] " + id + " 翻译失败：" + (err && err.message ? err.message : err));
            }
        }
        throw lastError || new Error("没有可用的翻译引擎");
    }

    /**
     * 复制文本到剪贴板
     */
    async copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (err) {
            console.warn("[中文翻译] 剪贴板 API 失败，尝试兜底方案：" + err);
        }
        try {
            const textarea = document.createElement("textarea");
            textarea.value = text;
            textarea.style.position = "fixed";
            textarea.style.top = "-1000px";
            textarea.style.opacity = "0";
            document.body.appendChild(textarea);
            textarea.select();
            const ok = document.execCommand("copy");
            document.body.removeChild(textarea);
            return ok;
        } catch (err) {
            console.warn("[中文翻译] 复制失败：" + err);
            return false;
        }
    }

    /**
     * 轻量提示
     */
    toast(message, duration) {
        if (nativeShowMessage) {
            try {
                nativeShowMessage(message, duration || 2200);
                return;
            } catch (e) {
                console.warn("[中文翻译] 原生消息提示失败，改用自绘提示：" + e);
            }
        }
        if (!this._toastBox) {
            this._toastBox = document.createElement("div");
            this._toastBox.id = "siyuan-translator-toast";
            this._toastBox.style.cssText = "position:fixed;left:50%;bottom:56px;transform:translateX(-50%);"
                + "z-index:99999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;";
            document.body.appendChild(this._toastBox);
        }
        const item = document.createElement("div");
        item.textContent = message;
        item.style.cssText = "background:#1f1f1f;color:#fff;padding:8px 16px;border-radius:6px;font-size:14px;"
            + "line-height:1.4;box-shadow:0 4px 14px rgba(0,0,0,.28);max-width:80vw;word-break:break-word;";
        this._toastBox.appendChild(item);
        setTimeout(function () {
            if (item.parentNode) item.parentNode.removeChild(item);
        }, duration || 2200);
    }

    ensureStyle() {
        if (this._styleElement) return;
        const style = document.createElement("style");
        style.textContent = `
.st-overlay { position: fixed; inset: 0; z-index: 99998; display: flex; align-items: center; justify-content: center; }
.st-mask { position: absolute; inset: 0; background: rgba(0,0,0,.45); }
.st-dialog { position: relative; width: 420px; max-width: 92vw; max-height: 86vh; overflow: auto;
    background: var(--b3-theme-background, #fff); color: var(--b3-theme-onlight-color, #333);
    border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.3); font-size: 14px; }
.st-title { padding: 14px 18px; font-size: 16px; font-weight: 600; border-bottom: 1px solid var(--b3-border-color, #e5e5e5); }
.st-body { padding: 6px 18px 10px; }
.st-field { margin: 12px 0; }
.st-field__label { margin-bottom: 6px; color: var(--b3-theme-onlight-secondary-color, #888); font-size: 13px; }
.st-input { width: 100%; box-sizing: border-box; padding: 6px 8px; font-size: 14px; font-family: inherit;
    color: inherit; background: var(--b3-theme-background, #fff);
    border: 1px solid var(--b3-border-color, #d5d5d5); border-radius: 4px; }
.st-note { margin-top: 12px; font-size: 12px; line-height: 1.6; color: var(--b3-theme-onlight-secondary-color, #999); }
.st-footer { padding: 10px 18px 16px; display: flex; justify-content: flex-end; gap: 8px; }
.st-btn { padding: 6px 16px; font-size: 14px; font-family: inherit; cursor: pointer; border-radius: 4px;
    border: 1px solid var(--b3-border-color, #d5d5d5); background: transparent; color: inherit; }
.st-btn:hover { background: var(--b3-theme-background-light, #f5f5f5); }
.st-btn--primary { background: var(--b3-primary-color, #337ab7); border-color: var(--b3-primary-color, #337ab7); color: #fff; }
.st-btn--primary:hover { opacity: .9; background: var(--b3-primary-color, #337ab7); }
`;
        document.head.appendChild(style);
        this._styleElement = style;
    }

    openSettings() {
        if (this._overlay) {
            this._overlay.remove();
            this._overlay = null;
            return;
        }
        this.ensureStyle();

        const self = this;
        const overlay = document.createElement("div");
        overlay.className = "st-overlay";
        overlay.innerHTML = `
<div class="st-mask"></div>
<div class="st-dialog">
    <div class="st-title">翻译设置</div>
    <div class="st-body">
        <div class="st-field">
            <div class="st-field__label">翻译引擎</div>
            <select class="st-input" data-key="engine">
                <option value="auto">自动容错（Edge → Google → 有道）</option>
                <option value="edge">微软 Edge（免费，国内可直连）</option>
                <option value="google">Google（免费，海外可直连）</option>
                <option value="youdao">有道智云（需 AppKey）</option>
            </select>
        </div>
        <div class="st-field">
            <div class="st-field__label">翻译方向</div>
            <select class="st-input" data-key="targetMode">
                <option value="auto">自动识别（中文 ↔ 英文）</option>
                <option value="en">强制译成英文</option>
                <option value="zh">强制译成简体中文</option>
            </select>
        </div>
        <div class="st-field">
            <div class="st-field__label">有道 AppKey</div>
            <input class="st-input" type="text" data-key="youdaoAppKey" placeholder="在 ai.youdao.com 控制台申请" />
        </div>
        <div class="st-field">
            <div class="st-field__label">有道 AppSecret</div>
            <input class="st-input" type="password" data-key="youdaoAppSecret" placeholder="仅保存在本地 data/storage" />
        </div>
        <div class="st-note">
            有道智云：注册并实名认证后可获 50 元体验金（约 100 万字符），用尽后按量计费 48 元/百万字符。
        </div>
    </div>
    <div class="st-footer">
        <button class="st-btn" data-act="cancel">取消</button>
        <button class="st-btn st-btn--primary" data-act="save">保存</button>
    </div>
</div>`;

        document.body.appendChild(overlay);
        this._overlay = overlay;

        overlay.querySelectorAll("[data-key]").forEach(function (el) {
            const key = el.getAttribute("data-key");
            if (self.config[key] !== undefined) el.value = self.config[key];
        });

        overlay.querySelector(".st-mask").addEventListener("click", function () {
            self.closeSettings();
        });
        overlay.querySelector('[data-act="cancel"]').addEventListener("click", function () {
            self.closeSettings();
        });
        overlay.querySelector('[data-act="save"]').addEventListener("click", function () {
            const next = Object.assign({}, self.config);
            overlay.querySelectorAll("[data-key]").forEach(function (el) {
                next[el.getAttribute("data-key")] = el.value;
            });
            self.config = next;
            self.saveData(STORAGE_NAME, next);
            self.cache.clear();
            self.closeSettings();
            self.toast("设置已保存");
        });
    }

    closeSettings() {
        if (this._overlay) {
            this._overlay.remove();
            this._overlay = null;
        }
    }
};

// 导出内部函数，便于自动化自测
module.exports.util = {
    detectLang: detectLang,
    resolveDirection: resolveDirection,
    splitText: splitText,
    joinChunks: joinChunks,
    sha256Hex: sha256Hex,
    sha256HexSync: sha256HexSync,
    engineChain: engineChain,
    ENGINES: ENGINES,
    LANGUAGES: LANGUAGES,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
};
