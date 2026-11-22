import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "（改）网盘直链下载助手.user.js"), "utf8").replace(/\r\n/g, "\n");

// 从主文件切出 mdm(link, filename, headers) {...} 方法源码
function extractMethod() {
	const start = source.indexOf("\n\t\t\t\tmdm(link, filename, headers) {");
	assert.ok(start >= 0, "找不到 mdm 方法");
	const end = source.indexOf("\n\t\t\t\t},", start);
	assert.ok(end > start, "找不到 mdm 方法结尾");
	const body = source.slice(start, end + "\n\t\t\t\t}".length).trim();
	return body.replace(/^mdm\(/, "function mdm(");
}

function build(values = {}) {
	values = { setting_mdm_command: "add", ...values };
	const base = {
		getValue: (key) => values[key],
		fixFilename: (s) => s,
		standHeaders: (h) => h,
		isType: (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? "object" : typeof v),
	};
	const factory = new Function("base", `${extractMethod()}\nreturn mdm;`);
	return factory(base);
}

const URL_ = "https://example.com/a.bin?x=1";

test("cmd：双引号包裹", () => {
	const mdm = build({ setting_curl_terminal: "wc", setting_mdm_cli: "C:\\mdm\\cli.exe" });
	assert.equal(mdm(URL_, "a.bin"), `"C:\\mdm\\cli.exe" add "${URL_}" -f "a.bin"`);
});

test("PowerShell：单引号包裹并加调用运算符", () => {
	const mdm = build({ setting_curl_terminal: "wp", setting_mdm_cli: "C:\\mdm\\cli.exe" });
	assert.equal(mdm(URL_, "a.bin"), `& 'C:\\mdm\\cli.exe' add '${URL_}' -f 'a.bin'`);
});

test("POSIX 终端（lt / ls / mt / 未知值）：单引号包裹", () => {
	for (const t of ["lt", "ls", "mt", "zzz", undefined]) {
		const mdm = build({ setting_curl_terminal: t, setting_mdm_cli: "/opt/mdm/cli" });
		assert.equal(mdm(URL_, "a.bin"), `'/opt/mdm/cli' add '${URL_}' -f 'a.bin'`, String(t));
	}
});

test("cli 路径含空格", () => {
	const wc = build({ setting_curl_terminal: "wc", setting_mdm_cli: "C:\\Program Files\\MDM\\cli.exe" });
	assert.equal(wc(URL_, "a"), `"C:\\Program Files\\MDM\\cli.exe" add "${URL_}" -f "a"`);
	const wp = build({ setting_curl_terminal: "wp", setting_mdm_cli: "C:\\Program Files\\MDM\\cli.exe" });
	assert.equal(wp(URL_, "a"), `& 'C:\\Program Files\\MDM\\cli.exe' add '${URL_}' -f 'a'`);
	const lt = build({ setting_curl_terminal: "lt", setting_mdm_cli: "/opt/My MDM/cli" });
	assert.equal(lt(URL_, "a"), `'/opt/My MDM/cli' add '${URL_}' -f 'a'`);
});

test("文件名与 Cookie 含双引号：cmd 转义为 \\\"", () => {
	const mdm = build({ setting_curl_terminal: "wc", setting_mdm_cli: "cli" });
	assert.equal(
		mdm(URL_, 'a"b.bin', { Cookie: 'k="v"' }),
		`"cli" add "${URL_}" -f "a\\"b.bin" --cookie "k=\\"v\\""`,
	);
});

test("文件名与 Cookie 含单引号：PowerShell 双写，POSIX 使用 '\\''", () => {
	const wp = build({ setting_curl_terminal: "wp", setting_mdm_cli: "cli" });
	assert.equal(
		wp(URL_, "it's.bin", { Cookie: "k='v'" }),
		`& 'cli' add '${URL_}' -f 'it''s.bin' --cookie 'k=''v'''`,
	);
	const lt = build({ setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	assert.equal(
		lt(URL_, "it's.bin", { Cookie: "k='v'" }),
		`'cli' add '${URL_}' -f 'it'\\''s.bin' --cookie 'k='\\''v'\\'''`,
	);
});

test("单引号在 cmd 中保持原样，双引号在 POSIX / PowerShell 中保持原样", () => {
	const wc = build({ setting_curl_terminal: "wc", setting_mdm_cli: "cli" });
	assert.equal(wc(URL_, "it's"), `"cli" add "${URL_}" -f "it's"`);
	const lt = build({ setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	assert.equal(lt(URL_, 'a"b'), `'cli' add '${URL_}' -f 'a"b'`);
	const wp = build({ setting_curl_terminal: "wp", setting_mdm_cli: "cli" });
	assert.equal(wp(URL_, 'a"b'), `& 'cli' add '${URL_}' -f 'a"b'`);
});

test("请求头映射不区分大小写，并按 -r / --user-agent / --cookie 输出", () => {
	const mdm = build({ setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	const out = mdm(URL_, "a", { COOKIE: "c=1", "user-agent": "UA/1.0", ReFeReR: "https://ref.example/" });
	assert.equal(
		out,
		`'cli' add '${URL_}' -f 'a' -r 'https://ref.example/' --user-agent 'UA/1.0' --cookie 'c=1'`,
	);
});

test("未知请求头会被丢弃", () => {
	const mdm = build({ setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	const out = mdm(URL_, "a", { Authorization: "Bearer x", Range: "bytes=0-", Referer: "https://r/", "X-Foo": "1" });
	assert.equal(out, `'cli' add '${URL_}' -f 'a' -r 'https://r/'`);
	assert.ok(!/Bearer|bytes|X-Foo/.test(out));
});

test("无请求头（undefined / null / 空对象）", () => {
	const mdm = build({ setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	const expected = `'cli' add '${URL_}' -f 'a'`;
	assert.equal(mdm(URL_, "a"), expected);
	assert.equal(mdm(URL_, "a", null), expected);
	assert.equal(mdm(URL_, "a", {}), expected);
});

test("设置为空时使用默认 cli 名称", () => {
	for (const v of [undefined, ""]) {
		const mdm = build({ setting_curl_terminal: "wc", setting_mdm_cli: v });
		assert.equal(mdm(URL_, "a"), `"misterdownloadmanager-cli" add "${URL_}" -f "a"`);
	}
});

test("值中的换行会被压成空格，避免拆成多条命令", () => {
	const mdm = build({ setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	assert.equal(mdm(URL_, "a\nb", { Cookie: "x=1\r\ny=2" }), `'cli' add '${URL_}' -f 'a b' --cookie 'x=1 y=2'`);
});

// ---- get 子命令（默认） ----
test("get：默认命令类型为 get，使用 -o 指定文件名", () => {
	const mdm = build({ setting_mdm_command: undefined, setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	assert.equal(mdm(URL_, "a.bin"), `'cli' get '${URL_}' -o 'a.bin'`);
});

test("get：全部请求头都以 -H 'Key: value' 传入", () => {
	const mdm = build({ setting_mdm_command: "get", setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
	assert.equal(
		mdm(URL_, "a", { Referer: "https://r/", Authorization: "Bearer x", "User-Agent": "UA" }),
		`'cli' get '${URL_}' -o 'a' -H 'Referer: https://r/' -H 'Authorization: Bearer x' -H 'User-Agent: UA'`,
	);
});

test("get：各终端引号规则", () => {
	const h = { Cookie: "k=\"v\"'" };
	const wc = build({ setting_mdm_command: "get", setting_curl_terminal: "wc", setting_mdm_cli: "C:\\a b\\cli.exe" });
	assert.equal(wc(URL_, 'a"b', h), `"C:\\a b\\cli.exe" get "${URL_}" -o "a\\"b" -H "Cookie: k=\\"v\\"'"`);
	const wp = build({ setting_mdm_command: "get", setting_curl_terminal: "wp", setting_mdm_cli: "cli" });
	assert.equal(wp(URL_, "it's", h), `& 'cli' get '${URL_}' -o 'it''s' -H 'Cookie: k="v"'''`);
	const ls = build({ setting_mdm_command: "get", setting_curl_terminal: "ls", setting_mdm_cli: "cli" });
	assert.equal(ls(URL_, "it's", h), `'cli' get '${URL_}' -o 'it'\\''s' -H 'Cookie: k="v"'\\'''`);
});

test("get：无请求头，且未知命令类型回退为 get", () => {
	for (const c of ["get", "bogus", ""]) {
		const mdm = build({ setting_mdm_command: c, setting_curl_terminal: "lt", setting_mdm_cli: "cli" });
		assert.equal(mdm(URL_, "a"), `'cli' get '${URL_}' -o 'a'`, c);
		assert.equal(mdm(URL_, "a", {}), `'cli' get '${URL_}' -o 'a'`, c);
	}
});

test("get：设置为空时使用默认 cli 名称", () => {
	const mdm = build({ setting_mdm_command: "get", setting_curl_terminal: "wc", setting_mdm_cli: "" });
	assert.equal(mdm(URL_, "a"), `"misterdownloadmanager-cli" get "${URL_}" -o "a"`);
});
