/**
 * Side-effect imports for the divination UI webfonts.
 *
 * Each theme references one of these families in its CSS module; without
 * these imports the divination panel would silently fall back to system
 * serifs (the themes still work, just less distinctive). Importing here —
 * not in the global app shell — keeps the cost scoped: the chunks only
 * load when the divination feature is visited.
 *
 * Weight selection rules:
 *   - 400 / 600 for serif body + headings
 *   - italic variants only where a theme actually renders italic
 *     (crystal_ball, tarot signs, astro)
 *   - 700 for runes title (carved-stone uppercase)
 *   - 700 for noto-serif-sc to support iching bold red titles
 *   - 400 / 700 for JetBrains Mono (field_oracle body + bracketed headers)
 */

import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/400-italic.css';
import '@fontsource/cormorant-garamond/600.css';

import '@fontsource/fraunces/400.css';
import '@fontsource/fraunces/700.css';

import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';

import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
