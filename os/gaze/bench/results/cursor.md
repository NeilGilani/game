# Drawn gaze cursor (SIMULATED)

Synthetic people and webcam (src/synth), typical and low camera noise (bench/lib.ts NOISE), 10 people per row, 30 fixations each
with drift and microsaccades under 1 degree and natural blinks; cursor sampled at 60 Hz. No real person or camera.
Definitions: bench/cursorMetrics.ts. Run: `cd os/gaze && npm run bench:cursor`.

| noise | head | cursor | jitter px (sd) | step px/frame | lag ms (sd) | accuracy px | blink move px | moved while closed px | fixations / saccades / blinks |
| ----- | ---- | ------ | -------------- | ------------- | ----------- | ----------- | ------------- | --------------------- | ----------------------------- |
| typical | still | before: camera frames + CSS transition | 51.1 (6.5) | 10.4 | 350 (89) | 83.6 | 112.1 | 20.7 | 210 / 167 / 77 |
| typical | still | after: engine cursor, every display frame | 38.1 (7.6) | 6.9 | 276 (33) | 66.4 | 27.8 | 8.4 | 210 / 167 / 77 |
| typical | natural | before: camera frames + CSS transition | 50.9 (8.3) | 10.5 | 355 (88) | 85.2 | 111.7 | 20.5 | 210 / 167 / 77 |
| typical | natural | after: engine cursor, every display frame | 37.3 (6.4) | 6.7 | 282 (51) | 68.0 | 27.0 | 8.5 | 210 / 167 / 77 |
| low | still | before: camera frames + CSS transition | 22.1 (2.8) | 5.3 | 136 (20) | 38.5 | 124.3 | 13.1 | 210 / 167 / 77 |
| low | still | after: engine cursor, every display frame | 21.7 (2.9) | 3.7 | 179 (26) | 32.4 | 42.1 | 5.4 | 210 / 167 / 77 |
| low | natural | before: camera frames + CSS transition | 22.4 (2.8) | 5.5 | 136 (23) | 40.0 | 122.7 | 12.9 | 210 / 167 / 77 |
| low | natural | after: engine cursor, every display frame | 22.6 (2.8) | 3.8 | 169 (26) | 35.3 | 41.7 | 5.3 | 210 / 167 / 77 |
