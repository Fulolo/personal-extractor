/* ============================================================
   面渣抽题器 · 记忆算法（独立模块）
   ------------------------------------------------------------
   设计：基于「当前分数(0~100)」的分段查表模型。
   每次作答根据当前分数所在区间，套用对应的加减分：

     当前分数区间      点击【记得】  点击【模糊】  点击【忘记了】
     0  ~ 20（含）     +15           +5            -10
     21 ~ 40（含）     +12           +4            -15
     41 ~ 60（含）     +10           +3            -20
     61 ~ 80（含）     +7            +2            -25
     81 ~ 100（含）    +4            +1            -30

   结果统一 clamp 到 0~100。
   记忆按钮只负责"计算分数"，不做持久化；持久化由 app.js 负责。
   本文件以 IIFE + window 挂载方式暴露 MemoryAlgo，兼容 file:// 直接打开
   （不使用 ES module，因为 file:// 下 module 会被 CORS 拦截）。
   ============================================================ */
(function (global) {
  'use strict';

  // 动作 -> 查表字段名
  var FIELD = { remembered: 'remembered', fuzzy: 'fuzzy', forgotten: 'forgotten' };

  // 分段表（区间含端点）
  var TABLE = [
    { lo: 0,  hi: 20,  remembered: 15, fuzzy: 5,  forgotten: -10 },
    { lo: 21, hi: 40,  remembered: 12, fuzzy: 4,  forgotten: -15 },
    { lo: 41, hi: 60,  remembered: 10, fuzzy: 3,  forgotten: -20 },
    { lo: 61, hi: 80,  remembered: 7,  fuzzy: 2,  forgotten: -25 },
    { lo: 81, hi: 100, remembered: 4,  fuzzy: 1,  forgotten: -30 }
  ];

  function clamp(n) {
    n = Math.round(n);
    if (n < 0) return 0;
    if (n > 100) return 100;
    return n;
  }

  // 给定分数，返回命中的区间行
  function bracket(score) {
    var s = clamp(score);
    for (var i = 0; i < TABLE.length; i++) {
      if (s >= TABLE[i].lo && s <= TABLE[i].hi) return TABLE[i];
    }
    return TABLE[TABLE.length - 1]; // 兜底：100
  }

  // 本次作答对"当前分数"的偏移量（用于回退）
  function deltaFor(score, act) {
    return bracket(score)[FIELD[act]];
  }

  // 应用一次作答：基于当前分数查表，返回新分数（已 clamp）
  function apply(score, act) {
    return clamp(score + deltaFor(score, act));
  }

  // 档次信息：key 用于 CSS 上色，label 用于文案
  // 0~19 陌生 / 20~49 模糊 / 50~79 熟悉 / 80~100 精通
  function tier(score) {
    var s = clamp(score);
    if (s >= 80) return { key: 'remembered', label: '精通' };
    if (s >= 50) return { key: 'mastered',   label: '熟悉' };
    if (s >= 20) return { key: 'fuzzy',      label: '模糊' };
    return { key: 'forgotten', label: '陌生' };
  }

  global.MemoryAlgo = {
    TABLE: TABLE,
    FIELD: FIELD,
    clamp: clamp,
    bracket: bracket,
    deltaFor: deltaFor,
    apply: apply,
    tier: tier
  };
})(typeof window !== 'undefined' ? window : this);
