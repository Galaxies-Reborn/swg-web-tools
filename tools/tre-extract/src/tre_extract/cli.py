"""Command line interface for the TRE → glTF pipeline."""

from __future__ import annotations

import argparse
import fnmatch
import re
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

from .convert import Converter, ConvertOptions, Timer, asset_key
from .formats.texture import TextureOptions
from .iff import parse
from .manifest import Manifest, ManifestEntry, display_name
from .preview import PreviewError, animation_strip, check_normals, contact_sheet, render
from .strings import DEFAULT_TABLES, available_locales, build_bundle, tables_from_template_index
from .templates import build_index, load_converted_keys, referenced_string_tables
from .vfs import build_vfs

DEFAULT_PRESETS = {
    # Sized for a viewer that shows one object at a time on a desktop page.
    "web": TextureOptions(max_size=1024, quality=82),
    # For thumbnails and mobile: a quarter of the pixels, half the bytes.
    "compact": TextureOptions(max_size=512, quality=76),
    # For inspection work where texel detail matters.
    "high": TextureOptions(max_size=2048, quality=90),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tre-extract",
        description="Convert Star Wars Galaxies TRE assets into glTF for the web",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    _add_source_args(

        sub.add_parser("list", help="list mounted asset paths")

    )
    listing = sub.choices["list"]
    listing.add_argument("--prefix", default="", help="only paths starting with this")
    listing.add_argument("--suffix", default="", help="only paths ending with this")
    listing.add_argument("--limit", type=int, default=50)

    _add_source_args(

        sub.add_parser("extract", help="write raw files out of the archives")

    )
    extract = sub.choices["extract"]
    extract.add_argument("pattern", help="glob over asset paths, e.g. 'appearance/mesh/frn_*'")
    extract.add_argument("--out", required=True, type=Path)

    _add_source_args(

        sub.add_parser("inspect", help="dump one asset's IFF tree")

    )
    inspect = sub.choices["inspect"]
    inspect.add_argument("path")
    inspect.add_argument("--depth", type=int, default=6)

    _add_source_args(

        sub.add_parser("resolve", help="show what an appearance resolves to")

    )
    resolve = sub.choices["resolve"]
    resolve.add_argument("appearance")

    _add_source_args(

        sub.add_parser("convert", help="convert appearances to GLB + manifest")

    )
    convert = sub.choices["convert"]
    convert.add_argument("--out", required=True, type=Path, help="output asset root")
    convert.add_argument(
        "--pattern",
        action="append",
        default=None,
        help=(
            "glob over appearance paths; repeatable. Defaults to the appearance "
            "entry points (.apt/.lod/.lmg), which resolve to the highest LOD"
        ),
    )
    convert.add_argument(
        "--include-lod-meshes",
        action="store_true",
        help=(
            "also convert `.msh` files reachable only through a LOD parent. Off by "
            "default: converting them produces one model per detail level, so a "
            "single bed shows up five times"
        ),
    )
    convert.add_argument(
        "--animation",
        action="append",
        default=None,
        help=(
            "glob over .ans paths to attach as animation clips; repeatable. "
            "Only clips whose bones match a model's skeleton are used"
        ),
    )
    convert.add_argument(
        "--animation-coverage",
        type=float,
        default=0.5,
        help=(
            "minimum clip/skeleton correspondence, measured in both directions "
            "(default 0.5); raise it to reject near-miss species"
        ),
    )
    convert.add_argument(
        "--animation-limit",
        type=int,
        default=6,
        help=(
            "most clips to bake into one model, 0 for no cap (default 6). "
            "Clips are not shared between GLBs, so each is paid for per asset"
        ),
    )
    convert.add_argument("--preset", choices=sorted(DEFAULT_PRESETS), default="web")
    convert.add_argument("--limit", type=int, default=0, help="stop after N assets (0 = all)")
    convert.add_argument("--no-textures", action="store_true")
    convert.add_argument("--force", action="store_true", help="rewrite assets that already exist")
    convert.add_argument(
        "--max-triangles",
        type=int,
        default=0,
        help="skip assets above this triangle count (0 = no limit)",
    )

    _add_source_args(

        sub.add_parser("strings", help="extract string tables the web tier resolves names with")

    )
    strings = sub.choices["strings"]
    strings.add_argument("--out", required=True, type=Path, help="output JSON path")
    strings.add_argument("--locale", default="en")
    strings.add_argument(
        "--table",
        action="append",
        default=None,
        help="table to include; repeatable. Defaults to the set the live database references",
    )
    strings.add_argument(
        "--from-templates",
        type=Path,
        default=None,
        help="a templates.json; include exactly the tables those templates reference",
    )
    strings.add_argument(
        "--all",
        action="store_true",
        help="include every table in the locale (~300k strings; far more than the app needs)",
    )

    _add_source_args(

        sub.add_parser("templates", help="index shared templates: appearance, name, and category")

    )
    templates = sub.choices["templates"]
    templates.add_argument("--out", required=True, type=Path, help="output JSON path")
    templates.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="a conversion manifest, so entries only link to models that exist",
    )
    templates.add_argument(
        "--print-tables",
        action="store_true",
        help="list the string tables the indexed templates reference, for the strings command",
    )

    preview = sub.add_parser(
        "preview", help="render converted models to a PNG, to check they look right"
    )
    preview.add_argument("models", nargs="+", help="paths to .glb files")
    preview.add_argument("--out", required=True, type=Path)
    preview.add_argument("--size", type=int, default=384)
    preview.add_argument("--columns", type=int, default=4)
    preview.add_argument("--quiet", action="store_true")
    preview.add_argument(
        "--animation",
        default=None,
        help="clip name to pose the first model with, sampled across its length",
    )
    preview.add_argument(
        "--animation-frames",
        type=int,
        default=6,
        help="samples to take across the clip (default 6)",
    )

    preview.add_argument(
        "--check-normals",
        action="store_true",
        help=(
            "also report winding/normal agreement, which catches a "
            "half-applied handedness conversion"
        ),
    )

    _add_source_args(

        sub.add_parser("terrain", help="bake a square of ground around a world coordinate")

    )
    terrain = sub.choices["terrain"]
    terrain.add_argument("--planet", required=True, help="scene name, e.g. tatooine")
    terrain.add_argument(
        "--centre",
        default="0,0",
        help=(
            "world X,Z to centre on. A waypoint reads '/way <planet> X Y Z', so pass "
            "the first and third numbers -- the middle one is height, which is what "
            "this computes"
        ),
    )
    terrain.add_argument(
        "--span",
        type=float,
        default=900.0,
        help="side length in metres (default 900, which covers the largest city radius)",
    )
    terrain.add_argument(
        "--spacing",
        type=float,
        default=8.0,
        help=(
            "metres between samples (default 8, the size of a terrain chunk and of a "
            "lot). Halving this quadruples the time"
        ),
    )
    terrain.add_argument("--out", required=True, type=Path, help="directory to write the tile into")
    terrain.add_argument(
        "--planet-wide",
        action="store_true",
        help=(
            "bake the WHOLE planet into tiles plus an overview, ignoring --centre "
            "and --span. 2048x2048 samples at the default spacing"
        ),
    )
    terrain.add_argument(
        "--workers",
        type=int,
        default=None,
        help="processes for a planet-wide bake (default: every core)",
    )
    terrain.add_argument(
        "--overview-spacing",
        type=float,
        default=32.0,
        help="metres per sample in the whole-planet overview (default 32)",
    )

    _add_source_args(

        sub.add_parser("blockers", help="export the static world objects a city must avoid")

    )
    blockers = sub.choices["blockers"]
    blockers.add_argument(
        "--planet",
        action="append",
        default=None,
        help="scene name; repeatable. Defaults to every planet with a snapshot",
    )
    blockers.add_argument(
        "--out",
        required=True,
        type=Path,
        help="directory to write <planet>.json into",
    )
    blockers.add_argument(
        "--assets",
        required=True,
        type=Path,
        help="converted asset root, for templates.json and manifest.json",
    )

    _add_source_args(

        sub.add_parser("props", help="export placeable decorations with their colliders")

    )
    props = sub.choices["props"]
    props.add_argument("--out", required=True, type=Path, help="JSON file to write")
    props.add_argument(
        "--assets",
        required=True,
        type=Path,
        help="converted asset root, for templates.json and manifest.json",
    )

    args = parser.parse_args(argv)
    handler = {
        "list": _cmd_list,
        "extract": _cmd_extract,
        "inspect": _cmd_inspect,
        "resolve": _cmd_resolve,
        "convert": _cmd_convert,
        "strings": _cmd_strings,
        "templates": _cmd_templates,
        "preview": _cmd_preview,
        "terrain": _cmd_terrain,
        "blockers": _cmd_blockers,
        "props": _cmd_props,
    }[args.command]
    return handler(args)


def _stem(path: str) -> str:
    return path.rsplit("/", 1)[-1].rsplit(".", 1)[0]


def _add_source_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--tre-dir",
        type=Path,
        help="directory holding the client's .tre archives",
    )
    parser.add_argument(
        "--loose",
        action="append",
        default=[],
        type=Path,
        help="loose asset directory mounted above the archives; repeatable",
    )
    parser.add_argument("--quiet", action="store_true")


def _open_vfs(args: argparse.Namespace):
    if not args.tre_dir and not args.loose:
        print("error: pass --tre-dir and/or --loose", file=sys.stderr)
        raise SystemExit(2)
    vfs = build_vfs(args.tre_dir, loose_dirs=args.loose)
    if not args.quiet:
        for line in vfs.describe()[:6]:
            print(f"  mounted {line}")
        extra = len(vfs.describe()) - 6
        if extra > 0:
            print(f"  ... and {extra} more")
        print(f"  {len(vfs)} unique asset paths")
    return vfs


# ---------------------------------------------------------------------------


def _cmd_list(args: argparse.Namespace) -> int:
    with _open_vfs(args) as vfs:
        paths = sorted(vfs.paths(prefix=args.prefix, suffix=args.suffix))
        for path in paths[: args.limit]:
            print(path)
        if len(paths) > args.limit:
            print(f"... {len(paths) - args.limit} more")
    return 0


def _cmd_extract(args: argparse.Namespace) -> int:
    with _open_vfs(args) as vfs:
        matches = [p for p in vfs.paths() if fnmatch.fnmatch(p, args.pattern.lower())]
        if not matches:
            print("no matches", file=sys.stderr)
            return 1
        for path in sorted(matches):
            target = args.out / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(vfs.read(path))
        print(f"extracted {len(matches)} files to {args.out}")
    return 0


def _cmd_inspect(args: argparse.Namespace) -> int:
    with _open_vfs(args) as vfs:
        data = vfs.try_read(args.path)
        if data is None:
            print(f"{args.path} not found", file=sys.stderr)
            return 1
        root = parse(data)

        def dump(node, depth: int = 0) -> None:
            suffix = "" if node.is_form else f"  {node.data[:48]!r}"
            print("  " * depth + repr(node) + suffix)
            if depth < args.depth:
                for child in node.children:
                    dump(child, depth + 1)

        dump(root)
    return 0


def _cmd_resolve(args: argparse.Namespace) -> int:
    with _open_vfs(args) as vfs:
        converter = Converter(vfs)
        resolved = converter.resolve(args.appearance)
        print(f"kind      {resolved.kind}")
        print(f"lods      {resolved.lod_count}")
        print("chain     " + "\n          ".join(resolved.chain))
        print("meshes    " + ("\n          ".join(resolved.meshes) or "(none)"))
        if resolved.skinned:
            print("skinned   " + "\n          ".join(resolved.skinned))
    return 0


#: Appearance entry points. Each resolves through the LOD graph to the single
#: highest-detail mesh, which is the one the viewer wants.
DEFAULT_PATTERNS = (
    "appearance/*.apt",
    "appearance/lod/*.lod",
    "appearance/mesh/*.lmg",
    "appearance/*.cmp",
    # Skeletal appearances: every wearable and every creature is referenced
    # through one of these, so omitting them leaves clothing with no model.
    "appearance/*.sat",
)

#: `_l0`, `_l3`, `_lod2` — a detail level owned by one of the entry points above.
LOD_SUFFIX = re.compile(r"_(?:l|lod)\d+$", re.IGNORECASE)


def _cmd_preview(args: argparse.Namespace) -> int:
    """Rasterise models offline.

    Structural checks prove a GLB is well-formed; only looking at it catches
    geometry that parses cleanly and renders wrong.
    """
    paths = [Path(p) for p in args.models]
    missing = [p for p in paths if not p.is_file()]
    if missing:
        print(f"not found: {', '.join(str(p) for p in missing)}", file=sys.stderr)
        return 1

    args.out.parent.mkdir(parents=True, exist_ok=True)
    try:
        if args.animation is not None:
            # A rigged model that exports cleanly can still tear apart the
            # moment it is posed, because an unposed model draws bind vertices
            # and never exercises the skin. Sampling across the clip is the
            # only check that catches it.
            image = animation_strip(
                paths[0],
                args.animation,
                cell=args.size,
                frames=args.animation_frames,
            )
        elif len(paths) == 1:
            image = render(paths[0], size=args.size)
        else:
            image = contact_sheet(paths, cell=args.size, columns=args.columns)
    except PreviewError as exc:
        print(f"could not render: {exc}", file=sys.stderr)
        return 1

    image.save(args.out)
    if not args.quiet:
        print(f"{len(paths)} model(s) -> {args.out} ({image.width}x{image.height})")

    if args.check_normals:
        worst = 1.0
        for model in paths:
            agreeing, total = check_normals(model)
            ratio = agreeing / total if total else 1.0
            worst = min(worst, ratio)
            print(f"  {model.name:<34} {agreeing}/{total} triangles agree ({ratio:.1%})")
        if worst < 0.95:
            print(
                "  ! winding and normals disagree; check the handedness conversion",
                file=sys.stderr,
            )
            return 1
    return 0


def _cmd_templates(args: argparse.Namespace) -> int:
    with _open_vfs(args) as vfs:
        converted = load_converted_keys(args.manifest) if args.manifest else None
        if args.manifest and converted is None:
            print(f"could not read manifest {args.manifest}", file=sys.stderr)
            return 1

        timer = Timer()

        def report(done: int, total: int) -> None:
            if not args.quiet:
                print(f"  {done}/{total}  {timer.rate(done):.0f}/s")

        index, warnings = build_index(vfs, converted_keys=converted, progress=report)

        args.out.parent.mkdir(parents=True, exist_ok=True)
        index.write(args.out)

        print(
            f"{len(index.entries):,} templates indexed "
            f"({index.with_models:,} with models, {index.with_names:,} with names) "
            f"in {timer.elapsed():.1f}s -> {args.out}"
        )
        if args.print_tables:
            tables = referenced_string_tables(index)
            print(f"  string tables referenced ({len(tables)}):")
            print("    " + " ".join(tables))
        for warning in warnings:
            print(f"  ! {warning}", file=sys.stderr)
    return 0


def _cmd_strings(args: argparse.Namespace) -> int:
    with _open_vfs(args) as vfs:
        locales = available_locales(vfs)
        if args.locale not in locales:
            print(
                f"locale {args.locale!r} not found; available: {', '.join(locales) or '(none)'}",
                file=sys.stderr,
            )
            return 1

        tables: tuple[str, ...] | None = tuple(args.table) if args.table else None
        if args.from_templates:
            discovered = tables_from_template_index(args.from_templates)
            if discovered is None:
                print(f"could not read template index {args.from_templates}", file=sys.stderr)
                return 1
            # Union with the defaults so the dashboards' own vocabulary
            # (resources, skills, attributes) survives even though no object
            # template references those tables.
            tables = tuple(sorted(set(discovered) | set(DEFAULT_TABLES)))
            if not args.quiet:
                print(f"  {len(tables)} tables from {args.from_templates.name}")

        bundle, warnings = build_bundle(
            vfs,
            locale=args.locale,
            tables=tables,
            include_all=args.all,
        )

        args.out.parent.mkdir(parents=True, exist_ok=True)
        bundle.write(args.out)

        print(
            f"{bundle.entry_count:,} strings across {len(bundle.tables)} tables "
            f"({args.locale}) -> {args.out}"
        )
        if not args.quiet:
            for name, entries in sorted(bundle.tables.items(), key=lambda kv: -len(kv[1]))[:8]:
                print(f"  {len(entries):>6}  {name}")
        for warning in warnings:
            print(f"  ! {warning}", file=sys.stderr)
    return 0


def _cmd_convert(args: argparse.Namespace) -> int:
    patterns = args.pattern or list(DEFAULT_PATTERNS)
    options = ConvertOptions(
        textures=DEFAULT_PRESETS[args.preset],
        include_textures=not args.no_textures,
        animation_coverage=args.animation_coverage,
        animation_limit=args.animation_limit,
    )

    models_dir = args.out / "models"
    models_dir.mkdir(parents=True, exist_ok=True)

    with _open_vfs(args) as vfs:
        candidates = sorted(
            {p for p in vfs.paths() if any(fnmatch.fnmatch(p, pat.lower()) for pat in patterns)}
        )
        if not args.include_lod_meshes:
            before = len(candidates)
            candidates = [p for p in candidates if not LOD_SUFFIX.search(_stem(p))]
            dropped = before - len(candidates)
            if dropped and not args.quiet:
                print(f"  skipping {dropped} LOD-level meshes (--include-lod-meshes to keep them)")

        if args.limit:
            candidates = candidates[: args.limit]
        if not candidates:
            print("no appearances matched", file=sys.stderr)
            return 1

        if args.animation:
            clips = sorted(
                {
                    p
                    for p in vfs.paths(suffix=".ans")
                    if any(fnmatch.fnmatch(p, pat.lower()) for pat in args.animation)
                }
            )
            options.animations = tuple(clips)
            if not args.quiet:
                print(f"  {len(clips)} animation clips available to attach")

        print(f"converting {len(candidates)} appearances at preset '{args.preset}'")
        converter = Converter(vfs, options)
        manifest = Manifest(
            generatedAt=datetime.now(UTC).isoformat(),
            generator="tre-extract",
            sourceLabel=str(args.tre_dir or args.loose),
        )

        timer = Timer()
        skipped = failed = 0
        for index, appearance in enumerate(candidates, start=1):
            # Skip before converting, not after writing. Converting and then
            # declining to write left the manifest describing bytes that were
            # never put on disk -- new clip names and a new size against an old
            # GLB. merge_existing carries the previous row forward instead,
            # which is what actually matches the file.
            if not args.force and (models_dir / f"{asset_key(appearance)}.glb").exists():
                skipped += 1
                continue

            try:
                result = converter.convert(appearance)
            except Exception as exc:
                failed += 1
                if not args.quiet:
                    print(f"  ! {appearance}: {exc}")
                continue

            if result is None:
                skipped += 1
                continue
            if args.max_triangles and result.triangles > args.max_triangles:
                skipped += 1
                continue

            model_path = models_dir / f"{result.key}.glb"
            model_path.parent.mkdir(parents=True, exist_ok=True)
            model_path.write_bytes(result.glb)

            if result.pattern_files:
                pattern_dir = args.out / "patterns"
                pattern_dir.mkdir(parents=True, exist_ok=True)
                for filename, blob in result.pattern_files.items():
                    (pattern_dir / filename).write_bytes(blob)

            manifest.entries.append(
                ManifestEntry(
                    key=result.key,
                    name=display_name(result.key),
                    kind=result.kind,
                    model=f"models/{result.key}.glb",
                    bounds={"min": result.bounds_min, "max": result.bounds_max},
                    triangles=result.triangles,
                    vertices=result.vertices,
                    lodCount=result.lod_count,
                    materials=result.materials,
                    textures=result.textures,
                    sizeBytes=len(result.glb),
                    animations=result.animations,
                    hardpoints=result.hardpoints,
                    hue=result.hue,
                    pattern=result.pattern,
                    warnings=result.warnings,
                )
            )

            if not args.quiet and index % 200 == 0:
                print(
                    f"  {index}/{len(candidates)}  "
                    f"{timer.rate(index):.1f}/s  "
                    f"{len(manifest.entries)} written, {skipped} empty, {failed} failed"
                )

        manifest_path = args.out / "manifest.json"
        # Carry forward anything a previous run produced, so converting one
        # category does not unpublish all the others.
        carried = manifest.merge_existing(manifest_path)
        manifest.write(manifest_path)
        _write_palettes(vfs, converter, manifest_path)

        total_bytes = sum(e.sizeBytes for e in manifest.entries)
        converted = len(manifest.entries) - carried
        if converter.stats.get("animations"):
            print(f"  attached {converter.stats['animations']} animation clips")
        print(
            f"done in {timer.elapsed():.1f}s: "
            f"{converted} converted, {skipped} without geometry, {failed} failed"
            + (f", {carried} carried over from earlier runs" if carried else "")
        )
        print(f"  {total_bytes / 1_048_576:.1f} MB of models -> {models_dir}")
        print(f"  manifest -> {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def _write_palettes(vfs, converter, manifest_path) -> None:
    """Write palettes.json beside the manifest.

    A palette is a RIFF `PAL ` file: a uint16 entry count at offset 22, then
    four bytes per entry, RGB and a pad. They are tiny -- 64 colours, 280 bytes
    -- and there are only a handful, so they are inlined as hex rather than
    copied as files.
    """
    import json as _json
    from pathlib import Path

    palettes: dict[str, list[str]] = {}
    for name in sorted(getattr(converter, "_palettes_seen", set())):
        raw = vfs.try_read(name)
        if not raw or len(raw) < 24:
            continue
        count = int.from_bytes(raw[22:24], "little")
        colours = []
        for i in range(count):
            offset = 24 + i * 4
            if offset + 3 > len(raw):
                break
            r, g, b = raw[offset], raw[offset + 1], raw[offset + 2]
            colours.append(f"#{r:02x}{g:02x}{b:02x}")
        if colours:
            palettes[name] = colours

    target = Path(manifest_path).with_name("palettes.json")

    # Merged, not replaced. A narrow run only sees the palettes its own
    # appearances reference, and writing just those would unpublish every
    # palette an earlier run found -- the same way the manifest would lose
    # entries without merge_existing.
    try:
        existing = _json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        existing = {}
    if isinstance(existing, dict):
        merged = {**existing, **palettes}
    else:
        merged = palettes

    if not merged:
        return
    target.write_text(_json.dumps(merged, indent=2), encoding="utf-8")
    print(f"  {len(merged)} palettes -> {target} ({len(palettes)} this run)")


def _cmd_terrain(args: argparse.Namespace) -> int:
    """Bake height, water and buildability for one square of ground."""
    from .formats.terrain import Terrain
    from .terrain_bake import bake, write_tile

    try:
        centre_x, centre_z = (float(part) for part in args.centre.split(","))
    except ValueError:
        print("error: --centre wants X,Z, e.g. --centre 3528,-4804", file=sys.stderr)
        return 2

    vfs = _open_vfs(args)
    path = f"terrain/{args.planet}.trn"
    try:
        data = vfs.read(path)
    except Exception:
        print(f"error: no {path} in the mounted archives", file=sys.stderr)
        return 2

    if args.planet_wide:
        from .terrain_planet import bake_planet

        def planet_progress(done: int, total: int) -> None:
            if args.quiet or done % max(1, total // 20):
                return
            print("  " + str(100 * done // total) + "%", end=chr(13), flush=True)

        started = time.time()
        bake = bake_planet(
            data,
            args.planet,
            args.out,
            spacing=args.spacing,
            overview_spacing=args.overview_spacing,
            workers=args.workers,
            progress=planet_progress,
        )
        if not args.quiet:
            print(
                "done in " + format(time.time() - started, ".1f") + "s: "
                + str(bake.samples) + "x" + str(bake.samples) + " samples in "
                + str(bake.tiles * bake.tiles) + " tiles, height "
                + format(bake.min_height, ".1f") + ".." + format(bake.max_height, ".1f") + " m"
            )
            print("  " + str(args.out / args.planet))
        return 0

    terrain = Terrain(data)
    samples = round(args.span / args.spacing) + 1
    if not args.quiet:
        print(
            f"baking {args.planet} around ({centre_x:.0f}, {centre_z:.0f}): "
            f"{args.span:.0f} m at {args.spacing:.0f} m = {samples}x{samples} samples"
        )

    def progress(done: int, total: int) -> None:
        if args.quiet or done % max(1, total // 10):
            return
        print(f"  {100 * done // total}%", end=chr(13), flush=True)

    started = time.time()
    tile, heights, flags = bake(
        terrain,
        args.planet,
        centre_x,
        centre_z,
        args.span,
        args.spacing,
        progress=progress,
    )
    out = write_tile(args.out, tile, heights, flags)

    if not args.quiet:
        water = sum(1 for b in flags if b & 0x01)
        print(
            f"done in {time.time() - started:.1f}s: "
            f"height {tile.min_height:.1f}..{tile.max_height:.1f} m, "
            f"{100 * water / len(flags):.1f}% water"
        )
        print(f"  {out}")
    return 0


#: Planets with a world snapshot. Listed rather than globbed so a missing one is
#: a visible failure rather than a quietly shorter run.
_SNAPSHOT_PLANETS = (
    "tatooine", "naboo", "corellia", "rori", "talus",
    "dantooine", "dathomir", "endor", "lok", "yavin4",
)


def _cmd_blockers(args: argparse.Namespace) -> int:
    """Reduce each planet's snapshot to the objects a city has to build around."""
    from .blockers import collect, load_indexes, write

    vfs = _open_vfs(args)
    try:
        templates, bounds = load_indexes(args.assets)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        print("  --assets must point at a converted asset root", file=sys.stderr)
        return 2

    planets = args.planet or list(_SNAPSHOT_PLANETS)
    total = 0
    for planet in planets:
        path = f"snapshot/{planet}.ws"
        try:
            data = vfs.read(path)
        except Exception:
            print(f"  {planet}: no {path}", file=sys.stderr)
            continue

        found, counts = collect(data, templates, bounds)
        out = write(args.out, planet, found)
        total += len(found)
        if not args.quiet:
            print(
                f"  {planet:10} {len(found):5} blockers"
                f"  (from {counts['outdoors']} outdoors:"
                f" {counts['too_small']} too small,"
                f" {counts['no_model']} no model,"
                f" {counts['unresolved']} unresolved)"
                f"  -> {out.name} {out.stat().st_size // 1024} KB"
            )
    if not args.quiet:
        print(f"{total} blockers across {len(planets)} planets")
    return 0


def _cmd_props(args: argparse.Namespace) -> int:
    """Export the decorations a player can place, with the room each takes up."""
    from .blockers import load_indexes
    from .props import collect, write

    vfs = _open_vfs(args)
    try:
        templates, bounds = load_indexes(args.assets)
    except FileNotFoundError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    found, counts = collect(vfs, templates, bounds)
    out = write(args.out, found)
    if not args.quiet:
        colliding = sum(1 for p in found if p.collides)
        print(
            f"  {len(found)} props from {counts['candidates']} templates"
            f"  ({counts['collision_extent']} with a real collision extent,"
            f" {counts['render_bounds']} using render bounds,"
            f" {counts['no_model']} with no model)"
        )
        print(f"  {colliding} take part in collision; the rest are ornaments")
        print(f"  -> {out} ({out.stat().st_size // 1024} KB)")
    return 0
