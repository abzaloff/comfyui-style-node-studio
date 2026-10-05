# Style Copy and Runtime Toggle Design

## Goal

Fix style editing so renaming creates a new style without changing the source,
and let users temporarily disable selected styles from their selection chips
while testing different prompt results.

## Style save behavior

The style name determines whether an edit updates the source or creates a copy.

- If the saved name matches the original name, update the existing style.
- If its category also changed, move that existing style to the new category
  without leaving a copy in the old category.
- If the saved name differs from the original name, create a new style from the
  edited values and leave the original style, thumbnail, and favorite state
  unchanged.
- If the destination category already contains a different style with the new
  name, reject the save with a clear conflict error instead of overwriting it.
- A same-name move continues to move the favorite entry and managed thumbnail
  with the style.

The API remains backward compatible for requests that create a style without an
original identity.

## Runtime style toggles

Each selected-style chip gets a checkbox on the left and keeps its remove
button on the right.

- A newly selected style is always checked.
- Unchecking a chip temporarily excludes that style from generation without
  removing the chip from the selected list.
- Checking it again includes it in generation at its existing position.
- Removing and selecting the style again resets it to checked.
- Clear All removes all chips and clears the temporary disabled set.
- Style gallery cards do not gain checkboxes or new enabled/disabled states.

The disabled set exists only in the live frontend widget. The workflow keeps
the complete selected-style list in `node.properties.selected_styles`, while
the hidden ComfyUI input receives a filtered JSON list containing only the
currently checked styles. Loading or reopening a workflow starts with an empty
disabled set, so every restored selected style is active.

Legacy workflow selection formats remain accepted. Missing runtime toggle
state always means enabled.

## Data flow

1. Selecting or removing a gallery card updates the complete persisted
   selection.
2. Toggling a chip updates only the in-memory disabled-key set.
3. A synchronization helper derives the hidden execution value from the full
   selection minus disabled keys.
4. Python receives the filtered selection through the existing
   `selected_styles` input and processes it without a new backend format.
5. Workflow restoration rebuilds the chips from the full persisted selection
   and clears all temporary disabled keys.

## Error handling

Save conflicts return an HTTP conflict response and leave both source and
destination files unchanged. Other validation and filesystem errors retain the
current API behavior. Checkbox interactions stop event propagation so they do
not remove a chip or toggle its gallery card accidentally.

## Verification

Backend tests will cover:

- renaming creates a second style and preserves the source;
- same-name edits update in place;
- same-name category changes move instead of copy;
- destination-name conflicts do not overwrite data;
- thumbnail and favorite behavior differs correctly between copy and move.

The browser harness will cover:

- selected chips render checked by default;
- unchecking filters the hidden execution value but preserves the full stored
  selection and chip;
- rechecking restores the style to the execution value;
- removing and re-adding resets the checkbox to checked;
- workflow restoration makes every selected style active.

Final verification will run the complete Python test suite, the browser UI
harness, JavaScript syntax checking, and `git diff --check`.
