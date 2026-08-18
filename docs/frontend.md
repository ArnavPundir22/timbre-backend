# Frontend Architecture — React 19 Web App

The frontend is a single-page React 19 application built with Vite and styled using Tailwind CSS. It is designed to capture audio, interact with the local WebAssembly DSP module, and communicate with the Phoenix backend via HTTP and WebSockets.

---

## 🎹 1. Web Audio API Pipeline

Browser-based audio capturing utilizes the browser's **Web Audio API** and `MediaRecorder` API:

```
[Mic Stream] ──> [MediaRecorder] ──(stops)──> [Blob] ──> [AudioContext.decodeAudioData] ──> [Float32Array PCM]
```

### Why we decode to Float32Array PCM:
* Standard browser recorders produce compressed audio formats (like `.webm` or `.ogg`) depending on the browser.
* To perform Digital Signal Processing (DSP) in Rust, we need the raw, uncompressed pulse-code modulation (PCM) values.
* By passing the recorded blob through the browser's native audio decoder (`AudioContext.decodeAudioData`), we extract a raw `Float32Array` containing the audio amplitude values scaled between `-1.0` and `+1.0`.

---

## 🛠️ 2. Dynamic DSP Preview Flow

When the user changes parameters (such as volume gain or the low-pass filter cutoff frequency), the UI does not modify the original recorded audio buffer. Instead:
1. It keeps a pristine copy of the **original raw PCM** array in React state (`rawPCM`).
2. When parameters change, a React `useEffect` hook clones the buffer.
3. It calls the WebAssembly functions in-place on the cloned array.
4. The processed PCM array is passed to the **WAV Encoder** to create a preview URL.
5. The preview audio player's `src` is updated instantly, providing zero-latency in-browser previewing of the effects.

---

## 📄 3. Client-Side WAV Encoder

Because browsers do not natively encode raw PCM float arrays into standard `.wav` files, the application contains a custom WAV encoder implemented in TypeScript:

```typescript
const bufferToWav = (buffer: Float32Array, sampleRate: number): Blob => {
  const bufferLength = buffer.length;
  const wavBuffer = new ArrayBuffer(44 + bufferLength * 2); // 44 bytes header + 16-bit samples
  const view = new DataView(wavBuffer);

  // Write RIFF WAVE headers...
  // Convert float32 [-1.0, 1.0] to signed 16-bit integers...
}
```

### Mathematical Conversion (Float32 to Int16):
To convert floating-point samples (between `-1.0` and `1.0`) to 16-bit signed integers (between `-32768` and `32767`):
* If the sample is negative, we multiply by `32768` (`0x8000`).
* If positive, we multiply by `32767` (`0x7FFF`).
* We clamp values to prevent clipping distortion before writing them in little-endian format.

---

## 👥 4. Real-Time Multiplayer Capture

During a multiplayer session, the app uses a `ScriptProcessorNode` to capture mic audio chunk-by-chunk in real-time.
* A buffer size of `4096` samples is used.
* Every time the microphone fills the buffer, the `onaudioprocess` handler is called.
* The Float32 samples are converted to 16-bit PCM (little-endian), encoded to **Base64**, and pushed to the Phoenix WebSocket Channel under the `"audio_chunk"` event.
