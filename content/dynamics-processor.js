'use strict';

/**
 * Wideband auto gain control, a three-band gain-riding compressor and an
 * optional per-band downward expander (noise reduction), in one worklet.
 *
 * ---------------------------------------------------------------- AGC
 * The AGC rides the level of the whole programme towards a loudness target, so
 * one tab plays at roughly the level of the next. Its detector is LUFS-like:
 * a K-weighting pre-filter (a +4 dB shelf above ~1.5 kHz and a 38 Hz
 * high-pass), channel powers summed, accumulated into 100 ms blocks, and the
 * mean of the last four blocks (400 ms, "momentary") read as the level. The
 * gain is only recomputed once per block, in dB:
 *
 *   desired = clamp(target - level, -maxCut, +maxBoost)
 *
 * It falls towards a lower `desired` with a ~1 s time constant and rises
 * towards a higher one with ~8 s, at half speed within 3 dB of it and never
 * faster than ~3 dB/s. Rising is what turns pauses and noise up, so it is
 * gated against the *programme* level, a slow (4 s) follower of the momentary
 * level that only moves while the gate is open:
 *
 *   level >= programme - 10 LU               normal
 *   programme + gate <= level < that         rise at quarter speed
 *   level < programme + gate, or < -60 LUFS  rise frozen
 *
 * with the more active state held for 0.5 s. A steadily quiet source is
 * therefore still brought up, while a pause or a sudden drop inside it is
 * not. If the level stays gated with sound present for 2.5 s, the quieter
 * sound becomes the programme. The first sound after a reset or 5 s of
 * silence starts a new programme, and for 3 s after that rising is four times
 * faster, so a new quiet video comes up quickly while gain riding inside a
 * song stays slow. The gain is interpolated linearly across each block.
 *
 * ---------------------------------------------------------- band split
 * Linkwitz-Riley 4th-order crossovers with allpass compensation:
 *
 *   x -> LP4(f1) -> AP(f2)  = low
 *   x -> HP4(f1) -> LP4(f2) = mid
 *                -> HP4(f2) = high
 *
 * LP4 + HP4 at one frequency is a second-order allpass, so mid + high is
 * HP4(f1) AP(f2), and the low band gets the same AP(f2) to match. The three
 * bands sum to AP(f1) AP(f2): flat magnitude wherever the crossovers sit.
 * 9 biquads per channel.
 *
 * The filters run a whole render quantum at a time, one section after
 * another, with coefficients and state in locals. Per sample and per section,
 * a method call reading and writing typed-array state costs several times
 * the arithmetic it does, and the audio thread has a hard deadline: on a
 * phone it is the difference between headroom and underruns. Filter state is
 * flushed to zero once it falls below 1e-30 at the end of each quantum, so a
 * pause never leaves the recursions grinding through subnormal numbers, which
 * are slow on most CPUs. A silent quantum through settled filters skips them
 * altogether.
 *
 * The split runs on the input before the AGC gain, which is applied per band
 * at the output (a scalar commutes with the linear split). That way the
 * expander's detector reads each band's level before the AGC, and the riders
 * read it after, without dividing anything.
 *
 * --------------------------------------------------------- gain riders
 * One gain per band, linked across channels. The rider gain g is compared
 * against the band's threshold at the band's *output* level (feedback), using
 * a 1 ms power envelope of the louder channel:
 *
 *   over  = env(max band^2) * (agc * g)^2 > threshold^2
 *   over  -> g *= attackCoefficient            (every sample)
 *   under -> g rises at a dB/s rate that slows a little as g grows (every
 *            32 samples), up to the band's maximum gain
 *
 * so g settles where the band's peaks sit at the threshold, or at the maximum
 * gain if the band is quieter than that. The gain actually applied is
 *
 *   G = g ^ q,   q = Density = 1 - 1/ratio
 *
 * Density 0 is unity in every band (the split's allpass is all that is left),
 * 0.5 is 2:1 above the threshold with half the maximum gain as lift below it,
 * and 1 levels every band to its threshold. G is kept in step with g by
 * multiplying it by attackCoefficient^q on each attack step and recomputing
 * g^q at each release step, so there is no per-sample pow. A faster copy of
 * the AGC's gate (20 ms windows, 200 ms hold, same programme level) slows the
 * release to a third, or freezes it, so the riders do not lift a pause or a
 * noise floor either.
 *
 * Thresholds are relative to the AGC target. With the AGC holding the input
 * at the target, the bands settle around the same level whatever the Loudness
 * setting, and the output keeps its peaks well clear of the limiter.
 *
 * ------------------------------------------------ expander (noise reduction)
 * When enabled, each band also has a downward expander, keyed on the band's
 * level *before* the AGC, so the AGC's boost never changes its decision. Its
 * detector is a 0.4 ms envelope of max|band| feeding a peak hold that decays
 * with ~45 ms. Every 4 samples its gain e (in [floor, 1]) opens quickly when
 * the peak is above it, closes slowly when the peak drops below half of it,
 * and otherwise tracks peak/threshold, which below the threshold is a 1:2
 * expansion down to the floor.
 *
 * The rider measures the band before the expander, and the expander gain is
 * applied alongside the rider's. If the expander came first, the feedback
 * rider would see the quieter band and turn it back up again.
 *
 * ------------------------------------------------------------- output
 * Per band the applied gain is agc * G * e * bandGain. The product G * e *
 * bandGain goes through a 0.2 ms one-pole before it is applied: the rider's
 * attack steps happen on individual signal peaks, and applied raw they would
 * amplitude-modulate the band and fold HF spurs back below Nyquist.
 */

const BAND_COUNT = 3;

const DEFAULT_CROSSOVERS_HZ = [150, 2500];
const MIN_CROSSOVER_HZ = 20;
const MAX_CROSSOVER_HZ = 18000;
const BUTTERWORTH_Q = Math.SQRT1_2;
// The most a crossover moves in one render quantum: 1/64 octave, about six
// octaves a second at 48 kHz, so the full range takes under two seconds.
const CROSSOVER_GLIDE_OCTAVES = 1 / 64;
const CROSSOVER_GLIDE_RATIO = Math.pow(2, CROSSOVER_GLIDE_OCTAVES);

const LOG_PER_DB = Math.LN10 / 20;
const DB_PER_LOG = 20 / Math.LN10;

/* ---------------------------------------------------------------- AGC */

const AGC_BLOCK_SECONDS = 0.1;
const AGC_WINDOW_BLOCKS = 4;
const AGC_FALL_SECONDS = 1;
const AGC_RISE_SECONDS = 8;
const AGC_MAX_RISE_DB_PER_SECOND = 3;
// Within this distance of the target, rising goes at half speed.
const AGC_NEAR_DB = 3;
// Between the gate and this far below the programme level, rising goes at
// quarter speed.
const AGC_SLOW_BELOW_PROGRAMME_DB = 10;
const AGC_SLOW_RISE_DIVISOR = 4;
// Absolute floor: below this the rise is frozen whatever the programme.
const AGC_ABSOLUTE_GATE_LUFS = -60;
const AGC_GATE_HOLD_SECONDS = 0.5;
// The programme level the gate compares against: a slow follower of the
// momentary level, updated only while the gate is open.
const AGC_PROGRAMME_SECONDS = 4;
// Fast acquire: this long after a (re)start, rising is this many times
// faster.
const AGC_ACQUIRE_SECONDS = 3;
const AGC_ACQUIRE_FACTOR = 4;
// Re-arm: after this long below the absolute gate, the next sound is treated
// as a new programme; and after this long gated *with* sound present, the
// quieter sound is accepted as the new programme.
const AGC_REARM_SILENCE_SECONDS = 5;
const AGC_REARM_QUIET_SECONDS = 2.5;

// BS.1770 offset between mean-square power and LUFS.
const LUFS_OFFSET = -0.691;
const POWER_EPSILON = 1e-20;

// The speed knobs are exponential: 0.5 is the base time, 0 is four times
// slower and 1 four times faster (or, for the band time knobs, 0 is four
// times faster and 1 four times slower).
const KNOB_SPAN = Math.log(16);

const GATE_NORMAL = 0;
const GATE_SLOW = 1;
const GATE_FROZEN = 2;

/* ---------------------------------------------------------- band riders */

const BAND_ATTACK_MS = [30, 12, 5];
const BAND_RELEASE_DB_PER_SECOND = [10, 20, 30];
// Threshold of each band relative to the AGC target (in the detector's
// 1 ms power-envelope terms), before the per-band offset. Calibrated so pink
// noise at the target settles every rider at about +3.5 dB: the multiband then
// adds density without tilting a balanced spectrum, and Density 0.5 lifts
// the whole programme by about 2 dB.
const BAND_THRESHOLD_COMMON_DB = 0;
const BAND_THRESHOLD_PATTERN_DB = [2.5, -2.5, -5];
// The riders' own gate: the same comparison as the AGC's, against the same
// programme level, but on 20 ms windows held for 100 ms, so a pause stops the
// release within about a tenth of a second instead of after the AGC's 400 ms
// window and 0.5 s hold. Its frozen state also freezes the AGC's rise, which
// would otherwise keep climbing until the pause filled the AGC's own window.
const RIDER_GATE_WINDOW_SECONDS = 0.02;
const RIDER_GATE_HOLD_SECONDS = 0.1;
// How much the release slows as the rider gain grows: rate scales by
// (1 + k) / (1 + k g), so about 0.8x at +12 dB.
const RELEASE_CURVE = 0.08;
const RELEASE_STEP_SAMPLES = 32;
// More than this far over the threshold (6 dB; a power ratio), the attack runs
// FAST_ATTACK_FACTOR times faster. It stands in for a per-band peak limiter:
// cheap, and it keeps transients in lifted bands from landing on the final
// limiter.
const FAST_ATTACK_OVER = 4;
const FAST_ATTACK_FACTOR = 4;
// Released gain above the maximum (after the maximum is lowered) settles back
// by this fraction per release step rather than jumping.
const OVER_MAX_SETTLE = 1 / 256;
const MIN_RIDER_GAIN = 1e-3;
const GATE_RELEASE_SCALE = [1, 1 / 3, 0];

const GAIN_SMOOTHING_SECONDS = 0.0002;

// The riders compare a short power envelope, not raw sample peaks, against
// their thresholds. The largest sample in each half-cycle of a high tone
// swings by up to 1.5 dB as the sampling grid beats against the tone (at
// 8 kHz / 44.1 kHz, a 200 Hz beat); a peak detector turns that into rider
// gain dither and audible sidebands. The mean of x^2 over a few cycles does
// not depend on where the samples fall. 1 ms is short against every band's
// attack time.
const DETECTOR_SECONDS = 0.001;

/* ------------------------------------------------------------ expander */

const NR_STEP_SAMPLES = 4;
const NR_ENVELOPE_SECONDS = 0.0004;
const NR_PEAK_DECAY_SECONDS = 0.045;
const NR_OPEN_DB_PER_SECOND = 3000;
const NR_CLOSE_DB_PER_SECOND = 300;
const NR_TRACK_SECONDS = 0.09;

/* --------------------------------------------------------- housekeeping */

// Recursive state smaller than this is set to zero at the end of a quantum.
// It is 600 dB down, far below anything audible, and well above the
// subnormal range (below about 2e-308) where the arithmetic slows down.
const FLUSH = 1e-30;
// Scratch buffers start at the render quantum and only ever grow.
const RENDER_QUANTUM = 128;

function dbToGain(db) {
    return Math.exp(db * LOG_PER_DB);
}

function knobScale(value) {
    return Math.exp((value - 0.5) * KNOB_SPAN);
}

// One quantum's step of a crossover from `current` towards `target`, capped
// in octaves.
function glide(current, target) {
    const octaves = Math.log2(target / current);
    if (octaves > CROSSOVER_GLIDE_OCTAVES) return current * CROSSOVER_GLIDE_RATIO;
    if (octaves < -CROSSOVER_GLIDE_OCTAVES) return current / CROSSOVER_GLIDE_RATIO;
    return target;
}

/**
 * One biquad section in transposed direct form II, with independent state per
 * channel. TDF2 keeps its accumulator in the output's own scale, which matters
 * for the very low cutoffs in the low band.
 */
class Biquad {
    constructor() {
        this.b0 = 1;
        this.b1 = 0;
        this.b2 = 0;
        this.a1 = 0;
        this.a2 = 0;
        this.z1 = new Float64Array(0);
        this.z2 = new Float64Array(0);
    }

    setChannelCount(count) {
        if (this.z1.length === count) return;
        this.z1 = new Float64Array(count);
        this.z2 = new Float64Array(count);
    }

    reset() {
        this.z1.fill(0);
        this.z2.fill(0);
    }

    // RBJ cookbook, normalised by a0.
    setLowpass(frequency, q, rate) {
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        this.b0 = ((1 - cos) / 2) / a0;
        this.b1 = (1 - cos) / a0;
        this.b2 = this.b0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
    }

    setHighpass(frequency, q, rate) {
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        this.b0 = ((1 + cos) / 2) / a0;
        this.b1 = -(1 + cos) / a0;
        this.b2 = this.b0;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
    }

    setAllpass(frequency, q, rate) {
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const a0 = 1 + alpha;
        this.b0 = (1 - alpha) / a0;
        this.b1 = (-2 * cos) / a0;
        this.b2 = 1;
        this.a1 = (-2 * cos) / a0;
        this.a2 = (1 - alpha) / a0;
    }

    setHighShelf(frequency, q, gainDb, rate) {
        const A = Math.pow(10, gainDb / 40);
        const w0 = 2 * Math.PI * Math.min(frequency / rate, 0.4999);
        const cos = Math.cos(w0);
        const alpha = Math.sin(w0) / (2 * q);
        const root = 2 * Math.sqrt(A) * alpha;
        const a0 = (A + 1) - (A - 1) * cos + root;
        this.b0 = (A * ((A + 1) + (A - 1) * cos + root)) / a0;
        this.b1 = (-2 * A * ((A - 1) + (A + 1) * cos)) / a0;
        this.b2 = (A * ((A + 1) + (A - 1) * cos - root)) / a0;
        this.a1 = (2 * ((A - 1) - (A + 1) * cos)) / a0;
        this.a2 = ((A + 1) - (A - 1) * cos - root) / a0;
    }

    /**
     * Filter `n` samples of one channel from `src` into `dst` (which may be
     * the same array). Coefficients and state stay in locals for the whole
     * run and the state is written back once, flushed to zero if it has
     * decayed below FLUSH.
     */
    run(channel, src, dst, n) {
        const b0 = this.b0;
        const b1 = this.b1;
        const b2 = this.b2;
        const a1 = this.a1;
        const a2 = this.a2;
        let z1 = this.z1[channel];
        let z2 = this.z2[channel];
        for (let i = 0; i < n; i++) {
            const x = src[i];
            const y = b0 * x + z1;
            z1 = b1 * x - a1 * y + z2;
            z2 = b2 * x - a2 * y;
            dst[i] = y;
        }
        this.z1[channel] = z1 < FLUSH && z1 > -FLUSH ? 0 : z1;
        this.z2[channel] = z2 < FLUSH && z2 > -FLUSH ? 0 : z2;
    }

    // Whether every channel's state is exactly zero, so that silence in
    // would be exactly silence out.
    isSettled() {
        const z1 = this.z1;
        const z2 = this.z2;
        for (let c = 0; c < z1.length; c++) {
            if (z1[c] !== 0 || z2[c] !== 0) return false;
        }
        return true;
    }
}

const BAND_NAMES = ['low', 'mid', 'high'];
// Parameter names, built once: the render loop must not allocate.
const THRESHOLD_PARAMS = BAND_NAMES.map((band) => `${band}ThresholdDb`);
const GAIN_PARAMS = BAND_NAMES.map((band) => `${band}GainDb`);
const NR_OFFSET_PARAMS = BAND_NAMES.map((band) => `${band}NrOffsetDb`);

class DynamicsProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        const k = 'k-rate';
        const descriptors = [
            { name: 'agcEnabled', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: k },
            { name: 'targetLufs', defaultValue: -17.4, minValue: -40, maxValue: 0, automationRate: k },
            { name: 'agcMaxBoostDb', defaultValue: 15, minValue: 0, maxValue: 30, automationRate: k },
            { name: 'agcMaxCutDb', defaultValue: 20, minValue: 0, maxValue: 40, automationRate: k },
            { name: 'agcSpeed', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: k },
            { name: 'agcGateDb', defaultValue: -20, minValue: -60, maxValue: 0, automationRate: k },

            { name: 'crossLowHz', defaultValue: DEFAULT_CROSSOVERS_HZ[0], minValue: MIN_CROSSOVER_HZ, maxValue: MAX_CROSSOVER_HZ, automationRate: k },
            { name: 'crossHighHz', defaultValue: DEFAULT_CROSSOVERS_HZ[1], minValue: MIN_CROSSOVER_HZ, maxValue: MAX_CROSSOVER_HZ, automationRate: k },

            { name: 'density', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: k },
            { name: 'bandAttack', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: k },
            { name: 'bandRelease', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: k },
            { name: 'bandMaxGainDb', defaultValue: 12, minValue: 0, maxValue: 24, automationRate: k },

            // Structural 0/1 switch; the host steps it.
            { name: 'nrEnabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: k },
            { name: 'nrThresholdDb', defaultValue: -55, minValue: -100, maxValue: 0, automationRate: k },
            { name: 'nrFloorDb', defaultValue: 12, minValue: 0, maxValue: 40, automationRate: k },
            { name: 'nrSpeed', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: k }
        ];

        BAND_NAMES.forEach((band) => {
            descriptors.push(
                { name: `${band}ThresholdDb`, defaultValue: 0, minValue: -24, maxValue: 24, automationRate: k },
                { name: `${band}GainDb`, defaultValue: 0, minValue: -24, maxValue: 24, automationRate: k },
                { name: `${band}NrOffsetDb`, defaultValue: 0, minValue: -24, maxValue: 24, automationRate: k }
            );
        });

        return descriptors;
    }

    constructor() {
        super();

        this.channelCount = 0;

        // Band split.
        this.splitLp = [new Biquad(), new Biquad()];
        this.splitHp = [new Biquad(), new Biquad()];
        this.lowAllpass = new Biquad();
        this.midLp = [new Biquad(), new Biquad()];
        this.highHp = [new Biquad(), new Biquad()];

        // AGC detector.
        this.kShelf = new Biquad();
        this.kHighpass = new Biquad();

        this.sections = [
            this.splitLp[0], this.splitLp[1], this.splitHp[0], this.splitHp[1],
            this.lowAllpass,
            this.midLp[0], this.midLp[1], this.highHp[0], this.highHp[1],
            this.kShelf, this.kHighpass
        ];

        this.crossovers = DEFAULT_CROSSOVERS_HZ.slice();

        // AGC state.
        this.blockPowers = new Float64Array(AGC_WINDOW_BLOCKS);
        this.agcGainDb = 0;
        this.agcGateState = GATE_NORMAL;
        this.agcLevelLufs = -Infinity;

        // Rider state per band, linear.
        this.riderGain = new Float64Array(BAND_COUNT);
        this.appliedRider = new Float64Array(BAND_COUNT);
        this.smoothedGain = new Float64Array(BAND_COUNT);

        // Expander state per band.
        this.nrEnvelope = new Float64Array(BAND_COUNT);
        this.nrPeak = new Float64Array(BAND_COUNT);
        this.nrGain = new Float64Array(BAND_COUNT);
        this.nrActive = false;

        // Per-block working sets.
        this.attackCoefficient = new Float64Array(BAND_COUNT);
        this.attackCoefficientQ = new Float64Array(BAND_COUNT);
        this.fastAttackCoefficient = new Float64Array(BAND_COUNT);
        this.fastAttackCoefficientQ = new Float64Array(BAND_COUNT);
        this.releaseDbPerStep = new Float64Array(BAND_COUNT);
        this.threshold = new Float64Array(BAND_COUNT);
        this.outputGain = new Float64Array(BAND_COUNT);
        this.nrThreshold = new Float64Array(BAND_COUNT);
        // The level parameters the three above were last computed from:
        // target, NR threshold, then threshold, gain and NR offset per band.
        this.levelParams = new Float64Array(2 + 3 * BAND_COUNT).fill(NaN);
        this.detector = new Float64Array(BAND_COUNT);

        // One quantum of filter output, bands[b][c], plus scratch for the
        // input, the high side of the first split and the K-weighted signal.
        this.capacity = 0;
        this.bands = [];
        this.inputScratch = new Float64Array(0);
        this.restScratch = new Float64Array(0);
        this.kScratch = new Float64Array(0);
        this.kPower = new Float64Array(0);
        this.agcBuffer = new Float64Array(0);
        this.releaseAt = new Int32Array(0);
        this.releaseScale = new Float64Array(0);

        // The AGC's per-quantum settings, reused rather than reallocated.
        this.agcParams = { agcEnabled: true, target: 0, maxBoost: 0, maxCut: 0, speed: 0, gateDb: 0 };

        // Metering, off until the host asks for it.
        this.metering = false;
        this.meterCountdown = 0;

        // Skip the filters on a silent quantum through settled state. The
        // output is bit-identical either way; tests switch it off to prove
        // that.
        this.fastPath = true;
        // Set while the node has no input, so the state is reset once on
        // the way in rather than on every quantum.
        this.idle = false;

        this.designForRate();

        this.port.onmessage = (event) => {
            const data = event.data;
            if (!data) return;
            if (data.type === 'reset') this.reset();
            else if (data.type === 'meters') this.metering = !!data.on;
        };

        this.reset();
    }

    designForRate() {
        this.designedRate = sampleRate;
        this.blockSamples = Math.max(1, Math.round(AGC_BLOCK_SECONDS * sampleRate));
        this.blockSeconds = this.blockSamples / sampleRate;
        this.gateHoldBlocks = Math.round(AGC_GATE_HOLD_SECONDS / this.blockSeconds);
        this.acquireBlocks = Math.round(AGC_ACQUIRE_SECONDS / this.blockSeconds);
        this.rearmSilenceBlocks = Math.round(AGC_REARM_SILENCE_SECONDS / this.blockSeconds);
        this.rearmQuietBlocks = Math.round(AGC_REARM_QUIET_SECONDS / this.blockSeconds);
        this.programmeCoefficient = 1 - Math.exp(-this.blockSeconds / AGC_PROGRAMME_SECONDS);
        this.riderWindowSamples = Math.max(1, Math.round(RIDER_GATE_WINDOW_SECONDS * sampleRate));
        this.riderHoldWindows = Math.round(RIDER_GATE_HOLD_SECONDS / RIDER_GATE_WINDOW_SECONDS);
        this.gainSmoothingCoefficient = Math.exp(-1 / (GAIN_SMOOTHING_SECONDS * sampleRate));
        this.detectorCoefficient = 1 - Math.exp(-1 / (DETECTOR_SECONDS * sampleRate));
        this.nrEnvelopeCoefficient = 1 - Math.exp(-1 / (NR_ENVELOPE_SECONDS * sampleRate));
        this.nrPeakDecay = Math.exp(-NR_STEP_SAMPLES / (NR_PEAK_DECAY_SECONDS * sampleRate));
        this.meterInterval = Math.round(0.1 * sampleRate);
        // K-weighting: high shelf +4 dB around 1.5 kHz, high-pass at 38 Hz.
        this.kShelf.setHighShelf(1500, Math.SQRT1_2, 4, sampleRate);
        this.kHighpass.setHighpass(38, 0.5, sampleRate);
        this.lastAttack = -1;
        this.lastRelease = -1;
        this.lastNrSpeed = -1;
        this.designCrossover();
    }

    designCrossover() {
        const [f1, f2] = this.crossovers;
        const rate = sampleRate;
        this.splitLp.forEach((s) => s.setLowpass(f1, BUTTERWORTH_Q, rate));
        this.splitHp.forEach((s) => s.setHighpass(f1, BUTTERWORTH_Q, rate));
        this.lowAllpass.setAllpass(f2, BUTTERWORTH_Q, rate);
        this.midLp.forEach((s) => s.setLowpass(f2, BUTTERWORTH_Q, rate));
        this.highHp.forEach((s) => s.setHighpass(f2, BUTTERWORTH_Q, rate));
    }

    reset() {
        this.sections.forEach((section) => section.reset());

        this.blockPowers.fill(0);
        this.blockCount = 0;
        this.blockIndex = 0;
        this.blockAccumulator = 0;
        this.blockPosition = 0;
        this.agcGainDb = 0;
        this.agcFrom = 1;
        this.agcTo = 1;
        this.agcGateState = GATE_NORMAL;
        this.agcGateHold = 0;
        this.agcLevelLufs = -Infinity;
        this.programmeLufs = AGC_ABSOLUTE_GATE_LUFS;
        this.rearmPending = true;
        this.acquireRemaining = 0;
        this.silentBlocks = 0;
        this.quietBlocks = 0;
        this.riderAccumulator = 0;
        this.riderPosition = 0;
        this.riderGateState = GATE_NORMAL;
        this.riderGateHold = 0;

        this.riderGain.fill(1);
        this.appliedRider.fill(1);
        this.detector.fill(0);
        this.smoothedGain.fill(1);
        this.releaseCountdown = RELEASE_STEP_SAMPLES;
        this.lastQ = -1;
        this.snapCrossovers = true;

        this.resetExpander();
    }

    resetExpander() {
        this.nrEnvelope.fill(0);
        this.nrPeak.fill(0);
        this.nrGain.fill(1);
        this.nrCountdown = NR_STEP_SAMPLES;
    }

    ensureChannels(count) {
        if (this.channelCount === count) return;
        this.channelCount = count;
        this.sections.forEach((section) => section.setChannelCount(count));
        this.capacity = 0;
        this.reset();
    }

    // Scratch for one quantum. Only allocates when the quantum grows, which
    // in a browser is never after the first call.
    ensureCapacity(frames) {
        if (frames <= this.capacity) return;
        const size = Math.max(frames, RENDER_QUANTUM);
        this.capacity = size;
        this.bands = [];
        for (let b = 0; b < BAND_COUNT; b++) {
            const perChannel = [];
            for (let c = 0; c < this.channelCount; c++) perChannel.push(new Float64Array(size));
            this.bands.push(perChannel);
        }
        this.inputScratch = new Float64Array(size);
        this.restScratch = new Float64Array(size);
        this.kScratch = new Float64Array(size);
        this.kPower = new Float64Array(size);
        this.agcBuffer = new Float64Array(size);
        // At most one release step per RELEASE_STEP_SAMPLES, plus one.
        const steps = Math.floor(size / RELEASE_STEP_SAMPLES) + 1;
        this.releaseAt = new Int32Array(steps);
        this.releaseScale = new Float64Array(steps);
    }

    filtersSettled() {
        const sections = this.sections;
        for (let s = 0; s < sections.length; s++) {
            if (!sections[s].isSettled()) return false;
        }
        return true;
    }

    // Only recomputed when a knob moves; never per sample. process() checks
    // whether one did before calling: some engines box every double that
    // crosses into a function they have not inlined, which would be an
    // allocation on every quantum.
    updateTiming(attack, release, nrSpeed) {
        this.lastAttack = attack;
        this.lastRelease = release;
        this.lastNrSpeed = nrSpeed;

        const attackScale = knobScale(attack);
        const releaseScale = knobScale(release);
        for (let b = 0; b < BAND_COUNT; b++) {
            const seconds = (BAND_ATTACK_MS[b] / 1000) * attackScale;
            this.attackCoefficient[b] = Math.exp(-1 / (seconds * sampleRate));
            this.fastAttackCoefficient[b] = Math.exp(-FAST_ATTACK_FACTOR / (seconds * sampleRate));
            this.releaseDbPerStep[b] =
                (BAND_RELEASE_DB_PER_SECOND[b] / releaseScale) * (RELEASE_STEP_SAMPLES / sampleRate);
        }
        this.lastQ = -1;

        const nrScale = knobScale(nrSpeed);
        const stepSeconds = NR_STEP_SAMPLES / sampleRate;
        this.nrOpenMultiplier = dbToGain(NR_OPEN_DB_PER_SECOND * nrScale * stepSeconds);
        this.nrCloseMultiplier = dbToGain(-NR_CLOSE_DB_PER_SECOND * nrScale * stepSeconds);
        this.nrTrackCoefficient = 1 - Math.exp(-stepSeconds * nrScale / NR_TRACK_SECONDS);
    }

    /**
     * End of an AGC block: update the momentary level, the gate and the gain.
     * Runs ten times a second.
     */
    finishBlock(params) {
        const power = this.blockAccumulator / this.blockSamples;
        this.blockAccumulator = 0;
        this.blockPowers[this.blockIndex] = power;
        this.blockIndex = (this.blockIndex + 1) % AGC_WINDOW_BLOCKS;
        if (this.blockCount < AGC_WINDOW_BLOCKS) this.blockCount++;

        // Average over the blocks actually filled, so a fresh start does not
        // read 6 dB low and lift the gain.
        let sum = 0;
        for (let i = 0; i < AGC_WINDOW_BLOCKS; i++) sum += this.blockPowers[i];
        const mean = sum / this.blockCount;
        const level = LUFS_OFFSET + 10 * Math.log10(mean + POWER_EPSILON);
        this.agcLevelLufs = level;

        const target = params.target;

        // Gate, against the programme level rather than the target, so a
        // steadily quiet source is still levelled while a pause in it is not.
        let candidate;
        if (level < AGC_ABSOLUTE_GATE_LUFS) {
            candidate = GATE_FROZEN;
            if (++this.silentBlocks >= this.rearmSilenceBlocks) this.rearmPending = true;
        } else {
            this.silentBlocks = 0;
            if (this.rearmPending) {
                // A new programme after a reset or a long silence.
                this.rearmPending = false;
                this.programmeLufs = level;
                this.acquireRemaining = this.acquireBlocks;
            }
            const relative = level - this.programmeLufs;
            candidate = relative < params.gateDb
                ? GATE_FROZEN
                : relative < -AGC_SLOW_BELOW_PROGRAMME_DB ? GATE_SLOW : GATE_NORMAL;
        }
        // The more active state wins at once; going quieter waits out the hold.
        if (candidate <= this.agcGateState) {
            this.agcGateState = candidate;
            this.agcGateHold = this.gateHoldBlocks;
        } else if (this.agcGateHold > 0) {
            this.agcGateHold--;
        } else {
            this.agcGateState = candidate;
        }

        if (level >= AGC_ABSOLUTE_GATE_LUFS) {
            if (this.agcGateState === GATE_FROZEN) {
                // Gated with sound present for long enough: this is the
                // programme now, not a pause in it.
                if (++this.quietBlocks >= this.rearmQuietBlocks) {
                    this.quietBlocks = 0;
                    this.programmeLufs = level;
                    this.acquireRemaining = this.acquireBlocks;
                    this.agcGateState = GATE_NORMAL;
                }
            } else {
                this.quietBlocks = 0;
                this.programmeLufs += (level - this.programmeLufs) * this.programmeCoefficient;
            }
        }

        let gainDb = this.agcGainDb;
        if (!params.agcEnabled) {
            gainDb = 0;
        } else {
            const speed = knobScale(1 - params.speed);
            const dt = this.blockSeconds;
            let desired = target - level;
            if (desired > params.maxBoost) desired = params.maxBoost;
            if (desired < -params.maxCut) desired = -params.maxCut;

            if (desired < gainDb) {
                gainDb += (desired - gainDb) * (1 - Math.exp(-dt / (AGC_FALL_SECONDS * speed)));
            } else if (desired > gainDb && this.agcGateState !== GATE_FROZEN
                && this.riderGateState !== GATE_FROZEN) {
                let rate = 1 / speed;
                if (this.acquireRemaining > 0) rate *= AGC_ACQUIRE_FACTOR;
                if (desired - gainDb < AGC_NEAR_DB) rate *= 0.5;
                if (this.agcGateState === GATE_SLOW) rate /= AGC_SLOW_RISE_DIVISOR;
                let step = (desired - gainDb) * (1 - Math.exp(-dt * rate / AGC_RISE_SECONDS));
                const cap = AGC_MAX_RISE_DB_PER_SECOND * dt * (rate > 1 ? rate : 1);
                if (step > cap) step = cap;
                gainDb += step;
            }
            // A lowered maximum boost (or cut) applies at once.
            if (gainDb > params.maxBoost) gainDb = params.maxBoost;
            if (gainDb < -params.maxCut) gainDb = -params.maxCut;
        }
        if (this.acquireRemaining > 0 && this.agcGateState !== GATE_FROZEN) this.acquireRemaining--;

        this.agcGainDb = gainDb;
        this.agcFrom = this.agcTo;
        this.agcTo = dbToGain(gainDb);
    }

    // End of a 20 ms rider-gate window.
    finishRiderWindow(params) {
        // The parameter set, not the value, for the same reason as
        // updateTiming.
        const gateDb = params.gateDb;
        const power = this.riderAccumulator / this.riderWindowSamples;
        this.riderAccumulator = 0;
        const level = LUFS_OFFSET + 10 * Math.log10(power + POWER_EPSILON);
        let candidate = GATE_NORMAL;
        if (level < AGC_ABSOLUTE_GATE_LUFS) {
            candidate = GATE_FROZEN;
        } else if (!this.rearmPending) {
            const relative = level - this.programmeLufs;
            if (relative < gateDb) candidate = GATE_FROZEN;
            else if (relative < -AGC_SLOW_BELOW_PROGRAMME_DB) candidate = GATE_SLOW;
        }
        if (candidate <= this.riderGateState) {
            this.riderGateState = candidate;
            this.riderGateHold = this.riderHoldWindows;
        } else if (this.riderGateHold > 0) {
            this.riderGateHold--;
        } else {
            this.riderGateState = candidate;
        }
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!output || output.length === 0) return true;

        const channelCount = output.length;
        const frames = output[0].length;

        this.ensureChannels(channelCount);
        this.ensureCapacity(frames);

        if (sampleRate !== this.designedRate) {
            this.designForRate();
            this.reset();
        }

        if (!input || input.length === 0) {
            for (let c = 0; c < channelCount; c++) output[c].fill(0);
            if (!this.idle) {
                this.reset();
                this.idle = true;
            }
            return true;
        }
        this.idle = false;

        // Crossovers retune in place, keeping filter state: a TDF2 section
        // rides a coefficient step far better than the click a reset makes.
        // Still, a big step clicks, and a host ramp does not prevent one:
        // setTargetAtTime covers an eighth of the distance in its first
        // quantum, the better part of an octave for a large move. So each
        // crossover glides, at most CROSSOVER_GLIDE_OCTAVES per quantum,
        // except straight after a reset, when there is no state to disturb.
        let f1 = parameters.crossLowHz[0];
        let f2 = parameters.crossHighHz[0];
        // Last line of defence for a host that does not keep them ordered.
        if (f1 > f2) { const t = f1; f1 = f2; f2 = t; }
        const crossovers = this.crossovers;
        if (f1 !== crossovers[0] || f2 !== crossovers[1]) {
            if (this.snapCrossovers) {
                crossovers[0] = f1;
                crossovers[1] = f2;
            } else {
                crossovers[0] = glide(crossovers[0], f1);
                crossovers[1] = glide(crossovers[1], f2);
            }
            this.designCrossover();
        }
        this.snapCrossovers = false;

        const attack = parameters.bandAttack[0];
        const release = parameters.bandRelease[0];
        const nrSpeed = parameters.nrSpeed[0];
        if (attack !== this.lastAttack || release !== this.lastRelease || nrSpeed !== this.lastNrSpeed) {
            this.updateTiming(attack, release, nrSpeed);
        }

        const target = parameters.targetLufs[0];
        const agcParams = this.agcParams;
        agcParams.agcEnabled = parameters.agcEnabled[0] >= 0.5;
        agcParams.target = target;
        agcParams.maxBoost = parameters.agcMaxBoostDb[0];
        agcParams.maxCut = parameters.agcMaxCutDb[0];
        agcParams.speed = parameters.agcSpeed[0];
        agcParams.gateDb = parameters.agcGateDb[0];

        const q = Math.min(1, Math.max(0, parameters.density[0]));
        const maxGain = dbToGain(parameters.bandMaxGainDb[0]);
        const attackCoefficient = this.attackCoefficient;
        const attackCoefficientQ = this.attackCoefficientQ;
        const fastAttackCoefficient = this.fastAttackCoefficient;
        const fastAttackCoefficientQ = this.fastAttackCoefficientQ;
        if (q !== this.lastQ) {
            this.lastQ = q;
            for (let b = 0; b < BAND_COUNT; b++) {
                attackCoefficientQ[b] = Math.pow(attackCoefficient[b], q);
                fastAttackCoefficientQ[b] = Math.pow(fastAttackCoefficient[b], q);
                this.appliedRider[b] = Math.pow(this.riderGain[b], q);
            }
        }

        const threshold = this.threshold;
        const outputGain = this.outputGain;
        const nrThreshold = this.nrThreshold;
        const nrBase = parameters.nrThresholdDb[0];
        // Recomputed only when one of the levels moves: nine exponentials a
        // quantum are a measurable share of the budget on a slow device.
        const levels = this.levelParams;
        let levelsChanged = levels[0] !== target || levels[1] !== nrBase;
        for (let b = 0; b < BAND_COUNT && !levelsChanged; b++) {
            levelsChanged = levels[2 + 3 * b] !== parameters[THRESHOLD_PARAMS[b]][0]
                || levels[3 + 3 * b] !== parameters[GAIN_PARAMS[b]][0]
                || levels[4 + 3 * b] !== parameters[NR_OFFSET_PARAMS[b]][0];
        }
        if (levelsChanged) {
            levels[0] = target;
            levels[1] = nrBase;
            for (let b = 0; b < BAND_COUNT; b++) {
                const thresholdDb = parameters[THRESHOLD_PARAMS[b]][0];
                const gainDb = parameters[GAIN_PARAMS[b]][0];
                const nrOffsetDb = parameters[NR_OFFSET_PARAMS[b]][0];
                levels[2 + 3 * b] = thresholdDb;
                levels[3 + 3 * b] = gainDb;
                levels[4 + 3 * b] = nrOffsetDb;
                // Squared: the detector is a power envelope.
                const amplitude = dbToGain(target + BAND_THRESHOLD_COMMON_DB
                    + BAND_THRESHOLD_PATTERN_DB[b] + thresholdDb);
                threshold[b] = amplitude * amplitude;
                outputGain[b] = dbToGain(gainDb);
                nrThreshold[b] = dbToGain(nrBase + nrOffsetDb);
            }
        }

        // Expander on/off. Switching on starts it open, so the first thing it
        // does is close on whatever is below the threshold rather than open.
        const nrWanted = parameters.nrEnabled[0] >= 0.5;
        if (nrWanted !== this.nrActive) {
            this.nrActive = nrWanted;
            this.resetExpander();
        }
        const nrActive = this.nrActive;
        const nrFloor = dbToGain(-parameters.nrFloorDb[0]);

        /* ---------------------------------------------- filters, blockwise */

        const sourceChannels = Math.min(input.length, channelCount);
        const bands = this.bands;
        const kPower = this.kPower;

        let silent = true;
        for (let c = 0; c < sourceChannels && silent; c++) {
            const source = input[c];
            for (let i = 0; i < frames; i++) {
                if (source[i] !== 0) { silent = false; break; }
            }
        }

        kPower.fill(0, 0, frames);
        if (silent && this.fastPath && this.filtersSettled()) {
            // Zero in, zero state: every filter would output exact zeros and
            // stay settled, so write the zeros directly.
            for (let b = 0; b < BAND_COUNT; b++) {
                for (let c = 0; c < channelCount; c++) bands[b][c].fill(0, 0, frames);
            }
        } else {
            const x = this.inputScratch;
            const rest = this.restScratch;
            const k = this.kScratch;
            for (let c = 0; c < channelCount; c++) {
                if (c < sourceChannels) {
                    const source = input[c];
                    for (let i = 0; i < frames; i++) {
                        const v = source[i];
                        // A single NaN or infinity would poison every
                        // filter's state permanently.
                        x[i] = v - v === 0 ? v : 0;
                    }
                } else {
                    x.fill(0, 0, frames);
                }

                this.kShelf.run(c, x, k, frames);
                this.kHighpass.run(c, k, k, frames);
                for (let i = 0; i < frames; i++) kPower[i] += k[i] * k[i];

                const low = bands[0][c];
                const mid = bands[1][c];
                const high = bands[2][c];
                this.splitLp[0].run(c, x, low, frames);
                this.splitLp[1].run(c, low, low, frames);
                this.lowAllpass.run(c, low, low, frames);
                this.splitHp[0].run(c, x, rest, frames);
                this.splitHp[1].run(c, rest, rest, frames);
                this.midLp[0].run(c, rest, mid, frames);
                this.midLp[1].run(c, mid, mid, frames);
                this.highHp[0].run(c, rest, high, frames);
                this.highHp[1].run(c, high, high, frames);
            }
        }

        /* ------------------------------------------------ control: shared */

        // The auto level and both gates, per sample in order, recording what
        // the bands need from them: the auto level gain at every sample, and
        // where each rider release step falls and how fast the gate lets it
        // go. The bands are independent of each other given those, so each
        // band then runs its whole quantum in one tight loop with its state
        // in locals, and the result is the same as interleaving them.
        const agcBuffer = this.agcBuffer;
        const releaseAt = this.releaseAt;
        const releaseScale = this.releaseScale;
        const blockSamples = this.blockSamples;
        const riderWindowSamples = this.riderWindowSamples;
        let agcFrom = this.agcFrom;
        let agcTo = this.agcTo;
        let blockPosition = this.blockPosition;
        let blockAccumulator = this.blockAccumulator;
        let riderPosition = this.riderPosition;
        let riderAccumulator = this.riderAccumulator;
        let releaseCountdown = this.releaseCountdown;
        let releaseSteps = 0;

        for (let i = 0; i < frames; i++) {
            // Interpolated across the AGC block.
            agcBuffer[i] = agcFrom + (agcTo - agcFrom) * (blockPosition / blockSamples);

            const kp = kPower[i];
            blockAccumulator += kp;
            if (++blockPosition >= blockSamples) {
                blockPosition = 0;
                this.blockAccumulator = blockAccumulator;
                this.finishBlock(agcParams);
                blockAccumulator = this.blockAccumulator;
                agcFrom = this.agcFrom;
                agcTo = this.agcTo;
            }
            riderAccumulator += kp;
            if (++riderPosition >= riderWindowSamples) {
                riderPosition = 0;
                this.riderAccumulator = riderAccumulator;
                this.finishRiderWindow(agcParams);
                riderAccumulator = this.riderAccumulator;
            }
            if (--releaseCountdown <= 0) {
                releaseCountdown = RELEASE_STEP_SAMPLES;
                releaseAt[releaseSteps] = i;
                releaseScale[releaseSteps] = GATE_RELEASE_SCALE[this.riderGateState];
                releaseSteps++;
            }
        }

        this.blockPosition = blockPosition;
        this.blockAccumulator = blockAccumulator;
        this.riderPosition = riderPosition;
        this.riderAccumulator = riderAccumulator;
        this.releaseCountdown = releaseCountdown;

        /* ---------------------------------------------- control: per band */

        const detectorCoefficient = this.detectorCoefficient;
        const smoothing = this.gainSmoothingCoefficient;
        const nrEnvelopeCoefficient = this.nrEnvelopeCoefficient;
        const nrOpen = this.nrOpenMultiplier;
        const nrClose = this.nrCloseMultiplier;
        const nrTrack = this.nrTrackCoefficient;
        const nrPeakDecay = this.nrPeakDecay;
        const nrCountdownStart = this.nrCountdown;
        let nrCountdownEnd = nrCountdownStart;

        for (let b = 0; b < BAND_COUNT; b++) {
            const channels = bands[b];
            const bandThreshold = threshold[b];
            const fastThreshold = bandThreshold * FAST_ATTACK_OVER;
            const attack = attackCoefficient[b];
            const attackQ = attackCoefficientQ[b];
            const fastAttack = fastAttackCoefficient[b];
            const fastAttackQ = fastAttackCoefficientQ[b];
            const releaseDb = this.releaseDbPerStep[b];
            const bandGain = outputGain[b];
            const bandNrThreshold = nrThreshold[b];

            let detector = this.detector[b];
            let g = this.riderGain[b];
            let applied = this.appliedRider[b];
            let smoothed = this.smoothedGain[b];
            let envelope = this.nrEnvelope[b];
            let peakHold = this.nrPeak[b];
            let expander = this.nrGain[b];
            let nrCountdown = nrCountdownStart;
            let step = 0;
            let nextRelease = releaseSteps > 0 ? releaseAt[0] : -1;

            // The first two channels are held in locals: indexing the array
            // of channels on every sample costs more than the arithmetic.
            // Anything past stereo takes the generic loops.
            const in0 = channels[0];
            const in1 = channelCount > 1 ? channels[1] : null;
            const out0 = output[0];
            const out1 = channelCount > 1 ? output[1] : null;
            const extra = channelCount > 2;

            for (let i = 0; i < frames; i++) {
                // The louder channel: one gain per band, linked.
                let v = in0[i];
                let level = v < 0 ? -v : v;
                if (in1 !== null) {
                    v = in1[i];
                    if (v < 0) v = -v;
                    if (v > level) level = v;
                }
                if (extra) {
                    for (let c = 2; c < channelCount; c++) {
                        v = channels[c][i];
                        if (v < 0) v = -v;
                        if (v > level) level = v;
                    }
                }

                // Rider attack, every sample. Power domain throughout: the
                // detector is a mean of x^2, and the gains and threshold are
                // squared to match.
                const agc = agcBuffer[i];
                const agcPower = agc * agc;
                detector += (level * level - detector) * detectorCoefficient;
                const over = detector * agcPower * g * g;
                if (over > bandThreshold) {
                    // Far over: a transient into a band the rider had lifted.
                    // Attack faster rather than leave it all to the limiter.
                    const far = over > fastThreshold;
                    g *= far ? fastAttack : attack;
                    if (g < MIN_RIDER_GAIN) g = MIN_RIDER_GAIN;
                    applied *= far ? fastAttackQ : attackQ;
                }

                // Rider release, every RELEASE_STEP_SAMPLES.
                if (i === nextRelease) {
                    const gateScale = releaseScale[step];
                    if (g > maxGain) {
                        g += (maxGain - g) * OVER_MAX_SETTLE;
                    } else if (gateScale > 0) {
                        const dB = releaseDb * gateScale
                            * (1 + RELEASE_CURVE) / (1 + RELEASE_CURVE * g);
                        g *= Math.exp(dB * LOG_PER_DB);
                        if (g > maxGain) g = maxGain;
                    }
                    applied = q === 0 ? 1 : q === 1 ? g : Math.pow(g, q);
                    step++;
                    nextRelease = step < releaseSteps ? releaseAt[step] : -1;
                }

                // Expander, every NR_STEP_SAMPLES, on the pre-AGC band level.
                let wanted;
                if (nrActive) {
                    envelope += (level - envelope) * nrEnvelopeCoefficient;
                    if (--nrCountdown <= 0) {
                        nrCountdown = NR_STEP_SAMPLES;
                        let pk = peakHold;
                        if (envelope > pk) pk = envelope;
                        if (pk > bandNrThreshold) pk = bandNrThreshold;
                        const relative = pk / bandNrThreshold;
                        if (relative > expander) expander *= nrOpen;
                        else if (2 * relative < expander) expander *= nrClose;
                        expander += (relative - expander) * nrTrack;
                        if (expander > 1) expander = 1;
                        if (expander < nrFloor) expander = nrFloor;
                        peakHold = pk * nrPeakDecay;
                    }
                    wanted = applied * expander * bandGain;
                } else {
                    wanted = applied * bandGain;
                }

                smoothed = smoothing * smoothed + (1 - smoothing) * wanted;
                const total = smoothed * agc;
                if (b === 0) {
                    out0[i] = in0[i] * total;
                    if (out1 !== null) out1[i] = in1[i] * total;
                    if (extra) for (let c = 2; c < channelCount; c++) output[c][i] = channels[c][i] * total;
                } else {
                    out0[i] += in0[i] * total;
                    if (out1 !== null) out1[i] += in1[i] * total;
                    if (extra) for (let c = 2; c < channelCount; c++) output[c][i] += channels[c][i] * total;
                }
            }

            // Envelopes that decay towards zero in a pause are flushed before
            // they reach the subnormal range, like the filter state.
            this.detector[b] = detector < FLUSH ? 0 : detector;
            this.riderGain[b] = g;
            this.appliedRider[b] = applied;
            this.smoothedGain[b] = smoothed;
            this.nrEnvelope[b] = envelope < FLUSH ? 0 : envelope;
            this.nrPeak[b] = peakHold < FLUSH ? 0 : peakHold;
            this.nrGain[b] = expander;
            nrCountdownEnd = nrCountdown;
        }
        this.nrCountdown = nrCountdownEnd;

        if (this.metering) {
            this.meterCountdown -= frames;
            if (this.meterCountdown <= 0) {
                this.meterCountdown = this.meterInterval;
                this.port.postMessage({
                    type: 'agc',
                    gainDb: this.agcGainDb,
                    levelLufs: this.agcLevelLufs,
                    gate: this.agcGateState
                });
            }
        }

        return true;
    }
}

registerProcessor('thunderfox-dynamics', DynamicsProcessor);
