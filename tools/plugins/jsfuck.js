export default {
  name: "jsfuck",
  detect(code) {
    // 粗检：JSFuck 通常包含大量 []()+! 组合
    const density = (code.match(/[\[\]\(\)\+\!]{1}/g) || []).length / Math.max(code.length, 1);
    return density > 0.12; // 阈值可调
  },
  process(code) {
    if (!this.detect(code)) return code;
    // 留给你接入现成解码器/AST 还原逻辑
    return code;
  }
};
