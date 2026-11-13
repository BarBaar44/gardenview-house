# Changelog

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
