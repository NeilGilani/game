# Drawn gaze cursor (SIMULATED)

Synthetic people and webcam (src/synth), typical noise, 10 people per row, 30 fixations each
with drift and microsaccades under 1 degree and natural blinks; cursor sampled at 60 Hz. No real person or camera.
Definitions: bench/cursorMetrics.ts. Run: `cd os/gaze && npm run bench:cursor`.

| head | cursor | jitter px (sd) | step px/frame | lag ms (sd) | accuracy px | blink move px | fixations / saccades / blinks |
| ---- | ------ | -------------- | ------------- | ----------- | ----------- | ------------- | ----------------------------- |
| still | before: camera frames + CSS transition | 50.0 (7.0) | 10.2 | 338 (75) | 81.5 | 116.8 | 210 / 167 / 77 |
| natural | before: camera frames + CSS transition | 53.0 (7.8) | 10.6 | 369 (87) | 92.4 | 110.4 | 210 / 167 / 77 |
