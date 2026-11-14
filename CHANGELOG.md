# Changelog

## v0.2.1

- Indoor lights as entities: new roles `dining_light` (behind the French doors) and `kitchen_light`. In the dark a room only glows (windows, transoms, open doorway, pendant lamps) while its light is on; with the light off its glass stays black and an open doorway shows the room dimmed. Without a light entity a room is lit whenever it is dark, as before. Both in the visual editor.

## v0.2.0

- The whole ground floor wall is now drawn as brick, like the real house: the walls left of the French doors and right of the kitchen window, and the strip under the kitchen side window, in the same softened red brick as the pier with the lantern. The white door and window frames form the edge.

## v0.1.2

- Fix: the animation jumped to the retracted position while the screen was still moving. motion_blinds polls the motor during a move, and the first poll can still read the starting position; the card took any report other than the target as "stopped here". Now a position reported during the travel is progress: the card carries on from that real position towards the target, with the time left for that distance. If the motor really stopped there, the travel ends on the last reported position.

## v0.1.1

- Moving screen: motion_blinds never reports opening or closing; on a command it jumps straight to the target and reports the real position when the motor stops. The card now treats the screen as travelling for `travel_time` (15 s for the whole range, scaled by the distance) after its own command or after any position jump: "Lowering…" / "Raising…", the hem pulse, and the cloth drawn moving from the old to the new position. The real position arriving early (stopped by the remote, say) ends the travel.
- Stop is always enabled (stop_cover on a still screen is harmless). After a stop the card holds the estimated position until the motor reports the real one.
- Up and down are not disabled from the reported position while the screen travels: that position is the target, not where the screen is.
- The wall between the French doors and the kitchen door is drawn as softened red brick (kept in the background), with the white frame edges on both sides.
- New option `travel_time` (seconds, 1 to 300, default 15), also in the visual editor.

## v0.1.0

First release.

- The garden facade as a line drawing, in the style of the Tesla Model 3 Card: French doors, kitchen door, lantern, balcony band and the screen cassette.
- The screen at its real position: solid grey cloth with light stripes, coming out at 30 degrees, with a coloured hem while it is out and its shadow on the patio while the sun is up.
- Text from the user's side: "60 % out", "Retracted", "Lowering…", "Raising…", "Unavailable".
- "Up at HH:MM" while the screen is out: the evening automation retracts it `retract_offset` minutes (120) before sunset; "No auto up" once that moment has passed for today.
- Up, stop and down buttons, each disabled when it does not apply and while the screen is unavailable.
- Drag the picture up or down to set a position (100 px for the whole range, snaps to 5 % and to 0/25/50/75/100); a dashed line shows the target.
- Wind warning from gusts of `wind_warning` km/h (40): yellow hem, wind lines, the swaying cloth and a highlighted up button.
- Open doors show the room behind them; the lantern lights up while it is on and toggles on tap.
- Dark (a dark sensor, an illuminance sensor below `dark_below`, or the sun below the horizon): the house goes grey, the rooms and the lantern stay lit, the card dims.
- Every action goes through Home Assistant's own action handler; visual editor; colours configurable.
