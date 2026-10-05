import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path


class FakeRoutes:
    def get(self, _path):
        return lambda function: function

    def post(self, _path):
        return lambda function: function


def load_extension_module():
    fake_server = types.SimpleNamespace(
        PromptServer=types.SimpleNamespace(
            instance=types.SimpleNamespace(routes=FakeRoutes())
        )
    )
    sys.modules["server"] = fake_server
    extension_path = Path(__file__).resolve().parents[1] / "__init__.py"
    spec = importlib.util.spec_from_file_location("style_node_studio_tested", extension_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sns = load_extension_module()


class ValidationTests(unittest.TestCase):
    def test_category_cannot_escape_styles_directory(self):
        for value in ("../outside", "..\\outside", "C:\\outside", "bad/name"):
            with self.subTest(value=value), self.assertRaises(sns.StyleDataError):
                sns._clean_category(value)

    def test_valid_category_keeps_human_readable_name(self):
        self.assertEqual(sns._clean_category("Design & Vector"), "Design & Vector")

    def test_json_selection_supports_commas_in_names(self):
        value = json.dumps([{"category": "Photo", "name": "Soft, cinematic"}])
        self.assertEqual(
            sns._parse_selected_styles(value),
            [("Photo", "Soft, cinematic")],
        )


class PromptProcessingTests(unittest.TestCase):
    def setUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.previous_styles_dir = sns.STYLES_DIR
        sns.STYLES_DIR = Path(self.temp_directory.name)
        (sns.STYLES_DIR / "Test.json").write_text(
            json.dumps(
                [
                    {
                        "name": "Cinematic",
                        "prompt": "cinematic, {prompt}, detailed",
                        "negative_prompt": "blurry",
                    }
                ]
            ),
            encoding="utf-8",
        )
        self.node = sns.StyleNodeStudio()
        self.selection = json.dumps(
            [{"category": "Test", "name": "Cinematic"}]
        )

    def tearDown(self):
        sns.STYLES_DIR = self.previous_styles_dir
        self.temp_directory.cleanup()

    def process(self, strength=1.0, mode="template"):
        return self.node.process_style(
            "All Categories",
            strength,
            mode,
            positive="subject",
            negative="noise",
            selected_styles=self.selection,
        )

    def test_template_preserves_prompt_position(self):
        self.assertEqual(
            self.process(),
            ("cinematic, subject, detailed", "noise, blurry"),
        )

    def test_append_and_prepend_are_distinct(self):
        self.assertEqual(
            self.process(mode="append")[0],
            "subject, cinematic, detailed",
        )
        self.assertEqual(
            self.process(mode="prepend")[0],
            "cinematic, detailed, subject",
        )

    def test_strength_weights_only_style_text(self):
        self.assertEqual(
            self.process(strength=0.5),
            (
                "(cinematic:0.50), subject, (detailed:0.50)",
                "noise, (blurry:0.50)",
            ),
        )

    def test_zero_strength_returns_original_prompts(self):
        self.assertEqual(self.process(strength=0.0), ("subject", "noise"))

    def test_negative_template_uses_negative_input_at_token_position(self):
        path = sns.STYLES_DIR / "Test.json"
        styles = json.loads(path.read_text(encoding="utf-8"))
        styles[0]["negative_prompt"] = "artifact, {prompt}, blurry"
        path.write_text(json.dumps(styles), encoding="utf-8")
        self.assertEqual(
            self.process()[1],
            "artifact, noise, blurry",
        )


class StorageTests(unittest.TestCase):
    def test_atomic_write_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "styles.json"
            expected = [{"name": "One", "prompt": "test"}]
            sns._write_styles(path, expected)
            self.assertEqual(sns._load_styles(path), expected)

    def test_load_styles_accepts_utf8_bom(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "imported.json"
            path.write_text(
                '[{"name": "Imported", "prompt": "{prompt}"}]',
                encoding="utf-8-sig",
            )
            self.assertEqual(
                sns._load_styles(path),
                [{"name": "Imported", "prompt": "{prompt}"}],
            )

    def test_thumbnail_filename_is_human_readable_and_safe(self):
        self.assertEqual(sns._safe_asset_stem("My Style"), "My Style")
        self.assertEqual(sns._safe_asset_stem("Bad/Style?"), "Bad_Style_")

    def test_managed_thumbnail_url_resolves_inside_category(self):
        with tempfile.TemporaryDirectory() as directory:
            previous_styles_dir = sns.STYLES_DIR
            sns.STYLES_DIR = Path(directory)
            try:
                value = sns._thumbnail_url("3D Render", "Low Poly.webp", 123)
                expected = Path(directory) / "3D Render" / "Low Poly.webp"
                self.assertEqual(sns._managed_thumbnail_path(value), expected)
            finally:
                sns.STYLES_DIR = previous_styles_dir


class FakeRequest:
    def __init__(self, body):
        self.body = body

    async def json(self):
        return self.body


class FakeMultipartPart:
    def __init__(self, name, value, content_type=None):
        self.name = name
        self.value = value
        self.headers = {"Content-Type": content_type} if content_type else {}
        self.consumed = False

    async def text(self):
        return self.value

    async def read_chunk(self):
        if self.consumed:
            return b""
        self.consumed = True
        return self.value


class FakeMultipartReader:
    def __init__(self, parts):
        self.parts = iter(parts)

    def __aiter__(self):
        return self

    async def __anext__(self):
        try:
            return next(self.parts)
        except StopIteration as exc:
            raise StopAsyncIteration from exc


class FakeMultipartRequest:
    def __init__(self, parts):
        self.parts = parts

    async def multipart(self):
        return FakeMultipartReader(self.parts)


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_directory = tempfile.TemporaryDirectory()
        self.previous_styles_dir = sns.STYLES_DIR
        self.previous_favorites_path = sns.FAVORITES_PATH
        sns.STYLES_DIR = Path(self.temp_directory.name)
        sns.FAVORITES_PATH = sns.STYLES_DIR / "favorites.json"

    async def asyncTearDown(self):
        sns.STYLES_DIR = self.previous_styles_dir
        sns.FAVORITES_PATH = self.previous_favorites_path
        self.temp_directory.cleanup()

    async def test_renaming_creates_copy_and_preserves_original(self):
        source_path = sns.STYLES_DIR / "Anime.json"
        sns._write_styles(
            source_path,
            [
                {
                    "name": "Old name",
                    "name_cn": "旧名称",
                    "prompt": "old, {prompt}",
                    "negative_prompt": "",
                    "thumbnail": "old.jpg",
                }
            ],
        )
        response = await sns.save_style(
            FakeRequest(
                {
                    "category": "Anime",
                    "original_category": "Anime",
                    "original_name": "Old name",
                    "style": {
                        "name": "New name",
                        "prompt": "new, {prompt}",
                        "negative_prompt": "bad",
                        "thumbnail": "new.jpg",
                    },
                }
            )
        )
        self.assertEqual(response.status, 200)
        saved = sns._load_styles(source_path)
        self.assertEqual(len(saved), 2)
        self.assertEqual(saved[0]["name"], "Old name")
        self.assertEqual(saved[0]["prompt"], "old, {prompt}")
        self.assertEqual(saved[1]["name"], "New name")
        self.assertEqual(saved[1]["name_cn"], "旧名称")

    async def test_api_rejects_path_traversal(self):
        response = await sns.save_style(
            FakeRequest(
                {
                    "category": "..\\outside",
                    "style": {"name": "Unsafe"},
                }
            )
        )
        self.assertEqual(response.status, 400)

    async def test_updating_thumbnail_version_does_not_delete_same_file(self):
        directory = sns._category_asset_dir("Anime")
        image_path = directory / "Style.webp"
        sns._write_bytes(image_path, b"webp-test")
        old_url = sns._thumbnail_url("Anime", image_path.name, 1)
        new_url = sns._thumbnail_url("Anime", image_path.name, 2)
        sns._write_styles(
            sns.STYLES_DIR / "Anime.json",
            [
                {
                    "name": "Style",
                    "prompt": "{prompt}",
                    "negative_prompt": "",
                    "thumbnail": old_url,
                }
            ],
        )
        response = await sns.save_style(
            FakeRequest(
                {
                    "category": "Anime",
                    "original_category": "Anime",
                    "original_name": "Style",
                    "style": {
                        "name": "Style",
                        "prompt": "new, {prompt}",
                        "negative_prompt": "",
                        "thumbnail": new_url,
                    },
                }
            )
        )
        self.assertEqual(response.status, 200)
        self.assertTrue(image_path.exists())

    async def test_thumbnail_upload_uses_category_and_style_directories(self):
        response = await sns.save_thumbnail(
            FakeMultipartRequest(
                [
                    FakeMultipartPart("category", "3D Render"),
                    FakeMultipartPart("name", "Low Poly 3D"),
                    FakeMultipartPart(
                        "image", b"webp-image", content_type="image/webp"
                    ),
                ]
            )
        )
        self.assertEqual(response.status, 200)
        payload = json.loads(response.text)
        self.assertTrue(
            (sns.STYLES_DIR / "3D Render" / "Low Poly 3D.webp").exists()
        )
        self.assertIn("category=3D+Render", payload["thumbnail"])

    async def test_delete_category_removes_json_and_asset_directory(self):
        category_path = sns.STYLES_DIR / "Temporary.json"
        asset_directory = sns.STYLES_DIR / "Temporary"
        sns._write_styles(
            category_path,
            [{"name": "One", "prompt": "{prompt}", "thumbnail": ""}],
        )
        sns._write_bytes(asset_directory / "One.webp", b"thumbnail")
        sns._write_favorites([{"category": "Temporary", "name": "One"}])

        response = await sns.delete_category(FakeRequest({"category": "Temporary"}))

        self.assertEqual(response.status, 200)
        self.assertFalse(category_path.exists())
        self.assertFalse(asset_directory.exists())
        self.assertEqual(json.loads(response.text)["deleted_styles"], 1)
        self.assertEqual(sns._load_favorites(), [])

    async def test_delete_category_rejects_path_traversal(self):
        response = await sns.delete_category(
            FakeRequest({"category": "..\\outside"})
        )
        self.assertEqual(response.status, 400)

    async def test_delete_category_reports_missing_category(self):
        response = await sns.delete_category(FakeRequest({"category": "Missing"}))
        self.assertEqual(response.status, 404)

    async def test_favorite_can_be_added_and_removed(self):
        sns._write_styles(
            sns.STYLES_DIR / "Anime.json",
            [{"name": "Ink", "prompt": "{prompt}"}],
        )

        added = await sns.set_favorite(
            FakeRequest({"category": "Anime", "name": "Ink", "favorite": True})
        )
        self.assertEqual(added.status, 200)
        self.assertEqual(
            sns._load_favorites(), [{"category": "Anime", "name": "Ink"}]
        )

        removed = await sns.set_favorite(
            FakeRequest({"category": "Anime", "name": "Ink", "favorite": False})
        )
        self.assertEqual(removed.status, 200)
        self.assertEqual(sns._load_favorites(), [])

    async def test_favorite_stays_on_original_when_name_changes(self):
        sns._write_styles(
            sns.STYLES_DIR / "Anime.json",
            [{"name": "Old", "prompt": "{prompt}", "thumbnail": ""}],
        )
        sns._write_favorites([{"category": "Anime", "name": "Old"}])

        response = await sns.save_style(
            FakeRequest(
                {
                    "category": "Illustration",
                    "original_category": "Anime",
                    "original_name": "Old",
                    "style": {
                        "name": "New",
                        "prompt": "painted, {prompt}",
                        "negative_prompt": "",
                        "thumbnail": "",
                    },
                }
            )
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(sns._load_favorites(), [{"category": "Anime", "name": "Old"}])
        self.assertEqual(sns._load_styles(sns.STYLES_DIR / "Anime.json")[0]["name"], "Old")
        self.assertEqual(sns._load_styles(sns.STYLES_DIR / "Illustration.json")[0]["name"], "New")

    async def test_same_name_category_change_moves_style_and_favorite(self):
        sns._write_styles(sns.STYLES_DIR / "Anime.json", [{"name": "Ink", "prompt": "old"}])
        sns._write_favorites([{"category": "Anime", "name": "Ink"}])
        response = await sns.save_style(FakeRequest({
            "category": "Illustration", "original_category": "Anime", "original_name": "Ink",
            "style": {"name": "Ink", "prompt": "new"},
        }))
        self.assertEqual(response.status, 200)
        self.assertEqual(sns._load_styles(sns.STYLES_DIR / "Anime.json"), [])
        self.assertEqual(sns._load_styles(sns.STYLES_DIR / "Illustration.json")[0]["prompt"], "new")
        self.assertEqual(sns._load_favorites(), [{"category": "Illustration", "name": "Ink"}])

    async def test_rename_rejects_existing_destination_without_changes(self):
        path = sns.STYLES_DIR / "Anime.json"
        original = [{"name": "Old", "prompt": "old"}, {"name": "Taken", "prompt": "taken"}]
        sns._write_styles(path, original)
        response = await sns.save_style(FakeRequest({
            "category": "Anime", "original_category": "Anime", "original_name": "Old",
            "style": {"name": "Taken", "prompt": "replacement"},
        }))
        self.assertEqual(response.status, 409)
        self.assertEqual(sns._load_styles(path), original)

    async def test_delete_style_removes_favorite(self):
        sns._write_styles(
            sns.STYLES_DIR / "Anime.json",
            [{"name": "Ink", "prompt": "{prompt}", "thumbnail": ""}],
        )
        sns._write_favorites([{"category": "Anime", "name": "Ink"}])

        response = await sns.delete_style(
            FakeRequest({"category": "Anime", "name": "Ink"})
        )

        self.assertEqual(response.status, 200)
        self.assertEqual(sns._load_favorites(), [])

    async def test_virtual_favs_category_cannot_store_styles(self):
        response = await sns.save_style(
            FakeRequest({"category": "Favs", "style": {"name": "Unsafe"}})
        )
        self.assertEqual(response.status, 400)

    async def test_get_styles_returns_only_existing_favorites(self):
        sns._write_styles(
            sns.STYLES_DIR / "Anime.json",
            [{"name": "Ink", "prompt": "{prompt}"}],
        )
        sns._write_favorites(
            [
                {"category": "Anime", "name": "Ink"},
                {"category": "Anime", "name": "Missing"},
            ]
        )

        response = await sns.get_styles(None)
        payload = json.loads(response.text)

        self.assertEqual(
            payload["favorites"], [{"category": "Anime", "name": "Ink"}]
        )


if __name__ == "__main__":
    unittest.main()
