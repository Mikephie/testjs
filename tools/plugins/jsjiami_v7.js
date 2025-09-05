// tools/plugins/jsjiami_v7.js
// 目标：在不 eval 全文的前提下，识别典型 v7 结构：字符串池 + 取值器 + 自旋扰动器
// 做三步：1) 拆出字符串表；2) 复原自旋（常见的位移/加盐轮转）；3) 还原调用点 _0xNNNN(idx,'salt')
// 说明：覆盖面很大但不是 100%，遇到变种再补规则。

import { parse } from "@babel/parser";
import traverse from "@babel/traverse";
import generate from "@babel/generator";
import * as t from "@babel/types";

export default {
  name: "jsjiami_v7",

  detect(code) {
    return code.includes("jsjiami.com.v7") || /encode_version\s*=.*jsjiami\.com\.v7/.test(code);
  },

  process(code) {
    if (!this.detect(code)) return code;

    // ---- 0) 预清理一些无意义标记 ----
    code = code.replace(/;+?\s*var\s+encode_version\s*=\s*['"]jsjiami\.com\.v7['"];?/g, "");
    code = code.replace(/['"]?jsjiami\.com\.v7['"]?;?/g, "");

    // ---- 1) 解析 AST，寻找“字符串池 + 取值器” ----
    let ast;
    try {
      ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
    } catch {
      return code; // 解析失败直接返回，避免卡住流水线
    }

    // 典型结构特征：
    // var _0xabc1 = ['strA','strB',...];           // 字符串池
    // function _0x1e61(a,b){ a = a - 0x0; return _0xabc1[a]; }  // 取值器（有时带扰动）
    // (function(...){ while(...){ try{ ... _0xabc1.push(_0xabc1.shift()) ... }})()   // 自旋扰动器

    // 1.1 扫描字符串池
    let poolId = null;
    let poolValues = null;

    traverse(ast, {
      VariableDeclarator(p) {
        if (t.isIdentifier(p.node.id) && t.isArrayExpression(p.node.init)) {
          const allStr = p.node.init.elements.every(el => t.isStringLiteral(el));
          if (allStr && !poolValues) {
            poolId = p.node.id.name;
            poolValues = p.node.init.elements.map(el => el.value);
          }
        }
      }
    });

    if (!poolId || !poolValues) return code; // 找不到字符串池，放弃还原

    // 1.2 简化：去掉常见 while(!![]) 自旋，把 pool 视为“最终态”
    traverse(ast, {
      WhileStatement(p) {
        const src = generate(p.node.test).code;
        if (/^\s*!{1,2}\[\]\s*$/.test(src) || /true/.test(src)) {
          // 直接移除（保守起见替空语句）
          p.replaceWith(t.emptyStatement());
        }
      }
    });

    // 1.3 捕获“取值器”函数名（_0x1e61 这种），并尝试识别索引平移
    let getterName = null;
    let baseOffset = 0;

    traverse(ast, {
      FunctionDeclaration(p) {
        const id = p.node.id?.name;
        if (!id) return;
        // 取值器常见形态：a = a - 0xNN; return _pool[a]
        let offset = 0;
        let ok = false;
        p.traverse({
          BinaryExpression(pp) {
            if (
              pp.node.operator === "-" &&
              t.isIdentifier(pp.node.left) &&
              t.isNumericLiteral(pp.node.right)
            ) {
              offset = pp.node.right.value;
              ok = true;
            }
          },
          MemberExpression(pp) {
            if (t.isIdentifier(pp.node.object, { name: poolId })) {
              ok = true;
            }
          }
        });
        if (ok && getterName === null) {
          getterName = id;
          baseOffset = offset | 0;
        }
      }
    });

    // ---- 2) 替换调用点 _getter(0x12a,'salt') → 直接字面量 ----
    if (getterName) {
      traverse(ast, {
        CallExpression(p) {
          const callee = p.node.callee;
          if (t.isIdentifier(callee, { name: getterName })) {
            const args = p.node.arguments;
            if (args.length >= 1 && t.isStringLiteral(args[0])) return; // 已经是字符串的，不管

            // idx 可能是 NumericLiteral 或 0xNN 解析后的
            let idxNode = args[0];
            let idxVal = null;
            if (t.isNumericLiteral(idxNode)) idxVal = idxNode.value;
            else {
              const code = generate(idxNode).code;
              // 简单把 0x1a 这种转 26
              const m = /^0x([0-9a-f]+)$/i.exec(code);
              if (m) idxVal = parseInt(m[1], 16);
            }
            if (idxVal !== null) {
              const real = poolValues[idxVal - baseOffset];
              if (typeof real === "string") {
                p.replaceWith(t.stringLiteral(real));
              }
            }
          }
        }
      });
    }

    // ---- 3) 输出代码（再做一点点微清理）----
    const out = generate(ast, { retainLines: false }).code
      .replace(/\b!!\[\]\b/g, "true")
      .replace(/\b!\[\]\b/g, "false");

    return out;
  }
};
