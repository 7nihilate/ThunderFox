'use strict';

/**
 * Test signal generators and measurements. Everything is mono Float32Array
 * in, numbers out; `stereo()` duplicates a signal for the processors, which
 * expect an array of channels.
 */

function dbToGain(db) {
    return Math.pow(10, db / 20);
}

function gainToDb(gain) {
    return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

function silence(seconds, rate) {
    return new Float32Array(Math.round(seconds * rate));
}

function tone(frequency, seconds, rate, amplitude) {
    const out = new Float32Array(Math.round(seconds * rate));
    const step = (2 * Math.PI * frequency) / rate;
    for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(step * i);
    return out;
}

// One sample at `amplitude` after `offsetSeconds` of silence.
function impulse(seconds, rate, amplitude, offsetSeconds) {
    const out = new Float32Array(Math.round(seconds * rate));
    out[Math.round((offsetSeconds || 0) * rate)] = amplitude;
    return out;
}

// A tone whose amplitude switches between levels (in dB) at the given times,
// so attack and release can be read off the output envelope.
function steppedTone(frequency, rate, steps) {
    const total = steps[steps.length - 1].until;
    const out = new Float32Array(Math.round(total * rate));
    const step = (2 * Math.PI * frequency) / rate;
    let from = 0;
    steps.forEach((segment) => {
        const to = Math.round(segment.until * rate);
        const amplitude = dbToGain(segment.db);
        for (let i = from; i < to; i++) out[i] = amplitude * Math.sin(step * i);
        from = to;
    });
    return out;
}

// A kick every `beat` seconds (120 to 45 Hz sweep, 120 ms decay) and a 55 Hz
// bass note on the off-beat (300 ms decay). Most of what a low band sees.
function kickBass(seconds, rate, beat) {
    const period = beat || 0.5;
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) {
        const t = i / rate;
        const tk = t % period;
        const phase = 2 * Math.PI * (45 * tk + 75 * 0.02 * (1 - Math.exp(-tk / 0.02)));
        const kick = 0.8 * Math.exp(-tk / 0.12) * Math.sin(phase);
        const tb = (t + period / 2) % period;
        const bass = 0.4 * Math.exp(-tb / 0.3) * Math.sin(2 * Math.PI * 55 * t);
        out[i] = kick + bass;
    }
    return out;
}

// A tone whose level wobbles: `centreDb` +/- `swingDb` at `wobbleHz`.
function wobblingTone(frequency, seconds, rate, centreDb, swingDb, wobbleHz) {
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) {
        const t = i / rate;
        out[i] = dbToGain(centreDb + swingDb * Math.sin(2 * Math.PI * wobbleHz * t))
            * Math.sin(2 * Math.PI * frequency * t);
    }
    return out;
}

// Naive square/pulse wave: instantaneous edges, so the input itself already
// contains folded harmonics. A stress signal, not a clean reference.
function squareNaive(frequency, seconds, rate, amplitude, duty) {
    const d = duty === undefined ? 0.5 : duty;
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i++) {
        out[i] = ((i * frequency) / rate) % 1 < d ? amplitude : -amplitude;
    }
    return out;
}

// Band-limited pulse wave: the Fourier series of a rectangular wave at the
// given duty cycle, truncated below 0.45 * rate. Every harmonic present is
// exact, so anything off the harmonic grid in the output was made by the
// processor. Above rate/6 only the fundamental fits and this degenerates to
// a sine, which is fine — the artifact under test is processor-generated
// either way.
function squareBandlimited(frequency, seconds, rate, amplitude, duty) {
    const d = duty === undefined ? 0.5 : duty;
    const out = new Float32Array(Math.round(seconds * rate));
    for (let h = 1; h * frequency < 0.45 * rate; h++) {
        const coefficient = ((4 * amplitude) / (Math.PI * h)) * Math.sin(Math.PI * h * d);
        if (coefficient === 0) continue;
        const step = (2 * Math.PI * h * frequency) / rate;
        for (let i = 0; i < out.length; i++) out[i] += coefficient * Math.sin(step * i);
    }
    return out;
}

// A sum of sines at the given frequencies, Schroeder-phased so the crest
// factor stays bounded rather than piling every tone onto one peak.
function multitone(frequencies, seconds, rate, amplitudePerTone) {
    const out = new Float32Array(Math.round(seconds * rate));
    frequencies.forEach((frequency, k) => {
        const phase = (Math.PI * k * k) / frequencies.length;
        const step = (2 * Math.PI * frequency) / rate;
        for (let i = 0; i < out.length; i++) {
            out[i] += amplitudePerTone * Math.sin(step * i + phase);
        }
    });
    return out;
}

// Deterministic noise in -1..1, so a test that uses it measures the same thing
// on every run.
function noise(seconds, rate, seed) {
    const out = new Float32Array(Math.round(seconds * rate));
    let state = (seed || 1) >>> 0;
    for (let i = 0; i < out.length; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        out[i] = state / 2147483648 - 1;
    }
    return out;
}

// Deterministic pink (1/f) noise at the given RMS level in dBFS: white noise
// through a sum of one-pole lowpasses spaced to approximate -3 dB/octave
// across the audio band. Equal energy per octave, so every band of a
// multiband split gets a comparable share, as with most music.
function pink(seconds, rate, rmsDb, seed) {
    const white = noise(seconds, rate, seed);
    const out = new Float32Array(white.length);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let sum = 0;
    for (let i = 0; i < white.length; i++) {
        const x = white[i];
        b0 = 0.99886 * b0 + x * 0.0555179;
        b1 = 0.99332 * b1 + x * 0.0750759;
        b2 = 0.96900 * b2 + x * 0.1538520;
        b3 = 0.86650 * b3 + x * 0.3104856;
        b4 = 0.55000 * b4 + x * 0.5329522;
        b5 = -0.7616 * b5 - x * 0.0168980;
        out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
        b6 = x * 0.115926;
        sum += out[i] * out[i];
    }
    const scale = dbToGain(rmsDb) / Math.sqrt(sum / out.length);
    for (let i = 0; i < out.length; i++) out[i] *= scale;
    return out;
}

// Dense programme material, normalised to a peak of 1: a sustained chord and
// a noise floor, a kick on every beat and a noise burst on every off-beat.
// The hits stand 12 dB or so above the bed, so a limiter driven by this has
// something to hold down all the time and something to catch twice a beat.
function drumsOverBed(seconds, rate, beat) {
    const period = beat || 0.5;
    const out = new Float32Array(Math.round(seconds * rate));
    const hiss = noise(seconds, rate, 7);
    const burst = noise(seconds, rate, 11);
    let max = 0;
    for (let i = 0; i < out.length; i++) {
        const t = i / rate;
        const bed = 0.12 * (Math.sin(2 * Math.PI * 220 * t)
            + Math.sin(2 * Math.PI * 277.2 * t + 1)
            + Math.sin(2 * Math.PI * 329.6 * t + 2)
            + 0.5 * Math.sin(2 * Math.PI * 880 * t + 0.5))
            + 0.03 * hiss[i];
        const tk = t % period;
        const phase = 2 * Math.PI * (45 * tk + 75 * 0.02 * (1 - Math.exp(-tk / 0.02)));
        const kick = 0.9 * Math.exp(-tk / 0.09) * Math.sin(phase);
        const ts = (t + period / 2) % period;
        const snare = 0.5 * Math.exp(-ts / 0.04) * burst[i];
        out[i] = bed + kick + snare;
        const magnitude = out[i] < 0 ? -out[i] : out[i];
        if (magnitude > max) max = magnitude;
    }
    for (let i = 0; i < out.length; i++) out[i] /= max;
    return out;
}

function concat(parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Float32Array(length);
    let offset = 0;
    parts.forEach((part) => { out.set(part, offset); offset += part.length; });
    return out;
}

function stereo(mono) {
    return [mono, Float32Array.from(mono)];
}

/* ------------------------------------------------------------ measurement */

function peak(signal, from, to) {
    let max = 0;
    const end = to === undefined ? signal.length : to;
    for (let i = from || 0; i < end; i++) {
        const magnitude = signal[i] < 0 ? -signal[i] : signal[i];
        if (magnitude > max) max = magnitude;
    }
    return max;
}

function rms(signal, from, to) {
    const end = to === undefined ? signal.length : to;
    const start = from || 0;
    let sum = 0;
    for (let i = start; i < end; i++) sum += signal[i] * signal[i];
    return Math.sqrt(sum / Math.max(1, end - start));
}

function hasNonFinite(signal) {
    for (let i = 0; i < signal.length; i++) if (!isFinite(signal[i])) return true;
    return false;
}

// Goertzel power at one frequency over [from, to).
function power(signal, frequency, rate, from, to) {
    const end = to === undefined ? signal.length : to;
    const start = from || 0;
    const n = end - start;
    const k = Math.round((n * frequency) / rate);
    const w = (2 * Math.PI * k) / n;
    const coefficient = 2 * Math.cos(w);
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = start; i < end; i++) {
        s0 = signal[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return (s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (n * n);
}

// Total harmonic distortion in dB relative to the fundamental, harmonics 2..N.
function thdDb(signal, fundamental, rate, from, to, harmonics) {
    const base = power(signal, fundamental, rate, from, to);
    let sum = 0;
    for (let h = 2; h <= (harmonics || 10); h++) {
        if (fundamental * h >= rate / 2) break;
        sum += power(signal, fundamental * h, rate, from, to);
    }
    return base > 0 ? 10 * Math.log10(sum / base) : -Infinity;
}

/**
 * The worst discrete off-harmonic tone, in dB relative to the fundamental,
 * and where it sits: a Goertzel scan from 300 Hz to just below Nyquist,
 * skipping a guard band around every harmonic of the fundamental. The metric
 * is a max with a guard band, not an integral, and that matters: the upward
 * stage legitimately amplitude-modulates the band it rides, which puts a
 * broad, masked skirt around the carrier and its harmonics. The audible
 * defect is different — a discrete aliased tone far from any harmonic — and
 * only a guarded max sees it instead of the skirt.
 */
function worstSpurDb(signal, fundamental, rate, from, to, guardHz, stepHz) {
    const guard = guardHz === undefined ? 400 : guardHz;
    const step = stepHz === undefined ? 50 : stepHz;
    const base = power(signal, fundamental, rate, from, to);
    let worst = 0;
    let worstHz = NaN;
    for (let f = 300; f < rate / 2 - 100; f += step) {
        const nearestHarmonic = Math.round(f / fundamental) * fundamental;
        if (Math.abs(f - nearestHarmonic) < guard) continue;
        const p = power(signal, f, rate, from, to);
        if (p > worst) { worst = p; worstHz = f; }
    }
    return {
        db: base > 0 && worst > 0 ? 10 * Math.log10(worst / base) : -Infinity,
        hz: worstHz
    };
}

// Integrated off-harmonic energy relative to the fundamental: total power
// minus the harmonic bins. Dominated by the benign AM skirt around the
// carrier, so it is for reporting only — worstSpurDb is the metric that
// matches what is heard.
function inharmonicRatioDb(signal, fundamental, rate, from, to) {
    const end = to === undefined ? signal.length : to;
    const start = from || 0;
    const base = power(signal, fundamental, rate, start, end);
    let total = 0;
    for (let i = start; i < end; i++) total += signal[i] * signal[i];
    total /= Math.max(1, end - start);
    // Goertzel power is the tone's mean-square amplitude contribution.
    let harmonic = 0;
    for (let h = 1; h * fundamental < rate / 2; h++) {
        harmonic += power(signal, h * fundamental, rate, start, end);
    }
    const residual = Math.max(0, total - harmonic);
    return base > 0 && residual > 0 ? 10 * Math.log10(residual / base) : -Infinity;
}

// Per-tone output/input power ratio in dB: the magnitude response through a
// processor, measured with a multitone of the same frequencies.
function toneGainsDb(input, output, frequencies, rate, from, to) {
    return frequencies.map((frequency) => {
        const pIn = power(input, frequency, rate, from, to);
        const pOut = power(output, frequency, rate, from, to);
        return pIn > 0 ? 10 * Math.log10(pOut / pIn) : NaN;
    });
}

// A comb notch reads as one tone sitting well below the average of its two
// neighbours; a smooth tilt or shelf reads near zero.
function notchDepthDb(gainsDb) {
    let worst = 0;
    for (let i = 1; i < gainsDb.length - 1; i++) {
        const dip = (gainsDb[i - 1] + gainsDb[i + 1]) / 2 - gainsDb[i];
        if (dip > worst) worst = dip;
    }
    return worst;
}

/**
 * Output-over-input level per window, in dB: the gain trajectory a dynamics
 * stage applied. Levels are per-window peaks, which for a tone are exact
 * whenever the window is at least one period long and phase-independent
 * otherwise, unlike an RMS over a fraction of a cycle.
 */
function gainTrack(input, output, rate, windowSeconds) {
    const window = Math.max(1, Math.round(windowSeconds * rate));
    const track = [];
    for (let start = 0; start + window <= input.length; start += window) {
        const inLevel = peak(input, start, start + window);
        const outLevel = peak(output, start, start + window);
        track.push({
            time: start / rate,
            db: inLevel > 1e-9 ? gainToDb(outLevel / inLevel) : NaN
        });
    }
    return track;
}

/**
 * Time for the gain to cover 63% of the change between its value before
 * `stepTime` and its settled value from `settledTime` on. `skipSeconds`
 * after the step is ignored, because a level step leaves the crossover
 * filters ringing with the old level for a millisecond or so, which reads as
 * a spurious gain jump against the new input level.
 */
function timeConstant(track, stepTime, settledTime, skipSeconds) {
    const before = track.filter((p) => p.time >= stepTime - 0.02 && p.time < stepTime && !isNaN(p.db));
    const after = track.filter((p) => p.time >= settledTime && !isNaN(p.db));
    if (before.length === 0 || after.length === 0) return NaN;
    const mean = (list) => list.reduce((sum, p) => sum + p.db, 0) / list.length;
    const start = mean(before);
    const target = mean(after);
    const goal = start + 0.63 * (target - start);
    const rising = target > start;
    const from = stepTime + (skipSeconds || 0);
    for (const point of track) {
        if (point.time < from || isNaN(point.db)) continue;
        if (rising ? point.db >= goal : point.db <= goal) return point.time - stepTime;
    }
    return NaN;
}

/**
 * How rough a per-sample gain trajectory (in dB) is, ignoring the first
 * `settleSeconds`: the largest change between consecutive samples, and the
 * RMS of the trajectory above `cutoffHz`. A click is a large step; jitter is
 * energy well above the rate at which the music's level actually changes.
 */
function gainRoughness(gainDb, rate, settleSeconds, cutoffHz) {
    const skip = Math.round((settleSeconds || 0) * rate);
    const c = Math.exp((-2 * Math.PI * (cutoffHz || 15)) / rate);
    let maxStep = 0;
    let highpassed = 0;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < gainDb.length; i++) {
        highpassed = c * (highpassed + gainDb[i] - gainDb[i - 1]);
        if (i < skip) continue;
        const step = Math.abs(gainDb[i] - gainDb[i - 1]);
        if (step > maxStep) maxStep = step;
        sum += highpassed * highpassed;
        count++;
    }
    return { maxStepDb: maxStep, modulationDb: count > 0 ? Math.sqrt(sum / count) : NaN };
}

/**
 * The reconstructed peak over [from, to): the signal interpolated at 8x with
 * a 64-tap Hann-windowed sinc. Much longer than the detector inside the
 * limiter, so it can stand as the reference the detector is judged against.
 */
function truePeak(signal, from, to) {
    const half = 32;
    const phases = 8;
    const kernels = [];
    for (let p = 0; p < phases; p++) {
        const kernel = new Float64Array(2 * half);
        for (let k = 0; k < 2 * half; k++) {
            const d = k - half + 1 - p / phases;
            const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
            kernel[k] = Math.abs(d) < half ? sinc * (0.5 + 0.5 * Math.cos((Math.PI * d) / half)) : 0;
        }
        kernels.push(kernel);
    }
    const start = Math.max(from || 0, half);
    const end = Math.min(to === undefined ? signal.length : to, signal.length - half - 1);
    let max = 0;
    for (let i = start; i < end; i++) {
        for (let p = 0; p < phases; p++) {
            const kernel = kernels[p];
            let sum = 0;
            for (let k = 0; k < 2 * half; k++) sum += kernel[k] * signal[i - half + 1 + k];
            const magnitude = sum < 0 ? -sum : sum;
            if (magnitude > max) max = magnitude;
        }
    }
    return max;
}

/**
 * Pumping in a per-sample gain trajectory (in dB), ignoring the first
 * `settleSeconds`. The trajectory is averaged over 100 ms first, which takes
 * out the dip that catches a transient and is masked by it, and leaves the
 * movement slow enough to be heard as the level going up and down. Returns
 * the averaged gain's peak-to-peak swing and its largest rise within 250 ms.
 */
function gainPumping(gainDb, rate, settleSeconds) {
    const window = Math.round(0.1 * rate);
    const hop = Math.round(0.25 * rate);
    const from = Math.max(window, Math.round((settleSeconds || 0) * rate));
    const averaged = [];
    let sum = 0;
    for (let i = from - window; i < gainDb.length; i++) {
        sum += gainDb[i];
        if (i >= from) {
            sum -= gainDb[i - window];
            averaged.push(sum / window);
        }
    }
    let min = Infinity;
    let max = -Infinity;
    let rise = 0;
    for (let i = 0; i < averaged.length; i++) {
        if (averaged[i] < min) min = averaged[i];
        if (averaged[i] > max) max = averaged[i];
        if (i >= hop && averaged[i] - averaged[i - hop] > rise) rise = averaged[i] - averaged[i - hop];
    }
    return { swingDb: max - min, riseDb: rise };
}

/**
 * The strongest amplitude-modulation sideband of a carrier at `f0`, in dB
 * relative to the carrier: Goertzel power at f0 +/- each offset. The window
 * must be long enough to resolve the offsets (bin spacing rate / n).
 */
function sidebandDb(signal, f0, rate, offsetsHz, from, to) {
    const carrier = power(signal, f0, rate, from, to);
    let worst = 0;
    offsetsHz.forEach((offset) => {
        worst = Math.max(worst,
            power(signal, f0 - offset, rate, from, to),
            power(signal, f0 + offset, rate, from, to));
    });
    return carrier > 0 && worst > 0 ? 10 * Math.log10(worst / carrier) : -Infinity;
}

// A 4th-order Butterworth high-pass (two RBJ sections), returned as a new
// signal. Used to find clicks: a steady low tone leaves almost nothing above
// a high cutoff, a discontinuity leaves a spike.
function highpass(signal, rate, cutoffHz) {
    const out = Float64Array.from(signal);
    [0.5411961, 1.3065630].forEach((q) => {
        const w0 = (2 * Math.PI * cutoffHz) / rate;
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        const b0 = ((1 + cos) / 2) / a0;
        const b1 = -(1 + cos) / a0;
        const b2 = b0;
        const a1 = (-2 * cos) / a0;
        const a2 = (1 - alpha) / a0;
        let z1 = 0;
        let z2 = 0;
        for (let i = 0; i < out.length; i++) {
            const x = out[i];
            const y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            out[i] = y;
        }
    });
    return out;
}

// Peak of the signal above `cutoffHz`, over [from, to).
function highpassPeak(signal, rate, cutoffHz, from, to) {
    return peak(highpass(signal, rate, cutoffHz), from, to);
}

/**
 * SMPTE-style intermodulation: a low tone and a high tone, and the products
 * at fHigh +/- n * fLow for n = 1..orders, summed, relative to the high tone.
 */
function imdSmpteDb(signal, fLow, fHigh, rate, from, to, orders) {
    const carrier = power(signal, fHigh, rate, from, to);
    let sum = 0;
    for (let n = 1; n <= (orders || 3); n++) {
        sum += power(signal, fHigh - n * fLow, rate, from, to);
        sum += power(signal, fHigh + n * fLow, rate, from, to);
    }
    return carrier > 0 && sum > 0 ? 10 * Math.log10(sum / carrier) : -Infinity;
}

/**
 * Twin-tone (CCIF-style) intermodulation: the difference tone f2 - f1 and
 * the third-order products 2f1 - f2 and 2f2 - f1, summed, relative to the
 * mean power of the two tones.
 */
function twinToneImdDb(signal, f1, f2, rate, from, to) {
    const tones = (power(signal, f1, rate, from, to) + power(signal, f2, rate, from, to)) / 2;
    const products = [f2 - f1, 2 * f1 - f2, 2 * f2 - f1]
        .filter((f) => f > 0 && f < rate / 2)
        .reduce((sum, f) => sum + power(signal, f, rate, from, to), 0);
    return tones > 0 && products > 0 ? 10 * Math.log10(products / tones) : -Infinity;
}

// The p-th percentile (0..1) of a list of numbers.
function percentile(values, p) {
    const sorted = Array.from(values).sort((a, b) => a - b);
    if (sorted.length === 0) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function mean(values) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    return values.length > 0 ? sum / values.length : NaN;
}

// RMS level of `a` over `b` in dB, over [from, to).
function channelRatioDb(a, b, from, to) {
    return gainToDb(rms(a, from, to) / rms(b, from, to));
}

/**
 * How far `b` departs from `scale * a`, as the RMS of the difference
 * relative to the RMS of `b`, in dB. Two channels that keep the same image
 * through a processor read far down.
 */
function residualDb(a, b, scale, from, to) {
    const end = to === undefined ? a.length : to;
    const start = from || 0;
    let diff = 0;
    let ref = 0;
    for (let i = start; i < end; i++) {
        const d = b[i] - scale * a[i];
        diff += d * d;
        ref += b[i] * b[i];
    }
    return ref > 0 && diff > 0 ? 10 * Math.log10(diff / ref) : -Infinity;
}

function rippleDb(track, fromTime, toTime) {
    const points = track.filter((p) => p.time >= fromTime && p.time < toTime && !isNaN(p.db));
    if (points.length === 0) return NaN;
    let min = Infinity;
    let max = -Infinity;
    points.forEach((p) => { if (p.db < min) min = p.db; if (p.db > max) max = p.db; });
    return max - min;
}

module.exports = {
    dbToGain,
    gainToDb,
    silence,
    tone,
    impulse,
    steppedTone,
    kickBass,
    wobblingTone,
    squareNaive,
    squareBandlimited,
    multitone,
    noise,
    pink,
    drumsOverBed,
    concat,
    stereo,
    peak,
    rms,
    hasNonFinite,
    power,
    thdDb,
    worstSpurDb,
    inharmonicRatioDb,
    toneGainsDb,
    notchDepthDb,
    gainTrack,
    timeConstant,
    gainRoughness,
    truePeak,
    gainPumping,
    sidebandDb,
    highpass,
    highpassPeak,
    imdSmpteDb,
    twinToneImdDb,
    percentile,
    mean,
    channelRatioDb,
    residualDb,
    rippleDb
};
