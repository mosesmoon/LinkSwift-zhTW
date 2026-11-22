import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "（改）网盘直链下载助手.user.js"), "utf8").replace(/\r\n/g, "\n");

// 从主文件切出 async mdmRemote(path, body, token) {...} 方法源码
function extractMdmRemote() {
	const start = source.indexOf("\n\t\tasync mdmRemote(path, body, token) {");
	assert.ok(start >= 0, "找不到 mdmRemote 方法");
	const end = source.indexOf("\n\t\t},", start);
	assert.ok(end > start, "找不到 mdmRemote 方法结尾");
	return source.slice(start, end + "\n\t\t}".length).trim().replace(/^async mdmRemote\(/, "async function mdmRemote(");
}

// respond(option) 回传 { status, responseText } 视为 onload，回传 "error" / "timeout" 触发对应回调
function build(values, respond) {
	const calls = [];
	const base = {
		getValue: (key) => values[key],
		console: { info() { }, error() { } },
		xmlHttpRequest(option) {
			calls.push(option);
			const r = respond(option);
			queueMicrotask(() => {
				if (r === "error") option.onerror({});
				else if (r === "timeout") option.ontimeout();
				else option.onload(r);
			});
		},
	};
	const fn = new Function("base", `${extractMdmRemote()}\nreturn mdmRemote;`)(base);
	return { mdmRemote: fn, calls };
}

test("POST /api/add：带令牌、JSON 请求体，不带 Origin / Referer / Cookie", async () => {
	const { mdmRemote, calls } = build(
		{ setting_mdm_remote_url: "https://127.0.0.1:8463/", setting_mdm_remote_token: "tok123" },
		() => ({ status: 200, responseText: '{"id":7}' }),
	);
	const res = await mdmRemote("/api/add", { url: "https://x.example/a.bin", start: true });
	assert.deepEqual(res, { status: 200, data: { id: 7 }, error: "" });
	const o = calls[0];
	assert.equal(o.method, "POST");
	assert.equal(o.url, "https://127.0.0.1:8463/api/add");
	assert.equal(o.headers.Authorization, "Bearer tok123");
	assert.equal(o.headers["Content-Type"], "application/json");
	assert.equal(o.data, JSON.stringify({ url: "https://x.example/a.bin", start: true }));
	assert.equal(o.anonymous, true);
	for (const h of ["Origin", "Referer", "Cookie"]) assert.ok(!(h in o.headers), h);
});

test("GET 无请求体；未设置地址时使用默认地址", async () => {
	const { mdmRemote, calls } = build({ setting_mdm_remote_token: "t" }, () => ({ status: 200, responseText: '{"downloads":[]}' }));
	const res = await mdmRemote("/api/list");
	assert.equal(res.error, "");
	assert.equal(calls[0].method, "GET");
	assert.equal(calls[0].url, "https://127.0.0.1:8463/api/list");
	assert.equal(calls[0].data, undefined);
	assert.ok(!("Content-Type" in calls[0].headers));
});

test("配对时传入空令牌：不带 Authorization", async () => {
	const { mdmRemote, calls } = build({ setting_mdm_remote_token: "old" }, () => ({ status: 200, responseText: '{"token":"new"}' }));
	const res = await mdmRemote("/api/pair", { code: "12345678", name: "LinkSwift" }, "");
	assert.equal(res.data.token, "new");
	assert.ok(!("Authorization" in calls[0].headers));
});

test("错误回应：取 code 作为错误", async () => {
	const { mdmRemote } = build({}, () => ({ status: 403, responseText: '{"error":"wrong code","code":"wrong-code","left":3}' }));
	const res = await mdmRemote("/api/pair", { code: "1" }, "");
	assert.equal(res.error, "wrong-code");
	assert.equal(res.data.left, 3);
});

test("200 但内容含 error 也视为失败；非 JSON 回应以 HTTP 状态表示", async () => {
	const a = build({}, () => ({ status: 200, responseText: '{"error":"bad address"}' }));
	assert.equal((await a.mdmRemote("/api/add", {})).error, "bad address");
	const b = build({}, () => ({ status: 502, responseText: "Bad Gateway" }));
	assert.equal((await b.mdmRemote("/api/add", {})).error, "HTTP 502");
});

test("连接失败与超时", async () => {
	assert.deepEqual(await build({}, () => "error").mdmRemote("/api/list"), { status: 0, data: null, error: "connect" });
	assert.deepEqual(await build({}, () => "timeout").mdmRemote("/api/list"), { status: 0, data: null, error: "timeout" });
});

test("UI：MDM 模式的推送按钮、全部推送与 sendto 分支都已接上", () => {
	assert.ok(source.includes('<button action="sendto" type="mdm"'));
	assert.ok(source.includes('type="sendto.mdm"'));
	assert.ok(source.includes('case "mdm": res = await download.tools.sendTo.mdm(link); break;'));
	assert.ok(source.includes('name: "setting_mdm_remote_url"'));
	assert.ok(source.includes('name: "setting_mdm_remote_token"'));
	for (const cls of ["listener-mdm-remote-url", "listener-mdm-pair-code", "listener-mdm-pair", "listener-mdm-test"]) {
		assert.ok(source.includes(`"${"." + cls}"`) || source.includes(`".${cls}"`), cls);
	}
});
