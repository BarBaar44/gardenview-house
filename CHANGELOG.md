# Changelog

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
