# ComfyUI Style Node Studio

`Style Node Studio` is a custom ComfyUI node for storing, selecting, and
combining reusable positive and negative prompt presets. It does not generate
images by itself. The node receives prompt strings, applies the selected styles,
and returns the resulting `positive` and `negative` strings.

![Style Node Studio interface](assets/style-node-studio.png)

## Installation

1. Copy the project directory to:

   ```text
   ComfyUI/custom_nodes/comfyui-style-node-studio
   ```

2. Restart ComfyUI.
3. Refresh the browser page with `Ctrl+F5`.
4. Add **Style Node Studio** from the **Style Node Studio** node category.

No additional Python dependencies are required.

## Node connections

- `positive` — the input positive prompt.
- `negative` — the input negative prompt.
- The `positive` and `negative` outputs contain the prompts after the selected
  styles have been applied.
- Multiple styles can be selected and are applied in selection order.
- `Clear All` deselects every style.

## Settings

### style_strength

Controls the weight of the style preset text:

- `0` — disables the selected styles;
- `1` — keeps the original text weight;
- values between `0` and `2` apply ComfyUI prompt weighting, for example
  `(cinematic lighting:0.50)`.

### inject_mode

Controls where the style text is placed relative to the input prompt:

- `template` — inserts the input prompt at the `{prompt}` token;
- `append` — adds the style after the input prompt;
- `prepend` — adds the style before the input prompt.

For an input prompt of `portrait` and a style containing
`cinematic, {prompt}, warm light`:

- `template`: `cinematic, portrait, warm light`;
- `append`: `portrait, cinematic, warm light`;
- `prepend`: `cinematic, warm light, portrait`.

## Style gallery

- The category list stays open to the left of the style cards. Click a category
  to filter the gallery, or choose `All Categories` to show everything.
- The search field filters styles by name across all categories, regardless of
  the category currently selected. Use the `×` button inside the field to clear
  the search and return to the selected category.
- Clicking a card selects or deselects the style.
- Selected styles remain visible as removable tags beside the search field,
  even when browsing another category.
- The `◎` button beside `Clear All` temporarily disables all selected styles
  when any are active, or enables all of them when none are active.
- The pencil button opens the style in the manager.
- The camera button replaces the preset thumbnail with the latest
  ComfyUI-generated image without opening the manager.
- The star in the upper-right corner adds or removes a favorite:
  - `☆` — not a favorite;
  - `★` — added to favorites.
- The `★ Favs` button opens the favorite styles immediately.

## Manager

The manager can:

- create styles and categories;
- edit names, categories, prompts, and thumbnails;
- move a style to another category by selecting the style, choosing a different
  category, and saving it;
- delete individual styles;
- delete a category together with all of its styles and local thumbnails;
- filter the library by category or show only `Favs`;
- insert `{prompt}` at the current cursor position with `Insert {prompt}`;
- choose a thumbnail from disk or use the latest ComfyUI-generated image;
- change the shared gallery card size from `96 px` to `320 px`. The setting is
  saved in the browser and applies immediately to the manager and every open
  Style Node Studio node.

When a thumbnail is saved, it is center-cropped to a square, converted to WebP,
and stored inside the category directory.

## Favorites

`Favs` is a virtual category. Favorite styles are not duplicated and remain in
their original categories. Favorite references are updated automatically when a
style is moved or renamed and removed when the style or its category is deleted.

The favorites list is stored in:

```text
favorites.json
```

## Style file format

Each category is represented by a JSON file:

```text
styles/<Category name>.json
```

The file contains an array of style presets:

```json
[
  {
    "name": "Cinematic Photography",
    "prompt": "cinematic lighting, {prompt}, shallow depth of field",
    "negative_prompt": "flat lighting, low detail",
    "thumbnail": "/style_node_studio/api/thumbnail?category=Photography&filename=Cinematic%20Photography.webp"
  }
]
```

Preset fields:

- `name` — the displayed style name;
- `prompt` — the positive style prompt;
- `negative_prompt` — the negative style prompt;
- `thumbnail` — the URL of a local or external preview image.

Local thumbnails are stored in the matching category directory:

```text
styles/<Category name>/<Style name>.webp
```
