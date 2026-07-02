import argparse
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
GENERATED_DIR = Path(r"D:\18133\.codex\generated_images\019f01e2-a69c-7873-bcba-c07d6c21194d")
STAGING = ROOT / "gift-assets-staging"
APP_ASSETS = ROOT / "desktop" / "src" / "assets" / "xingye-gifts"


def latest_generated() -> Path:
    files = [p for p in GENERATED_DIR.glob("*.png") if p.is_file()]
    if not files:
        raise FileNotFoundError(f"no generated PNG files in {GENERATED_DIR}")
    return max(files, key=lambda p: p.stat().st_mtime)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("set_name")
    parser.add_argument("file_name")
    args = parser.parse_args()

    src = latest_generated()
    staging_dst = STAGING / args.set_name / args.file_name
    app_dst = APP_ASSETS / args.set_name / args.file_name
    staging_dst.parent.mkdir(parents=True, exist_ok=True)
    app_dst.parent.mkdir(parents=True, exist_ok=True)

    with Image.open(src) as im:
        im = im.convert("RGBA")
        im.save(staging_dst, "PNG", optimize=True)
        im.resize((512, 512), Image.Resampling.LANCZOS).save(app_dst, "PNG", optimize=True)

    print(f"imported {src}")
    print(f"staging {staging_dst}")
    print(f"app {app_dst}")


if __name__ == "__main__":
    main()
