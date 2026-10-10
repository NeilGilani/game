# @agency/contracts

Shared types for AGENCY OS (version 0). Every package builds against these from day one, with fakes for parts
that don't exist yet. Owned by Instance 1: request changes in your PR or `os/<area>/INTEGRATION_REQUEST.md`.
Changes should be additive; breaking changes bump `CONTRACTS_VERSION` and are announced in `docs/os/STATUS.md`.

Coordinates are global macOS screen points with the origin at the top-left of the main display.
