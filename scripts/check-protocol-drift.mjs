#!/usr/bin/env node
// check-protocol-drift.mjs — wire 协议的跨仓漂移检查
//
// 权威是插件仓的 src/protocol/types.ts（PROTOCOL.md 同仓）；app 仓的
// lib/protocol/protocol.dart 是**手工镜像**，两边没有编译期约束，所以用这个脚本兜底。
//
// 用法：
//   node scripts/check-protocol-drift.mjs --ts <types.ts> --dart <protocol.dart> \
//        [--allow scripts/protocol-drift-allow.txt] [--json]
//
// 检查两件事（都以 TS 侧为权威，方向单一，避免噪音）：
//   A. TS 里声明的字段名（interface/type 字面量的属性）必须能在 Dart 侧找到
//      —— 以 `['field']` 读取或 `'field':` 写入的形式出现
//   B. TS 里出现的判别值（`type|kind|op|method|channel|event|reason|code|status|action|decision|mode|error: "x"`）
//      必须能在 Dart 文件里找到字面量
//
// 找不到就退出码 1，并把名字打出来。确认「这是有意的、不属于 wire 契约」的，
// 写进 allowlist（一行一个名字，`#` 开头是注释），别直接把检查关掉。
//
// 已知盲区（有意）：Dart 侧多出来的名字只做提示、不算失败 —— app 会读 Pi 核心
// 载荷里的字段（如 input_tokens/output_tokens），那些本来就不在插件协议里。
// 大小写混排字段名（camelCase）也在 A 的范围内；纯排版差异不会命中。

import { readFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const opt = (name, fallback = undefined) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const tsPath = opt("ts");
const dartPath = opt("dart");
const allowPath = opt("allow", "scripts/protocol-drift-allow.txt");
const asJson = flag("json");

if (!tsPath || !dartPath) {
	console.error("用法: node scripts/check-protocol-drift.mjs --ts <types.ts> --dart <protocol.dart> [--allow <file>] [--json]");
	process.exit(2);
}
for (const p of [tsPath, dartPath]) {
	if (!existsSync(p)) {
		console.error(`找不到文件: ${p}`);
		process.exit(2);
	}
}

const ts = readFileSync(tsPath, "utf8");
const dart = readFileSync(dartPath, "utf8");

const allow = new Set();
if (existsSync(allowPath)) {
	for (const line of readFileSync(allowPath, "utf8").split("\n")) {
		const name = line.split("#")[0].trim();
		if (name) allow.add(name);
	}
}

const IDENT = /^[a-z][A-Za-z0-9_]{2,}$/;

// A. TS 字段名
const tsFields = new Set(
	[...ts.matchAll(/^\s+([a-z][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]).filter((k) => IDENT.test(k)),
);
const dartIndexReads = [...dart.matchAll(/\[\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\]/g)].map((m) => m[1]);
// map key：同时覆盖 `'k': v` 与 Dart 的条件展开 `if (x != null) 'k': x`
const dartMapKeys = [...dart.matchAll(/['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*:/g)].map((m) => m[1]);
const dartFields = new Set([...dartIndexReads, ...dartMapKeys]);

const missingFields = [...tsFields].filter((f) => !dartFields.has(f) && !allow.has(f)).sort();

// B. TS 判别值
const DISC_KEYS = "type|kind|op|method|channel|event|reason|code|status|action|decision|mode|error";
const tsDiscriminants = new Set(
	[...ts.matchAll(new RegExp(`\\b(?:${DISC_KEYS})\\s*:\\s*"([a-z][a-z0-9_]{2,})"`, "g"))].map((m) => m[1]),
);
const missingDiscriminants = [...tsDiscriminants]
	.filter((d) => !dart.includes(`'${d}'`) && !dart.includes(`"${d}"`) && !allow.has(d))
	.sort();

// 提示用（不算失败）：Dart 里读到、TS 没声明的字段
const dartOnlyFields = [...dartFields].filter((f) => !tsFields.has(f)).sort();

const report = {
	ts: tsPath,
	dart: dartPath,
	allow: existsSync(allowPath) ? allowPath : null,
	counts: {
		tsFields: tsFields.size,
		dartFields: dartFields.size,
		tsDiscriminants: tsDiscriminants.size,
	},
	missingFields,
	missingDiscriminants,
	info_dartOnlyFields: dartOnlyFields,
};

if (asJson) console.log(JSON.stringify(report, null, 1));

const failed = missingFields.length + missingDiscriminants.length > 0;
if (!asJson) {
	if (allow.size > 0) console.log(`allowlist: ${[...allow].sort().join(", ")}`);
	console.log(`TS 字段 ${tsFields.size} / Dart 字段 ${dartFields.size} · TS 判别值 ${tsDiscriminants.size}`);
	if (missingFields.length) {
		console.error(`\n❌ TS 声明的字段在 Dart 侧找不到 (${missingFields.length}):`);
		for (const f of missingFields) console.error(`   - ${f}`);
	}
	if (missingDiscriminants.length) {
		console.error(`\n❌ TS 的判别值在 Dart 侧找不到 (${missingDiscriminants.length}):`);
		for (const d of missingDiscriminants) console.error(`   - ${d}`);
	}
	if (dartOnlyFields.length) {
		console.log(`\nℹ️  Dart 侧多出 ${dartOnlyFields.length} 个字段（多为 Pi 核心载荷，非失败项）：`);
		console.log(`   ${dartOnlyFields.join(", ")}`);
	}
	if (failed) {
		console.error(`\n修 wire 要两个仓一起改；确实不属于契约的写进 ${allowPath}`);
		process.exit(1);
	}
	console.log("\n✅ 协议镜像一致");
}
process.exit(failed ? 1 : 0);
