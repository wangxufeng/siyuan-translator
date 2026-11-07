# Chinese Translator

A SiYuan (思源笔记) plugin: **select any text → right-click → the translation shows up right in the context menu → click to copy it.**

It detects the language automatically and translates Chinese ⇄ English. The default engine is the free Microsoft Edge endpoint (reachable from mainland China); if that fails it falls back to Google, and to Youdao when you supply your own API key.

## Features

- **Inline translation in the context menu** — no extra dialog, the result shows up in the menu item itself
- **Automatic language detection** — Chinese → English, English → Chinese; mixed text is judged by character ratio
- **Three engines with automatic failover** — Microsoft Edge → Google → Youdao
- **Long text chunking** — text over 4000 characters is split at sentence boundaries and rejoined afterwards
- **Click to copy** — one click puts the translation on the clipboard
- **Local cache** — identical text is served from memory, no repeated requests
- **Actionable errors** — a failed translation shows the reason in the menu, and clicking it opens the settings

## Usage

1. Select a passage of text in your note
2. Right-click → the menu shows **"翻译中…"**
3. The translation appears directly in the menu item
4. Click the item → the translation is copied to your clipboard (hover to see the full text)

## Translation engines

| Engine | API key | Reachable in mainland China | Notes |
| --- | --- | --- | --- |
| Microsoft Edge | Not needed | ✅ Recommended | Edge's built-in translation endpoint, no authentication required since Aug 2026; supports batch translation via a JSON array |
| Google | Not needed | ⚠️ Unreliable | The classic `client=gtx` free endpoint; often rate-limited (429) or timing out behind the firewall |
| Youdao | ✅ | ✅ | Official API, best terminology quality; new accounts get ¥50 of trial credit after real-name verification |

In **auto failover** mode the engines are tried in the order above; the first one that succeeds wins.

### About Youdao (free tier)

**Youdao can be tried for free, but it is not free forever:**

- **Web version** ([fanyi.youdao.com](https://fanyi.youdao.com/)): free, roughly 5000 characters per submission; aggressive use may trigger a CAPTCHA. Its internal endpoint (`dict.youdao.com/translate`) is no longer usable directly (returns 404).
- **Developer API** ([ai.youdao.com](https://ai.youdao.com/)): after registering and completing real-name verification you get **¥50 of trial credit ≈ 1,000,000 characters** (roughly 20,000 short sentences). After that it is billed at **¥48 per million characters**; there is no permanent free quota.

To use it: create an application on the [ai.youdao.com console](https://ai.youdao.com/) (platform type "API"), copy the **AppKey** and **AppSecret**, and paste them into the plugin's translation settings.

The plugin uses the official v3 signature (`signType=v3`, SHA-256). Your keys are stored only in your local `data/storage/petal/<plugin>/` directory and are never sent to any third party.

## Settings

Open **"翻译设置…"** from the right-click menu:

| Option | Values | Notes |
| --- | --- | --- |
| Translation engine | Auto failover / Microsoft Edge / Google / Youdao | Defaults to auto failover |
| Translation direction | Auto-detect / Force English / Force Simplified Chinese | Defaults to auto-detect (Chinese ⇄ English) |
| Youdao AppKey | text | Required for the Youdao engine |
| Youdao AppSecret | password field | Required for the Youdao engine |

## Installation

**Option 1: source directory**

Clone or download this repository and put the whole directory into your SiYuan workspace under `data/plugins/` (the directory name must match the `name` field in `plugin.json`), then restart SiYuan.

**Option 2: release archive**

Download `package.zip` and extract it into `data/plugins/`.

## Development

```bash
node test/selftest.js          # logic self-test + live calls to the Edge / Google endpoints
npm install jsdom --no-save    # required by the UI smoke test
node test/uitest.js            # menu injection, settings panel, clipboard, teardown
```

`selftest.js` runs without the SiYuan runtime and hits the real Microsoft Edge / Google endpoints. It covers language detection, translation direction, long-text chunking, the SHA-256 signature implementation and the full translation flow. `uitest.js` uses jsdom to simulate the runtime and verifies the UI paths.

## Disclaimer

The plugin calls vendor **unofficial free endpoints**, which may change or disappear at any time and may be rate-limited. It is provided for demonstration purposes; do not use it for high-concurrency workloads.
