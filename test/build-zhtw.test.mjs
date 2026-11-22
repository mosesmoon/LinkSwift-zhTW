import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as espree from "espree";
import { buildZhTw, createConverter, loadProtectConfig, DEFAULT_IN, DEFAULT_PROTECT, PARSE_OPTIONS, GENERATED_NOTICE, UPDATE_URL } from "../tools/build-zhtw.mjs";

const convert = createConverter();
const build = (src, protect = { literals: [] }) => buildZhTw(src, { convert, protect });

const META = [
	"// ==UserScript==",
	"// @name              Demo",
	"// @namespace         github.com/someone",
	"// @description       简体描述",
	"// @description:zh-TW 繁體描述",
	"// @match             *://pan.baidu.com/*",
	"// @grant             GM_xmlhttpRequest",
	"// ==/UserScript==",
	"",
].join("\n");

describe("fixture: 轉換與保留", () => {
	const body = [
		'alert("文件下载");',
		'if (x === "文件") {}',
		'if (s.includes("文件")) {}',
		'switch (v) { case "文件": break; }',
		"$('a:contains(\"下载\")').hide();",
		'const o = { "文件": 1 };',
		'const u = "https://example.com/搜索?q=文件";',
		'const keep = "保留这个文件";',
		'const t = `<div title="文件">${name}下载</div>`;',
		"// 注释：文件下载",
		's.replace("百度", "") + "网络设置";',
		'GM_xmlhttpRequest({ url: "/api/文件", data: "文件=1", onload: () => alert("请求失败") });',
		'tag.text("会员中心"); if (tag.text() === "会员中心") {}',
		'const re = /文件/;',
	].join("\n");
	const src = META + body + "\n";
	let out, report;
	before(() => ({ output: out, report } = build(src, { literals: ["保留这个文件"], notes: { "保留这个文件": "測試" } })));

	test("顯示字串轉為台灣用語", () => {
		assert.match(out, /alert\("檔案下載"\);/);
		assert.match(out, /`<div title="檔案">\$\{name\}下載<\/div>`/);
		assert.match(out, /\/\/ 註釋：檔案下載/);
		assert.match(out, /\+ "網路設定";/);
		assert.match(out, /alert\("請求失敗"\)/, "請求呼叫內的回呼函式不應被保護");
	});

	test("比對 / 選擇器 / 鍵 / URL / 清單字串保持不變", () => {
		for (const s of ['x === "文件"', 's.includes("文件")', 'case "文件":', "$('a:contains(\"下载\")')", '{ "文件": 1 }', '"https://example.com/搜索?q=文件"', '"保留这个文件"', 's.replace("百度", "")', 'url: "/api/文件"', 'data: "文件=1"', "/文件/"]) {
			assert.ok(out.includes(s), `應保持不變：${s}`);
		}
	});

	test("比對字串的同值字串也一併保留", () => {
		assert.ok(out.includes('tag.text("会员中心"); if (tag.text() === "会员中心")'));
		assert.ok(report.protected.some((p) => p.reason === "same-value" && p.value === "会员中心"));
	});

	test("報告列出保留理由與行號", () => {
		const reasons = new Set(report.protected.map((p) => p.reason));
		for (const r of ["comparison", "string-method", "switch-case", "selector-syntax", "url", "allowlist", "request"]) assert.ok(reasons.has(r), `缺少理由 ${r}`);
		const allow = report.protected.find((p) => p.reason === "allowlist");
		assert.equal(allow.line, META.split("\n").length - 1 + 8);
		assert.match(allow.detail, /測試/);
	});

	test("metadata 改寫", () => {
		const lines = out.split("\n");
		assert.equal(lines[1], "// @name              LinkSwift 繁中版");
		assert.equal(lines[2], "// @namespace         github.com/mosesmoon");
		assert.equal(lines[3], "// @description       繁體描述");
		assert.ok(lines.includes(`// @updateURL         ${UPDATE_URL}`));
		assert.ok(lines.includes(`// @downloadURL       ${UPDATE_URL}`));
		assert.ok(lines.includes("// @match             *://pan.baidu.com/*"));
		assert.equal(lines[lines.indexOf("// ==/UserScript==") + 1], GENERATED_NOTICE);
		assert.ok(out.includes("// @description:zh-TW 繁體描述"));
	});
});

test("fixture: $() 建立 HTML 時內層字串照常轉換，選擇器則保留", () => {
	const src = META + 'const li = $(`<li>${ok ? "成功" : "失败"}</li>`);\nconst el = $(".item[title=\\"手机\\"]");\nel.find("文件");\n';
	const { output } = build(src);
	assert.ok(output.includes('$(`<li>${ok ? "成功" : "失敗"}</li>`)'));
	assert.ok(output.includes('$(".item[title=\\"手机\\"]")'));
	assert.ok(output.includes('el.find("文件")'));
});

test("fixture: CRLF 與多行樣板字串保持換行格式", () => {
	const src = META.replace(/\n/g, "\r\n") + "const h = `\r\n<div>文件</div>\r\n<span>${a}下载</span>\r\n`;\r\n// 设置\r\n";
	const { output, report } = build(src);
	assert.equal(report.totals.eol, "CRLF");
	assert.equal(output.match(/(?<!\r)\n/g), null, "不應出現單獨的 LF");
	assert.ok(output.includes("const h = `\r\n<div>檔案</div>\r\n<span>${a}下載</span>\r\n`;\r\n// 設定\r\n"));
	assert.ok(output.includes(`// ==/UserScript==\r\n${GENERATED_NOTICE}\r\n`));
});

test("fixture: 跳脫字元與 BOM 原樣保留", () => {
	const src = "﻿" + META + 'const a = "文件\\n\\u4e0b载\\"";\n';
	const { output } = build(src);
	assert.ok(output.startsWith("﻿// ==UserScript=="));
	assert.ok(output.includes('const a = "檔案\\n\\u4e0b載\\"";'));
});

test("fixture: 建置結果可重現且對產物再建置不會重複插入註記", () => {
	const src = META + 'alert("文件");\n';
	const a = build(src).output;
	assert.equal(build(src).output, a);
	assert.equal(build(a).output.split(GENERATED_NOTICE).length - 1, 1);
});

// ---------- 真實檔案 ----------
async function readParsableSource() {
	let lastErr;
	for (let i = 0; i < 10; i++) {
		const text = fs.readFileSync(DEFAULT_IN, "utf8");
		try {
			espree.parse(text.replace(/^﻿/, ""), PARSE_OPTIONS);
			return text;
		} catch (e) {
			lastErr = e; // 另一個流程可能正在編輯原始碼，稍候重試
			await sleep(3000);
		}
	}
	throw lastErr;
}

describe("real file", () => {
	let src, out, report, tmpDir, outFile;
	before(async () => {
		src = await readParsableSource();
		({ output: out, report } = buildZhTw(src, { convert, protect: loadProtectConfig(DEFAULT_PROTECT) }));
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhtw-"));
		outFile = path.join(tmpDir, "LinkSwift.zh-TW.user.js");
		fs.writeFileSync(outFile, out, "utf8");
	});

	test("輸出通過 node --check", () => {
		const r = spawnSync(process.execPath, ["--check", outFile], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
	});

	test("token 序列與原始碼一致（忽略 String / Template 的值）", () => {
		const sig = (code) => espree.parse(code.replace(/^﻿/, ""), PARSE_OPTIONS).tokens.map((t) => (t.type === "String" || t.type === "Template" ? t.type : `${t.type}\u0001${t.value}`));
		const a = sig(src);
		const b = sig(out);
		assert.equal(b.length, a.length);
		assert.deepEqual(b, a);
	});

	test("metadata 的 @match / @connect / @require / @resource / @grant / @run-at 完全相同", () => {
		const pick = (code) => code.split(/\r?\n/).filter((l) => /^\/\/\s*@(match|connect|require|resource|grant|run-at)\b/.test(l));
		const a = pick(src);
		assert.ok(a.length > 10);
		assert.deepEqual(pick(out), a);
	});

	test("有轉換內容且保留了已知的比對字串", () => {
		assert.ok(report.totals.stringsConverted > 100);
		assert.ok(out.includes('encodeURIComponent("LinkSwift:主代码")'));
		assert.ok(out.includes("// @name              LinkSwift 繁中版"));
	});

	test("建置兩次結果相同", () => {
		const again = buildZhTw(src, { convert, protect: loadProtectConfig(DEFAULT_PROTECT) });
		assert.equal(again.output, out);
		assert.equal(again.reportMarkdown, buildZhTw(src, { convert, protect: loadProtectConfig(DEFAULT_PROTECT) }).reportMarkdown);
	});
});

test("台灣用語修正表：修正 OpenCC 斷詞錯誤與大陸用語", () => {
	const convert = createConverter();
	assert.equal(convert("显示复制全部链接"), "顯示複製全部連結");
	assert.equal(convert("下载地址获取失败"), "下載連結獲取失敗");
	assert.equal(convert("请求地址"), "請求網址");
	assert.equal(convert("Microsoft Windows 命令提示符"), "Microsoft Windows 命令提示字元");
	assert.equal(convert("组件实例"), "元件實例");
	// 受保護的比對字串不經過修正表
	const { output } = buildZhTw('if (t === "下载地址") alert("复制下载地址");\n', { protect: { literals: [], notes: {} } });
	assert.ok(output.includes('t === "下载地址"'));
	assert.ok(output.includes('alert("複製下載連結")'));
});
