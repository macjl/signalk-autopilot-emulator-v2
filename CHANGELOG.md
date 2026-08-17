# Changelog

## 0.1.7

- Add Signal K Autopilot API v2 virtual provider.
- Support compass, GPS, route, apparent wind and true wind modes.
- Publish virtual turn-rate and control-error outputs.
- Make route mode follow route track with bounded cross-track-error correction.
- Use magnetic heading for compass and route steering.
- Make wind target adjustments helm-directional.
- Reject inactive or route read-only commands explicitly.
- Add GitHub Actions CI and npm publish workflows.
