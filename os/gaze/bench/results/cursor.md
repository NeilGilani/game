# Drawn gaze cursor (SIMULATED)

Synthetic people and webcam (src/synth), typical and low camera noise (bench/lib.ts NOISE), 10 people per row, 30 fixations each
with drift and microsaccades under 1 degree and natural blinks; cursor sampled at 60 Hz. No real person or camera.
Definitions: bench/cursorMetrics.ts. Run: `cd os/gaze && npm run bench:cursor`.

| noise | head | cursor | jitter px (sd) | step px/frame | lag ms (sd) | accuracy px | blink move px | moved while closed px | fixations / saccades / blinks |
| ----- | ---- | ------ | -------------- | ------------- | ----------- | ----------- | ------------- | --------------------- | ----------------------------- |
| typical | still | before: camera frames + CSS transition | 50.0 (7.0) | 10.2 | 338 (75) | 81.5 | 116.8 | 21.2 | 210 / 167 / 77 |
| typical | still | after: engine cursor, every display frame | 38.6 (4.3) | 6.4 | 281 (45) | 72.2 | 27.1 | 8.4 | 210 / 167 / 77 |
| typical | natural | before: camera frames + CSS transition | 53.0 (7.8) | 10.6 | 369 (87) | 92.4 | 110.4 | 20.9 | 210 / 167 / 77 |
| typical | natural | after: engine cursor, every display frame | 37.6 (6.0) | 6.1 | 280 (34) | 81.1 | 22.7 | 8.3 | 210 / 167 / 77 |
| low | still | before: camera frames + CSS transition | 22.0 (2.8) | 5.6 | 137 (14) | 38.2 | 125.4 | 12.9 | 210 / 167 / 77 |
| low | still | after: engine cursor, every display frame | 21.4 (2.9) | 3.2 | 173 (24) | 36.5 | 40.9 | 5.1 | 210 / 167 / 77 |
| low | natural | before: camera frames + CSS transition | 22.3 (2.9) | 5.5 | 150 (23) | 49.6 | 120.8 | 12.8 | 210 / 167 / 77 |
| low | natural | after: engine cursor, every display frame | 21.6 (3.5) | 3.2 | 183 (26) | 46.9 | 39.7 | 5.2 | 210 / 167 / 77 |
