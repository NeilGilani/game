## Selecting a target in a grid of same-size targets (24 px gaps, dwell 1200 ms, 15 looks of up to 8 s per person; simulated, typical webcam noise)

| head | target px | condition | correct | wrong | timeout | median s | p90 s | people |
|---|---|---|---|---|---|---|---|---|
| still | 96 | no context (= old snap 48 px) | 83% | 10% | 7% | 3.04 | 5.34 | 6 |
| still | 96 | context right, prior 1.25 | 97% | 3% | 0% | 2.17 | 3.49 | 6 |
| still | 96 | context right, prior 1.5 | 98% | 2% | 0% | 1.99 | 3.25 | 6 |
| still | 96 | context right, prior 2 | 99% | 0% | 1% | 1.86 | 2.68 | 6 |
| still | 96 | context right, prior 3 | 100% | 0% | 0% | 1.79 | 2.30 | 6 |
| still | 96 | context wrong, prior 1.25 | 69% | 24% | 7% | 3.41 | 6.09 | 6 |
| still | 96 | context wrong, prior 1.5 | 59% | 37% | 4% | 3.13 | 6.15 | 6 |
| still | 96 | context wrong, prior 2 | 41% | 48% | 11% | 3.29 | 5.81 | 6 |
| still | 96 | context wrong, prior 3 | 31% | 63% | 6% | 2.92 | 5.42 | 6 |
| still | 96 | context right, prior 1.5 + prediction (travel 150 px, default) | 98% | 2% | 0% | 1.91 | 2.93 | 6 |
| still | 96 | context wrong, prior 1.5 + prediction (travel 150 px, default) | 59% | 37% | 4% | 3.09 | 6.15 | 6 |
| still | 96 | context right, prior 1.5 + prediction (travel 60 px) | 98% | 2% | 0% | 1.80 | 2.93 | 6 |
| still | 96 | context wrong, prior 1.5 + prediction (travel 60 px) | 59% | 37% | 4% | 2.92 | 6.15 | 6 |
| still | 96 | context right, prior 1.5 + prediction (travel 300 px) | 98% | 2% | 0% | 1.94 | 2.93 | 6 |
| still | 96 | context wrong, prior 1.5 + prediction (travel 300 px) | 59% | 37% | 4% | 3.12 | 6.15 | 6 |
| still | 120 | no context (= old snap 48 px) | 91% | 7% | 2% | 2.27 | 4.12 | 6 |
| still | 120 | context right, prior 1.25 | 100% | 0% | 0% | 2.00 | 3.36 | 6 |
| still | 120 | context right, prior 1.5 | 100% | 0% | 0% | 1.91 | 2.51 | 6 |
| still | 120 | context right, prior 2 | 100% | 0% | 0% | 1.80 | 2.29 | 6 |
| still | 120 | context right, prior 3 | 100% | 0% | 0% | 1.74 | 2.18 | 6 |
| still | 120 | context wrong, prior 1.25 | 88% | 10% | 2% | 2.43 | 4.42 | 6 |
| still | 120 | context wrong, prior 1.5 | 77% | 19% | 4% | 2.46 | 4.64 | 6 |
| still | 120 | context wrong, prior 2 | 66% | 31% | 3% | 2.70 | 5.43 | 6 |
| still | 120 | context wrong, prior 3 | 46% | 44% | 10% | 2.87 | 5.43 | 6 |
| still | 120 | context right, prior 1.5 + prediction (travel 150 px, default) | 100% | 0% | 0% | 1.76 | 2.48 | 6 |
| still | 120 | context wrong, prior 1.5 + prediction (travel 150 px, default) | 76% | 21% | 3% | 2.38 | 4.64 | 6 |
| still | 120 | context right, prior 1.5 + prediction (travel 60 px) | 100% | 0% | 0% | 1.67 | 2.46 | 6 |
| still | 120 | context wrong, prior 1.5 + prediction (travel 60 px) | 76% | 21% | 3% | 2.38 | 4.64 | 6 |
| still | 120 | context right, prior 1.5 + prediction (travel 300 px) | 100% | 0% | 0% | 1.84 | 2.48 | 6 |
| still | 120 | context wrong, prior 1.5 + prediction (travel 300 px) | 76% | 21% | 3% | 2.38 | 4.64 | 6 |
| natural | 96 | no context (= old snap 48 px) | 79% | 16% | 6% | 3.36 | 6.82 | 6 |
| natural | 96 | context right, prior 1.25 | 96% | 3% | 1% | 2.20 | 4.61 | 6 |
| natural | 96 | context right, prior 1.5 | 99% | 1% | 0% | 2.01 | 3.58 | 6 |
| natural | 96 | context right, prior 2 | 100% | 0% | 0% | 1.87 | 3.02 | 6 |
| natural | 96 | context right, prior 3 | 100% | 0% | 0% | 1.74 | 2.33 | 6 |
| natural | 96 | context wrong, prior 1.25 | 68% | 27% | 6% | 3.45 | 6.10 | 6 |
| natural | 96 | context wrong, prior 1.5 | 59% | 40% | 1% | 3.40 | 6.10 | 6 |
| natural | 96 | context wrong, prior 2 | 33% | 59% | 8% | 3.18 | 6.71 | 6 |
| natural | 96 | context wrong, prior 3 | 16% | 78% | 7% | 2.77 | 5.45 | 6 |
| natural | 96 | context right, prior 1.5 + prediction (travel 150 px, default) | 99% | 1% | 0% | 1.89 | 3.56 | 6 |
| natural | 96 | context wrong, prior 1.5 + prediction (travel 150 px, default) | 59% | 40% | 1% | 3.40 | 6.10 | 6 |
| natural | 96 | context right, prior 1.5 + prediction (travel 60 px) | 99% | 1% | 0% | 1.81 | 3.33 | 6 |
| natural | 96 | context wrong, prior 1.5 + prediction (travel 60 px) | 58% | 41% | 1% | 3.39 | 6.10 | 6 |
| natural | 96 | context right, prior 1.5 + prediction (travel 300 px) | 99% | 1% | 0% | 1.95 | 3.56 | 6 |
| natural | 96 | context wrong, prior 1.5 + prediction (travel 300 px) | 59% | 40% | 1% | 3.40 | 6.10 | 6 |
| natural | 120 | no context (= old snap 48 px) | 88% | 10% | 2% | 2.33 | 3.81 | 6 |
| natural | 120 | context right, prior 1.25 | 100% | 0% | 0% | 2.00 | 3.92 | 6 |
| natural | 120 | context right, prior 1.5 | 100% | 0% | 0% | 1.93 | 2.72 | 6 |
| natural | 120 | context right, prior 2 | 100% | 0% | 0% | 1.81 | 2.33 | 6 |
| natural | 120 | context right, prior 3 | 100% | 0% | 0% | 1.72 | 2.17 | 6 |
| natural | 120 | context wrong, prior 1.25 | 81% | 18% | 1% | 2.46 | 4.49 | 6 |
| natural | 120 | context wrong, prior 1.5 | 66% | 28% | 7% | 2.53 | 5.01 | 6 |
| natural | 120 | context wrong, prior 2 | 50% | 48% | 2% | 2.67 | 5.25 | 6 |
| natural | 120 | context wrong, prior 3 | 33% | 62% | 4% | 2.76 | 5.12 | 6 |
| natural | 120 | context right, prior 1.5 + prediction (travel 150 px, default) | 100% | 0% | 0% | 1.80 | 2.72 | 6 |
| natural | 120 | context wrong, prior 1.5 + prediction (travel 150 px, default) | 64% | 29% | 7% | 2.49 | 5.01 | 6 |
| natural | 120 | context right, prior 1.5 + prediction (travel 60 px) | 100% | 0% | 0% | 1.78 | 2.55 | 6 |
| natural | 120 | context wrong, prior 1.5 + prediction (travel 60 px) | 64% | 29% | 7% | 2.49 | 5.01 | 6 |
| natural | 120 | context right, prior 1.5 + prediction (travel 300 px) | 100% | 0% | 0% | 1.87 | 2.72 | 6 |
| natural | 120 | context wrong, prior 1.5 + prediction (travel 300 px) | 64% | 29% | 7% | 2.49 | 5.01 | 6 |

### When does a prior pay off? (all rows above pooled)

| prior | correct, no context | correct, context right | correct, context wrong | context must be right at least |
|---|---|---|---|---|
| 1.25 | 85% | 98% | 76% | 41% of the time |
| 1.5 | 85% | 99% | 65% | 59% of the time |
| 2 | 85% | 100% | 48% | 72% of the time |
| 3 | 85% | 100% | 31% | 79% of the time |

Error radius the engine reported during these looks (px, about 2 sigma): median 103, 10th percentile 85, 90th 120.

## Selections nobody wanted while reading (three pages under a grid of 96 px targets, 1 in 8 marked likely, prior 1.5; simulated)

| head | condition | per minute | minutes |
|---|---|---|---|
| still | no context (= old snap 48 px) | 0.00 | 13.0 |
| still | likely targets, prior 1.5 | 0.00 | 13.0 |
| still | likely targets, prior 1.5 + prediction (travel 150 px, default) | 0.38 | 13.0 |
| still | likely targets, prior 1.5 + prediction (travel 60 px) | 0.46 | 13.0 |
| still | likely targets, prior 1.5 + prediction (travel 300 px) | 0.46 | 13.0 |
| natural | no context (= old snap 48 px) | 0.00 | 13.0 |
| natural | likely targets, prior 1.5 | 0.46 | 13.0 |
| natural | likely targets, prior 1.5 + prediction (travel 150 px, default) | 0.77 | 13.0 |
| natural | likely targets, prior 1.5 + prediction (travel 60 px) | 0.77 | 13.0 |
| natural | likely targets, prior 1.5 + prediction (travel 300 px) | 0.77 | 13.0 |
