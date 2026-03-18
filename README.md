# Camera Audio Synthesizer

A browser-based audio synthesizer that converts your camera feed into sound in real time. Each pixel in the video frame becomes an oscillator — brighter areas produce louder tones, darker areas produce silence.

## How It Works

The video feed is sampled down to a small pixel grid (4×4 up to 32×32). Each pixel is converted to grayscale, and its brightness drives the amplitude of a corresponding sine wave oscillator. Frequencies are distributed logarithmically across the audible spectrum (50 Hz – 5 kHz), roughly matching human pitch perception.

Pixels are mapped to oscillators using a **Hilbert curve** — a space-filling fractal path that preserves spatial locality, so neighboring pixels in the image tend to map to neighboring frequencies in the sound.

Audio processing runs entirely in an **AudioWorklet** on a dedicated thread, keeping synthesis smooth and glitch-free.

## Controls

| Control | Description |
|---|---|
| **Start / Stop** | Opens the camera and begins audio synthesis |
| **Volume** | Master amplitude multiplier (default is intentionally low — start here) |
| **Grid Size** | Resolution of the pixel grid: 4×4 (16 oscillators) up to 32×32 (1024 oscillators) |

A live **waveform display** shows the synthesized audio output, and a scaled-up **grayscale preview** shows the pixel grid being fed to the synth.

## Usage

Open `index.html` in a modern browser. Grant camera and audio permissions when prompted, then click **Start**.

- Point the camera at **high-contrast scenes** for more dynamic sound
- Use a **small grid size** (4×4 or 8×8) for cleaner, more musical tones
- Use a **large grid size** (32×32) for dense, textural noise
- The environment-facing (rear) camera is used by default on mobile

## Requirements

- A browser supporting **Web Audio API** + **AudioWorklet** (Chrome, Edge, Firefox, Safari 14.1+)
- Camera access
- No build step or dependencies — it's a single HTML file
