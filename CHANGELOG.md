# Changelog

## Unreleased

- Make `courseNextPoint` advance the active route, preserving its direction, and
  end navigation in standby at the final point.
- Add optional automatic advancement using arrival-circle or perpendicular-passed
  notifications, with an explicit warning to disable Freeboard's auto-advance.

## 0.1.10

- Round exposed autopilot targets to the nearest whole degree.

## 0.1.9

- Remove configurable Signal K path options and use the documented defaults.

## 0.1.8

- Persist the virtual autopilot state, mode, target and active dodge across Signal K restarts.
- Resume route mode from live route data instead of a stored route heading.

## 0.1.7

- Add Signal K Autopilot API v2 virtual provider.
- Support compass, GPS, route, apparent wind and true wind modes.
- Publish virtual turn-rate and control-error outputs.
- Make route mode follow route track with bounded cross-track-error correction.
- Use magnetic heading for compass and route steering.
- Make wind target adjustments helm-directional.
- Reject inactive or route read-only commands explicitly.
- Add GitHub Actions CI and npm publish workflows.
