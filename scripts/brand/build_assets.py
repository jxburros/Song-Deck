"""Rebuild Song Deck's editable artwork with Vixl 0.13.0 (no AI provider required)."""

from pathlib import Path

from vixl import Project

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "apps/studio/public"
SOURCES = ROOT / "docs/brand/vixl"


def path(name, points, fill, stroke="#59666f", width=1):
    """A tightly bounded, editable polygon or open polyline."""
    xs, ys = zip(*points)
    x, y = min(xs), min(ys)
    w, h = max(max(xs) - x, 1), max(max(ys) - y, 1)
    d = "M" + " L".join(f"{px - x} {py - y}" for px, py in points)
    if fill != "transparent":
        d += " Z"
    return {
        "type": "shape",
        "shape": "path",
        "name": name,
        "path": d,
        "x": x,
        "y": y,
        "width": w,
        "height": h,
        "fill": fill,
        "stroke": stroke,
        "stroke_width": width,
    }


def main():
    PUBLIC.joinpath("brand").mkdir(exist_ok=True)
    SOURCES.mkdir(parents=True, exist_ok=True)
    # Deliberate 5:4 crop for the studio hero; no text is baked into the artwork.
    hero = Project(1000, 800, "#0b0b0d")
    ops = [
        {"type": "gradient", "name": "graphite-atmosphere", "direction": "radial", "start": "#3a454d", "end": "#0b0b0d"}
    ]
    for i in range(12):
        ops.append(path(f"rhythm-{i}", [(40 + i * 32, 590), (520 + i * 32, 110)], "transparent", "#354048"))
    ops += [
        path("ground", [(80, 595), (560, 430), (910, 615), (450, 710)], "#101518", "#303b42"),
        path("shadow", [(270, 550), (555, 520), (830, 660), (465, 640)], "#090c0e", "#090c0e"),
        path("left-plane", [(260, 480), (600, 155), (545, 565)], "#111619", "#6d7d88"),
        path("right-plane", [(600, 155), (765, 500), (545, 565)], "#253038", "#6d7d88"),
        path("inner-plane", [(310, 457), (582, 205), (536, 540)], "#090d10", "#253138"),
        path("silver-facet", [(600, 155), (634, 350), (765, 500)], "#3a454d", "#6d7d88"),
        path("ice-edge", [(600, 155), (600, 182), (552, 561), (545, 565)], "#7eebff", "#7eebff"),
        path("base-facet", [(260, 480), (545, 565), (380, 596)], "#1e272d", "#414e57"),
    ]
    for i in range(7):
        ops.append(
            path(
                f"face-line-{i}", [(600 + i * 17, 190 + i * 35), (563 + i * 25, 540 - i * 7)], "transparent", "#46535c"
            )
        )
    hero.apply(ops)
    hero.save(SOURCES / "sound-dimension.vixl")
    hero.export(PUBLIC / "brand/sound-dimension.svg", svg_policy="strict")
    hero.export(SOURCES / "sound-dimension.png", scale=0.8)
    print("Hero checks:", hero.check())

    # Three angular stacked decks retain the music-card idea of Song Deck's original mark.
    icon = Project(512, 512, "#0b0b0d")
    icon.apply(
        [
            path("back-deck", [(112, 162), (326, 112), (400, 290), (184, 342)], "#3a3f45", "#63717c", 3),
            path("middle-deck", [(124, 192), (351, 159), (377, 354), (148, 386)], "#e8ecef", "#0b0b0d", 5),
            path("front-deck", [(150, 220), (368, 220), (368, 398), (342, 422), (150, 422)], "#7eebff", "#0b0b0d", 6),
            path(
                "waveform",
                [(182, 323), (210, 323), (231, 268), (256, 375), (283, 288), (304, 323), (338, 323)],
                "transparent",
                "#0b0b0d",
                12,
            ),
        ]
    )
    icon.save(SOURCES / "song-deck-icon.vixl")
    icon.export(PUBLIC / "favicon.svg", svg_policy="strict")
    for name, size in [
        ("favicon-32.png", 32),
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("icon-maskable-512.png", 512),
    ]:
        icon.export(PUBLIC / name, scale=size / 512)
    print("Icon checks:", icon.check())


if __name__ == "__main__":
    main()
