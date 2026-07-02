from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
STAGING = ROOT / "gift-assets-staging"
APP_ASSETS = ROOT / "desktop" / "src" / "assets" / "xingye-gifts"

TARGETS = {
    "modern": ["09-plush-bear.png", "10-earphones.png"],
    "cn_ancient": None,
    "republican": None,
    "west_medieval": None,
    "wuxia": None,
    "xianxia": None,
}


def sync_one(set_name: str, file_name: str) -> None:
    src = STAGING / set_name / file_name
    dst = APP_ASSETS / set_name / file_name
    if not src.exists():
        raise FileNotFoundError(src)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = im.convert("RGBA")
        im = im.resize((512, 512), Image.Resampling.LANCZOS)
        im.save(dst, "PNG", optimize=True)
    print(f"synced {set_name}/{file_name}")


def main() -> None:
    count = 0
    for set_name, names in TARGETS.items():
        if names is None:
            names = sorted(p.name for p in (STAGING / set_name).glob("*.png") if not p.name.endswith("-v2.png"))
        for name in names:
            sync_one(set_name, name)
            count += 1
    print(f"done: {count} files")


if __name__ == "__main__":
    main()
