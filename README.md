# signalk-autopilot-emulator-v2

Minimal Signal K plugin that exposes a virtual autopilot through the Autopilot API v2.

It intentionally has no webapp and does not implement legacy v1 PUT handlers. Clients such as SKIP, Freeboard or a dedicated autopilot UI should talk to:

`/signalk/v2/api/vessels/self/autopilots/_default`

## Behaviour

- Registers one virtual autopilot device, `virtual` by default.
- Publishes API v2 heartbeat updates through `app.autopilotUpdate()`.
- Supports `standby` and `auto` states.
- Supports `compass`, `gps`, `windApparent` and `windTrue` modes.
- Does not implement route following yet.
- Publishes a controller output at `steering.autopilot.output.turnRate`.

The turn-rate output is in `rad/s`. Positive values command a turn to starboard. In `compass` mode the output is proportional to `target - heading`; in `gps` mode it is proportional to `target - course over ground`; in wind modes the sign is reversed because wind angle is relative to the bow.

Route following would need active navigation data such as waypoint bearing and cross-track error. Until that steering law exists, route actions are reported as unavailable and reject calls explicitly.

## Default Inputs

- `navigation.headingTrue.value`
- `navigation.courseOverGroundTrue.value`
- `environment.wind.angleApparent.value`
- `environment.wind.angleTrueWater.value`

Inputs are intentionally mode-specific. `compass` reads the configured heading path, while `gps` reads the configured course path; the plugin does not silently fall back from heading to course over ground.

## Install From A Local Pack

```sh
npm pack
npm install ./signalk-autopilot-emulator-v2-0.1.2.tgz
```
