// 自适应 jsjiami v7 解混淆插件（无硬编码）：
// - 自动识别“字符串池 + 解码器函数”
// - 抽取前奏到受控 VM 执行（完成数组旋转/缓存）
// - 将 _0x????(idx, key) 调用替换为字面量字符串
// - 不改业务逻辑，失败安全回退为原样

import * as t from "@babel/types";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
const traverse = traverseModule.default;               // ← 关键：ESM 默认导出
import generateModule from "@babel/generator";
const generate = generateModule.default;               // ← 关键：ESM 默认导出
import vm from "node:vm";

export default {
  name: "jsjiami_v7",

  detect(code) {
    try {
      const ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
      const pools = findStringPools(ast);
      if (pools.length === 0) return false;
      const readers = findPoolReaders(ast, new Set(pools.map(p => p.id)));
      return readers.length > 0;
    } catch {
      return false;
    }
  },

  process(code) {
    let ast;
    try {
      ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
    } catch {
      return code;
    }

    // 1) 识别字符串池与候选解码器
    const pools = findStringPools(ast);
    const poolIds = new Set(pools.map(p => p.id));
    if (poolIds.size === 0) return code;

    const readers = findPoolReaders(ast, poolIds);
    if (readers.length === 0) return code;

    // 2) 构建并执行前奏（仅含与 pool 相关的顶层语句）
    const prelude = buildPrelude(code, ast, poolIds);
    const sandbox = buildSandbox();
    try {
      vm.runInNewContext(prelude, sandbox, { timeout: 1000, microtaskMode: "afterEvaluate" });
    } catch {
      return code; // 前奏执行失败 → 保守回退
    }

    // 3) 从沙盒中挑出真正能解码的函数
    const decoderNames = pickDecodersInSandbox(sandbox, readers);
    if (decoderNames.size === 0) return code;

    // 4) AST 替换：把解码调用替换成字面量
    let changed = false;
    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        if (!t.isIdentifier(callee)) return;
        if (!decoderNames.has(callee.name)) return;

        const args = p.node.arguments;
        if (args.length === 0) return;

        const idxNum = evalNumeric(args[0]);
        if (idxNum === null) return;

        let keyVal = undefined;
        if (args[1]) {
          const v = evalStringOrNumber(args[1]);
          if (typeof v === "string" || typeof v === "number") keyVal = v;
        }

        try {
          const fn = sandbox[callee.name];
          if (typeof fn !== "function") return;
          const out = (args.length >= 2) ? fn(idxNum, keyVal) : fn(idxNum);
          if (typeof out === "string") {
            p.replaceWith(t.stringLiteral(out));
            changed = true;
          }
        } catch {
          // 单点失败保持原样
        }
      }
    });

    return changed ? generate(ast, { retainLines: false }).code : code;
  }
};

/* ================= 工具函数 ================= */

// 识别大数组的字符串池
function findStringPools(ast) {
  const pools = [];
  traverse(ast, {
    VariableDeclarator(p) {
      const id = p.node.id;
      const init = p.node.init;
      if (!t.isIdentifier(id)) return;
      if (!t.isArrayExpression(init)) return;
      const els = init.elements;
      if (!els || els.length < 6) return;
      const allStr = els.every(e => t.isStringLiteral(e));
      if (allStr) pools.push({ id: id.name, node: p.node });
    }
  });
  return pools;
}

// 找到访问“字符串池[computedIndex]”且索引依赖形参的函数（候选解码器）
function findPoolReaders(ast, poolIds) {
  const readers = [];

  function inspectFn(node, fnName) {
    const params = node.params.map(p => (t.isIdentifier(p) ? p.name : null)).filter(Boolean);
    if (params.length === 0) return null;

    let touchesPool = false;
    let usesParamInIndex = false;

    traverse(node, {
      MemberExpression(me) {
        const obj = me.node.object;
        if (!t.isIdentifier(obj)) return;
        if (!poolIds.has(obj.name)) return;
        touchesPool = true;

        if (me.node.computed && me.node.property) {
          if (exprDependsOnParams(me.node.property, params)) usesParamInIndex = true;
        }
      }
    }, undefined, undefined); // 这里传 node 子树本身没问题

    if (touchesPool && usesParamInIndex) {
      return { name: fnName, node };
    }
    return null;
  }

  traverse(ast, {
    FunctionDeclaration(p) {
      const id = p.node.id?.name;
      if (!id) return;
      const hit = inspectFn(p.node, id);
      if (hit) readers.push(hit);
    },
    VariableDeclarator(p) {
      const id = t.isIdentifier(p.node.id) ? p.node.id.name : null;
      const init = p.node.init;
      if (!id) return;
      if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        const hit = inspectFn(init, id);
        if (hit) readers.push(hit);
      }
    }
  });

  // 去重
  const seen = new Set();
  return readers.filter(r => (seen.has(r.name) ? false : (seen.add(r.name), true)));
}

// 判断表达式是否依赖参数名（不用 traverse 直接跑子树，自己递归更稳）
function exprDependsOnParams(expr, params) {
  let dep = false;
  (function walk(n) {
    if (!n || dep) return;
    if (t.isIdentifier(n) && params.includes(n.name)) { dep = true; return; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && "type" in v) walk(v);
    }
  })(expr);
  return dep;
}

// 构建“前奏代码”：挑出所有包含任一 poolId 的顶层语句（顺序保持）
function buildPrelude(source, ast, poolIds) {
  const snippets = [];
  traverse(ast, {
    Program(p) {
      for (const node of p.node.body) {
        const code = generate(node).code;
        for (const pid of poolIds) {
          if (code.includes(pid)) { snippets.push(code); break; }
        }
      }
    }
  });
  // 轻度沙盒硬化（屏蔽 require/process）
  const header = `
;(() => { try {
  const g = (1,eval)('this');
  if (g) { g.require = undefined; g.process = undefined; }
} catch(_){} })();`;
  return header + "\n" + snippets.join("\n");
}

// 受控沙盒
function buildSandbox() {
  const sb = Object.create(null);
  const atob = (s) => Buffer.from(String(s), "base64").toString("binary");
  const btoa = (s) => Buffer.from(String(s), "binary").toString("base64");
  Object.assign(sb, {
    console: { log(){}, warn(){}, error(){} },
    setTimeout(){ throw new Error("blocked"); },
    setInterval(){ throw new Error("blocked"); },
    atob, btoa
  });
  sb.globalThis = sb.self = sb.window = sb;
  return sb;
}

// 在沙盒里选出能返回 string 的解码器函数
function pickDecodersInSandbox(sandbox, readers) {
  const names = new Set();
  for (const r of readers) {
    const fn = sandbox[r.name];
    if (typeof fn !== "function") continue;

    let ok = false;
    for (const idx of [0,1,2,3,4,5,10,16,32,64,128,255]) {
      try { if (typeof fn(idx, "x") === "string") { ok = true; break; } } catch {}
      try { if (typeof fn(idx) === "string") { ok = true; break; } } catch {}
    }
    if (ok) names.add(r.name);
  }
  return names;
}

// 计算简单数值（0x/一元/常见二元）
function evalNumeric(node) {
  if (t.isNumericLiteral(node)) return node.value;
  if (t.isUnaryExpression(node) && (node.operator === "+" || node.operator === "-")) {
    const v = evalNumeric(node.argument);
    return v === null ? null : (node.operator === "+" ? +v : -v);
  }
  if (t.isBinaryExpression(node)) {
    const l = evalNumeric(node.left);
    const r = evalNumeric(node.right);
    if (l === null || r === null) return null;
    switch (node.operator) {
      case "+": return l + r;
      case "-": return l - r;
      case "*": return l * r;
      case "/": return r === 0 ? null : l / r;
      case "%": return r === 0 ? null : l % r;
      case "<<": return l << r;
      case ">>": return l >> r;
      case ">>>": return l >>> r;
      case "&": return l & r;
      case "|": return l | r;
      case "^": return l ^ r;
      default: return null;
    }
  }
  if (t.isStringLiteral(node)) {
    const s = node.value;
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^\d+$/.test(s)) return parseInt(s, 10);
  }
  return null;
}

// 字面量尽量算成 string/number
function evalStringOrNumber(node) {
  if (t.isStringLiteral(node)) return node.value;
  const n = evalNumeric(node);
  if (n !== null) return n;
  return null;
}
