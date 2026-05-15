/**
 * Side-effect imports for the Xingye shell UI webfonts (秘密空间 / 日记 /
 * 日程 / 状态 panels). Mirrors the per-feature scoping used by
 * `xingye-divination-fonts.ts`: the @fontsource chunks are only loaded when
 * the user actually visits the Xingye shell.
 *
 * Why these two families:
 *   - **Ma Shan Zheng** (马善政体) — brush calligraphy, used for big titles
 *     in the secret-space cabinet and the journal card heads.
 *   - **Zhi Mang Xing** (志摩行书) — semi-cursive 行书, used for handwritten
 *     diary bodies, mood chips and signatures.
 *
 * Both are referenced explicitly by the design canvas (`index.html` head
 * loads them from Google Fonts). We self-host via @fontsource so the desktop
 * shell does not depend on a CDN nor a relaxed CSP.
 *
 * Note: Noto Serif SC and JetBrains Mono are already loaded by
 * `xingye-divination-fonts.ts` — we deliberately don't re-import them here
 * to avoid duplicate font-face declarations.
 */

import '@fontsource/ma-shan-zheng/400.css';
import '@fontsource/zhi-mang-xing/400.css';
