// 配布用パッケージを作成する。
//   1. TypeScript をコンパイル（tsc）
//   2. 実行に必要なファイルだけを dist/ に集約
//   3. dist/ を zip 化（Chrome ウェブストア提出 / unpacked 配布の両方に使える）
// 使い方: bun run package
import { $ } from "bun";
import { rm, mkdir, cp } from "node:fs/promises";

const DIST = "dist";

// 拡張機能の実行時に必要なファイル（ソースの .ts や node_modules は含めない）。
const FILES = [
  "manifest.json",
  "popup.html",
  "popup.js",
  "jspdf.umd.min.js",
];
const DIRS = [
  "fonts", // NotoSansJP.ttf（テキストレイヤー用フォント）
];

// 1. コンパイル
await $`bun run build`;

// 2. dist/ を作り直して必要ファイルをコピー
await rm(DIST, { recursive: true, force: true });
await mkdir(DIST, { recursive: true });
for (const f of FILES) {
  await cp(f, `${DIST}/${f}`);
}
for (const d of DIRS) {
  await cp(d, `${DIST}/${d}`, { recursive: true });
}

// 3. zip 化（バージョンをファイル名に含める）
const { version, name } = await Bun.file("package.json").json();
const zipName = `${name}-v${version}.zip`;
await rm(zipName, { force: true });
// dist/ の中身をルートに置いた zip にする（manifest.json が zip 直下に来る必要がある）
await $`cd ${DIST} && zip -r -FS ../${zipName} . -x ".*"`;

console.log(`\n✓ ${zipName} を作成しました（dist/ も展開済み）。`);
