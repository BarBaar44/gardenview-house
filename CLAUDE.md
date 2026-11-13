# Gardenview House: notes for working on this repo

Marketplace (formerly HACS) dashboard card (Lovelace) for the sun screen on the back of the owner's house, drawn as the garden facade. Owner: BarBaar44 (Bb). Sister repos with the same conventions: [appliance-card](https://github.com/BarBaar44/appliance-card) (the reference), [espresso-card](https://github.com/BarBaar44/espresso-card), [tesla-model3-card](https://github.com/BarBaar44/tesla-model3-card) (the drawing style), [vacuum-card](https://github.com/BarBaar44/vacuum-card), [room-card](https://github.com/BarBaar44/room-card), [climate-card](https://github.com/BarBaar44/climate-card).

## Files

| File | Purpose |
|---|---|
| `gardenview-house.js` | The whole card: plain custom element, no build step, no dependencies. `GH_DEFAULTS` holds the owner's entities and thresholds, `GH_COLORS` the colours, `GH` the camera and geometry, `ghScene` the drawing. |
| `tests/gardenview-house.test.js` | jsdom tests: texts, retract time, buttons, travel window on a fake clock, wind, dark, doors, lantern, actions, drag, redraws, config errors, editor round trips. `npm test`. |
| `hacs.json` | Manifest for the Home Assistant Marketplace (HACS became the Marketplace in HA 2026.11; same file, same validation action). |
| `README.md` | User docs, also the Marketplace info page. Keep the option, role and decision tables in sync with the code. |
| `CHANGELOG.md` | One `## vX.Y.Z` section per release; the Release workflow uses it as the release notes. |
| `shot.png` | README image, linked by absolute raw URL so it renders in the Marketplace. |
| `gardenview-house.yaml` | Minimal and full example configs. |

## The device

`cover.sun_screen`: Coulisse Motionblinds motor (`motion_blinds`, local), `device_class: shade`, `supported_features: 15` (open, close, stop, set position; no tilt). `current_position` 0 to 100: **100 = open = retracted**, 0 = fully out. States open, closed, opening, closing, briefly unavailable after an HA restart. Signal strength (`sensor.sun_screen_signal_strength`) belongs in more-info, not on the card. Used a few times a season.

Automation "Close Sunscreen" (do not change it from here): 2 h before sunset, if the position is below 99, it runs `open_cover` (retracts). Hence `retract_offset: 120` and "No auto up" once that moment has passed for today (sun.sun `next_setting` jumps to tomorrow after sunset).

## Rules to keep

* The card speaks from the user's side: `out = 100 - current_position`. Never show the raw position.
* motion_blinds never reports `opening`/`closing`: on a command `current_position` jumps to the target at once, and the real position comes when the motor stops (~15 s for the whole range). The card keeps a travel window (`_travel`, `_watchCover`, `_onPosChange`): started by its own commands and by any position jump it did not cause, lasting `travel_time` × distance (min 2 s). While travelling the cloth is drawn at the estimated position (redrawn every 250 ms), text "Lowering…"/"Raising…" with `from → to`, ghost line at the target. A report equal to the target during the window is the jump and is ignored; a different one is the real stop position and ends the window; reports within 5 s after a window or within `travel_time` after Stop are final reports, not new moves. Stop holds the estimated position (`_hold`) until the real one arrives.
* Buttons: Stop is always enabled (only off while unavailable). Up is disabled when retracted and down when fully out, but never while travelling (the reported position is then the target). The up button is highlighted (`hot`) in wind only while the screen is out.
* All actions go through `hass-action`: tap and hold as configured, the screen controls as `perform-action` (`cover.open_cover`, `close_cover`, `stop_cover`, `set_cover_position` with `position = 100 - out`). Never call `hass.callService`.
* Drag: relative (`GH_DRAG_PX` = 100 px for the whole range, from the current out), snaps to 5 % and to 0/25/50/75/100 within 4 %. A drag starts only after 8 px vertical movement and only when set position is supported; until then a tap stays a tap. The lantern's tap circle (r 9 in viewBox units, about 40 px) takes precedence over the picture tap; it is hidden without a `lantern` entity.
* Dark: `dark` entity (on/off, or numeric below `dark_below`), else the sun below the horizon. Dark greys the house (`X()` colour map in `ghScene`), keeps glass, rooms and lantern lit, and dims text and buttons to 70 %.
* The cloth comes out at 30 degrees below horizontal (confirmed by Bb; constant `PITCH` in `GH`).
* Drawing style: the Tesla card's line art (white surfaces, `#111` outlines, black glass). The pier between the French doors and the kitchen door (with the lantern) is softened red brick (between full brick and muted, kept in the background; thin outline, fine mortar lines) with white frame (kozijn) strips on both sides. The screen cloth is solid grey with light stripes (Bb chose solid over see-through); colour only in the hem (`--gh-out`, `--gh-wind` in wind).
* Camera: 65 degrees to the wall (about 25 off straight on) from the left. At 45 degrees the open leaves cover the doorways; do not go back without checking the open-door states. The kitchen door hinges on the right; the French doors open outward, both leaves from one sensor unless `garden_door_2` is set. The viewBox is fixed (screen fully out included) so the picture never jumps.
* The picture is rebuilt only when its inputs change (`_sceneKey`); text and buttons update in place. Re-render only when one of the card's own entities changes, plus a 60 s tick for "Up at" / "No auto up".
* Layout: 12 columns by 2 rows, 120 px high; picture 191 x 112 px, text in a container query (word sizes shrink below 112 px so "Unavailable" and "Lowering…" fit at 360 px). Measure in a real browser (Playwright) at 360 and 520 px after any text or layout change. A stub `ha-card` must not set `display` inline, or the render lies; give it a shadow root with `:host { display: block; background: ... }` like the real one.
* Visual editor (`GardenviewHouseEditor`, on `ha-form`): fields show the defaults; only non-defaults are written; a cleared entity with a default is written as `null` (a cleared cover falls back to the default); entities without a default stay absent when empty; `retract_offset: null` survives; unknown keys are kept. Keep `GH_ENTITY_FIELDS` and `GH_NUMBER_FIELDS` in sync with `GH_DEFAULTS`.
* Animations (hem pulse while moving, cloth sway in wind) stop under reduced motion.
* The whole file sits in one block scope so its top-level names cannot clash with sister cards loaded as classic scripts; `const VERSION` stays on its own line for the Release workflow.
* Out of scope (Bb's call): party decorations, anything not about the screen, doors or lantern. More detail belongs in a pop-up, not on the card.

## Owner's entities

* Dark: `sensor.outdoor_sensor_illuminance` below 10 lx (the threshold of Bb's Garden Lights automation). Lantern `light.rear_garden`, doors `binary_sensor.door_sensor_garden_doors_contact` (one sensor, both leaves) and `binary_sensor.door_sensor_kitchen_contact` are set; the door sensors report `device_class: window`, which the card ignores (it only reads on = open).

## Releasing

1. Changes go through a pull request; Bb merges.
2. Bump `VERSION`, add the CHANGELOG section in the PR that is meant to become a release.
3. The owner pushes the `vX.Y.Z` tag. **Never tag or release without the owner's explicit go.** Claude sessions here cannot push tags or create releases anyway.
