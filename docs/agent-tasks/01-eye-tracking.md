# Task 1: Eye tracking that works for real people, all day

**Branch:** `agent/eye-tracking`  ·  **Your area:** `frontend/src/vision/`, `frontend/src/input/`, `os/gaze/`
Read `docs/agent-tasks/RULES.md` first.

## Why
Everything in AGENCY depends on the eye cursor. Today it was tuned on one face, at one desk, for minutes. Real users
have drooping eyelids (ptosis is common in ALS), glasses, dark rooms, head supports, oxygen masks, wheelchairs that
sit low or at an angle, and they use it for 8+ hours a day while getting tired. Make it work for them.

## Build
1. **A test bench you can trust.** A reproducible offline benchmark: synthetic and recorded landmark streams (no raw
   video stored; landmarks only) covering head poses, distances, lighting noise, glasses glare, partial occlusion,
   drooping lids, slow drift and fatigue. Metrics: pointing error (px and degrees), time to select a 96 px target,
   false selections per minute while reading, recovery time after the face is lost. Add a `make gaze-bench` target
   and record a baseline before you change anything.
2. **Better pointing.** Use the benchmark to improve the eye cursor (`frontend/src/vision/eyeCursor.ts`) and gaze
   engine: head-pose compensation, per-person adaptive gain learned silently from confirmed selections, drift
   correction, smarter blink and lid handling, steadier cursor without lag. Every change must beat the baseline;
   show before/after numbers.
3. **Adaptive dwell.** Dwell time and target magnetism that adapt to the person (faster when they're accurate, slower
   when false selections rise, never surprising), with a caregiver override and a "tired mode" that makes
   everything bigger and slower.
4. **Abilities change over time.** In ALS, eye control can weaken. Add a gentle "how is it going" check that suggests
   switching to blink-switch scanning or larger targets when accuracy drops for days, never automatically and never
   with a medical claim.
5. **Camera trouble in plain words.** Detect and explain: too dark, backlit, face too far, camera blocked, glasses
   glare, person looking away. Give one simple fix each.

## Done means
Benchmark committed with baseline and final numbers; measured improvement on the hard cases; adaptive dwell and
tired mode with tests; no regression in existing gaze and e2e tests; report with the numbers.
