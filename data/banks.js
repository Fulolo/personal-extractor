// 题库注册表（手动维护）。
// 新增一个题库的 5 步：
//   1) 把该题库的 markdown 放进 extractor/../<folder>/
//   2) 复制 build-javaguide.mjs 改为 build-<id>.mjs，调整差异配置后运行
//   3) 在 index.html 里增加一行 <script src="data/<id>.js"></script>
//   4) 在下面追加一条 { id, name, global }
//   5) 运行 node build-all.mjs（或 npm run build）
window.BANKS = [
  { id: 'sanfene', name: '面渣逆袭', global: 'SANFENE_DATA' },
  { id: 'javaguide', name: 'JavaGuide', global: 'JAVAGUIDE_DATA' },
];
