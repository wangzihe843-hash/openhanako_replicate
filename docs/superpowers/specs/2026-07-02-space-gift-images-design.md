# Space Gift Image Completion Design

## Scope

Complete the `space` gift-image set without changing gift definitions or filenames:

- Recover and import the already generated `03-zero-g-plant.png`.
- Generate and import `04-space-food.png` through `10-constellation-pendant.png`.
- Replace the existing SVG-rendered placeholder PNGs in the same project asset locations used by completed gift sets.

## Visual Direction

Use `space/01-meteorite.png` and `space/02-star-projector.png` as the primary references. Every new image must use:

- a square 1:1 canvas;
- a single centered, immediately recognizable gift object;
- warm ivory studio background with generous empty space;
- polished realistic 3D product-render treatment;
- soft grounding shadow or restrained glow appropriate to the object;
- dark navy, warm brass, cream, and muted stellar-gold palette, with restrained secondary color where the object requires it;
- no text, letters, numbers, logos, watermark, border, hands, or people.

The set should feel collectible, warm, refined, and consistent rather than cold industrial science fiction.

## Asset Subjects

1. `03-zero-g-plant.png`: a small living plant suspended inside a refined sealed zero-gravity botanical chamber.
2. `04-space-food.png`: premium compact astronaut food packaging or meal module, clearly edible and gift-like without readable labels.
3. `05-starship-model.png`: a detailed collectible starship model on a small display stand.
4. `06-astronaut-figurine.png`: a charming premium astronaut collectible figurine, not a real person.
5. `07-moon-lamp.png`: a softly glowing moon-textured table lamp with a refined base.
6. `08-stardust-vial.png`: a sealed glass vial containing luminous golden stardust.
7. `09-orrery.png`: a compact brass celestial orrery with dark-blue planetary accents.
8. `10-constellation-pendant.png`: an elegant constellation pendant in brass/gold and dark-blue enamel, with no recognizable letters or zodiac text.

## Workflow

1. Locate candidate generated images under the Codex generated-image cache and copy them into a workspace inspection folder when direct viewing is blocked.
2. Identify the correct previously generated zero-gravity plant by visual comparison with 01/02.
3. Generate each remaining asset separately using the same shared style constraints plus a subject-specific prompt.
4. Inspect every generated image for subject recognition, composition, palette, unwanted text, malformed geometry, and cross-set consistency.
5. Regenerate only images that fail those checks.
6. Copy accepted files over the existing project PNG placeholders and any mirrored source asset directory required by the application build.

## Verification

- All ten `space` filenames exist in the canonical source asset directory.
- Files 03 through 10 are generated raster artwork rather than the old flat SVG renders.
- Images are square PNGs and visually consistent with 01/02.
- The application asset references still resolve without code changes.
- A final visual pass confirms no text, watermark, malformed object, accidental character, or inconsistent background.

## Non-goals

- No gift inventory, pricing, lore, or UI behavior changes.
- No redesign of 01/02.
- No changes to other world sets.
