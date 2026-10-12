// Stills taken from the demo recording (public/demo/agency-demo.mp4): the real AGENCY app, recorded with live
// Gemini and practice services. No webcam was on the recording machine, so a scripted pointer stands in for the
// eyes; the yellow ring is the app's own dwell ring. Each still is one frame of the video, saved as a JPEG.

export interface FrameInfo {
  file: string;
  /** Where in the recording the frame comes from, in seconds. */
  at: number;
  alt: string;
}

export const FRAMES: Record<string, FrameInfo> = {
  "food-dwell": {
    file: "food-dwell.jpg",
    at: 7.6,
    alt: "AGENCY's Home: twelve big app tiles. The pointer rests on Food, which is outlined in blue while a yellow ring fills to choose it.",
  },
  "approve-dwell": {
    file: "approve-dwell.jpg",
    at: 26,
    alt: "A task waiting for your OK: pay $24.80 to Thai Basil for Pad thai, delivered home, with every detail listed. The pointer rests on Approve and its yellow ring is filling. Marked simulated.",
  },
  "talk-dwell": {
    file: "talk-dwell.jpg",
    at: 47.5,
    alt: "Talk: big word buttons such as I, want, need, help and stop, and a suggested sentence, “I need help fixing your wheelchair”, being chosen with a look.",
  },
};

export const FRAME_SOURCE =
  "Still from the demo recording of the real app. A scripted pointer stands in for the eyes.";
