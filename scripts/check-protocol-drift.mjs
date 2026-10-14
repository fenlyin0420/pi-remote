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

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

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

// C/D. fixtures 清单（第三个共享产物：两边各存一份 wire 金样本）
const fixturesDir = opt("fixtures");
const manifestPath = opt("manifest", "scripts/protocol-fixtures.sha256");
const peerManifestPath = opt("peer-manifest");
const writeManifest = flag("write-manifest");

function walk(dir, base = dir, acc = []) {
	for (const entry of readdirSync(dir).sort()) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) walk(full, base, acc);
		else acc.push(relative(base, full).split("\\").join("/"));
	}
	return acc;
}
function manifestOf(dir) {
	const lines = [];
	for (const rel of walk(dir).sort()) {
		const sha = createHash("sha256").update(readFileSync(join(dir, rel))).digest("hex");
		lines.push(`${sha}  ${rel}`);
	}
	return lines.join("\n") + "\n";
}
function parseManifest(text) {
	const map = new Map();
	for (const line of text.split("\n")) {
		const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
		if (m) map.set(m[2].trim(), m[1]);
	}
	return map;
}
function diffManifests(local, peer) {
	const out = [];
	for (const [name, sha] of local) {
		if (!peer.has(name)) out.push(`+ 仅本仓有: ${name}`);
		else if (peer.get(name) !== sha) out.push(`≠ 内容不同: ${name}`);
	}
	for (const name of peer.keys()) if (!local.has(name)) out.push(`- 仅对端有: ${name}`);
	return out;
}

let fixtures = null;
if (fixturesDir) {
	if (!existsSync(fixturesDir)) {
		console.error(`找不到 fixtures 目录: ${fixturesDir}`);
		process.exit(2);
	}
	const local = manifestOf(fixturesDir);
	if (writeManifest) {
		writeFileSync(manifestPath, local);
		console.log(`已写 ${manifestPath}（${local.trim().split("\n").length} 个文件）`);
	}
	fixtures = { count: local.trim().split("\n").length, vsManifest: [], vsPeer: [] };
	if (existsSync(manifestPath)) {
		fixtures.vsManifest = diffManifests(parseManifest(local), parseManifest(readFileSync(manifestPath, "utf8")));
	} else {
		fixtures.vsManifest = [`(未找到 ${manifestPath}，跳过本仓清单比对)`];
	}
	if (peerManifestPath && existsSync(peerManifestPath)) {
		fixtures.vsPeer = diffManifests(parseManifest(local), parseManifest(readFileSync(peerManifestPath, "utf8")));
	}
}

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
	fixtures,
};

if (asJson) console.log(JSON.stringify(report, null, 1));

const failed =
	missingFields.length + missingDiscriminants.length > 0 ||
	Boolean(fixtures && (fixtures.vsManifest.some((l) => !l.startsWith("(")) || fixtures.vsPeer.length));
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
	if (fixtures) {
		console.log(`\nfixtures: ${fixtures.count} 个文件`);
		const show = (title, lines) => {
			if (!lines.length) return;
			console.error(`${title} (${lines.length}):`);
			for (const l of lines) console.error(`   ${l}`);
		};
		show("❌ 本仓 fixtures 与已提交清单不一致（改了 fixtures 就重跑 --write-manifest）", fixtures.vsManifest.filter((l) => !l.startsWith("(")));
		show("❌ 与对端仓 fixtures 不一致（两个仓的 wire 金样本必须同源）", fixtures.vsPeer);		if (!fixtures.vsManifest.filter((l) => !l.startsWith("(")).length) console.log("✅ fixtures 与已提交清单一致");
		if (peerManifestPath) {
			if (fixtures.vsPeer.length) console.error("❌ 与对端仓 fixtures 不一致（两个仓的 wire 金样本必须同源）");
			else console.log("✅ fixtures 与对端仓一致");
		}
	}
	if (failed) {
		console.error(`\n修 wire 要两个仓一起改；确实不属于契约的写进 ${allowPath}`);
		process.exit(1);
	}
	console.log("\n✅ 协议镜像一致");
}
process.exit(failed ? 1 : 0);
