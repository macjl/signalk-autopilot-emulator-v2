# signalk-autopilot-emulator-v2

Minimal Signal K plugin that exposes a virtual autopilot through the Autopilot API v2.

It intentionally has no webapp and does not implement legacy v1 PUT handlers. Clients such as SKIP, Freeboard or a dedicated autopilot UI should talk to:

`/signalk/v2/api/vessels/self/autopilots/_default`

## Behaviour

- Registers one virtual autopilot device, `virtual` by default.
- Publishes API v2 heartbeat updates through `app.autopilotUpdate()`.
- Supports `standby` and `auto` states.
- Supports `compass`, `gps`, `route`, `windApparent` and `windTrue` modes.
- Publishes a controller output at `steering.autopilot.output.turnRate`.
- Persists the selected mode, engagement state, target and any active dodge in
  the plugin data directory, so they are restored after a Signal K restart.
  Route mode resumes from the current route data rather than a stale heading.

The turn-rate output is in `rad/s`. Positive values command a turn to starboard. In `compass` mode the output is proportional to `target - heading`; in `gps` mode it is proportional to `target - course over ground`; in `route` mode it is proportional to the dynamic route target heading minus heading; in wind modes the sign is reversed because wind angle is relative to the bow.

Target adjustments are helm-directional. In wind modes, `+10` commands 10 degrees to starboard and `-10` commands 10 degrees to port, even though Signal K wind angles are signed values where port tack is negative.

Targets are rounded to the nearest whole degree before being exposed through the API.

Route mode follows the same simple logic as the legacy emulator work: route target heading is based on `bearingTrackTrue`, with a bounded correction of `-atan(crossTrackError / routeXteLookahead)`. Positive cross-track error steers left, negative cross-track error steers right. True route bearings are converted to magnetic when `navigation.magneticVariation.value` is available, so route mode steers against the same magnetic heading input as compass mode.

## Default Inputs

- `navigation.headingMagnetic.value`
- `navigation.courseOverGroundTrue.value`
- `navigation.course.calcValues.bearingTrackTrue.value`
- `navigation.course.calcValues.crossTrackError.value`
- `environment.wind.angleApparent.value`
- `environment.wind.angleTrueWater.value`

Inputs are intentionally mode-specific and fixed to the default paths above. `compass` reads magnetic heading, `gps` reads course over ground, and `route` reads the route paths; the plugin does not silently fall back from heading to course over ground.

## Install From A Local Pack

```sh
npm pack
npm install ./signalk-autopilot-emulator-v2-0.1.7.tgz
```
