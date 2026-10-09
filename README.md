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

### Advancing route points

`POST /signalk/v2/api/vessels/self/autopilots/_default/courseNextPoint`
advances the active route by one point using the server's Course API. The pilot
must be engaged in route mode. The route direction and arrival circle are
preserved, and the pilot follows the next leg as its calculated values update.
At the final point, the action clears navigation and puts the pilot in standby.
A destination without an active route returns an HTTP 409 error.

Freeboard's automatic arrival handling updates the Course API directly. The
plugin's `courseNextPoint` action serves Autopilot API clients and the plugin's
own automatic arrival handling described below.

### Automatic arrival advancement

Enable **Automatically advance route points on arrival** (`autoAdvance`, disabled
by default) to follow the route without relying on an open Freeboard client.
Select one trigger with `autoAdvanceTrigger`:

- `perpendicularPassed` (default): advance when the perpendicular through the
  current destination has been passed.
- `arrivalCircleEntered`: advance when the vessel enters the destination's arrival
  circle. Set a positive arrival circle radius in the Course API or Freeboard.

The Course Data Provider must be enabled and configured to emit the selected
notification. The actual streamed paths are
`notifications.navigation.course.perpendicularPassed` and
`notifications.navigation.course.arrivalCircleEntered`.

The plugin calls `courseNextPoint` immediately on a new active notification, while
engaged in route mode. Updates to an already active notification, its clearing,
and notifications already active at plugin startup do not trigger advancement.
At the final point, navigation ends and the pilot returns to standby.

**If automatic advancement is enabled in this plugin, disable "Auto-advance to
next point on arrival" in Freeboard. Enabling both can skip a waypoint or end the
route prematurely.**

The two options operate independently. Freeboard's arrival countdown uses the
current route index when it expires: if the plugin has already advanced, Freeboard
can advance again. Clearing the notification can cancel Freeboard's countdown,
but only once the course provider recalculates and Freeboard receives the clear.
Do not rely on that timing to coordinate the two options. The plugin does not
detect or change Freeboard's settings.

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
