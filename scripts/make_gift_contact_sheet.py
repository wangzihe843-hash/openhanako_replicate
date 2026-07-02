import argparse
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
STAGING = ROOT / "gift-assets-staging"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("set_name")
    args = parser.parse_args()

    source_dir = STAGING / args.set_name
    files = sorted(p for p in source_dir.glob("*.png") if not p.name.endswith("-v2.png"))
    cell_w, cell_h = 220, 220
    cols = 5
    rows = (len(files) + cols - 1) // cols
    out = Image.new("RGB", (cols * cell_w, rows * cell_h), "white")
    draw = ImageDraw.Draw(out)
    for index, path in enumerate(files):
        thumb = Image.open(path).convert("RGB").resize((180, 180), Image.Resampling.LANCZOS)
        x = (index % cols) * cell_w + 20
        y = (index // cols) * cell_h + 10
        out.paste(thumb, (x, y))
        draw.text((x, y + 184), path.name, fill=(80, 70, 60))
    dest = STAGING / f"{args.set_name}-contact-sheet.png"
    out.save(dest)
    print(dest)


if __name__ == "__main__":
    main()
