import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import aaencode from "./plugins/aaencode.js";
import jsfuck from "./plugins/jsfuck.js";
import jsjiami_v7 from "./plugins/jsjiami_v7.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_DIR = path.resolve(__dirname, "../input");
const OUTPUT_DIR = path.resolve(__dirname, "../decoded");

const PLUGINS = [
  jsjiami_v7, // 优先：常见且“套娃”多
  aaencode,
  jsfuck
];

// 递归读所有 .js
function listJs(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) out.push(...listJs(p));
    else if (name.toLowerCase().endsWith(".js")) out.push(p);
  }
  return out;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function writeOut(inFile, code) {
  const rel = path.relative(INPUT_DIR, inFile);
  const outPath = path.join(OUTPUT_DIR, rel);
  ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, code, "utf8");
  console.log(" → saved:", outPath);
}

function runPipeline(raw) {
  let code = raw;
  let changed = true;
  // 多轮次：直到没有插件再改出新结果（防止一层层套娃）
  for (let round = 1; round <= 5 && changed; round++) {
    changed = false;
    for (const plugin of PLUGINS) {
      const before = code;
      try {
        code = plugin.process(code);
      } catch (e) {
        console.warn(`[plugin:${plugin.name}] error:`, e.message);
      }
      if (code !== before) changed = true;
    }
  }
  return code;
}

function main() {
  ensureDir(OUTPUT_DIR);
  const files = listJs(INPUT_DIR);
  if (files.length === 0) {
    console.log("input/ 下没有 .js 文件，跳过。");
    return;
  }
  for (const f of files) {
    console.log("===> decode:", f);
    const raw = fs.readFileSync(f, "utf8");
    const out = runPipeline(raw);
    writeOut(f, out);
  }
}
main();
