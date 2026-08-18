# Rust WebAssembly (WASM) DSP Module

The client-side digital signal processing is powered by a Rust crate located at `web/crates/timbre_kit`. By compiling Rust to WebAssembly using `wasm-pack`, we execute CPU-intensive audio mathematical transforms at native speed directly inside the browser.

---

## ⚡ 1. DSP Algorithms Implemented

Three signal processing algorithms are implemented in [lib.rs](file:///home/dell/iv-fullstack-eng-assignment-ArnavPundir22-main/web/crates/timbre_kit/src/lib.rs):

### A. Volume / Gain Adjustment
Multiplies the amplitude of each sample by a constant factor.
* **Math**: \(y[t] = x[t] \cdot \text{factor}\)
* **Code**:
  ```rust
  pub fn apply_gain(samples: &mut [f32], factor: f32) {
      for sample in samples.iter_mut() {
          *sample *= factor;
      }
  }
  ```

### B. Peak Normalization
Analyzes the entire signal to find the absolute maximum peak amplitude, then scales the entire signal so that the peak is exactly `1.0` (or `-1.0`). This maximizes volume without causing clipping distortion.
* **Math**: \(y[t] = x[t] \cdot \frac{1}{\max(|x|)}\)
* **Code**:
  ```rust
  pub fn normalize(samples: &mut [f32]) {
      // Find peak amplitude...
      let factor = 1.0 / max_val;
      // Scale all samples...
  }
  ```

### C. Low-Pass Filter
Implements a single-pole RC low-pass filter. It attenuates frequencies above a specified cutoff frequency while allowing lower frequencies to pass through.
* **Math**:
  The digital coefficient \(\alpha\) is derived from the cutoff frequency \(f_c\) and sample rate \(f_s\):
  \[\alpha = \frac{dt}{RC + dt} \quad \text{where} \quad dt = \frac{1}{f_s}, \quad RC = \frac{1}{2 \pi f_c}\]
  The difference equation for the filter is:
  \[y[t] = y[t-1] + \alpha \cdot (x[t] - y[t-1])\]
* **Code**:
  ```rust
  pub fn low_pass_filter(samples: &mut [f32], sample_rate: f32, cutoff_frequency: f32) {
      let dt = 1.0 / sample_rate;
      let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_frequency);
      let alpha = dt / (rc + dt);
      // Loop and filter...
  }
  ```

---

## 🧠 2. WebAssembly Memory Sharing

A key performance feature of WebAssembly is **shared memory**:
* In `timbre_kit`, functions accept slices (`&[f32]` or `&mut [f32]`).
* The JavaScript side allocates memory inside the WASM linear memory heap.
* When JS passes a `Float32Array` view pointing to the WASM heap, the Rust code operates directly on that buffer in-place without copying data between the JS VM and the WebAssembly engine.
* This allows processing millions of audio samples in milliseconds with zero garbage collection overhead.
