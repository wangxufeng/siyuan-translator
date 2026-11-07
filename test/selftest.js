/*
 * 插件自测：node test/selftest.js
 *
 * 直接运行本文件即可，无需安装依赖，也不需要启动思源。
 * 里面会用真实网络调用微软 Edge / Google 的免费翻译端点。
 */
const crypto = require("crypto");
const Module = require("module");

// 屏蔽对 siyuan 运行时模块的依赖，让纯逻辑能在 Node 里跑
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === "siyuan") {
        return {
            Plugin: class {
                constructor() {
                    this.eventBus = {on() {}, off() {}};
                }

                addIcons() {}

                loadData() {
                    return Promise.resolve(null);
                }

                saveData() {
                    return Promise.resolve();
                }
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const Plugin = require("../index.js");
const util = Plugin.util;

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
    if (cond) {
        pass++;
        console.log("  PASS  " + name);
    } else {
        fail++;
        console.log("  FAIL  " + name + (extra ? "  ::  " + extra : ""));
    }
}

(async function () {
    console.log("== 语言检测 ==");
    check("纯中文 -> zh", util.detectLang("你好世界，今天天气很好。") === "zh");
    check("纯英文 -> en", util.detectLang("Hello world, today is a good day.") === "en");
    check("中文为主 -> zh", util.detectLang("思源笔记 SiYuan 很好用") === "zh");
    check("英文为主 -> en", util.detectLang("Hello 世界") === "en");
    check("无字母 -> other", util.detectLang("12345 !!!") === "other");

    console.log("== 翻译方向 ==");
    check("zh -> en", util.resolveDirection("zh", "auto").to === "en" && util.resolveDirection("zh", "auto").from === "zhHans");
    check("en -> zh", util.resolveDirection("en", "auto").to === "zhHans");
    check("强制英文", util.resolveDirection("en", "en").to === "en");
    check("强制中文", util.resolveDirection("zh", "zh").to === "zhHans");

    console.log("== 长文本分块 ==");
    check("短文本不切分", util.splitText("短文本", 4000).length === 1);
    const long = "第一句话。第二句话！第三句话？\n".repeat(200);
    const chunks = util.splitText(long, 500);
    check("长文本被切分", chunks.length > 1, "chunks=" + chunks.length);
    check("分块后内容不丢失", chunks.join("") === long);
    check("每块不超上限", chunks.every((c) => c.length <= 500));
    const noBreak = "A".repeat(1200);
    const hardChunks = util.splitText(noBreak, 500);
    check("无断点时硬切", hardChunks.length === 3 && hardChunks.join("") === noBreak);
    check("拼接补空格", util.joinChunks(["Hello wor", "ld"]) === "Hello wor ld");
    check("中文拼接不加空格", util.joinChunks(["你好", "世界"]) === "你好世界");

    console.log("== SHA-256 ==");
    const samples = ["", "abc", "hello world",
        "appKey=123456 salt=abc curtime=1700000000 secret=xyz",
        "x".repeat(1000), "中文测试 with 🚀 emoji"];
    for (const s of samples) {
        const expected = crypto.createHash("sha256").update(s, "utf8").digest("hex");
        const sync = util.sha256HexSync(s);
        check("纯 JS 实现 " + JSON.stringify(s.slice(0, 14)), sync === expected, sync + " != " + expected);
    }
    for (const s of samples) {
        const expected = crypto.createHash("sha256").update(s, "utf8").digest("hex");
        const got = await util.sha256Hex(s);
        check("WebCrypto 路径 " + JSON.stringify(s.slice(0, 14)), got === expected, got + " != " + expected);
    }

    console.log("== 引擎调用链 ==");
    check("auto -> edge,google", JSON.stringify(util.engineChain({engine: "auto"})) === JSON.stringify(["edge", "google"]));
    check("配置有道后追加", JSON.stringify(util.engineChain({engine: "auto", youdaoAppKey: "k", youdaoAppSecret: "s"})) === JSON.stringify(["edge", "google", "youdao"]));
    check("指定 edge 只用 edge", JSON.stringify(util.engineChain({engine: "edge"})) === JSON.stringify(["edge"]));

    console.log("== 真实端点：微软 Edge ==");
    try {
        const r1 = await util.ENGINES.edge.translate(["你好，世界"], "zhHans", "en");
        console.log("       zh -> en : " + r1[0]);
        check("Edge 中译英", !!r1[0] && /hello/i.test(r1[0]), r1[0]);
    } catch (e) {
        check("Edge 中译英", false, e.message);
    }
    try {
        const r2 = await util.ENGINES.edge.translate(["SiYuan is a WYSIWYG note-taking app."], "en", "zhHans");
        console.log("       en -> zh : " + r2[0]);
        check("Edge 英译中", !!r2[0] && /[\u4e00-\u9fff]/.test(r2[0]), r2[0]);
    } catch (e) {
        check("Edge 英译中", false, e.message);
    }
    try {
        const r3 = await util.ENGINES.edge.translate(["第一句话。", "第二句话！", "第三句话？"], "zhHans", "en");
        console.log("       批量    : " + JSON.stringify(r3));
        check("Edge 批量数组", Array.isArray(r3) && r3.length === 3 && r3[0].length > 0, JSON.stringify(r3));
    } catch (e) {
        check("Edge 批量数组", false, e.message);
    }

    console.log("== 真实端点：Google ==");
    try {
        const r4 = await util.ENGINES.google.translate(["你好，世界"], "zhHans", "en");
        console.log("       zh -> en : " + r4[0]);
        check("Google 中译英", !!r4[0], r4[0]);
    } catch (e) {
        console.log("       SKIP  当前网络下 Google 不可用（预期内的降级路径）：" + e.message);
    }

    console.log("== 插件完整流程 ==");
    const plugin = new Plugin({});
    plugin.config = Object.assign({}, util.DEFAULT_CONFIG);
    plugin.cache = new Map();
    try {
        const res = await plugin.translate("今天天气很好，我们一起去公园散步吧。");
        console.log("       译文 : " + res.text);
        check("中文自动译英文", !!res.text && /[a-z]/i.test(res.text), res.text);
        check("记录所用引擎", !!res.engine, res.engine);
    } catch (e) {
        check("中文自动译英文", false, e.message);
    }
    try {
        const res2 = await plugin.translate("This is a test of the English to Chinese direction.");
        console.log("       译文 : " + res2.text);
        check("英文自动译中文", !!res2.text && /[\u4e00-\u9fff]/.test(res2.text), res2.text);
    } catch (e) {
        check("英文自动译中文", false, e.message);
    }
    try {
        const res3 = await plugin.translate("短句");
        const res4 = await plugin.translate("短句");
        check("相同文本命中缓存", res3 === res4);
    } catch (e) {
        check("相同文本命中缓存", false, e.message);
    }

    console.log("");
    console.log("通过 " + pass + " 项，失败 " + fail + " 项");
    process.exit(fail > 0 ? 1 : 0);
})();
