// tools/plugins/jsjiami_v7.js
// 自适应还原：无硬编码名称/偏移；AST 识别字符串池 & 解码器 → 受控 VM 执行 → 替换调用点为字面量。
// 仅做“可读化”，不改变原业务逻辑。失败则安全回退为原样。

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";
import vm from "node:vm";

export default {
  name: "jsjiami_v7",

  // 不依赖品牌字样：基于“字符串池 + 函数访问池”结构判断
  detect(code) {
    try {
      const ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
      const pools = findStringPools(ast);
      if (pools.length === 0) return false;
      const fns = findPoolReaders(ast, new Set(pools.map(p => p.id)));
      return fns.length > 0;
    } catch {
      return false;
    }
  },

  process(code) {
    // 解析
    let ast;
    try {
      ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
    } catch {
      return code;
    }

    // 识别字符串池 & 访问该池的函数（候选解码器）
    const pools = findStringPools(ast);            // [{ id, node }]
    const poolIds = new Set(pools.map(p => p.id));
    if (poolIds.size === 0) return code;

    const readers = findPoolReaders(ast, poolIds); // [{ name, node }]
    if (readers.length === 0) return code;

    // 抽取“前奏代码”：包含所有出现 poolId 的顶层语句（池声明、旋转 IIFE、解码器函数等）
    const prelude = buildPrelude(code, ast, poolIds);

    // 构建受控沙盒，执行前奏代码（让旋转/缓存等完成），拿到真实函数引用
    const sandbox = buildSandbox();
    try {
      vm.runInNewContext(prelude, sandbox, { timeout: 1000, microtaskMode: "afterEvaluate" });
    } catch {
      // 前奏执行失败，放弃替换
      return code;
    }

    // 选择在沙盒里真实可用的“解码器函数集合”
    const decoderNames = pickDecodersInSandbox(sandbox, readers);

    if (decoderNames.size === 0) {
      // 没有可用的解码器则不动
      return code;
    }

    // 第二遍 AST：替换所有对解码器的调用为字面量字符串
    let changed = false;
    traverse(ast, {
      CallExpression(path) {
        const callee = path.node.callee;
        if (!t.isIdentifier(callee)) return;
        if (!decoderNames.has(callee.name)) return;

        const args = path.node.arguments;
        if (args.length === 0) return;

        const idxNum = evalNumeric(args[0]);
        if (idxNum === null) return;

        let keyVal = undefined;
        if (args[1]) {
          const k = evalStringOrNumber(args[1]);
          if (typeof k === "string" || typeof k === "number") keyVal = k;
        }

        try {
          const fn = sandbox[callee.name];
          if (typeof fn !== "function") return;
          const out = (args.length >= 2) ? fn(idxNum, keyVal) : fn(idxNum);
          if (typeof out === "string") {
            path.replaceWith(t.stringLiteral(out));
            changed = true;
          }
        } catch {
          // 解码失败则保持原样
        }
      }
    });

    return changed ? generate(ast, { retainLines: false }).code : code;
  }
};

/* ===================== 工具函数区域 ===================== */

// 找大量字符串的数组声明（字符串池）
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

// 找访问字符串池的函数（候选解码器）：函数体内出现 poolId[...]，且索引表达式依赖其形参
function findPoolReaders(ast, poolIds) {
  const readers = [];
  function isReader(fnPath) {
    const node = fnPath.node;
    const id = node.id && node.id.name ? node.id.name : (
      // 匿名函数可能赋值给变量
      t.isVariableDeclarator(fnPath.parent) && t.isIdentifier(fnPath.parent.id)
        ? fnPath.parent.id.name
        : null
    );
    if (!id) return null;

    const params = node.params.map(p => t.isIdentifier(p) ? p.name : null).filter(Boolean);
    if (params.length === 0) return null;

    let touchesPool = false;
    let usesParamInIndex = false;

    fnPath.traverse({
      MemberExpression(me) {
        if (!t.isIdentifier(me.node.object)) return;
        if (!poolIds.has(me.node.object.name)) return;
        touchesPool = true;

        if (me.node.computed && me.node.property) {
          if (dependsOnParams(me.node.property, params)) usesParamInIndex = true;
        }
      }
    });

    if (touchesPool && usesParamInIndex) {
      return { name: id, node };
    }
    return null;
  }

  traverse(ast, {
    FunctionDeclaration(p) {
      const hit = isReader(p);
      if (hit) readers.push(hit);
    },
    VariableDeclarator(p) {
      const init = p.node.init;
      if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
        const fake = { node: init, parent: p.node, traverse: (v) => traverse(init, v) };
        const hit = (function () {
          const node = init;
          const id = t.isIdentifier(p.node.id) ? p.node.id.name : null;
          if (!id) return null;

          const params = node.params.map(q => t.isIdentifier(q) ? q.name : null).filter(Boolean);
          if (params.length === 0) return null;

          let touchesPool = false;
          let usesParamInIndex = false;
          traverse(init, {
            MemberExpression(me) {
              if (!t.isIdentifier(me.node.object)) return;
              if (!poolIds.has(me.node.object.name)) return;
              touchesPool = true;
              if (me.node.computed && me.node.property) {
                if (dependsOnParams(me.node.property, params)) usesParamInIndex = true;
              }
            }
          });
          if (touchesPool && usesParamInIndex) {
            return { name: id, node: init };
          }
          return null;
        })();
        if (hit) readers.push(hit);
      }
    }
  });

  // 去重（按函数名）
  const seen = new Set();
  return readers.filter(r => (seen.has(r.name) ? false : (seen.add(r.name), true)));
}

// 判断表达式是否依赖给定参数名之一（简易版）
function dependsOnParams(expr, params) {
  let dep = false;
  traverse(expr, {
    Identifier(idp) {
      if (params.includes(idp.node.name)) dep = true;
    }
  }, expr.scope, expr);
  return dep;
}

// 构建前奏代码：收集所有包含 poolId 的顶层语句（顺序按源码）
function buildPrelude(source, ast, poolIds) {
  const picks = [];
  traverse(ast, {
    Program(p) {
      for (const node of p.node.body) {
        const code = generate(node).code;
        for (const pid of poolIds) {
          if (code.includes(pid)) { picks.push(code); break; }
        }
      }
    }
  });
  // 在沙盒注入一个占位数组用于后续检测
  const header = `
;(() => {
  try {
    // 防止外部对象被访问
    const g = (1,eval)('this');
    if (g) { g.require = undefined; g.process = undefined; }
  } catch {}
})();`;
  return header + "\n" + picks.join("\n");
}

// 构建受控沙盒（禁用敏感对象，提供 atob/btoa）
function buildSandbox() {
  const sb = Object.create(null);
  const atob = (s) => Buffer.from(String(s), "base64").toString("binary");
  const btoa = (s) => Buffer.from(String(s), "binary").toString("base64");

  Object.assign(sb, {
    globalThis: null,
    self: null,
    window: null,
    document: {},
    console: { log(){}, warn(){}, error(){} },
    setTimeout(){ throw new Error("blocked"); },
    setInterval(){ throw new Error("blocked"); },
    atob, btoa
  });
  sb.globalThis = sb.self = sb.window = sb;
  return sb;
}

// 在沙盒里筛选真实可调用的解码器函数
function pickDecodersInSandbox(sandbox, readers) {
  const names = new Set();
  for (const r of readers) {
    const fn = sandbox[r.name];
    if (typeof fn !== "function") continue;
    // 试探调用：尝试若干索引，能返回字符串即认为有效
    let ok = false;
    for (const idx of [0,1,2,3,4,5,10,16,32,64,128,255]) {
      try {
        const out = fn(idx, "test");
        if (typeof out === "string") { ok = true; break; }
      } catch {}
      try {
        const out2 = fn(idx);
        if (typeof out2 === "string") { ok = true; break; }
      } catch {}
    }
    if (ok) names.add(r.name);
  }
  return names;
}

// 计算简单数值（支持 0x.., +/-, 二元运算）
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
    // 形如 "0x1a" 的字符串
    const m = /^0x[0-9a-f]+$/i.exec(node.value);
    if (m) return parseInt(node.value, 16);
    if (/^\d+$/.test(node.value)) return parseInt(node.value, 10);
  }
  return null;
}

// 尽量把字面求成基本值（字符串/数字），否则返回 null
function evalStringOrNumber(node) {
  if (t.isStringLiteral(node)) return node.value;
  const n = evalNumeric(node);
  if (n !== null) return n;
  return null;
}
