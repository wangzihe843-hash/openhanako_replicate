# 赠礼系统礼物图 · SVG 源文件

这里是 110 张礼物图里 **101 张本地手绘 SVG 的源文件**（另 9 张是 Canva 生成的，无 SVG 源，见下）。
应用实际加载的是 `desktop/src/assets/xingye-gifts/{set}/{NN-slug}.png`（512px，由这些 SVG 渲染而来）；
礼物目录数据在 `desktop/src/react/xingye/xingye-gift-catalog.ts`。

## 怎么改一张图

1. 按 slug 找到对应 SVG（文件名形如 `{前缀}-{NN}-{slug}.svg`，按下表前缀对应 set；
   或直接 `grep` slug，例如想改 `wuxia/01-sword-tassel.png` 就找 `*sword-tassel.svg`）。
2. 改 SVG，用 sharp 渲染回 512px PNG 覆盖 assets：
   ```
   node -e "require('sharp')('xx.svg').resize(512,512).png({compressionLevel:9}).toFile('../../../desktop/src/assets/xingye-gifts/{set}/{NN-slug}.png')"
   ```
   （需先 `npm i sharp`；规范见同目录 `STYLE_GUIDE.md` / `DESIGN_PHILOSOPHY.md`）。

## 文件名前缀 → set 对应

| 前缀 | set 目录 | 数量 | 备注 |
|------|----------|------|------|
| `cn-`  | `cn_ancient`   | 9  | 缺 01-jade-pendant（Canva 生成） |
| `mod-` | `modern`       | 2  | 仅 09-plush-bear / 10-earphones；01–08 是 Canva |
| `rep-` | `republican`   | 10 | |
| `med-` | `west_medieval`| 10 | |
| `wx-`  | `wuxia` + `xianxia` | 8 | 最初武侠/仙侠合并批；拆分后分属两 set（按 slug 对应） |
| `wux-` | `wuxia`        | 6  | 拆分后新增 |
| `xia-` | `xianxia`      | 6  | 拆分后新增 |
| `wf-`  | `west_fantasy` | 10 | |
| `stm-` | `steampunk`    | 10 | |
| `cyb-` | `cyberpunk`    | 10 | |
| `was-` | `wasteland`    | 10 | |
| `spc-` | `space`        | 10 | |

> 注意：SVG 文件名里的 NN 编号和 slug 可能与最终 PNG 略有出入（拆分武侠/仙侠时重新编了号，
> 个别 slug 也微调过，如 `cn-03-calligraphy.svg` → `03-calligraphy-set.png`）。**以 slug 为准**匹配。

## 无 SVG 源的 9 张（Canva 生成）

`modern/01-rose-bouquet` … `modern/08-strawberry-cake`（8 张）+ `cn_ancient/01-jade-pendant`。
Canva 免费额度（终身 10 次 Magic Design）耗尽后改走本地 SVG 管线，这 9 张是耗尽前的产物。
要改这几张得重新手绘 SVG 或换图。
