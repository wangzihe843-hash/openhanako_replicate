# 礼物图标风格规范（Warm Inventory）— 必读，逐条遵守

每张图 = 一个手写 SVG（1024×1024）→ sharp 渲染 PNG。质感基准见参考图（先 Read 它们校准眼睛）：
- `D:\18133\projects\openhanako_replicate\gift-assets-staging\cn_ancient\02-silk-fan.png`
- `D:\18133\projects\openhanako_replicate\gift-assets-staging\west_fantasy\03-potion.png`
- `D:\18133\projects\openhanako_replicate\gift-assets-staging\wuxia\01-sword-tassel.png`

## 渲染命令
SVG 写到 `D:\18133\Temp\svg2png\{前缀}-{nn}-{slug}.svg`，然后：
```
Set-Location "D:\18133\Temp\svg2png"; node -e "const sharp=require('sharp'); sharp('文件.svg').png().toFile('D:/18133/projects/openhanako_replicate/gift-assets-staging/{set}/{nn}-{slug}.png').then(()=>console.log('ok')).catch(e=>{console.error(e.message);process.exit(1)})"
```
（sharp 已装好；多个文件可在一个 node -e 里 Promise.all）

## 画布与构图
- `<rect width="1024" height="1024" fill="#FAF3E6"/>` 打底，**绝对无文字/字母/数字**（钟表面用刻度线、标签用空白色块、印章用抽象几何纹）。
- 单一物体居中，占画布高度 45–65%，光学中心略高于几何中心，四周留足呼吸空间。
- 物体落地：底部 ground ellipse `fill="#EADBBD"`（ry≈13-17）。悬浮/发光物例外（见下）。

## 长投影（Canva 质感的灵魂）
- 实体物件必须有斜向长投影：把物体主剪影**偏移 (60,44)** 画成 `fill="#F1E3C9"`，画在物体之前、ground ellipse 之前。
- **必须合并成 1–2 个连续形状**！分段矩形会出现断缝/滴落感/托架感。圆角矩形顶部不得高过主体（会露出"拇指"）。
- 发光物（晶石/灯/全息投影等）**不要长投影**：改用 2-3 层同心光晕圆（如 `#EAF3EE` opacity 0.5-0.6 递进）+ ground ellipse。

## 明暗与材质（每张至少做到）
1. 主体 3–4 级同色调分层：受光面 / 固有色 / 暗部（同色系加深，禁纯黑，最深用暖棕 #3E332C 级）。
2. 接触处 occlusion：物体压物体处加一条深色低透明带。
3. 高光：白/近白 stroke 弧线（opacity 0.6-0.9），玻璃用双高光。
4. 材质细节 ≥2 处：木纹线 / 织物 tick / 金属双线+铆钉 / 玻璃液面线+气泡 / 宝石棱线+托爪 / 编织纹。

## 调色板（暖色低饱和；每件最多一个红/粉 accent）
- 基础：bg #FAF3E6；投影 #F1E3C9；地影 #EADBBD
- 木/铜暖棕：#C09058 / #A87844 / #8C6239 / 高光 #D8B077
- 金/黄铜：#D9A856 / #C28F3F / 高光 #EFCB8B（蒸汽朋克主色）
- 红 accent：#C9574C / #B83E35 / #D34E42 / 高光 #E8766B
- 粉：#F6C6CB / #EFADB4 / #E2949D
- 玉/青：#9CCFC4 / #6FA89B / #B8D0AE（仙侠）；草绿 #8FA882 / #8FB98B
- 紫（魔法/赛博）：#A98BC4 / #8E6FB1 / #C7B3DC
- 银/铁：#C9CDD4 / #A9AFB8 / #8F96A1（中世纪）
- 新世界观补充（保持低饱和）：赛博朋克霓虹=#C77DA6 品红 + #7FB8BF 青，发光体可用白核+色晕；废土=锈 #B07050、军绿 #9A9B6E、土 #B5A284；太空=暗蓝 #6E7FA8 / #8E9FC4、星金 #E5C878；民国=暖褐+金+一点 #7FAFA3 湖绿。

## 已踩过的坑（一票否决项，自检时逐条对照）
- 吊坠/链子/流苏必须在世界坐标里**垂直下垂**（不随主体 rotate）。
- 抽象纹样别带两个对称圆点（像眼睛→变脸）；别画成箭头形/小人形。
- 绳结别用两条短竖线（像滴血）；蝴蝶结要画双环+垂带。
- 卷轴端部用竖向圆柱，别用正面同心圆（像车轮）。
- 装订线别画十字（像医院）；高光带别成箭头；浅色缺口三角浮在形体内像碎纸。
- 表盘/仪表只用刻度短线，不放数字字母。

## 工作流（每张图必须走完）
1. 写 SVG → 渲染 → **Read 渲染出的 PNG 用眼睛看**。
2. 对照否决项清单 + "这像不像它该是的东西？有没有像别的东西（脸/箭头/车轮）？"
3. 有问题改 SVG 重渲染再看，直到合格。每张至少看一遍，不准跳过。
