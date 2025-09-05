export default {
  name: "aaencode",
  detect(code) {
    // 很多 AAE 的特征（极简示例）
    return /ﾟωﾟ|（｀・ω・´）|ω｀/u.test(code);
  },
  process(code) {
    if (!this.detect(code)) return code;
    // 这里留空位：接你现有的 AAE 解码实现
    // 先占位：保持原样（可自行替换为真实解码逻辑）
    return code;
  }
};
