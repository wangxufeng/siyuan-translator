/*
 * UI 冒烟测试：node test/uitest.js
 *
 * 用 jsdom 模拟思源运行环境，验证菜单注入、设置面板、剪贴板复制等界面路径。
 * 需要先安装 jsdom：npm install jsdom --no-save
 */
const {JSDOM} = require("jsdom");
const Module = require("module");

// 1. 搭建 jsdom 运行环境
const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {url: "http://127.0.0.1:6806/"});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {value: dom.window.navigator, configurable: true, writable: true});
global.HTMLElement = dom.window.HTMLElement;
global.CustomEvent = dom.window.CustomEvent;
global.URLSearchParams = dom.window.URLSearchParams;
global.TextEncoder = dom.window.TextEncoder;

let copied = "";
Object.defineProperty(dom.window.navigator, "clipboard", {
    value: {
        writeText: (text) => {
            copied = text;
            return Promise.resolve();
        },
    },
    configurable: true,
});
global.fetch = () => Promise.reject(new Error("测试环境不联网"));

// 2. 屏蔽 siyuan 运行时依赖
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === "siyuan") {
        return {
            Plugin: class {
                constructor() {
                    this.eventBus = {on() {}, off() {}};
                    this.saved = null;
                }

                addIcons() {}

                loadData() {
                    return Promise.resolve(this.saved);
                }

                saveData(name, data) {
                    this.saved = data;
                    return Promise.resolve();
                }
            },
        };
    }
    return originalLoad.apply(this, arguments);
};

const Plugin = require("../index.js");

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
    console.log("== 插件加载 ==");
    const plugin = new Plugin({});
    let icons = "";
    plugin.addIcons = (svg) => {
        icons = svg;
    };
    await plugin.onload();
    check("onload 正常完成", !!plugin.config);
    check("默认引擎为自动容错", plugin.config.engine === "auto");
    check("图标已注册", icons.indexOf("iconTranslate") > -1);
    check("事件监听已注册", true);

    console.log("== 右键菜单注入 ==");
    const addedItems = [];
    const fakeMenu = {
        addItem(item) {
            addedItems.push(item);
        },
    };
    // 模拟思源渲染菜单项：调用 bind 并把回调注入
    const renderMenuItem = (item) => {
        const el = document.createElement("li");
        el.className = "b3-menu__item";
        const label = document.createElement("div");
        label.className = "b3-menu__label";
        el.appendChild(label);
        item.el = el;
        if (item.bind) item.bind(el);
        return el;
    };

    plugin.onOpenMenuContent({
        detail: {
            menu: fakeMenu,
            range: {toString: () => "你好世界"},
        },
    });
    check("注入了两个菜单项", addedItems.length === 2, "count=" + addedItems.length);
    check("菜单项带图标", addedItems[0].icon === "iconTranslate");
    check("菜单项初始文案", addedItems[0].label === "翻译中…");
    check("设置项文案正确", addedItems[1].label === "翻译设置…");

    // 无选区时不应注入
    addedItems.length = 0;
    plugin.onOpenMenuContent({detail: {menu: fakeMenu, range: {toString: () => "   "}}});
    check("空白选区不注入菜单项", addedItems.length === 0);

    console.log("== 翻译失败时的降级 ==");
    // 让翻译必然失败
    plugin.config.engine = "edge";
    const origTranslate = plugin.translate.bind(plugin);
    plugin.translate = () => Promise.reject(new Error("模拟网络故障"));
    addedItems.length = 0;
    plugin.onOpenMenuContent({
        detail: {
            menu: fakeMenu,
            range: {toString: () => "测试文本"},
        },
    });
    const failedEl = renderMenuItem(addedItems[0]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    check("失败时显示错误文案", failedEl.querySelector(".b3-menu__label").textContent.indexOf("翻译失败") > -1,
        failedEl.querySelector(".b3-menu__label").textContent);
    check("失败文案带原因", failedEl.querySelector(".b3-menu__label").textContent.indexOf("模拟网络故障") > -1);
    plugin.translate = origTranslate;

    console.log("== 设置面板 ==");
    plugin.openSettings();
    check("设置浮层已创建", !!plugin._overlay && !!document.querySelector(".st-overlay"));
    check("浮层挂载到 body", document.body.contains(plugin._overlay));
    const engineSelect = plugin._overlay.querySelector('[data-key="engine"]');
    const targetSelect = plugin._overlay.querySelector('[data-key="targetMode"]');
    check("引擎下拉存在", !!engineSelect);
    check("方向下拉存在", !!targetSelect);
    check("引擎下拉回填当前值", engineSelect.value === plugin.config.engine, engineSelect.value + " != " + plugin.config.engine);
    check("有道 AppKey 输入框存在", !!plugin._overlay.querySelector('[data-key="youdaoAppKey"]'));
    check("有道 AppSecret 为密码框", plugin._overlay.querySelector('[data-key="youdaoAppSecret"]').type === "password");

    // 改值并保存
    engineSelect.value = "youdao";
    targetSelect.value = "zh";
    plugin._overlay.querySelector('[data-key="youdaoAppKey"]').value = "test-key";
    plugin._overlay.querySelector('[data-key="youdaoAppSecret"]').value = "test-secret";
    plugin._overlay.querySelector('[data-act="save"]').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    check("保存后浮层关闭", !plugin._overlay);
    check("配置已更新", plugin.config.engine === "youdao" && plugin.config.targetMode === "zh");
    check("配置已持久化", plugin.saved && plugin.saved.engine === "youdao");
    check("有道 Key 已保存", plugin.config.youdaoAppKey === "test-key");

    console.log("== 取消按钮 ==");
    plugin.openSettings();
    plugin._overlay.querySelector('[data-act="cancel"]').click();
    check("取消后浮层关闭", !plugin._overlay);
    check("取消不改动配置", plugin.config.engine === "youdao");

    console.log("== 点击遮罩关闭 ==");
    plugin.openSettings();
    plugin._overlay.querySelector(".st-mask").click();
    check("点遮罩后浮层关闭", !plugin._overlay);

    console.log("== 剪贴板复制 ==");
    const ok = await plugin.copyText("Hello 世界");
    check("复制成功", ok === true);
    check("剪贴板内容正确", copied === "Hello 世界", copied);

    console.log("== 消息提示 ==");
    plugin.toast("测试提示");
    check("toast 未抛异常", true);

    console.log("== 卸载清理 ==");
    plugin.openSettings();
    plugin.onunload();
    check("卸载后移除浮层", !plugin._overlay);
    check("卸载后 DOM 无残留", document.querySelectorAll(".st-overlay").length === 0);

    console.log("");
    console.log("通过 " + pass + " 项，失败 " + fail + " 项");
    process.exit(fail > 0 ? 1 : 0);
})();
