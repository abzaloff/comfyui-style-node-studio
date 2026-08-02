import json
import math
import os
import re
import shutil
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse

from aiohttp import web
import server


BASE_DIR = Path(__file__).resolve().parent
STYLES_DIR = BASE_DIR / "styles"
STYLES_DIR.mkdir(parents=True, exist_ok=True)
FAVORITES_PATH = BASE_DIR / "favorites.json"
FAVORITES_CATEGORY = "Favs"

WEB_DIRECTORY = "./web"

MAX_CATEGORY_LENGTH = 100
MAX_NAME_LENGTH = 200
MAX_PROMPT_LENGTH = 100_000
MAX_THUMBNAIL_LENGTH = 8_000_000
MAX_THUMBNAIL_BYTES = 12 * 1024 * 1024
INVALID_CATEGORY_CHARS = set('<>:"/\\|?*')
THUMBNAIL_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


class StyleDataError(ValueError):
    pass


def _clean_text(value, field, max_length, *, required=False):
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise StyleDataError(f"{field} must be a string")
    value = value.strip() if required else value
    if required and not value:
        raise StyleDataError(f"{field} is required")
    if len(value) > max_length:
        raise StyleDataError(f"{field} is too long")
    return value


def _clean_category(value):
    value = _clean_text(value, "category", MAX_CATEGORY_LENGTH, required=True)
    if value in {".", ".."} or value.endswith((" ", ".")):
        raise StyleDataError("category contains an invalid path segment")
    if any(char in INVALID_CATEGORY_CHARS or ord(char) < 32 for char in value):
        raise StyleDataError("category contains invalid filename characters")
    return value


def _category_path(category):
    category = _clean_category(category)
    path = (STYLES_DIR / f"{category}.json").resolve()
    try:
        path.relative_to(STYLES_DIR.resolve())
    except ValueError as exc:
        raise StyleDataError("category points outside the styles directory") from exc
    return path


def _ensure_real_category(category):
    if category.casefold() == FAVORITES_CATEGORY.casefold():
        raise StyleDataError(f"{FAVORITES_CATEGORY} is a virtual category")
    return category


def _validate_style(value):
    if not isinstance(value, dict):
        raise StyleDataError("style must be an object")
    return {
        "name": _clean_text(value.get("name"), "style.name", MAX_NAME_LENGTH, required=True),
        "prompt": _clean_text(value.get("prompt", ""), "style.prompt", MAX_PROMPT_LENGTH),
        "negative_prompt": _clean_text(
            value.get("negative_prompt", ""),
            "style.negative_prompt",
            MAX_PROMPT_LENGTH,
        ),
        "thumbnail": _clean_text(
            value.get("thumbnail", ""),
            "style.thumbnail",
            MAX_THUMBNAIL_LENGTH,
        ),
    }


def _load_styles(path):
    if not path.exists():
        return []
    # Third-party style packs are often saved by Windows tools that prepend a
    # UTF-8 BOM. ``utf-8-sig`` accepts both BOM and regular UTF-8 files.
    with path.open("r", encoding="utf-8-sig") as file:
        styles = json.load(file)
    if not isinstance(styles, list):
        raise StyleDataError(f"{path.name} must contain a JSON array")
    if not all(isinstance(style, dict) for style in styles):
        raise StyleDataError(f"{path.name} contains a non-object style")
    return styles


def _write_styles(path, styles):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.stem}.",
            suffix=".tmp",
            delete=False,
        ) as file:
            temp_name = file.name
            json.dump(styles, file, ensure_ascii=False, indent=2)
            file.write("\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def _load_favorites():
    favorites = _load_styles(FAVORITES_PATH)
    result = []
    seen = set()
    for item in favorites:
        category = _clean_category(item.get("category"))
        _ensure_real_category(category)
        name = _clean_text(
            item.get("name"), "favorite.name", MAX_NAME_LENGTH, required=True
        )
        key = (category, name)
        if key not in seen:
            seen.add(key)
            result.append({"category": category, "name": name})
    return result


def _write_favorites(favorites):
    _write_styles(FAVORITES_PATH, favorites)


def _move_favorite(original_category, original_name, category, name):
    if not original_category or not original_name:
        return
    source_key = (original_category, original_name)
    target_key = (category, name)
    if source_key == target_key:
        return
    favorites = _load_favorites()
    was_favorite = any(
        (item["category"], item["name"]) == source_key for item in favorites
    )
    updated = [
        item
        for item in favorites
        if (item["category"], item["name"]) != source_key
    ]
    if was_favorite and not any(
        (item["category"], item["name"]) == target_key for item in updated
    ):
        updated.append({"category": category, "name": name})
    if updated != favorites:
        _write_favorites(updated)


def _remove_favorites(*, category, name=None):
    favorites = _load_favorites()
    updated = [
        item
        for item in favorites
        if not (
            item["category"] == category
            and (name is None or item["name"] == name)
        )
    ]
    if updated != favorites:
        _write_favorites(updated)


def _write_bytes(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_name = None
    try:
        with tempfile.NamedTemporaryFile(
            "wb",
            dir=path.parent,
            prefix=f".{path.stem}.",
            suffix=".tmp",
            delete=False,
        ) as file:
            temp_name = file.name
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp_name, path)
    finally:
        if temp_name and os.path.exists(temp_name):
            os.unlink(temp_name)


def _safe_asset_stem(name):
    name = _clean_text(name, "style.name", MAX_NAME_LENGTH, required=True)
    stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip(" .")
    stem = re.sub(r"\s+", " ", stem)[:120].rstrip(" .")
    if not stem:
        raise StyleDataError("style.name cannot be converted to a filename")
    return stem


def _category_asset_dir(category):
    category = _clean_category(category)
    path = (STYLES_DIR / category).resolve()
    try:
        path.relative_to(STYLES_DIR.resolve())
    except ValueError as exc:
        raise StyleDataError("thumbnail directory points outside styles") from exc
    return path


def _thumbnail_url(category, filename, version=None):
    query = {"category": category, "filename": filename}
    if version is not None:
        query["v"] = str(version)
    return f"/style_node_studio/api/thumbnail?{urlencode(query)}"


def _managed_thumbnail_path(value):
    if not isinstance(value, str) or not value:
        return None
    parsed = urlparse(value)
    if parsed.path != "/style_node_studio/api/thumbnail":
        return None
    query = parse_qs(parsed.query)
    category = query.get("category", [None])[0]
    filename = query.get("filename", [None])[0]
    if not category or not filename or Path(filename).name != filename:
        return None
    extension = Path(filename).suffix.lower()
    if extension not in set(THUMBNAIL_EXTENSIONS.values()):
        return None
    try:
        directory = _category_asset_dir(category)
        path = (directory / filename).resolve()
        path.relative_to(directory)
    except (StyleDataError, ValueError):
        return None
    return path


def _delete_managed_thumbnail(value):
    path = _managed_thumbnail_path(value)
    if not path or not path.exists():
        return
    path.unlink()
    try:
        path.parent.rmdir()
    except OSError:
        pass


def _apply_strength(text, strength):
    text = text.strip()
    if not text or math.isclose(strength, 0.0, abs_tol=1e-9):
        return ""
    if math.isclose(strength, 1.0, abs_tol=1e-9):
        return text
    return f"({text}:{strength:.2f})"


def _join_prompt(left, right):
    left = left.strip(" ,")
    right = right.strip(" ,")
    if left and right:
        return f"{left}, {right}"
    return left or right


def _parse_selected_styles(value):
    if not isinstance(value, str) or not value.strip():
        return []
    value = value.strip()
    if value.startswith("["):
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            decoded = None
        if isinstance(decoded, list):
            result = []
            for item in decoded:
                if isinstance(item, dict):
                    category = item.get("category")
                    name = item.get("name")
                    if isinstance(category, str) and isinstance(name, str):
                        result.append((category, name))
                elif isinstance(item, str) and item.strip():
                    result.append(item.strip())
            return result
    # Compatibility with the original comma-separated workflow format.
    return [item.strip() for item in value.split(",") if item.strip()]


class StyleNodeStudio:
    """Visual style-preset library for ComfyUI prompt strings."""

    @classmethod
    def INPUT_TYPES(cls):
        # category is retained as a hidden legacy widget in the frontend so old
        # workflows continue to load. Filtering is handled by the gallery.
        categories = ["All Categories"]
        for path in sorted(STYLES_DIR.glob("*.json")):
            if path.stem.casefold() == FAVORITES_CATEGORY.casefold():
                continue
            categories.append(path.stem)

        return {
            "required": {
                "category": (categories, {"default": "All Categories"}),
                "style_strength": (
                    "FLOAT",
                    {"default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05},
                ),
                "inject_mode": (
                    ["template", "append", "prepend"],
                    {"default": "template"},
                ),
            },
            "optional": {
                "positive": (
                    "STRING",
                    {"forceInput": True, "multiline": True, "default": ""},
                ),
                "negative": (
                    "STRING",
                    {"forceInput": True, "multiline": True, "default": ""},
                ),
                "selected_styles": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    FUNCTION = "process_style"
    CATEGORY = "Style Node Studio"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Style files can change without workflow inputs changing.
        return float("nan")

    def process_style(
        self,
        category,
        style_strength,
        inject_mode,
        positive="",
        negative="",
        selected_styles="",
    ):
        del category  # Kept only for backward-compatible workflow loading.

        selected_items = _parse_selected_styles(selected_styles)
        if not selected_items or math.isclose(style_strength, 0.0, abs_tol=1e-9):
            return (positive or "", negative or "")

        all_styles = {}
        for path in STYLES_DIR.glob("*.json"):
            try:
                all_styles[path.stem] = _load_styles(path)
            except (OSError, json.JSONDecodeError, StyleDataError) as exc:
                print(f"[Style Node Studio] Cannot read {path.name}: {exc}")

        out_pos = positive or ""
        out_neg = negative or ""

        for selected_item in selected_items:
            target_item = None
            if isinstance(selected_item, tuple):
                category_name, style_name = selected_item
                target_item = next(
                    (
                        item
                        for item in all_styles.get(category_name, [])
                        if item.get("name") == style_name
                    ),
                    None,
                )
            elif " / " in selected_item:
                category_name, style_name = selected_item.split(" / ", 1)
                target_item = next(
                    (
                        item
                        for item in all_styles.get(category_name, [])
                        if item.get("name") == style_name
                    ),
                    None,
                )
            else:
                for category_styles in all_styles.values():
                    target_item = next(
                        (
                            item
                            for item in category_styles
                            if item.get("name") == selected_item
                        ),
                        None,
                    )
                    if target_item:
                        break

            if not target_item:
                continue

            raw_positive = str(target_item.get("prompt", ""))
            raw_negative = str(target_item.get("negative_prompt", ""))
            style_positive = ", ".join(
                part.strip(" ,")
                for part in raw_positive.split("{prompt}")
                if part.strip(" ,")
            )
            style_positive = _apply_strength(style_positive, style_strength)
            style_negative_text = ", ".join(
                part.strip(" ,")
                for part in raw_negative.split("{prompt}")
                if part.strip(" ,")
            )
            style_negative = _apply_strength(style_negative_text, style_strength)

            if inject_mode == "prepend":
                out_pos = _join_prompt(style_positive, out_pos)
            elif inject_mode == "append":
                out_pos = _join_prompt(out_pos, style_positive)
            elif "{prompt}" in raw_positive:
                template_parts = raw_positive.split("{prompt}")
                combined_parts = []
                for index, part in enumerate(template_parts):
                    weighted_part = _apply_strength(part.strip(" ,"), style_strength)
                    if weighted_part:
                        combined_parts.append(weighted_part)
                    if index < len(template_parts) - 1 and out_pos.strip(" ,"):
                        combined_parts.append(out_pos.strip(" ,"))
                out_pos = ", ".join(combined_parts)
            else:
                out_pos = _join_prompt(out_pos, style_positive)

            if inject_mode == "prepend":
                out_neg = _join_prompt(style_negative, out_neg)
            elif inject_mode == "template" and "{prompt}" in raw_negative:
                template_parts = raw_negative.split("{prompt}")
                combined_parts = []
                for index, part in enumerate(template_parts):
                    weighted_part = _apply_strength(part.strip(" ,"), style_strength)
                    if weighted_part:
                        combined_parts.append(weighted_part)
                    if index < len(template_parts) - 1 and out_neg.strip(" ,"):
                        combined_parts.append(out_neg.strip(" ,"))
                out_neg = ", ".join(combined_parts)
            else:
                out_neg = _join_prompt(out_neg, style_negative)

        return (out_pos, out_neg)


routes = server.PromptServer.instance.routes


@routes.get("/style_node_studio/api/get_styles")
async def get_styles(request):
    del request
    result = {}
    errors = []
    for path in sorted(STYLES_DIR.glob("*.json")):
        if path.stem.casefold() == FAVORITES_CATEGORY.casefold():
            continue
        try:
            result[path.stem] = _load_styles(path)
        except (OSError, json.JSONDecodeError, StyleDataError) as exc:
            errors.append(f"{path.name}: {exc}")
    try:
        valid_styles = {
            (category, style.get("name"))
            for category, styles in result.items()
            for style in styles
            if isinstance(style.get("name"), str)
        }
        favorites = [
            item
            for item in _load_favorites()
            if (item["category"], item["name"]) in valid_styles
        ]
    except (OSError, json.JSONDecodeError, StyleDataError) as exc:
        favorites = []
        errors.append(f"{FAVORITES_PATH.name}: {exc}")
    return web.json_response(
        {"styles": result, "favorites": favorites, "errors": errors}
    )


@routes.post("/style_node_studio/api/set_favorite")
async def set_favorite(request):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise StyleDataError("request body must be an object")
        category = _ensure_real_category(_clean_category(body.get("category")))
        name = _clean_text(
            body.get("name"), "name", MAX_NAME_LENGTH, required=True
        )
        favorite = body.get("favorite")
        if not isinstance(favorite, bool):
            raise StyleDataError("favorite must be a boolean")

        key = (category, name)
        favorites = _load_favorites()
        updated = [
            item
            for item in favorites
            if (item["category"], item["name"]) != key
        ]
        if favorite:
            styles = _load_styles(_category_path(category))
            if not any(style.get("name") == name for style in styles):
                return web.json_response(
                    {"status": "error", "message": "Style was not found"},
                    status=404,
                )
            updated.append({"category": category, "name": name})
        if updated != favorites:
            _write_favorites(updated)
        return web.json_response(
            {
                "status": "ok",
                "category": category,
                "name": name,
                "favorite": favorite,
            }
        )
    except (StyleDataError, json.JSONDecodeError) as exc:
        return web.json_response(
            {"status": "error", "message": str(exc)}, status=400
        )
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Cannot save favorite: {exc}"},
            status=500,
        )


@routes.get("/style_node_studio/api/thumbnail")
async def get_thumbnail(request):
    try:
        category = _clean_category(request.query.get("category"))
        filename = _clean_text(
            request.query.get("filename"), "filename", 180, required=True
        )
        if Path(filename).name != filename:
            raise StyleDataError("invalid thumbnail filename")
        if Path(filename).suffix.lower() not in set(THUMBNAIL_EXTENSIONS.values()):
            raise StyleDataError("unsupported thumbnail extension")
        directory = _category_asset_dir(category)
        path = (directory / filename).resolve()
        try:
            path.relative_to(directory)
        except ValueError as exc:
            raise StyleDataError("thumbnail points outside its category") from exc
        if not path.is_file():
            raise web.HTTPNotFound(text="Thumbnail was not found")
        response = web.FileResponse(path)
        response.headers["Cache-Control"] = "private, max-age=31536000, immutable"
        return response
    except StyleDataError as exc:
        return web.json_response(
            {"status": "error", "message": str(exc)}, status=400
        )


@routes.post("/style_node_studio/api/save_thumbnail")
async def save_thumbnail(request):
    try:
        reader = await request.multipart()
        category = None
        name = None
        image_bytes = None
        image_type = None

        async for part in reader:
            if part.name == "category":
                category = await part.text()
            elif part.name == "name":
                name = await part.text()
            elif part.name == "image":
                image_type = (part.headers.get("Content-Type") or "").split(";", 1)[0]
                chunks = []
                total = 0
                while True:
                    chunk = await part.read_chunk()
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_THUMBNAIL_BYTES:
                        raise StyleDataError("thumbnail is larger than 12 MB")
                    chunks.append(chunk)
                image_bytes = b"".join(chunks)

        category = _ensure_real_category(_clean_category(category))
        stem = _safe_asset_stem(name)
        extension = THUMBNAIL_EXTENSIONS.get(image_type)
        if not extension:
            raise StyleDataError("thumbnail must be JPEG, PNG, or WebP")
        if not image_bytes:
            raise StyleDataError("thumbnail image is empty")

        directory = _category_asset_dir(category)
        path = directory / f"{stem}{extension}"
        _write_bytes(path, image_bytes)

        for stale_extension in set(THUMBNAIL_EXTENSIONS.values()) - {extension}:
            stale_path = directory / f"{stem}{stale_extension}"
            if stale_path.exists():
                stale_path.unlink()

        version = path.stat().st_mtime_ns
        return web.json_response(
            {
                "status": "ok",
                "thumbnail": _thumbnail_url(category, path.name, version),
            }
        )
    except StyleDataError as exc:
        return web.json_response(
            {"status": "error", "message": str(exc)}, status=400
        )
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Cannot save thumbnail: {exc}"},
            status=500,
        )


@routes.post("/style_node_studio/api/save_style")
async def save_style(request):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise StyleDataError("request body must be an object")

        category = _ensure_real_category(
            _clean_category(body.get("category", "Custom"))
        )
        incoming_style = _validate_style(body.get("style"))
        original_category_value = body.get("original_category")
        original_name_value = body.get("original_name")
        original_category = (
            _ensure_real_category(_clean_category(original_category_value))
            if original_category_value is not None
            else None
        )
        original_name = (
            _clean_text(
                original_name_value,
                "original_name",
                MAX_NAME_LENGTH,
                required=True,
            )
            if original_name_value is not None
            else None
        )

        target_path = _category_path(category)
        target_styles = _load_styles(target_path)
        source_path = _category_path(original_category) if original_category else None
        source_styles = (
            target_styles
            if source_path == target_path
            else _load_styles(source_path) if source_path else None
        )

        existing_style = None
        if source_styles is not None and original_name:
            existing_style = next(
                (style for style in source_styles if style.get("name") == original_name),
                None,
            )
        if existing_style is None:
            existing_style = next(
                (
                    style
                    for style in target_styles
                    if style.get("name") == incoming_style["name"]
                ),
                None,
            )

        previous_thumbnail = (
            existing_style.get("thumbnail", "") if existing_style else ""
        )
        merged_style = dict(existing_style or {})
        merged_style.update(incoming_style)

        if source_styles is not None and original_name:
            source_styles[:] = [
                style for style in source_styles if style.get("name") != original_name
            ]

        target_styles[:] = [
            style
            for style in target_styles
            if style.get("name") != incoming_style["name"]
        ]
        target_styles.append(merged_style)

        _write_styles(target_path, target_styles)
        if source_path and source_path != target_path:
            # If the second write fails, the safe failure mode is a duplicate,
            # not loss of the original style.
            _write_styles(source_path, source_styles)

        _move_favorite(
            original_category,
            original_name,
            category,
            incoming_style["name"],
        )

        new_thumbnail = merged_style.get("thumbnail", "")
        previous_thumbnail_path = _managed_thumbnail_path(previous_thumbnail)
        new_thumbnail_path = _managed_thumbnail_path(new_thumbnail)
        if (
            previous_thumbnail != new_thumbnail
            and previous_thumbnail_path != new_thumbnail_path
        ):
            _delete_managed_thumbnail(previous_thumbnail)

        return web.json_response(
            {"status": "ok", "category": category, "style": merged_style}
        )
    except (StyleDataError, json.JSONDecodeError) as exc:
        return web.json_response(
            {"status": "error", "message": str(exc)}, status=400
        )
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Cannot save style: {exc}"}, status=500
        )


@routes.post("/style_node_studio/api/delete_style")
async def delete_style(request):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise StyleDataError("request body must be an object")
        category = _clean_category(body.get("category"))
        name = _clean_text(
            body.get("name"), "name", MAX_NAME_LENGTH, required=True
        )
        path = _category_path(category)
        styles = _load_styles(path)
        deleted_styles = [style for style in styles if style.get("name") == name]
        remaining = [style for style in styles if style.get("name") != name]
        if len(remaining) == len(styles):
            return web.json_response(
                {"status": "error", "message": "Style was not found"}, status=404
            )
        _write_styles(path, remaining)
        for style in deleted_styles:
            _delete_managed_thumbnail(style.get("thumbnail", ""))
        _remove_favorites(category=category, name=name)
        return web.json_response({"status": "ok"})
    except (StyleDataError, json.JSONDecodeError) as exc:
        return web.json_response(
            {"status": "error", "message": str(exc)}, status=400
        )
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Cannot delete style: {exc}"},
            status=500,
        )


@routes.post("/style_node_studio/api/delete_category")
async def delete_category(request):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise StyleDataError("request body must be an object")

        category = _ensure_real_category(_clean_category(body.get("category")))
        path = _category_path(category)
        if not path.is_file():
            return web.json_response(
                {"status": "error", "message": "Category was not found"},
                status=404,
            )

        styles = _load_styles(path)
        directory = _category_asset_dir(category)
        if directory.exists() and not directory.is_dir():
            raise StyleDataError("category asset path is not a directory")

        # Removing the JSON first makes the category disappear immediately. An
        # orphaned asset directory is safer than a visible category whose
        # thumbnails were only partly removed if filesystem cleanup fails.
        path.unlink()
        if directory.exists():
            shutil.rmtree(directory)
        _remove_favorites(category=category)

        return web.json_response(
            {"status": "ok", "category": category, "deleted_styles": len(styles)}
        )
    except (StyleDataError, json.JSONDecodeError) as exc:
        return web.json_response(
            {"status": "error", "message": str(exc)}, status=400
        )
    except OSError as exc:
        return web.json_response(
            {"status": "error", "message": f"Cannot delete category: {exc}"},
            status=500,
        )


NODE_CLASS_MAPPINGS = {"StyleNodeStudio": StyleNodeStudio}

NODE_DISPLAY_NAME_MAPPINGS = {"StyleNodeStudio": "Style Node Studio"}
