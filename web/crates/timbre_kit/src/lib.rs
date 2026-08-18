//! timbre_kit — the client-side Rust that compiles to WebAssembly.
//!
//! The browser captures audio, hands the raw PCM samples to Rust, and Rust does
//! the DSP before the samples go back out. `rms_level` is a minimal example of
//! that seam; build the real work (anonymization / modulation / mixing) here.

use wasm_bindgen::prelude::*;

/// Root-mean-square level of a block of `f32` PCM samples (each in -1.0..=1.0).
#[wasm_bindgen]
pub fn rms_level(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt()
}

/// Volume / Gain Adjustment: multiplies each sample by the specified factor.
#[wasm_bindgen]
pub fn apply_gain(samples: &mut [f32], factor: f32) {
    for sample in samples.iter_mut() {
        *sample *= factor;
    }
}

/// Normalize: scales the signal so that the peak amplitude is exactly 1.0 (or -1.0).
#[wasm_bindgen]
pub fn normalize(samples: &mut [f32]) {
    if samples.is_empty() {
        return;
    }
    let mut max_val: f32 = 0.0;
    for &sample in samples.iter() {
        let abs_s = sample.abs();
        if abs_s > max_val {
            max_val = abs_s;
        }
    }
    if max_val > 0.0 {
        let factor = 1.0 / max_val;
        for sample in samples.iter_mut() {
            *sample *= factor;
        }
    }
}

/// Low-pass filter: simple single-pole RC low-pass filter.
#[wasm_bindgen]
pub fn low_pass_filter(samples: &mut [f32], sample_rate: f32, cutoff_frequency: f32) {
    if samples.is_empty() {
        return;
    }
    let dt = 1.0 / sample_rate;
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_frequency);
    let alpha = dt / (rc + dt);
    
    let mut last_output = samples[0];
    for sample in samples.iter_mut() {
        let current_input = *sample;
        let current_output = last_output + alpha * (current_input - last_output);
        *sample = current_output;
        last_output = current_output;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rms_of_silence_is_zero() {
        assert_eq!(rms_level(&[0.0; 128]), 0.0);
    }

    #[test]
    fn rms_of_empty_is_zero() {
        assert_eq!(rms_level(&[]), 0.0);
    }

    #[test]
    fn rms_of_full_scale_is_one() {
        assert!((rms_level(&[1.0, -1.0, 1.0, -1.0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_apply_gain() {
        let mut samples = vec![0.5, -0.5, 1.0];
        apply_gain(&mut samples, 2.0);
        assert_eq!(samples, vec![1.0, -1.0, 2.0]);
    }

    #[test]
    fn test_normalize() {
        let mut samples = vec![0.5, -0.25, 0.0];
        normalize(&mut samples);
        assert_eq!(samples, vec![1.0, -0.5, 0.0]);
    }

    #[test]
    fn test_low_pass_filter() {
        let mut samples = vec![1.0, 1.0, 1.0, 1.0];
        // Low-pass filter on a constant signal should converge to the constant signal value.
        low_pass_filter(&mut samples, 44100.0, 1000.0);
        assert!((samples[3] - 1.0).abs() < 0.2);
    }
}
