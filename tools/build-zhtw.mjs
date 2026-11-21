#!/usr/bin/env node
/**
 * 產生 LinkSwift 的台灣繁體中文建置檔，不修改原始碼。
 *
 * 做法：用 espree 解析原始碼，只轉換「字串 Literal、樣板字串片段、註解」中含 CJK 的文字，
 * 依 range 由後往前拼接，其餘位元組完全不變。會與頁面文字 / 伺服器回應 / DOM 比對的
 * 中文字串（比較運算、switch case、includes/indexOf、選擇器、物件鍵、請求參數等）一律保留，
 * 並寫入報告供人工稽核。
 *
 * 用法：node tools/build-zhtw.mjs [--in <file>] [--out <file>] [--report <file>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as espree from "espree";
import * as OpenCC from "opencc-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");
export const SOURCE_NAME = "（改）网盘直链下载助手.user.js";
export const DEFAULT_IN = path.join(ROOT, SOURCE_NAME);
export const DEFAULT_OUT = path.join(ROOT, "dist", "LinkSwift.zh-TW.user.js");
export const DEFAULT_REPORT = path.join(ROOT, "temp", "zhtw-report.md");
export const DEFAULT_PROTECT = path.join(ROOT, "tools", "zhtw-protect.json");

export const UPDATE_URL = "https://raw.githubusercontent.com/mosesmoon/LinkSwift-zhTW/dev/dist/LinkSwift.zh-TW.user.js";
export const GENERATED_NOTICE = `// 此檔案由 tools/build-zhtw.mjs 自動產生，請勿直接修改；原始碼：${SOURCE_NAME}`;

export const PARSE_OPTIONS = Object.freeze({ ecmaVersion: "latest", sourceType: "script", range: true, loc: true, comment: true, tokens: true });

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/u;
export const hasCJK = (s) => CJK.test(s);

// ---------- 規則表 ----------
const COMPARISON_OPS = new Set(["===", "==", "!==", "!="]);
const STRING_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "startsWith", "endsWith", "match", "matchAll", "replace", "replaceAll", "split", "search", "test"]);
const SELECTOR_METHODS = new Set(["find", "filter", "is", "closest", "not", "has", "children", "parents", "parentsUntil", "siblings", "next", "prev", "nextAll", "prevAll", "querySelector", "querySelectorAll", "matches", "waitForKeyElements"]);
const SELECTOR_FUNCS = new Set(["$", "jQuery", "waitForKeyElements"]);
const STORAGE_FUNCS = new Set(["GM_getValue", "GM_setValue", "GM_deleteValue", "getValue", "setValue", "deleteValue", "getItem", "setItem", "removeItem"]);
const ENCODE_FUNCS = new Set(["encodeURIComponent", "encodeURI", "escape", "btoa"]);
const LOOKUP_FUNCS = new Set(["hasOwnProperty", "hasOwn"]);
const ARRAY_LOOKUP_METHODS = new Set(["includes", "indexOf", "lastIndexOf", "some", "every", "find", "findIndex", "filter"]);
const REQUEST_PROPS = new Set(["url", "headers", "data", "body"]);
const REQUEST_FUNCS = new Set(["fetch", "GM_xmlhttpRequest", "GM.xmlHttpRequest", "$.ajax", "$.get", "$.post", "jQuery.ajax", "jQuery.get", "jQuery.post", "base.post", "base.get", "URLSearchParams", "FormData"]);
const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration", "Program"]);
// 「比對」類理由：同值字串在其他地方出現時一併保留（確保比對的雙方一致）
const MATCH_REASONS = new Set(["comparison", "switch-case", "string-method", "regexp", "selector", "selector-syntax", "object-key", "member-lookup", "lookup", "array-lookup", "allowlist"]);
// 會拿來做子字串比對的理由：其他轉換字串若「包含」此值會列為可疑
const SUBSTRING_REASONS = new Set(["string-method", "selector-syntax"]);
const NEAR_LINES = 150;

// 轉換時原樣保留的子字串：內嵌 URL、CSS font / font-family 宣告（字型名稱必須與系統字型完全相同）
const MASK_IN_TEXT = /(?<url>[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`\\]*)|(?<font>\bfont(?:-family)?\s*:[^;{}<>]*)/g;
const ATTR_SELECTOR_CJK = new RegExp(String.raw`\[\s*[\w-]+\s*[~|^$*]?=\s*["']?[^\]"']*` + CJK.source, "u");
const DANGER_CHARS = /[^\p{L}\p{N}\s]|[\r\n]/gu; // 轉換前後必須完全一致的 ASCII/符號集合（另見 asciiSignature）

// ---------- 小工具 ----------
function calleeName(callee) {
	if (!callee) return "";
	if (callee.type === "Identifier") return callee.name;
	if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
		const obj = calleeName(callee.object) || (callee.object.type === "ThisExpression" ? "this" : "?");
		return `${obj}.${callee.property.name}`;
	}
	if (callee.type === "ChainExpression") return calleeName(callee.expression);
	return "";
}
function propName(callee) {
	if (callee?.type === "ChainExpression") return propName(callee.expression);
	if (callee?.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return callee.property.name;
	if (callee?.type === "MemberExpression" && callee.computed && callee.property.type === "Literal") return String(callee.property.value);
	return null;
}
function keyName(prop) {
	if (!prop || prop.computed) return null;
	if (prop.key.type === "Identifier") return prop.key.name;
	if (prop.key.type === "Literal") return String(prop.key.value);
	return null;
}
const looksLikeHTML = (s) => /^\s*</.test(s);

/** 只保留非字母數字空白的字元（ASCII 符號），用來確認 OpenCC 沒有動到引號、反斜線、${ 等語法字元 */
function asciiSignature(s) {
	return (s.match(DANGER_CHARS) || []).filter((c) => c.charCodeAt(0) < 0x80 || c === "\r" || c === "\n").join("");
}

/**
 * OpenCC twp 之後的台灣用語修正表（依序套用，長詞在前）。
 * 只作用在已決定要轉換的片段，受保護的字串不會經過這裡。
 */
export const TERM_FIXES = [
	["覆制", "複製"], // OpenCC 斷詞錯誤：显示复制 → 顯示覆制
	["命令提示符", "命令提示字元"],
	["下載地址", "下載連結"],
	["主機地址", "主機位址"],
	["地址", "網址"],
	["分享連線", "分享連結"],
	["擴充套件", "擴充功能"],
	["例項", "實例"],
	["響應", "回應"],
	["反饋", "回饋"],
	["彈框", "彈出視窗"],
	["文本", "文字"],
	["映象", "鏡像"]
];

export function applyTermFixes(s) {
	for (const [from, to] of TERM_FIXES) s = s.split(from).join(to);
	return s;
}

export function createConverter() {
	const opencc = OpenCC.Converter({ from: "cn", to: "twp" });
	return (s) => applyTermFixes(opencc(s));
}

export function loadProtectConfig(file = DEFAULT_PROTECT) {
	if (!fs.existsSync(file)) return { literals: [], notes: {} };
	const json = JSON.parse(fs.readFileSync(file, "utf8"));
	return { literals: Array.isArray(json.literals) ? json.literals : [], notes: json.notes || {} };
}

// ---------- AST 走訪 ----------
function indexAst(ast) {
	const parent = new Map();
	const strings = []; // Literal(string) 與 TemplateLiteral
	const stack = [ast];
	while (stack.length) {
		const node = stack.pop();
		if ((node.type === "Literal" && typeof node.value === "string" && !node.regex) || node.type === "TemplateLiteral") strings.push(node);
		for (const key of Object.keys(node)) {
			if (key === "loc" || key === "range" || key === "parent") continue;
			const v = node[key];
			if (Array.isArray(v)) {
				for (const c of v) if (c && typeof c.type === "string") { parent.set(c, node); stack.push(c); }
			} else if (v && typeof v.type === "string") { parent.set(v, node); stack.push(v); }
		}
	}
	return { parent, strings };
}

/** 樣板字串片段在原始碼中的內文範圍（range 含 ` / ${ / } 分隔符） */
function quasiInner(q) {
	return [q.range[0] + 1, q.range[1] - (q.tail ? 1 : 2)];
}

/** 字串節點的「值」：Literal 用 value；樣板字串用 cooked 串接，表達式以 \u0000 代替 */
function cookedValue(node) {
	if (node.type === "Literal") return node.value;
	return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("\u0000");
}

// ---------- 保護判斷 ----------
function makeDecider({ parent, allow, ast, src }) {
	const lookupUses = collectArrayLookupUses(ast, parent);

	function climbTransparent(node) {
		let cur = node;
		for (;;) {
			const p = parent.get(cur);
			if (!p) return cur;
			if ((p.type === "BinaryExpression" && p.operator === "+") ||
				(p.type === "LogicalExpression") ||
				(p.type === "ConditionalExpression" && p.test !== cur) ||
				(p.type === "TemplateLiteral") ||
				(p.type === "SequenceExpression" && p.expressions.at(-1) === cur) ||
				(p.type === "AwaitExpression") || (p.type === "ParenthesizedExpression") ||
				(p.type === "ChainExpression")) { cur = p; continue; }
			return cur;
		}
	}

	function requestContext(node) {
		let cur = node;
		for (let p = parent.get(cur); p && !FUNCTION_TYPES.has(p.type); cur = p, p = parent.get(p)) {
			if (p.type === "Property" && p.value === cur && REQUEST_PROPS.has(keyName(p))) return { reason: "request", detail: `${keyName(p)}: 屬性值` };
			if ((p.type === "CallExpression" || p.type === "NewExpression") && p.arguments.includes(cur)) {
				const name = calleeName(p.callee);
				if (REQUEST_FUNCS.has(name)) return { reason: "request", detail: `${p.type === "NewExpression" ? "new " : ""}${name}() 參數` };
			}
		}
		return null;
	}

	return function decide(node) {
		const value = cookedValue(node);
		const p0 = parent.get(node);

		// 1. 明確清單
		const allowHit = allow.has(value) ? value : node.type === "TemplateLiteral" ? node.quasis.map((q) => q.value.cooked).find((c) => allow.has(c)) : undefined;
		if (allowHit !== undefined) return { reason: "allowlist", detail: "tools/zhtw-protect.json" };

		// 2. 鍵
		if ((p0?.type === "Property" || p0?.type === "MethodDefinition" || p0?.type === "PropertyDefinition") && p0.key === node) return { reason: "object-key", detail: "物件屬性鍵" };
		if (p0?.type === "MemberExpression" && p0.computed && p0.property === node) return { reason: "member-lookup", detail: "obj[\"…\"] 取值" };
		if (p0?.type === "BinaryExpression" && p0.operator === "in" && p0.left === node) return { reason: "lookup", detail: "in 運算子" };
		if (p0?.type === "TaggedTemplateExpression" && p0.quasi === node) return { reason: "tagged-template", detail: `${calleeName(p0.tag) || "tag"}\`…\`` };

		// 3. 內容特徵
		const flat = value.replace(/\u0000/g, "X");
		if (/:contains\(|:has-text\(/.test(flat) || ATTR_SELECTOR_CJK.test(flat)) return { reason: "selector-syntax", detail: "含 jQuery / CSS 選擇器語法" };
		const trimmed = flat.trim();
		if (!/\s/.test(trimmed) && !trimmed.startsWith("<") && (/:\/\//.test(trimmed) || /^\/\S/.test(trimmed))) return { reason: "url", detail: "整段為 URL / 路徑" };

		// 4. 直接語境（穿過 + ?: || 樣板表達式）
		const top = climbTransparent(node);
		const p = parent.get(top);
		if (p) {
			if (p.type === "BinaryExpression" && COMPARISON_OPS.has(p.operator)) return { reason: "comparison", detail: `${p.operator} 運算元` };
			if (p.type === "SwitchCase" && p.test === top) return { reason: "switch-case", detail: "switch case 標籤" };
			if (p.type === "MemberExpression" && p.computed && p.property === top) return { reason: "member-lookup", detail: "obj[\"…\"] 取值" };
			if ((p.type === "CallExpression" || p.type === "NewExpression") && p.arguments.includes(top)) {
				const argIndex = p.arguments.indexOf(top);
				const name = calleeName(p.callee);
				const prop = propName(p.callee);
				const short = name.split(".").pop() || prop || "";
				if (short === "RegExp" && (p.callee.type === "Identifier")) return { reason: "regexp", detail: `${p.type === "NewExpression" ? "new " : ""}RegExp() 參數` };
				if (p.type === "NewExpression" && name === "URL") return { reason: "url", detail: "new URL() 參數" };
				if (p.type === "CallExpression") {
					if (argIndex === 0 && prop && STRING_METHODS.has(prop)) return { reason: "string-method", detail: `.${prop}() 第一個參數` };
					if (argIndex === 0 && ((p.callee.type === "Identifier" && SELECTOR_FUNCS.has(p.callee.name)) || (prop && SELECTOR_METHODS.has(prop))) && !looksLikeHTML(flat) && !/^[`"']\s*</.test(src.slice(top.range[0], top.range[0] + 16))) return { reason: "selector", detail: `${name || prop}() 選擇器參數` };
					if (argIndex === 0 && STORAGE_FUNCS.has(short)) return { reason: "storage-key", detail: `${name}() 儲存鍵` };
					if (ENCODE_FUNCS.has(short) && p.callee.type === "Identifier") return { reason: "uri-encode", detail: `${name}() 參數` };
					if (LOOKUP_FUNCS.has(short)) return { reason: "lookup", detail: `${name}() 參數` };
					if ((prop === "append" || prop === "set") && p.arguments.length === 2) {
						const a0 = p.arguments[0];
						const a0str = a0.type === "Literal" && typeof a0.value === "string" ? a0.value : a0.type === "TemplateLiteral" ? cookedValue(a0) : null;
						if (a0str !== null && !looksLikeHTML(a0str)) return { reason: "request", detail: `.${prop}(key, value)（FormData / URLSearchParams / Map）` };
					}
				}
			}
			if (p.type === "ArrayExpression") {
				const arr = p;
				const ap = parent.get(arr);
				if (ap?.type === "MemberExpression" && ap.object === arr && ARRAY_LOOKUP_METHODS.has(propName(ap)) && parent.get(ap)?.type === "CallExpression") {
					return { reason: "array-lookup", detail: `[…].${propName(ap)}()` };
				}
			}
		}

		// 5. 請求語境（穿過物件、陣列、巢狀呼叫，遇函式邊界停止）
		const req = requestContext(node);
		if (req) return req;

		// 6. 可疑：陣列元素，且陣列變數之後被 includes/indexOf 使用
		if (p?.type === "ArrayExpression") {
			const name = arrayBindingName(p, parent);
			if (name && lookupUses.has(name)) return { suspicious: "array-used-for-lookup", detail: `陣列 ${name} 在 L${lookupUses.get(name).join(", L")} 被 .includes/.indexOf 等使用` };
		}
		return null;
	};
}

function arrayBindingName(arr, parent) {
	const ap = parent.get(arr);
	if (ap?.type === "VariableDeclarator" && ap.init === arr && ap.id.type === "Identifier") return ap.id.name;
	if (ap?.type === "AssignmentExpression" && ap.right === arr) {
		if (ap.left.type === "Identifier") return ap.left.name;
		const pn = propName(ap.left);
		if (pn) return pn;
	}
	if (ap?.type === "Property" && ap.value === arr) return keyName(ap);
	return null;
}

function collectArrayLookupUses(ast, parent) {
	const uses = new Map();
	const stack = [ast];
	while (stack.length) {
		const n = stack.pop();
		if (n.type === "CallExpression") {
			const callee = n.callee.type === "ChainExpression" ? n.callee.expression : n.callee;
			if (callee.type === "MemberExpression" && ARRAY_LOOKUP_METHODS.has(propName(callee))) {
				const obj = callee.object;
				const name = obj.type === "Identifier" ? obj.name : propName(obj);
				if (name) {
					if (!uses.has(name)) uses.set(name, []);
					uses.get(name).push(n.loc.start.line);
				}
			}
		}
		for (const key of Object.keys(n)) {
			if (key === "loc" || key === "range") continue;
			const v = n[key];
			if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") stack.push(c); }
			else if (v && typeof v.type === "string") stack.push(v);
		}
	}
	void parent;
	return uses;
}

// ---------- 轉換 ----------
/** 轉換一段原始碼文字：URL 子字串原樣保留，其餘含 CJK 的部分交給 OpenCC；語法字元若有變動則放棄 */
function convertSegment(text, convert) {
	let out = "";
	let last = 0;
	const kept = [];
	for (const m of text.matchAll(MASK_IN_TEXT)) {
		const before = text.slice(last, m.index);
		out += hasCJK(before) ? convert(before) : before;
		out += m[0];
		if (hasCJK(m[0])) kept.push({ kind: m.groups.url ? "url" : "css-font", text: m[0] });
		last = m.index + m[0].length;
	}
	const rest = text.slice(last);
	out += hasCJK(rest) ? convert(rest) : rest;
	if (asciiSignature(out) !== asciiSignature(text)) return { text, unsafe: true, kept };
	return { text: out, unsafe: false, kept };
}

// ---------- Metadata ----------
function findMetadataBlock(src) {
	const start = src.search(/^\/\/[ \t]*==UserScript==/m);
	if (start < 0) return null;
	const endMatch = /^\/\/[ \t]*==\/UserScript==[^\r\n]*/m.exec(src.slice(start));
	if (!endMatch) return null;
	return { start, end: start + endMatch.index + endMatch[0].length };
}

function rewriteMetadata(block, eol) {
	const lines = block.split(/\r?\n/);
	const lineRe = (key) => new RegExp(`^(//[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})([ \\t]+)(.*)$`);
	const zhTW = lines.map((l) => lineRe("@description:zh-TW").exec(l)).find(Boolean);
	const nameMatch = lines.map((l) => lineRe("@name").exec(l)).find(Boolean);
	const valueCol = nameMatch ? nameMatch[1].length + nameMatch[2].length : 22;
	const warnings = [];
	const set = (key, value) => {
		const re = lineRe(key);
		let hit = false;
		for (let i = 0; i < lines.length; i++) {
			const m = re.exec(lines[i]);
			if (m) { lines[i] = m[1] + m[2] + value; hit = true; }
		}
		return hit;
	};
	const pad = (key) => {
		const prefix = `// ${key}`;
		return prefix + " ".repeat(Math.max(1, valueCol - prefix.length));
	};
	set("@name", "LinkSwift 繁中版");
	set("@namespace", "github.com/mosesmoon");
	if (zhTW) set("@description", zhTW[3]);
	else warnings.push("metadata 沒有 @description:zh-TW，@description 保持原樣");
	for (const key of ["@updateURL", "@downloadURL"]) {
		if (set(key, UPDATE_URL)) continue;
		let at = -1;
		for (const anchor of ["@downloadURL", "@updateURL", "@supportURL", "@homepage", "@homepageURL"]) {
			const re = lineRe(anchor);
			const idx = lines.findLastIndex((l) => re.test(l));
			if (idx >= 0) { at = idx + 1; break; }
		}
		if (at < 0) at = lines.length - 1; // 結束標記之前
		lines.splice(at, 0, pad(key) + UPDATE_URL);
	}
	return { text: lines.join(eol), warnings };
}

// ---------- 主函式 ----------
/**
 * @param {string} input 原始碼文字
 * @param {{ protect?: {literals?: string[], notes?: Record<string,string>}, convert?: (s:string)=>string, verify?: boolean }} [opts]
 * @returns {{ output: string, report: object, reportMarkdown: string }}
 */
export function buildZhTw(input, opts = {}) {
	const convert = opts.convert || createConverter();
	const protect = { literals: opts.protect?.literals || [], notes: opts.protect?.notes || {} };
	const allow = new Set(protect.literals);
	const bom = input.startsWith("\uFEFF") ? "\uFEFF" : "";
	const src = bom ? input.slice(1) : input;
	const crlf = (src.match(/\r\n/g) || []).length;
	const lf = (src.match(/(?<!\r)\n/g) || []).length;
	const eol = crlf > lf ? "\r\n" : "\n";

	const ast = espree.parse(src, PARSE_OPTIONS);
	const { parent, strings } = indexAst(ast);
	const meta = findMetadataBlock(src);
	const inMeta = (r) => meta && r[0] < meta.end && r[1] > meta.start;
	const decide = makeDecider({ parent, allow, ast, src });

	const lineOf = (n) => n.loc.start.line;
	const cjkStrings = strings
		.filter((n) => (n.type === "Literal" ? hasCJK(src.slice(n.range[0], n.range[1])) : n.quasis.some((q) => hasCJK(src.slice(...quasiInner(q))))))
		.sort((a, b) => a.range[0] - b.range[0]);

	// 第一輪：判斷
	const decisions = new Map();
	for (const n of cjkStrings) decisions.set(n, decide(n));

	// 第二輪：同值傳播（比對類保留的值，在其他地方以完整字串出現時一併保留）
	const matchValues = new Map();
	const substringValues = new Map();
	for (const n of cjkStrings) {
		const d = decisions.get(n);
		if (!d?.reason) continue;
		const v = cookedValue(n);
		if (MATCH_REASONS.has(d.reason) && !v.includes("\u0000") && !matchValues.has(v)) matchValues.set(v, lineOf(n));
		if (SUBSTRING_REASONS.has(d.reason)) {
			const pieces = d.reason === "selector-syntax"
				? [...v.matchAll(/:(?:contains|has-text)\(\s*["']?([^"')]+)/g), ...v.matchAll(/\[\s*[\w-]+\s*[~|^$*]?=\s*["']?([^\]"']+)/g)].map((m) => m[1])
				: [v];
			for (const piece of pieces) {
				if (!hasCJK(piece) || piece.length < 2) continue;
				if (!substringValues.has(piece)) substringValues.set(piece, []);
				substringValues.get(piece).push(lineOf(n));
			}
		}
	}
	for (const n of cjkStrings) {
		const d = decisions.get(n);
		if (d?.reason) continue;
		const v = cookedValue(n);
		if (matchValues.has(v) && matchValues.get(v) !== lineOf(n)) decisions.set(n, { reason: "same-value", detail: `與 L${matchValues.get(v)} 的比對字串同值` });
		else if (matchValues.has(v)) decisions.set(n, { reason: "same-value", detail: "與同一行的比對字串同值" });
	}

	// 產生拼接
	const splices = [];
	const protectedList = [];
	const suspiciousList = [];
	const unsafeList = [];
	let stringsConverted = 0;
	let stringsUnchanged = 0;
	let commentsConverted = 0;

	const record = (list, n, reason, detail) => list.push({ line: lineOf(n), reason, detail, value: cookedValue(n).replace(/\u0000/g, "${…}") });

	for (const n of cjkStrings) {
		const d = decisions.get(n);
		if (d?.reason) {
			const note = d.reason === "allowlist" ? protect.notes[cookedValue(n)] : undefined;
			record(protectedList, n, d.reason, note ? `${d.detail}：${note}` : d.detail);
			continue;
		}
		if (d?.suspicious) record(suspiciousList, n, d.suspicious, d.detail);
		const segs = n.type === "Literal" ? [[n.range[0] + 1, n.range[1] - 1]] : n.quasis.map(quasiInner);
		let changed = false;
		let unsafe = false;
		const local = [];
		for (const [a, b] of segs) {
			const text = src.slice(a, b);
			if (!hasCJK(text)) continue;
			const r = convertSegment(text, convert);
			if (r.unsafe) { unsafe = true; break; }
			for (const k of r.kept) record(suspiciousList, n, k.kind === "url" ? "kept-embedded-url" : "kept-css-font", `${k.kind === "url" ? "內嵌 URL" : "CSS 字型宣告"}含中文，該段已原樣保留：${k.text.trim()}`);
			if (r.text !== text) { local.push({ start: a, end: b, text: r.text }); changed = true; }
		}
		if (unsafe) { record(unsafeList, n, "converter-unsafe", "OpenCC 結果改動了語法字元，已略過"); continue; }
		splices.push(...local);
		if (changed) stringsConverted++; else stringsUnchanged++;
		const v = cookedValue(n);
		// 含有「附近（±NEAR_LINES 行）被拿去做子字串比對 / 選擇器比對」的文字：可能是腳本自己插入、之後又被比對的內容
		for (const [piece, lines] of substringValues) {
			const near = lines.find((l) => Math.abs(l - lineOf(n)) <= NEAR_LINES);
			if (near !== undefined && v !== piece && v.includes(piece)) { record(suspiciousList, n, "contains-matched-text", `含有 L${near} 用於子字串比對的「${piece}」（相距 ${Math.abs(near - lineOf(n))} 行）`); break; }
		}
	}

	for (const c of ast.comments) {
		if (inMeta(c.range) || src.slice(c.range[0], c.range[1]) === GENERATED_NOTICE) continue;
		const a = c.range[0] + 2;
		const b = c.type === "Block" ? c.range[1] - 2 : c.range[1];
		const text = src.slice(a, b);
		if (!hasCJK(text)) continue;
		const r = convertSegment(text, convert);
		if (r.unsafe) { unsafeList.push({ line: c.loc.start.line, reason: "converter-unsafe", detail: "註解轉換改動了語法字元，已略過", value: text.trim() }); continue; }
		if (r.text !== text) { splices.push({ start: a, end: b, text: r.text }); commentsConverted++; }
	}

	// Metadata 與產生註記
	const warnings = [];
	if (meta) {
		const m = rewriteMetadata(src.slice(meta.start, meta.end), eol);
		warnings.push(...m.warnings);
		splices.push({ start: meta.start, end: meta.end, text: m.text });
		const after = src.slice(meta.end);
		const nextLine = after.replace(/^\r?\n/, "").split(/\r?\n/, 1)[0];
		if (nextLine !== GENERATED_NOTICE) splices.push({ start: meta.end, end: meta.end, text: eol + GENERATED_NOTICE });
	} else {
		warnings.push("找不到 // ==UserScript== metadata 區塊");
	}

	splices.sort((x, y) => y.start - x.start || y.end - x.end);
	let out = src;
	let guard = Infinity;
	for (const s of splices) {
		if (s.end > guard) throw new Error(`拼接範圍重疊：${s.start}-${s.end}`);
		out = out.slice(0, s.start) + s.text + out.slice(s.end);
		guard = s.start;
	}
	out = bom + out;

	if (opts.verify !== false) verifyTokens(src, out.startsWith("\uFEFF") ? out.slice(1) : out);

	const byReason = {};
	for (const p of protectedList) byReason[p.reason] = (byReason[p.reason] || 0) + 1;
	const report = {
		totals: {
			cjkStrings: cjkStrings.length,
			stringsConverted,
			stringsUnchangedByConverter: stringsUnchanged,
			commentsConverted,
			protected: protectedList.length,
			protectedByReason: byReason,
			suspicious: suspiciousList.length,
			converterUnsafe: unsafeList.length,
			eol: eol === "\r\n" ? "CRLF" : "LF",
		},
		protected: protectedList,
		suspicious: suspiciousList,
		unsafe: unsafeList,
		warnings,
	};
	return { output: out, report, reportMarkdown: renderReport(report) };
}

/** 輸出與原始碼的 token 序列必須一致（String / Template 的 value 除外） */
export function tokenSignature(code) {
	const ast = espree.parse(code, PARSE_OPTIONS);
	return ast.tokens.map((t) => (t.type === "String" || t.type === "Template" ? t.type : `${t.type}:${t.value}`));
}
export function verifyTokens(src, out) {
	const a = tokenSignature(src);
	const b = tokenSignature(out);
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) {
		if (a[i] !== b[i]) throw new Error(`輸出 token 序列與原始碼不一致（第 ${i} 個 token：${a[i]} → ${b[i]}）`);
	}
}

// ---------- 報告 ----------
const REASON_LABELS = {
	"comparison": "比較運算 (=== / == / !== / !=)",
	"switch-case": "switch case 標籤",
	"string-method": "字串方法第一個參數 (includes / indexOf / replace / split …)",
	"regexp": "RegExp() 參數",
	"selector": "選擇器參數 ($ / find / filter / is / closest / querySelector / waitForKeyElements)",
	"selector-syntax": "含選擇器語法 (:contains( / [attr=\"中文\"])",
	"object-key": "物件屬性鍵",
	"member-lookup": "obj[\"…\"] 取值",
	"lookup": "in / hasOwnProperty 查詢",
	"array-lookup": "陣列直接用於 includes / indexOf",
	"request": "請求語境 (fetch / GM_xmlhttpRequest / base.post / url / headers / data / body / FormData)",
	"url": "整段為 URL / 路徑",
	"storage-key": "儲存鍵 (GM_getValue / setValue / localStorage)",
	"uri-encode": "encodeURIComponent 等編碼函式參數",
	"tagged-template": "標籤樣板字串",
	"allowlist": "tools/zhtw-protect.json 明確清單",
	"same-value": "與比對字串同值（保持比對雙方一致）",
};

function cell(s, max = 60) {
	let t = String(s).replace(/\r?\n/g, "⏎").replace(/\t/g, " ");
	if ([...t].length > max) t = [...t].slice(0, max).join("") + "…";
	return t.replace(/\|/g, "\\|").replace(/`/g, "ˋ");
}

export function renderReport(report) {
	const t = report.totals;
	const L = [];
	L.push("# LinkSwift 繁中版建置報告", "");
	L.push("由 `tools/build-zhtw.mjs` 產生。保留的字串維持簡體原文，請逐條確認是否確實為比對 / 請求用途；可疑項目已轉換，需人工確認。", "");
	L.push("## 總計", "");
	L.push("| 項目 | 數量 |", "| --- | ---: |");
	L.push(`| 含中文的字串節點 | ${t.cjkStrings} |`);
	L.push(`| 已轉換字串 | ${t.stringsConverted} |`);
	L.push(`| 轉換後無變化（本來就與台灣用字相同） | ${t.stringsUnchangedByConverter} |`);
	L.push(`| 已轉換註解 | ${t.commentsConverted} |`);
	L.push(`| 保留（未轉換） | ${t.protected} |`);
	L.push(`| 可疑（已轉換，待確認） | ${t.suspicious} |`);
	L.push(`| 轉換不安全而略過 | ${t.converterUnsafe} |`);
	L.push(`| 換行格式 | ${t.eol} |`, "");
	L.push("### 保留理由統計", "", "| 理由 | 說明 | 數量 |", "| --- | --- | ---: |");
	for (const [r, c] of Object.entries(t.protectedByReason).sort((a, b) => b[1] - a[1])) L.push(`| \`${r}\` | ${REASON_LABELS[r] || r} | ${c} |`);
	L.push("");
	if (report.warnings.length) {
		L.push("## 警告", "");
		for (const w of report.warnings) L.push(`- ${w}`);
		L.push("");
	}
	const table = (title, rows) => {
		L.push(`## ${title}（${rows.length}）`, "");
		if (!rows.length) { L.push("（無）", ""); return; }
		L.push("| 行 | 理由 | 字串 | 說明 |", "| ---: | --- | --- | --- |");
		for (const r of [...rows].sort((a, b) => a.line - b.line || a.reason.localeCompare(b.reason))) L.push(`| ${r.line} | \`${r.reason}\` | ${cell(r.value)} | ${cell(r.detail, 80)} |`);
		L.push("");
	};
	table("保留的中文字串", report.protected);
	table("可疑項目", report.suspicious);
	table("轉換不安全而略過", report.unsafe);
	return L.join("\n");
}

// ---------- CLI ----------
function parseArgs(argv) {
	const args = { in: DEFAULT_IN, out: DEFAULT_OUT, report: DEFAULT_REPORT, protect: DEFAULT_PROTECT };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const take = () => { if (i + 1 >= argv.length) throw new Error(`${k} 需要參數`); return path.resolve(argv[++i]); };
		if (k === "--in") args.in = take();
		else if (k === "--out") args.out = take();
		else if (k === "--report") args.report = take();
		else if (k === "--protect") args.protect = take();
		else if (k === "-h" || k === "--help") { args.help = true; }
		else throw new Error(`未知參數：${k}`);
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log("node tools/build-zhtw.mjs [--in <file>] [--out <file>] [--report <file>] [--protect <json>]");
		return;
	}
	const input = fs.readFileSync(args.in, "utf8");
	const { output, report, reportMarkdown } = buildZhTw(input, { protect: loadProtectConfig(args.protect) });
	fs.mkdirSync(path.dirname(args.out), { recursive: true });
	fs.writeFileSync(args.out, output, "utf8");
	fs.mkdirSync(path.dirname(args.report), { recursive: true });
	fs.writeFileSync(args.report, reportMarkdown + "\n", "utf8");
	const t = report.totals;
	console.log(`輸出：${path.relative(process.cwd(), args.out)}`);
	console.log(`報告：${path.relative(process.cwd(), args.report)}`);
	console.log(`字串：轉換 ${t.stringsConverted}、無變化 ${t.stringsUnchangedByConverter}、保留 ${t.protected}、可疑 ${t.suspicious}、略過 ${t.converterUnsafe}；註解轉換 ${t.commentsConverted}`);
	console.log(`保留理由：${Object.entries(t.protectedByReason).map(([r, c]) => `${r}=${c}`).join(", ")}`);
	for (const w of report.warnings) console.warn(`警告：${w}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try { main(); } catch (e) { console.error(e?.stack || e); process.exitCode = 1; }
}
