'use strict';

/**
 * Offline tests for the two worklets. Run with `npm test` or `node tests/run.js`.
 *
 * Each test drives a processor with a generated signal (tone, stepped tone,
 * impulse) and checks a property that should hold regardless of tuning: the
 * limiter never exceeds its ceiling and does not pump, latency is what the node
 * reports, the band split sums flat, the auto level converges and holds still
 * through pauses, the noise reduction does not get undone, and the whole chain
 * leaves the limiter little to do.
 * Measured numbers are printed alongside so tuning changes can be compared.
 */

const { loadProcessor, prepareChain } = require('./harness');
const S = require('./signals');

const RATE = 48000;

const dyn = loadProcessor('content/dynamics-processor.js', RATE);
const dyn441 = loadProcessor('content/dynamics-processor.js', 44100);
const limiter = loadProcessor('content/limiter-processor.js', RATE);

let failures = 0;
let passes = 0;

function check(name, condition, detail) {
    const status = condition ? 'PASS' : 'FAIL';
    if (condition) passes++; else failures++;
    console.log(`${status}  ${name}${detail ? `  (${detail})` : ''}`);
}

function note(text) {
    console.log(`      ${text}`);
}

function fmt(value, digits) {
    return isFinite(value) ? value.toFixed(digits === undefined ? 2 : digits) : String(value);
}

/* ----------------------------------------------------------------- limiter */

console.log('\n== Limiter ==');

const CEILING_DB = -0.3;
const CEILING = S.dbToGain(CEILING_DB);

{
    // A tone 12 dB over the ceiling must come out at or under the ceiling,
    // sample for sample, with ISP on and off.
    [1, 0].forEach((isp) => {
        const input = S.tone(1000, 1, RATE, S.dbToGain(CEILING_DB + 12));
        const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, isp })[0];
        const max = S.peak(out, RATE * 0.1);
        check(`ceiling holds on a +12 dB tone (isp=${isp})`, max <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out),
            `peak ${fmt(S.gainToDb(max), 3)} dBFS vs ceiling ${CEILING_DB}`);
    });
}

{
    // Isolated full-scale impulses, 12 dB over: none may pass the ceiling and
    // the delay must match the reported latency.
    const input = S.concat([
        S.impulse(0.2, RATE, S.dbToGain(11.7), 0.1),
        S.impulse(0.2, RATE, -S.dbToGain(11.7), 0.1)
    ]);
    const processor = limiter.create();
    const reported = processor.port.posted.find((m) => m.type === 'latency');
    const out = limiter.run(processor, S.stereo(input), { ceiling: CEILING })[0];

    let argmax = 0;
    for (let i = 0; i < out.length / 2; i++) if (Math.abs(out[i]) > Math.abs(out[argmax])) argmax = i;
    const measuredLatency = argmax - Math.round(0.1 * RATE);
    check('impulse stays under the ceiling', S.peak(out) <= CEILING * (1 + 1e-4),
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS`);
    check('measured latency matches the reported latency', reported && measuredLatency === reported.samples,
        `${measuredLatency} samples measured, ${reported ? reported.samples : '?'} reported`);
}

/**
 * The gain the limiter applied, per sample and in dB. The detector is linked
 * across channels, so a second channel carrying a small constant comes out as
 * that constant times the gain, whatever is on the first.
 */
function limiterGainDb(processorSet, input, params) {
    const PROBE = 1e-3;
    const probe = new Float32Array(input.length).fill(PROBE);
    const processor = processorSet.create();
    const latency = processor.port.posted.find((m) => m.type === 'latency').samples;
    const out = processorSet.run(processor, [input, probe],
        Object.assign({ ceiling: CEILING }, params || {}));
    const gain = new Float32Array(input.length);
    for (let i = 0; i < gain.length; i++) {
        // Until the probe has reached the output the limiter is at rest.
        gain[i] = i <= latency ? 0 : S.gainToDb(out[1][i] / PROBE);
    }
    return { gainDb: gain, out: out[0], latency };
}

// Seconds after `fromSeconds` at which the gain first comes back above `db`.
function timeToRecover(gainDb, fromSeconds, db) {
    for (let i = Math.round(fromSeconds * RATE); i < gainDb.length; i++) {
        if (gainDb[i] >= db) return i / RATE - fromSeconds;
    }
    return NaN;
}

{
    // A lone transient, 12 dB over on a quiet bed, comes back on the fast
    // release: 90% of the way, in dB, one hold plus one Release after it.
    const HOLD = 0.02;
    [0.05, 0.12, 0.5, 1.0].forEach((release) => {
        const input = S.tone(1000, 1.5 + release * 3, RATE, S.dbToGain(-20.3));
        const at = Math.round(0.5 * RATE);
        for (let i = 0; i < 48; i++) {
            input[at + i] += S.dbToGain(11.7) * Math.sin((Math.PI * i) / 48)
                * Math.sin((2 * Math.PI * 3000 * i) / RATE);
        }
        const { gainDb } = limiterGainDb(limiter, input, { release, hold: HOLD });
        let dip = 0;
        for (let i = at; i < at + RATE * 0.05; i++) if (gainDb[i] < dip) dip = gainDb[i];
        const recovered = timeToRecover(gainDb, 0.5 + 0.002, dip * 0.1);
        const expected = HOLD + release;
        check(`release ${release}s: a lone transient recovers in about that time`,
            dip < -10 && isFinite(recovered) && recovered > expected * 0.7 && recovered < expected * 1.4,
            `dip ${fmt(dip, 1)} dB, 90% back after ${fmt(recovered, 3)} s`);
    });
}

{
    // Sustained reduction does not come back on the fast release. After a
    // second at 12 dB over, the gain a quarter of a second later has barely
    // moved, and the whole recovery is a slope of a few dB per second.
    const recoveries = [0.04, 0.08].map((release) => {
        const input = S.steppedTone(1000, RATE, [
            { db: -20.3, until: 0.5 },
            { db: 11.7, until: 1.5 },
            { db: -20.3, until: 9 }
        ]);
        const { gainDb } = limiterGainDb(limiter, input, { release });
        return {
            release,
            held: gainDb[Math.round(1.4 * RATE)],
            soon: gainDb[Math.round(1.75 * RATE)],
            seconds: timeToRecover(gainDb, 1.5, -0.1)
        };
    });
    const stock = recoveries[1];
    check('sustained limiting: no swell when the programme drops',
        stock.held < -11.5 && stock.soon - stock.held < 1.5,
        `${fmt(stock.held, 2)} dB held, ${fmt(stock.soon, 2)} dB a quarter of a second after`);
    check('sustained limiting: 12 dB comes back in a few seconds',
        stock.seconds > 2 && stock.seconds < 6,
        `within 0.1 dB of unity after ${fmt(stock.seconds, 2)} s`);
    const ratio = stock.seconds / recoveries[0].seconds;
    check('the Release control scales the slow recovery too', ratio > 1.6 && ratio < 2.4,
        `${fmt(recoveries[0].seconds, 2)} s at 40 ms, ${fmt(stock.seconds, 2)} s at 80 ms`);
}

{
    // Dense material driven hard, which is where a limiter pumps: every hit
    // pushes the gain down and the sustained material swells back up behind
    // it. Bounded here are that swell, measured on the gain averaged over
    // 100 ms, and the roughness of the gain from one sample to the next.
    const programme = S.drumsOverBed(8, RATE);
    [12, 24].forEach((driveDb) => {
        const input = Float32Array.from(programme, (v) => v * S.dbToGain(CEILING_DB + driveDb));
        const { gainDb, out } = limiterGainDb(limiter, input);
        const pumping = S.gainPumping(gainDb, RATE, 4);
        const roughness = S.gainRoughness(gainDb, RATE, 4);
        check(`dense programme ${driveDb} dB over: ceiling holds and the gain does not pump`,
            S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out)
                && pumping.riseDb < 3 && pumping.swingDb < 4 && roughness.maxStepDb < 0.08,
            `swing ${fmt(pumping.swingDb)} dB, rise ${fmt(pumping.riseDb)} dB in 250 ms, `
                + `max ${fmt(roughness.maxStepDb, 3)} dB/sample`);
    });
}

{
    // The attack is an S-curve across the whole look-ahead. A lone click
    // 24 dB over is the steepest thing it has to draw.
    const input = S.impulse(0.4, RATE, CEILING * S.dbToGain(24), 0.1);
    const { gainDb, out } = limiterGainDb(limiter, input);
    const roughness = S.gainRoughness(gainDb, RATE, 0.01);
    let dip = 0;
    for (let i = 0; i < gainDb.length; i++) if (gainDb[i] < dip) dip = gainDb[i];
    check('a 24 dB click is met with a smooth gain curve',
        S.peak(out) <= CEILING * (1 + 1e-4) && dip < -23.9 && roughness.maxStepDb < 0.25,
        `dip ${fmt(dip, 1)} dB, max ${fmt(roughness.maxStepDb, 3)} dB/sample`);
}

{
    // Moving the smoothing control rebuilds the running sums while the
    // envelope is in flight. The ceiling must survive that at any setting.
    const programme = S.drumsOverBed(3, RATE);
    const input = Float32Array.from(programme, (v) => v * S.dbToGain(CEILING_DB + 18));
    let state = 1;
    const smoothing = () => {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return 0.0002 + (state / 4294967296) * 0.0048;
    };
    const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, smoothing })[0];
    check('ceiling holds while the smoothing control is moved', S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out),
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS`);
}

{
    // The drive is plain gain while nothing is over the ceiling.
    const input = S.tone(1000, 0.5, RATE, S.dbToGain(CEILING_DB - 12));
    const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, drive: S.dbToGain(6) })[0];
    const gain = S.gainToDb(S.rms(out, RATE / 4) / S.rms(input, RATE / 4));
    check('drive of 6 dB below the ceiling is 6 dB of gain', Math.abs(gain - 6) < 0.01, `${fmt(gain, 3)} dB`);
}

{
    // Turning the drive down while the limiter is deep in sustained
    // reduction. The reduction the drive was responsible for has to go with
    // it; left to the slow release, the output would drop by the full 12 dB
    // and take seconds to come back. Compared against the same programme
    // at the lower drive throughout, quarter of a second by quarter.
    const programme = Float32Array.from(S.drumsOverBed(10, RATE), (v) => v * CEILING);
    const high = S.dbToGain(24);
    const low = S.dbToGain(12);
    const drive = (start) => {
        const t = start / RATE - 6;
        return t < 0 ? high : low + (high - low) * Math.exp(-t / 0.02);
    };
    const moved = limiter.run(limiter.create(), S.stereo(programme), { ceiling: CEILING, drive })[0];
    const steady = limiter.run(limiter.create(), S.stereo(programme), { ceiling: CEILING, drive: low })[0];
    let worst = 0;
    for (let t = 6; t < 8; t += 0.25) {
        const from = Math.round(t * RATE);
        const to = from + Math.round(0.25 * RATE);
        const difference = S.gainToDb(S.rms(moved, from, to) / S.rms(steady, from, to));
        if (Math.abs(difference) > Math.abs(worst)) worst = difference;
    }
    check('turning the drive down 12 dB does not leave the output quiet',
        S.peak(moved) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(moved) && Math.abs(worst) < 1,
        `worst ${fmt(worst, 2)} dB against the lower drive held throughout`);
}

{
    // The ceiling under a drive that never stops moving, up and down.
    const programme = Float32Array.from(S.drumsOverBed(4, RATE), (v) => v * CEILING);
    const drive = (start) => S.dbToGain(12 + 12 * Math.sin((2 * Math.PI * 3 * start) / RATE));
    const out = limiter.run(limiter.create(), S.stereo(programme), { ceiling: CEILING, drive })[0];
    check('ceiling holds while the drive is moved', S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out),
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS`);
}

{
    // Same guarantee and the same latency report at 44.1 kHz, where the
    // look-ahead is an odd number of samples.
    const limiter441 = loadProcessor('content/limiter-processor.js', 44100);
    const input = S.concat([
        S.impulse(0.2, 44100, S.dbToGain(11.7), 0.1),
        Float32Array.from(S.drumsOverBed(2, 44100), (v) => v * S.dbToGain(CEILING_DB + 18))
    ]);
    const processor = limiter441.create();
    const reported = processor.port.posted.find((m) => m.type === 'latency');
    const out = limiter441.run(processor, S.stereo(input), { ceiling: CEILING })[0];
    let argmax = 0;
    for (let i = 0; i < 0.2 * 44100; i++) if (Math.abs(out[i]) > Math.abs(out[argmax])) argmax = i;
    check('44.1 kHz: ceiling holds and latency matches the report',
        S.peak(out) <= CEILING * (1 + 1e-4) && !S.hasNonFinite(out)
            && argmax - Math.round(0.1 * 44100) === reported.samples,
        `peak ${fmt(S.gainToDb(S.peak(out)), 3)} dBFS, ${reported.samples} samples`);
}

{
    // A tone at a quarter of the sample rate, sampled 45 degrees off its
    // crests: every sample reads 3 dB under the peak the waveform actually
    // reaches. With ISP on, the reconstructed output has to stay under the
    // ceiling, not just the samples.
    const input = new Float32Array(RATE);
    for (let i = 0; i < input.length; i++) {
        input[i] = S.dbToGain(CEILING_DB + 12) * Math.sin((Math.PI * i) / 2 + Math.PI / 4);
    }
    const on = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, isp: 1 })[0];
    const off = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, isp: 0 })[0];
    const onPeak = S.truePeak(on, RATE / 2, RATE / 2 + 4800);
    const offPeak = S.truePeak(off, RATE / 2, RATE / 2 + 4800);
    check('ISP holds the reconstructed peak of an off-crest tone under the ceiling',
        onPeak <= CEILING * (1 + 1e-3),
        `true peak ${fmt(S.gainToDb(onPeak), 3)} dBFS with ISP, ${fmt(S.gainToDb(offPeak), 3)} dBFS without`);
}

{
    // Sustained bass through a heavily driven limiter. What the ear calls
    // jitter or roughness is gain moving within a cycle, which shows up as
    // harmonic distortion of a pure tone. The Loudness macro drives the
    // limiter by up to 24 dB, so 12 dB over is a normal operating point.
    [0.12, 0.5].forEach((release) => {
        [40, 80, 200].forEach((frequency) => {
            const input = S.tone(frequency, 2, RATE, S.dbToGain(CEILING_DB + 12));
            const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING, release })[0];
            const thd = S.thdDb(out, frequency, RATE, RATE, 2 * RATE);
            check(`driven ${frequency} Hz, release ${release}s: ceiling holds and distortion under -50 dB`,
                S.peak(out, RATE) <= CEILING * (1 + 1e-4) && thd < -50,
                `THD ${fmt(thd, 1)} dB`);
        });
    });
}

{
    // A transient on top of a steady tone: the gain must dip for the hit and
    // then come back, not stay down. Checks that hold and release do not
    // latch under a continuous signal.
    const bed = S.tone(1000, 1.5, RATE, S.dbToGain(CEILING_DB - 6));
    const hit = S.impulse(1.5, RATE, S.dbToGain(CEILING_DB + 6), 0.5);
    const input = new Float32Array(bed.length);
    for (let i = 0; i < input.length; i++) input[i] = bed[i] + hit[i];
    const out = limiter.run(limiter.create(), S.stereo(input), { ceiling: CEILING })[0];
    const track = S.gainTrack(input, out, RATE, 0.001);
    const during = track.find((p) => p.time >= 0.5 && p.time < 0.51);
    const later = track.find((p) => p.time >= 1.0);
    check('gain dips for a transient and recovers on a steady bed', during && later && during.db < -3 && later.db > -0.1,
        `dip ${fmt(during ? during.db : NaN, 1)} dB, ${fmt(later ? later.db : NaN, 2)} dB half a second later`);
}

/* ---------------------------------------------------------------- dynamics */

// The settings a test wants "just the split" with: no auto level, every band
// at unity.
const FLAT = { agcEnabled: 0, density: 0 };

// Run the dynamics worklet, recording a processor field after every quantum.
// `quantum` (default 128) sets the time resolution of the record.
function track(instance, input, params, read, quantum) {
    const processor = instance.create();
    const values = [];
    const out = instance.run(processor, input, params, (p, start) => {
        values.push({ time: start / instance.sampleRate, value: read(p) });
    }, quantum);
    return { processor, values, out };
}

// The value of a tracked field at a given time.
function at(values, time) {
    let best = values[0];
    for (let i = 0; i < values.length; i++) {
        if (values[i].time <= time) best = values[i]; else break;
    }
    return best.value;
}

console.log('\n== Dynamics: band split ==');

{
    // With the auto level off and Density 0 every band is at unity, and the
    // three bands sum to AP(f1) AP(f2): flat magnitude.
    [40, 120, 300, 1000, 2500, 5000, 8000, 15000].forEach((frequency) => {
        const input = S.tone(frequency, 1, RATE, S.dbToGain(-12));
        const out = dyn.run(dyn.create(), S.stereo(input), FLAT)[0];
        const error = S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
        check(`flat at ${frequency} Hz`, Math.abs(error) < 0.05 && !S.hasNonFinite(out), `${fmt(error, 4)} dB`);
    });
}

{
    // Multitone flatness, at the stock split and with both crossovers
    // moved. Integer frequencies sit exactly on the bins of the one-second
    // Goertzel window, so the allpass's phase rotation cannot leak.
    const frequencies = [];
    for (let i = 0; i < 40; i++) frequencies.push(Math.round(40 * Math.pow(18000 / 40, i / 39)));
    const input = S.multitone(frequencies, 2, RATE, S.dbToGain(-30));
    [{ label: 'stock crossovers', params: FLAT },
        { label: 'crossovers 300/6000', params: Object.assign({ crossLowHz: 300, crossHighHz: 6000 }, FLAT) },
        { label: 'crossovers given out of order', params: Object.assign({ crossLowHz: 6000, crossHighHz: 300 }, FLAT) }]
        .forEach(({ label, params }) => {
            const out = dyn.run(dyn.create(), S.stereo(input), params)[0];
            const gains = S.toneGainsDb(input, out, frequencies, RATE, RATE, 2 * RATE);
            const spread = Math.max(...gains) - Math.min(...gains);
            check(`multitone flat within 0.1 dB (${label})`, spread < 0.1 && !S.hasNonFinite(out),
                `spread ${fmt(spread, 4)} dB`);
        });
}

{
    // Routing: cut one band by 12 dB at a time. A tone inside a band must drop
    // when its own band is cut and stay put otherwise. Not by the full 12 dB:
    // LR4 outputs are in phase, so a tone even an octave from a crossover
    // keeps a few percent of its amplitude in the neighbouring band, and that
    // share is not cut.
    const bands = ['low', 'mid', 'high'];
    [[40, 0], [600, 1], [10000, 2]].forEach(([frequency, home]) => {
        const input = S.tone(frequency, 1, RATE, S.dbToGain(-20));
        const drops = bands.map((band) => {
            const out = dyn.run(dyn.create(), S.stereo(input), Object.assign({ [`${band}GainDb`]: -12 }, FLAT))[0];
            return -S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
        });
        const ok = drops.every((drop, b) => (b === home ? drop > 10 && drop < 12.1 : drop < 1));
        check(`${frequency} Hz lands in the ${bands[home]} band`, ok,
            drops.map((d, b) => `${bands[b]} -${fmt(d, 1)}`).join(', '));
    });

    // The crossover parameters move the routing: 300 Hz is mid at the stock
    // 150 Hz low crossover and low once it moves to 900 Hz.
    const input = S.tone(300, 1, RATE, S.dbToGain(-20));
    const out = dyn.run(dyn.create(), S.stereo(input),
        Object.assign({ crossLowHz: 900, crossHighHz: 4000, lowGainDb: -12 }, FLAT))[0];
    const drop = -S.gainToDb(S.rms(out, RATE / 2) / S.rms(input, RATE / 2));
    check('raising the low crossover to 900 Hz moves 300 Hz into the low band', drop > 10.5,
        `-${fmt(drop, 2)} dB with the low band cut`);
}

console.log('\n== Dynamics: auto level ==');

{
    // Convergence: steady pink noise well under, near and over the target
    // ends up at the target (level + gain), unless the boost runs out first.
    const target = -17.4;
    [{ db: -25, label: '8 dB under' }, { db: -8, label: '9 dB over' }].forEach(({ db, label }) => {
        const input = S.pink(30, RATE, db, 3);
        const { processor } = track(dyn, S.stereo(input), { targetLufs: target }, () => 0);
        const reached = processor.agcLevelLufs + processor.agcGainDb;
        check(`pink noise ${label} the target converges to it within 1 LU`, Math.abs(reached - target) < 1,
            `input ${fmt(processor.agcLevelLufs, 1)} LUFS, gain ${fmt(processor.agcGainDb, 1)} dB -> ${fmt(reached, 1)} LUFS`);
    });

    const quiet = S.pink(30, RATE, -40, 3);
    const { processor } = track(dyn, S.stereo(quiet), { targetLufs: target, agcMaxBoostDb: 15 }, () => 0);
    check('a steadily quiet source is still brought up to the maximum boost', processor.agcGainDb > 14,
        `input ${fmt(processor.agcLevelLufs, 1)} LUFS, gain ${fmt(processor.agcGainDb, 1)} dB (max 15)`);
}

{
    // Falling is fast, rising is slow and rate-capped. From a settled -20 dB
    // input, a step up of 10 dB and a step down of 10 dB: 63% times.
    const settle = S.pink(15, RATE, -20, 5);
    const time63 = (stepDb) => {
        const input = S.concat([settle, S.pink(25, RATE, -20 + stepDb, 6)]);
        const { values } = track(dyn, S.stereo(input), {}, (p) => p.agcGainDb);
        const start = at(values, 15);
        const end = at(values, 39.9);
        const goal = start + 0.63 * (end - start);
        const hit = values.find((v) => v.time > 15 && (end < start ? v.value <= goal : v.value >= goal));
        return { seconds: hit ? hit.time - 15 : Infinity, values };
    };
    const fall = time63(10);
    const rise = time63(-10);
    check('auto level falls within 2 s of a 10 dB step up', fall.seconds < 2, `${fmt(fall.seconds, 2)} s`);
    check('auto level rises at least 3x slower than it falls', rise.seconds > 3 * fall.seconds,
        `${fmt(rise.seconds, 2)} s vs ${fmt(fall.seconds, 2)} s`);
    let maxRate = 0;
    for (let i = 0; i < rise.values.length; i++) {
        const later = rise.values.find((v) => v.time >= rise.values[i].time + 1);
        if (!later || rise.values[i].time < 15) continue;
        maxRate = Math.max(maxRate, later.value - rise.values[i].value);
    }
    check('auto level rises no faster than 3 dB/s once acquired', maxRate <= 3.1, `${fmt(maxRate, 2)} dB/s`);
}

{
    // Pauses: 2 s of programme, 2 s of near-silence, repeated. The gain must
    // not climb during the pauses.
    const parts = [];
    for (let k = 0; k < 6; k++) {
        parts.push(S.pink(2, RATE, -25, 10 + k));
        const hiss = S.noise(2, RATE, 20 + k).map((v) => v * S.dbToGain(-75));
        parts.push(hiss);
    }
    const { values } = track(dyn, S.stereo(S.concat(parts)), {}, (p) => p.agcGainDb);
    let worst = -Infinity;
    for (let k = 1; k < 6; k++) {
        const pauseStart = 4 * k - 2;
        worst = Math.max(worst, at(values, pauseStart + 1.95) - at(values, pauseStart + 0.05));
    }
    check('auto level does not climb during pauses', worst < 0.5, `worst climb ${fmt(worst, 2)} dB`);

    // The riders have a faster gate of their own: with the auto level off,
    // the band gains must not climb through a pause either, once its 100 ms
    // hold has run out.
    const riders = track(dyn, S.stereo(S.concat(parts)), { agcEnabled: 0 },
        (p) => Math.max(...Array.from(p.riderGain).map(S.gainToDb)));
    let riderWorst = -Infinity;
    for (let k = 1; k < 6; k++) {
        const pauseStart = 4 * k - 2;
        riderWorst = Math.max(riderWorst, at(riders.values, pauseStart + 1.95) - at(riders.values, pauseStart + 0.2));
    }
    check('band riders do not climb during pauses', riderWorst < 1, `worst climb ${fmt(riderWorst, 2)} dB`);
}

{
    // A quiet video after a loud one: frozen at first (it might be a quiet
    // passage), then accepted as the new programme and brought up quickly.
    const input = S.concat([S.pink(10, RATE, -10, 3), S.pink(20, RATE, -35, 4)]);
    const { values } = track(dyn, S.stereo(input), {}, (p) => p.agcGainDb);
    const hold = at(values, 11.5) - at(values, 10.1);
    const after = at(values, 18) - at(values, 10.1);
    check('quiet after loud: held for the first moments', hold < 2, `${fmt(hold, 2)} dB in 1.4 s`);
    check('quiet after loud: then brought up as a new programme', after > 12, `+${fmt(after, 1)} dB by 8 s in`);
}

{
    // Fast acquire: a fresh start on a quiet source comes up within seconds.
    const { values } = track(dyn, S.stereo(S.pink(6, RATE, -32, 8)), {}, (p) => p.agcGainDb);
    check('fast acquire: a quiet source is +6 dB up within 3 s of a start', at(values, 3) > 6,
        `+${fmt(at(values, 3), 1)} dB at 3 s`);
}

{
    // Switched off, the auto level does nothing.
    const { processor } = track(dyn, S.stereo(S.pink(5, RATE, -35, 3)), { agcEnabled: 0 }, () => 0);
    check('auto level off holds unity', processor.agcGainDb === 0, `${processor.agcGainDb} dB`);
}

console.log('\n== Dynamics: band riders ==');

{
    // Static curve with the auto level off, on a 400 Hz (mid band) tone at
    // Density 0.5: a quiet band is lifted by half the maximum gain (+6 dB),
    // and above the threshold the output rises at half the input's rate.
    const gainAt = (db, params) => {
        const input = S.tone(400, 3, RATE, S.dbToGain(db));
        const out = dyn.run(dyn.create(), S.stereo(input), Object.assign({ agcEnabled: 0 }, params))[0];
        return S.gainToDb(S.rms(out, 2 * RATE) / S.rms(input, 2 * RATE));
    };
    const quiet = gainAt(-50, {});
    check('Density 0.5 lifts a quiet band by half the max gain', Math.abs(quiet - 6) < 0.5, `${fmt(quiet, 2)} dB`);
    const slope = (gainAt(-6, {}) + 10) - gainAt(-16, {});
    check('Density 0.5 compresses 2:1 above the threshold', Math.abs(slope - 5) < 1,
        `10 dB in -> ${fmt(slope, 2)} dB out`);
    const flat = gainAt(-6, { density: 0 });
    check('Density 0 leaves a loud band at unity', Math.abs(flat) < 0.05, `${fmt(flat, 3)} dB`);
    // Density 1 levels the band: its rider takes back every dB of a 10 dB
    // rise. Read from the rider rather than the summed output, where the
    // tone's small leakage into the quiet neighbouring bands is (correctly)
    // lifted by their riders and adds back a little level.
    const riderAt = (db) => {
        const processor = dyn.create();
        dyn.run(processor, S.stereo(S.tone(400, 3, RATE, S.dbToGain(db))), { agcEnabled: 0, density: 1 });
        return S.gainToDb(processor.riderGain[1]);
    };
    const levelled = riderAt(-6) - riderAt(-16);
    check('Density 1 levels a band: its rider takes back a 10 dB rise', Math.abs(levelled + 10) < 0.5,
        `rider ${fmt(levelled, 2)} dB for +10 dB in`);
}

{
    // Linked stereo: a loud left channel pulls the right down with it.
    const loudLeft = S.tone(400, 2, RATE, S.dbToGain(-6));
    const quietRight = S.tone(400, 2, RATE, S.dbToGain(-40));
    const linked = dyn.run(dyn.create(), [loudLeft, quietRight], { agcEnabled: 0 })[1];
    const alone = dyn.run(dyn.create(), [S.silence(2, RATE), quietRight], { agcEnabled: 0 })[1];
    const difference = S.gainToDb(S.rms(alone, RATE) / S.rms(linked, RATE));
    check('channels are linked: a loud left channel reduces the right', difference > 6, `${fmt(difference, 1)} dB less`);
}

{
    // Attack and release are in milliseconds and dB/s, not samples: the same
    // step gives the same timing at 44.1 and 48 kHz.
    const timing = (instance) => {
        const rate = instance.sampleRate;
        const input = S.steppedTone(400, rate, [{ db: -40, until: 2 }, { db: -6, until: 3 }, { db: -40, until: 5 }]);
        // Read every 8 samples: the mid band's fast attack lands within a
        // single 128-sample quantum.
        const { values } = track(instance, S.stereo(input), { agcEnabled: 0, density: 1 },
            (p) => S.gainToDb(p.riderGain[1]), 8);
        const attack = S.timeConstant(values.map((v) => ({ time: v.time, db: v.value })), 2, 2.9, 0);
        return attack;
    };
    const a48 = timing(dyn);
    const a441 = timing(dyn441);
    check('rider attack is the same at 44.1 and 48 kHz', Math.abs(a48 - a441) / a48 < 0.1,
        `${fmt(a48 * 1000, 1)} ms vs ${fmt(a441 * 1000, 1)} ms`);
}

{
    // Steady-tone distortion at the defaults with the auto level off. The
    // riders' gain only moves on peaks over the threshold, smoothed over
    // 0.2 ms, so a steady tone is clean except for the low band, whose
    // attack steps at the tone's own rate.
    [
        { f: 50, bound: -40 },
        { f: 400, bound: -50 },
        { f: 2500, bound: -50 },
        { f: 8000, bound: -50 }
    ].forEach(({ f, bound }) => {
        const input = S.tone(f, 2, RATE, S.dbToGain(-12));
        const out = dyn.run(dyn.create(), S.stereo(input), { agcEnabled: 0 })[0];
        const thd = S.thdDb(out, f, RATE, RATE, 2 * RATE);
        check(`${f} Hz at the defaults: distortion under ${bound} dB`, thd < bound, `THD ${fmt(thd, 1)} dB`);
    });
}

{
    // A kick and bass pattern, low band gain read every sample: no unbounded
    // steps, nothing non-finite.
    const input = S.kickBass(3, RATE).map((v) => v * S.dbToGain(-6));
    [0.5, 1].forEach((density) => {
        const gain = new Float32Array(input.length);
        let finite = true;
        dyn.run(dyn.create(), S.stereo(input), { agcEnabled: 0, density }, (processor, i) => {
            gain[i] = S.gainToDb(processor.smoothedGain[0]);
            if (!isFinite(gain[i])) finite = false;
        }, 1);
        const rough = S.gainRoughness(gain, RATE, 1, 15);
        check(`kick and bass, Density ${density}: low band gain stays bounded`, finite && rough.maxStepDb < 1,
            `max ${fmt(rough.maxStepDb, 3)} dB/sample`);
    });
}

{
    // An impulse comes out finite and settles; a NaN in the input does not
    // poison the filters.
    const input = S.impulse(0.5, RATE, 0.9, 0.1);
    const out = dyn.run(dyn.create(), S.stereo(input), {})[0];
    check('impulse response is finite and decays', !S.hasNonFinite(out) && S.peak(out, Math.round(0.4 * RATE)) < 1e-3,
        `tail peak ${fmt(S.gainToDb(S.peak(out, Math.round(0.4 * RATE))), 1)} dBFS`);
    const poisoned = S.tone(400, 0.5, RATE, 0.3);
    poisoned[1000] = NaN;
    const clean = dyn.run(dyn.create(), S.stereo(poisoned), {})[0];
    check('a NaN in the input does not poison the output', !S.hasNonFinite(clean) && S.rms(clean, RATE / 4) > 0.01,
        `rms after ${fmt(S.gainToDb(S.rms(clean, RATE / 4)), 1)} dBFS`);
}

console.log('\n== Dynamics: HF alias spurs ==');

{
    // The riders' attack steps happen on individual signal peaks; applied raw
    // they amplitude-modulate the band and fold back as inharmonic tones,
    // worst at 44.1 kHz. The 0.2 ms smoother on the applied gain is what keeps
    // them down. Density 1 and a hot level keep the riders working.
    [dyn, dyn441].forEach((instance) => {
        const rate = instance.sampleRate;
        [6000, 8000, 10000, 12000].forEach((f0) => {
            [['sine', S.tone], ['square', S.squareBandlimited]].forEach(([kind, generate]) => {
                const input = generate(f0, 1.5, rate, S.dbToGain(-6));
                const out = instance.run(instance.create(), S.stereo(input), { agcEnabled: 0, density: 1 })[0];
                const spur = S.worstSpurDb(out, f0, rate, Math.round(0.4 * rate), Math.round(1.4 * rate));
                check(`${kind} ${f0} Hz at ${rate} Hz: worst alias spur under -78 dBc`,
                    spur.db <= -78 && !S.hasNonFinite(out), `${fmt(spur.db, 1)} dBc at ${Math.round(spur.hz)} Hz`);
            });
        });
    });
}

{
    // At Density 1 compression tilts the spectrum, but smoothly: no tone may
    // sit well below its neighbours, which a band misalignment would leave.
    const frequencies = [];
    for (let i = 0; i < 40; i++) frequencies.push(Math.round(40 * Math.pow(18000 / 40, i / 39)));
    const input = S.multitone(frequencies, 2, RATE, S.dbToGain(-30));
    const out = dyn.run(dyn.create(), S.stereo(input), { agcEnabled: 0, density: 1 })[0];
    const notch = S.notchDepthDb(S.toneGainsDb(input, out, frequencies, RATE, RATE, 2 * RATE));
    check('multitone at Density 1: no comb notch against the local trend', notch < 3 && !S.hasNonFinite(out),
        `worst notch ${fmt(notch, 2)} dB`);
}

console.log('\n== Dynamics: noise reduction ==');

{
    // Off means off: the noise reduction parameters change nothing.
    const input = S.pink(2, RATE, -50, 3);
    const a = dyn.run(dyn.create(), S.stereo(input), { nrEnabled: 0 })[0];
    const b = dyn.run(dyn.create(), S.stereo(input), { nrEnabled: 0, nrThresholdDb: -30, nrFloorDb: 24 })[0];
    let identical = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { identical = false; break; }
    check('noise reduction off: its settings have no effect', identical);
}

{
    // Steady noise far under the threshold settles at the floor; a tone above
    // the threshold passes untouched. Auto level off so levels are direct.
    const params = { agcEnabled: 0, density: 0 };
    const hiss = S.pink(2, RATE, -85, 4);
    const off = dyn.run(dyn.create(), S.stereo(hiss), params)[0];
    const on = dyn.run(dyn.create(), S.stereo(hiss), Object.assign({ nrEnabled: 1 }, params))[0];
    const cut = S.gainToDb(S.rms(off, RATE) / S.rms(on, RATE));
    check('noise far under the threshold settles at the 12 dB floor', Math.abs(cut - 12) < 1, `${fmt(cut, 2)} dB cut`);

    const tone = S.tone(400, 1, RATE, S.dbToGain(-30));
    const toneOff = dyn.run(dyn.create(), S.stereo(tone), params)[0];
    const toneOn = dyn.run(dyn.create(), S.stereo(tone), Object.assign({ nrEnabled: 1 }, params))[0];
    // Within 0.3 dB rather than exactly: the tone's few-percent leakage into
    // the empty neighbouring bands is below their thresholds, and those bands
    // correctly close on it.
    const toneCut = S.gainToDb(S.rms(toneOff, RATE / 2) / S.rms(toneOn, RATE / 2));
    check('a tone above the threshold passes within 0.3 dB', Math.abs(toneCut) < 0.3, `${fmt(toneCut, 3)} dB`);

    // How quickly it opens: a tone burst after closed silence-level noise.
    const burst = S.concat([S.pink(1, RATE, -85, 5), S.tone(400, 0.2, RATE, S.dbToGain(-30))]);
    const burstOff = dyn.run(dyn.create(), S.stereo(burst), params)[0];
    const burstOn = dyn.run(dyn.create(), S.stereo(burst), Object.assign({ nrEnabled: 1 }, params))[0];
    const from = RATE + Math.round(0.005 * RATE);
    const to = from + Math.round(0.005 * RATE);
    const opened = S.gainToDb(S.rms(burstOn, from, to) / S.rms(burstOff, from, to));
    check('opens within 5 ms of a sound starting', opened > -1, `${fmt(opened, 2)} dB at 5-10 ms`);
}

{
    // Keyed before the auto level: a loud high band drives the auto level up
    // to its boost while the low band holds -85 dB hiss. The expander's
    // decision for the low band must not change with the boost.
    const hiss = S.pink(20, RATE, -85, 6);
    const lead = S.tone(9000, 20, RATE, S.dbToGain(-35));
    const mix = hiss.map((v, i) => v + lead[i]);
    const withAgc = dyn.create();
    dyn.run(withAgc, S.stereo(mix), { nrEnabled: 1 });
    const withoutAgc = dyn.create();
    dyn.run(withoutAgc, S.stereo(mix), { nrEnabled: 1, agcEnabled: 0 });
    const difference = Math.abs(S.gainToDb(withAgc.nrGain[0]) - S.gainToDb(withoutAgc.nrGain[0]));
    check('expander is keyed before the auto level', withAgc.agcGainDb > 6 && difference < 0.5,
        `auto level +${fmt(withAgc.agcGainDb, 1)} dB, low band expander ${fmt(S.gainToDb(withAgc.nrGain[0]), 1)} vs ${fmt(S.gainToDb(withoutAgc.nrGain[0]), 1)} dB`);
}

{
    // The rider must not undo the expander. Noise under the expander's
    // threshold but loud enough for the riders to work (above the -60 LUFS
    // gate): with noise reduction on, the output must still be well down.
    const noise = S.pink(6, RATE, -50, 7);
    const params = { agcEnabled: 0, nrThresholdDb: -30 };
    const off = dyn.run(dyn.create(), S.stereo(noise), params)[0];
    const on = dyn.run(dyn.create(), S.stereo(noise), Object.assign({ nrEnabled: 1 }, params))[0];
    const cut = S.gainToDb(S.rms(off, 4 * RATE) / S.rms(on, 4 * RATE));
    check('band riders do not undo the noise reduction', cut > 9, `${fmt(cut, 1)} dB down with it on`);
}

{
    // A tone sitting just above the threshold keeps the expander working at
    // its edge; it must not chatter into audible distortion.
    const params = { agcEnabled: 0, density: 0, nrEnabled: 1, nrThresholdDb: -40 };
    const input = S.tone(400, 2, RATE, S.dbToGain(-38));
    const out = dyn.run(dyn.create(), S.stereo(input), params)[0];
    const thd = S.thdDb(out, 400, RATE, RATE, 2 * RATE);
    check('a tone at the expander threshold: distortion under -60 dB', thd < -60, `THD ${fmt(thd, 1)} dB`);
}

console.log('\n== Chain: limiter transparency ==');

{
    // The whole chain at the defaults, dynamics then limiter, across the
    // Loudness range and at two input levels. Thresholds follow the target,
    // so the limiter should only catch stray peaks: little reduction most of
    // the time and never a lot.
    const programme = S.drumsOverBed(20, RATE, 0.45);
    [-30, -24, -17.4, -12].forEach((targetLufs) => {
        [-12, -30].forEach((peakDb) => {
            const input = programme.map((v) => v * S.dbToGain(peakDb));
            const shaped = dyn.run(dyn.create(), S.stereo(input), { targetLufs });
            const reductions = [];
            limiter.run(limiter.create(), shaped, { ceiling: S.dbToGain(-0.3) }, (processor, start) => {
                if (start > 8 * RATE) reductions.push(processor.peakReduction * 20 / Math.LN10);
                processor.peakReduction = 0;
            });
            reductions.sort((a, b) => a - b);
            const p95 = reductions[Math.floor(0.95 * reductions.length)];
            const max = reductions[reductions.length - 1];
            check(`target ${targetLufs} LUFS, input peaking ${peakDb} dB: limiter under 1 dB 95% of the time, never over 6 dB`,
                p95 < 1 && max < 6, `p95 ${fmt(p95, 2)} dB, max ${fmt(max, 2)} dB`);
        });
    });
}

{
    // A steady tone through the whole chain stays clean.
    const input = S.tone(440, 6, RATE, S.dbToGain(-14));
    const shaped = dyn.run(dyn.create(), S.stereo(input), {});
    const out = limiter.run(limiter.create(), shaped, { ceiling: S.dbToGain(-0.3) })[0];
    const thd = S.thdDb(out, 440, RATE, 4 * RATE, 6 * RATE);
    check('steady 440 Hz through the chain: distortion under -60 dB', thd < -60, `THD ${fmt(thd, 1)} dB`);
}

{
    // The limiter reports its deepest reduction over the port when metering
    // is on, and stays quiet when it is off.
    const processor = limiter.create();
    const loud = S.tone(1000, 0.5, RATE, S.dbToGain(6));
    limiter.run(processor, S.stereo(loud), { ceiling: S.dbToGain(-0.3) });
    const silent = processor.port.posted.filter((m) => m.type === 'gr').length;
    processor.port.onmessage({ data: { type: 'meters', on: true } });
    limiter.run(processor, S.stereo(loud), { ceiling: S.dbToGain(-0.3) });
    const reports = processor.port.posted.filter((m) => m.type === 'gr');
    check('limiter reports gain reduction only while metering', silent === 0 && reports.length >= 3
        && reports[reports.length - 1].db > 5, `${reports.length} reports, last ${fmt(reports.length ? reports[reports.length - 1].db : 0, 1)} dB`);
}

console.log('\n== Audio quality ==');

{
    // Rider calibration: pink noise at the target settles every band's rider
    // at about the same lift, so the multiband adds density without tilting
    // a balanced spectrum.
    const processor = dyn.create();
    dyn.run(processor, S.stereo(S.pink(20, RATE, -17.4, 3)), { targetLufs: -17.4 });
    const riders = Array.from(processor.riderGain).map(S.gainToDb);
    check('pink noise at the target settles every rider between +2 and +5 dB',
        riders.every((db) => db > 2 && db < 5), riders.map((db) => `${fmt(db, 1)} dB`).join(' / '));
}

{
    // Band isolation, the point of a multiband: a loud bass note pulsing at
    // 2 Hz must not modulate a quiet tone in another band. The bass envelope
    // is a raised cosine, so its spectrum stays at 50 +/- 2 Hz and anything
    // at 6 kHz +/- 2, 4, 6 Hz was made by the processor.
    const seconds = 12;
    const tone = S.tone(6000, seconds, RATE, S.dbToGain(-24));
    const mix = new Float32Array(tone.length);
    for (let i = 0; i < mix.length; i++) {
        const t = i / RATE;
        mix[i] = tone[i] + S.dbToGain(-6) * (0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * t)) * Math.sin(2 * Math.PI * 50 * t);
    }
    const from = 4 * RATE;
    const to = seconds * RATE;
    const out = dyn.run(dyn.create(), S.stereo(mix), { agcEnabled: 0 })[0];
    const alone = dyn.run(dyn.create(), S.stereo(tone), { agcEnabled: 0 })[0];
    const sideband = S.sidebandDb(out, 6000, RATE, [2, 4, 6], from, to);
    const shift = 10 * Math.log10(S.power(out, 6000, RATE, from, to) / S.power(alone, 6000, RATE, from, to));
    check('bands are isolated: pulsing bass does not modulate a 6 kHz tone (auto level off)',
        sideband < -100 && Math.abs(shift) < 0.1,
        `sidebands ${fmt(sideband, 1)} dBc, tone level ${fmt(shift, 3)} dB`);
    // With the auto level on, the bass does move the wideband gain, but
    // slowly: no audible pumping on the tone.
    const withAgc = dyn.run(dyn.create(), S.stereo(mix), {})[0];
    const agcSideband = S.sidebandDb(withAgc, 6000, RATE, [2, 4, 6], from, to);
    check('with the auto level on, the bass pulses leave the tone\'s sidebands under -60 dBc',
        agcSideband < -60, `sidebands ${fmt(agcSideband, 1)} dBc`);
}

/** Dynamics at the given settings, then the limiter at its defaults. */
function chain(input, dynParams, instance, limiterInstance) {
    const d = instance || dyn;
    const l = limiterInstance || limiter;
    const shaped = d.run(d.create(), input, dynParams || {});
    return l.run(l.create(), shaped, { ceiling: CEILING });
}

{
    // SMPTE intermodulation through the whole chain at the defaults: 60 Hz
    // and 7 kHz at 4:1. The two land in different bands, so the bass cannot
    // modulate the treble through a shared gain.
    const low = S.tone(60, 4, RATE, S.dbToGain(-10));
    const high = S.tone(7000, 4, RATE, S.dbToGain(-22));
    const input = low.map((v, i) => v + high[i]);
    const out = chain(S.stereo(input))[0];
    const imd = S.imdSmpteDb(out, 60, 7000, RATE, 2 * RATE, 4 * RATE);
    check('SMPTE IMD (60 Hz + 7 kHz) through the chain under -70 dB', imd < -70, `${fmt(imd, 1)} dB`);
}

{
    // Twin-tone intermodulation at 19 and 20 kHz, where a fast high band
    // rider would ride the 1 kHz beat between them and fold products down.
    [-12, -6].forEach((db) => {
        const a = S.tone(19000, 4, RATE, S.dbToGain(db));
        const b = S.tone(20000, 4, RATE, S.dbToGain(db));
        const input = a.map((v, i) => v + b[i]);
        const out = chain(S.stereo(input))[0];
        const imd = S.twinToneImdDb(out, 19000, 20000, RATE, 2 * RATE, 4 * RATE);
        check(`twin-tone IMD (19 + 20 kHz at ${db} dBFS each) through the chain under -65 dB`,
            imd < -65 && !S.hasNonFinite(out), `${fmt(imd, 1)} dB`);
    });
}

{
    // Stereo image: every gain is linked, and both channels go through the
    // same filters, so a source panned 6 dB left comes out panned exactly
    // the same, and the right channel stays an exact scaled copy of the left.
    const left = S.drumsOverBed(6, RATE).map((v) => v * S.dbToGain(-8));
    const right = left.map((v) => v * 0.5);
    const out = chain([left, right]);
    const ratio = S.channelRatioDb(out[1], out[0], RATE, 6 * RATE) - S.gainToDb(0.5);
    const residual = S.residualDb(out[0], out[1], 0.5, RATE, 6 * RATE);
    check('a panned source keeps its image through the chain', Math.abs(ratio) < 0.01 && residual < -100,
        `ratio error ${fmt(ratio, 4)} dB, residual ${fmt(residual, 1)} dB`);
}

{
    // Silence in is silence out, exactly, from both worklets: no DC, no
    // dither, no noise floor of their own.
    const zeros = S.silence(3, RATE);
    const fromDyn = dyn.run(dyn.create(), S.stereo(zeros), { nrEnabled: 1 });
    const fromLimiter = limiter.run(limiter.create(), fromDyn, { ceiling: CEILING });
    const exact = [fromDyn, fromLimiter].every((out) => out.every((ch) => ch.every((v) => v === 0)));
    check('silence in gives exact zeros out of both worklets', exact);
}

{
    // After a loud passage and five seconds of silence, every recursive
    // state has been flushed to exactly zero: nothing is left decaying
    // through the subnormal range, which is very slow on most CPUs.
    const input = S.concat([S.drumsOverBed(2, RATE).map((v) => v * S.dbToGain(-3)), S.silence(5, RATE)]);
    const d = dyn.create();
    const shaped = dyn.run(d, S.stereo(input), { nrEnabled: 1 });
    const l = limiter.create();
    limiter.run(l, shaped, { ceiling: CEILING });
    const envelopes = [d.detector, d.nrEnvelope, d.nrPeak].every((a) => a.every((v) => v === 0));
    const limiterRest = l.fast === 0 && l.slow === 0 && l.envelopeSum === 0 && l.averageSum === 0;
    check('after a pause, filter and envelope state is exactly zero', d.filtersSettled() && envelopes && limiterRest,
        `filters ${d.filtersSettled() ? 'settled' : 'not settled'}, envelopes ${envelopes ? 'zero' : 'not zero'}, `
            + `limiter ${limiterRest ? 'at rest' : 'not at rest'}`);
}

{
    // A very quiet signal passes untouched at Density 0 with the auto level
    // off: nothing in the chain gates, dithers or truncates it.
    const input = S.tone(1000, 2, RATE, S.dbToGain(-80));
    const out = chain(S.stereo(input), FLAT)[0];
    const error = S.gainToDb(S.rms(out, RATE) / S.rms(input, RATE));
    check('a -80 dBFS tone passes the chain within 0.05 dB', Math.abs(error) < 0.05, `${fmt(error, 4)} dB`);
}

{
    // Clicks when controls move. A steady 1 kHz tone has nothing above
    // 16 kHz, so anything there is a discontinuity. The host ramps every
    // control with a 20 ms setTargetAtTime, emulated here per quantum; the
    // crossovers are also checked stepped, which the worklet's own glide
    // has to absorb.
    const tone = S.tone(1000, 4, RATE, S.dbToGain(-12));
    const hostRamp = (values, period) => (start) => {
        const t = start / RATE;
        const k = Math.floor(t / period);
        const target = values[k % values.length];
        if (k === 0) return target;
        const previous = values[(k - 1) % values.length];
        return target + (previous - target) * Math.exp(-(t - k * period) / 0.02);
    };
    const stepped = (values, period) => (start) => values[Math.floor(start / RATE / period) % values.length];
    const clickDb = (params) => {
        const out = dyn.run(dyn.create(), S.stereo(tone), params)[0];
        return S.gainToDb(S.highpassPeak(out, RATE, 16000, RATE / 2));
    };
    const baseline = clickDb({});
    const ramped = clickDb({
        crossLowHz: hostRamp([150, 900, 400], 0.5),
        crossHighHz: hostRamp([2500, 6000, 1500], 0.5),
        density: hostRamp([0.2, 0.8], 0.25),
        bandMaxGainDb: hostRamp([12, 4, 20], 0.4)
    });
    const steppedCrossovers = clickDb({
        crossLowHz: stepped([150, 900, 400], 0.5),
        crossHighHz: stepped([2500, 6000, 1500], 0.5)
    });
    const switches = clickDb({
        nrEnabled: (start) => Math.floor(start / RATE / 0.7) % 2,
        agcEnabled: (start) => 1 - (Math.floor(start / RATE / 1.1) % 2)
    });
    check('controls moving as the host ramps them: no click above -65 dBFS', ramped < -65,
        `${fmt(ramped, 1)} dBFS above 16 kHz, against ${fmt(baseline, 1)} dBFS at rest`);
    check('crossovers stepped: the glide keeps clicks under -65 dBFS', steppedCrossovers < -65,
        `${fmt(steppedCrossovers, 1)} dBFS above 16 kHz`);
    check('switching noise reduction and auto level: no click above -90 dBFS', switches < -90,
        `${fmt(switches, 1)} dBFS above 16 kHz`);
}

{
    // High sample rates, as some desktop audio devices run: the split is
    // still flat, the limiter still holds its ceiling, and the riders still
    // make no alias spurs.
    [88200, 96000].forEach((rate) => {
        const d = loadProcessor('content/dynamics-processor.js', rate);
        const l = loadProcessor('content/limiter-processor.js', rate);
        const frequencies = [];
        for (let i = 0; i < 30; i++) frequencies.push(Math.round(40 * Math.pow(30000 / 40, i / 29)));
        const multitone = S.multitone(frequencies, 2, rate, S.dbToGain(-30));
        const flat = d.run(d.create(), S.stereo(multitone), FLAT)[0];
        const gains = S.toneGainsDb(multitone, flat, frequencies, rate, rate, 2 * rate);
        const spread = Math.max(...gains) - Math.min(...gains);

        const loud = Float32Array.from(S.drumsOverBed(2, rate), (v) => v * S.dbToGain(CEILING_DB + 18));
        const limited = l.run(l.create(), S.stereo(loud), { ceiling: CEILING })[0];

        const sine = S.tone(16000, 1.5, rate, S.dbToGain(-6));
        const ridden = d.run(d.create(), S.stereo(sine), { agcEnabled: 0, density: 1 })[0];
        const spur = S.worstSpurDb(ridden, 16000, rate, Math.round(0.4 * rate), Math.round(1.4 * rate), 400, 100);

        check(`${rate} Hz: split flat, ceiling holds, no alias spurs`,
            spread < 0.1 && S.peak(limited) <= CEILING * (1 + 1e-4) && spur.db < -78
                && !S.hasNonFinite(flat) && !S.hasNonFinite(limited),
            `spread ${fmt(spread, 4)} dB, peak ${fmt(S.gainToDb(S.peak(limited)), 3)} dBFS, `
                + `worst spur ${fmt(spur.db, 1)} dBc`);
    });
}

{
    // Two minutes of programme through the chain: nothing drifts, nothing
    // goes non-finite, the ceiling holds throughout, and the level stays put
    // from one ten-second window to the next once the auto level has
    // settled.
    const seconds = 120;
    const input = Float32Array.from(S.drumsOverBed(seconds, RATE), (v) => v * S.dbToGain(-12));
    const d = dyn.create();
    const shaped = dyn.run(d, S.stereo(input), {});
    const out = limiter.run(limiter.create(), shaped, { ceiling: CEILING })[0];
    const windows = [];
    for (let t = 20; t < seconds; t += 10) windows.push(S.gainToDb(S.rms(out, t * RATE, (t + 10) * RATE)));
    const drift = Math.max(...windows) - Math.min(...windows);
    const stateFinite = [d.riderGain, d.smoothedGain, d.detector].every((a) => a.every(isFinite))
        && isFinite(d.agcGainDb);
    check('two minutes of programme: finite, under the ceiling, level steady within 0.5 dB',
        !S.hasNonFinite(out) && stateFinite && S.peak(out) <= CEILING * (1 + 1e-4) && drift < 0.5,
        `drift ${fmt(drift, 3)} dB across ten-second windows`);
}

{
    // The fast paths change nothing: the dynamics worklet skipping its
    // filters on silence, and the limiter skipping the interpolator on quiet
    // samples and the whole loop on silence, must give bit-identical output
    // to running everything. Programme with silent gaps, at several drives,
    // and with the ceiling moving under the limiter.
    // The last gap is long enough for 18 dB of sustained limiting to
    // release completely, which is when the limiter's silence path can
    // start.
    const programme = S.concat([
        S.drumsOverBed(2, RATE), S.silence(1.5, RATE),
        S.drumsOverBed(1, RATE), S.silence(2, RATE),
        S.pink(1, RATE, -20, 9), S.silence(9, RATE)
    ]);
    const identical = (a, b) => a.every((ch, c) => ch.every((v, i) => v === b[c][i]));

    [{}, { nrEnabled: 1 }].forEach((params) => {
        const input = S.stereo(programme.map((v) => v * S.dbToGain(-10)));
        const fast = dyn.create();
        let skipped = 0;
        const settled = fast.filtersSettled.bind(fast);
        fast.filtersSettled = () => { const r = settled(); if (r) skipped++; return r; };
        const slow = dyn.create();
        slow.fastPath = false;
        const a = dyn.run(fast, input, params);
        const b = dyn.run(slow, input, params);
        check(`dynamics fast path is bit-identical${params.nrEnabled ? ' (noise reduction on)' : ''}`,
            identical(a, b) && skipped > 0 && fast.agcGainDb === slow.agcGainDb,
            `${skipped} silent quanta skipped`);
    });

    [-6, 0, 6, 18].forEach((overDb) => {
        const input = S.stereo(programme.map((v) => v * S.dbToGain(CEILING_DB + overDb)));
        const fast = limiter.create();
        let skipped = 0;
        const skip = fast.skipSilence.bind(fast);
        fast.skipSilence = (...args) => { skipped++; return skip(...args); };
        const slow = limiter.create();
        slow.fastPath = false;
        // At +6 dB the ceiling jumps to a random setting every quantum.
        let state = 7;
        const ceiling = overDb !== 6 ? CEILING : () => {
            state = (Math.imul(state, 1103515245) + 12345) >>> 0;
            return S.dbToGain(-3 * (state / 4294967296));
        };
        const a = limiter.run(fast, input, { ceiling });
        state = 7;
        const b = limiter.run(slow, input, { ceiling });
        check(`limiter fast paths are bit-identical, programme ${overDb >= 0 ? '+' : ''}${overDb} dB over${overDb === 6 ? ', ceiling moving' : ''}`,
            identical(a, b) && skipped > 0, `${skipped} silent quanta skipped`);
    });
}

console.log('\n== Real time ==');

// The render quantum's deadline, in milliseconds: 128 samples at 48 kHz.
const BUDGET_MS = (128 / RATE) * 1000;

/**
 * Dynamics then limiter, as a page runs them: both worklet files freshly
 * loaded (see loadProcessor), so the JIT sees one instance of each with one
 * configuration. The processors above have been driven through every shape
 * of test (mono, one-sample quanta, parameters changing every block), and a
 * JIT that has seen all of that compiles them differently from one that has
 * only seen a page playing audio.
 */
function pageChain(dynParams, fastPath) {
    const stages = [
        { processor: loadProcessor('content/dynamics-processor.js', RATE, true).create(), params: dynParams },
        { processor: loadProcessor('content/limiter-processor.js', RATE, true).create(), params: { ceiling: CEILING } }
    ];
    if (fastPath === false) stages.forEach((stage) => { stage.processor.fastPath = false; });
    return stages;
}

{
    // Per-quantum cost of dynamics plus limiter, browser-style: views and
    // parameter arrays built ahead, nothing allocated in the loop. A desktop
    // has headroom to spare; the numbers are printed with a projection to a
    // device four times slower, a mid-range phone. The mean is what keeps
    // the device busy; the tail is what causes underruns. Warmed up first,
    // so the JIT has compiled what it is going to.
    const programme = S.stereo(Float32Array.from(S.drumsOverBed(20, RATE), (v) => v * S.dbToGain(-12)));
    [{ label: 'defaults', params: {} }, { label: 'noise reduction on', params: { nrEnabled: 1 } }].forEach(({ label, params }) => {
        // The JIT compiles the hot paths in its own time; a page plays for
        // far longer than that, so the first pass is warm-up.
        const prepared = prepareChain(pageChain(params), programme);
        prepared.run(false);
        prepared.run(false);
        const { times } = prepared.run(true);
        const meanShare = (100 * S.mean(times)) / BUDGET_MS;
        const p99 = (100 * S.percentile(times, 0.99)) / BUDGET_MS;
        const p999 = (100 * S.percentile(times, 0.999)) / BUDGET_MS;
        check(`chain at ${label}: mean under 5% and p99 under 25% of the quantum budget`,
            meanShare < 5 && p99 < 25,
            `mean ${fmt(meanShare)}%, p99 ${fmt(p99)}%, p99.9 ${fmt(p999)}% `
                + `(x4 device: mean ${fmt(4 * meanShare, 1)}%, p99 ${fmt(4 * p99, 1)}%)`);
    });
}

{
    // Silence must not cost more than sound. Before the flush, filter state
    // decaying after a pause spent seconds in the subnormal range, where
    // every multiply is many times slower; the fast paths go further and
    // skip work outright. Checked with the fast paths off too, so the flush
    // stands on its own.
    const input = S.stereo(S.concat([S.drumsOverBed(3, RATE).map((v) => v * S.dbToGain(-6)), S.silence(30, RATE)]));
    const audioQuanta = Math.floor((3 * RATE) / 128);
    [true, false].forEach((fastPath) => {
        const prepared = prepareChain(pageChain({ nrEnabled: 1 }, fastPath), input);
        prepared.run(false);
        const { times } = prepared.run(true);
        // From the second loop: the first second of audio, then silence well
        // after the decay.
        const audio = S.mean(times.subarray(Math.floor(audioQuanta / 3), audioQuanta));
        const quiet = S.mean(times.subarray(audioQuanta + 10 * (RATE / 128)));
        check(`silence costs no more than sound (fast paths ${fastPath ? 'on' : 'off'})`,
            quiet <= audio * (fastPath ? 1 : 1.25),
            `${fmt((100 * quiet) / BUDGET_MS)}% of budget in silence, ${fmt((100 * audio) / BUDGET_MS)}% with audio`);
    });
}

{
    // The render loop allocates nothing: garbage collection on the audio
    // thread is a pause in the middle of a quantum.
    //
    // Checked per allocation site with V8's sampling heap profiler, counting
    // garbage as well as survivors. What V8 has not optimised yet boxes
    // every double it computes, which is allocation in V8 and none at all in
    // SpiderMonkey, which keeps doubles unboxed. So each pass is ten seconds
    // of audio, passes repeat until V8 has finished compiling (one comes out
    // clean, up to eight), and the functions that run only now and then are
    // left out: the auto level's block update (10 Hz), the riders' gate
    // window (50 Hz) and the limiter's periodic re-sum (every 65536
    // samples). Everything per quantum and per sample must allocate nothing.
    const inspector = require('inspector');
    const session = new inspector.Session();
    session.connect();
    // The in-process session answers synchronously.
    const post = (method, params) => {
        let result = null;
        session.post(method, params || {}, (error, response) => {
            if (error) throw error;
            result = response;
        });
        return result;
    };

    const seconds = 10;
    const input = S.stereo(Float32Array.from(S.drumsOverBed(seconds, RATE), (v) => v * S.dbToGain(-12)));
    const prepared = prepareChain(pageChain({ nrEnabled: 1 }), input);
    prepared.run(false);

    const OCCASIONAL = ['finishBlock', 'finishRiderWindow', 'rebuildBoxes', 'sumRecent'];
    const isWorklet = (frame) => /(dynamics|limiter)-processor\.js$/.test(frame.url);
    const measurePass = () => {
        post('HeapProfiler.startSampling', {
            samplingInterval: 16,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true
        });
        prepared.run(false);
        const { profile } = post('HeapProfiler.stopSampling');
        const result = { perQuantum: 0, occasional: 0, sites: {} };
        const walk = (node, underOccasional) => {
            const frame = node.callFrame;
            const occasional = underOccasional || (isWorklet(frame) && OCCASIONAL.includes(frame.functionName));
            if (node.selfSize > 0 && isWorklet(frame)) {
                if (occasional) {
                    result.occasional += node.selfSize;
                } else {
                    result.perQuantum += node.selfSize;
                    const site = `${frame.functionName || '(anonymous)'}:${frame.lineNumber + 1}`;
                    result.sites[site] = (result.sites[site] || 0) + node.selfSize;
                }
            }
            (node.children || []).forEach((child) => walk(child, occasional));
        };
        walk(profile.head, false);
        return result;
    };

    post('HeapProfiler.enable');
    let pass = null;
    let passes = 0;
    while (passes < 8) {
        pass = measurePass();
        passes++;
        if (pass.perQuantum < 1024) break;
    }
    post('HeapProfiler.disable');
    session.disconnect();

    const sites = pass.sites;
    const worst = Object.keys(sites).sort((a, b) => sites[b] - sites[a]).slice(0, 3)
        .map((site) => `${site} ${fmt(sites[site] / 1024, 1)} KB`).join(', ');
    check('the per-quantum code allocates nothing', pass.perQuantum < 1024,
        `${fmt(pass.perQuantum / 1024, 1)} KB over ${seconds} s on pass ${passes}${worst ? ` (${worst})` : ''}; `
            + `occasional updates ${fmt(pass.occasional / 1024, 1)} KB`);
}

{
    // The plain throughput figure, for comparison between changes.
    const input = S.stereo(S.pink(10, RATE, -20, 5));
    const timeIt = (instance, params) => {
        const begin = process.hrtime.bigint();
        instance.run(instance.create(), input, params);
        return Number(process.hrtime.bigint() - begin) / 1e6 / 10;
    };
    const plain = timeIt(dyn, {});
    const withNr = timeIt(dyn, { nrEnabled: 1 });
    const limited = timeIt(limiter, { ceiling: CEILING });
    check('dynamics and limiter each run at least 10x faster than real time',
        plain < 100 && withNr < 100 && limited < 100,
        `dynamics ${fmt(plain, 1)} ms per second of audio (${fmt(withNr, 1)} with noise reduction), `
            + `limiter ${fmt(limited, 1)} ms`);
}

/* ------------------------------------------------------------------ settings */

console.log('\n== Settings ==');

{
    // common/settings.js is browser-free, so it runs as-is in a bare context.
    const fs = require('fs');
    const path = require('path');
    const vm = require('vm');
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'common', 'settings.js'), 'utf8');
    const settings = vm.runInNewContext(`${source}; ThunderFoxSettings`, {});

    const sorted = settings.sanitizeAdvanced({ crossLowHz: 8000, crossHighHz: 300 });
    check('sanitizeAdvanced puts crossed crossovers back in order',
        sorted.crossLowHz === 300 && sorted.crossHighHz === 8000,
        `${sorted.crossLowHz} / ${sorted.crossHighHz} Hz`);

    const choices = [settings.sanitizeAdvanced({ audioLatency: 'stable' }).audioLatency,
        settings.sanitizeAdvanced({ audioLatency: 'huge' }).audioLatency];
    check('sanitizeAdvanced keeps a known buffer choice and rejects others',
        choices[0] === 'stable' && choices[1] === 'auto', choices.join(' / '));

    const hints = [settings.latencyHint('auto', false), settings.latencyHint('auto', true),
        settings.latencyHint('low', true), settings.latencyHint('stable', false), settings.latencyHint('bogus', true)];
    check('buffer choices map to latency hints, Auto per platform',
        hints.join() === 'interactive,balanced,interactive,playback,balanced', hints.join(' / '));

    check('the buffer choice and noise reduction are governed by the Advanced switch',
        settings.ADVANCED_ALL_KEYS.includes('audioLatency') && settings.ADVANCED_ALL_KEYS.includes('limiterIsp')
            && settings.ADVANCED_ALL_KEYS.includes('nrEnabled') && !settings.ADVANCED_ALL_KEYS.includes('crossMidHz'));
    const nr = [settings.sanitizeAdvanced({ nrEnabled: true }).nrEnabled, settings.sanitizeAdvanced({ nrEnabled: 'yes' }).nrEnabled,
        settings.sanitizeAdvanced({}).nrEnabled];
    check('noise reduction is a stored boolean that defaults to off', nr.join() === 'true,false,false', nr.join(' / '));

    const flags = settings.sanitizeAdvanced({ agcEnabled: false, limiterIsp: 'yes' });
    check('sanitizeAdvanced keeps booleans and rejects non-booleans',
        flags.agcEnabled === false && flags.limiterIsp === true,
        JSON.stringify({ agc: flags.agcEnabled, isp: flags.limiterIsp }));

    const ends = [settings.loudnessProfile(0).targetLufs, settings.loudnessProfile(1).targetLufs];
    check('Loudness spans -30 to -12 LUFS', ends[0] === -30 && ends[1] === -12, ends.join(' / '));
    check('a bad Loudness value falls back to the default',
        settings.loudnessProfile('loud').targetLufs
            === settings.loudnessProfile(settings.DEFAULTS.loudness).targetLufs);

    const current = settings.SETTINGS_VERSION;

    const held = settings.migrateStored({ settingsVersion: 1, limiterHoldMs: 2 });
    check('migration 1 -> 2 still moves the limiter hold from its old default',
        held.limiterHoldMs === 20 && held.settingsVersion === current, JSON.stringify(held));

    const widened = settings.migrateStored({ settingsVersion: 4, limiterAttackMs: 2.5 });
    const narrow = settings.migrateStored({ settingsVersion: 4, limiterAttackMs: 1 });
    check('migration 4 -> 5 moves the limiter attack only from its old default',
        widened.limiterAttackMs === 5 && narrow.limiterAttackMs === undefined
            && widened.settingsVersion === current && narrow.settingsVersion === current,
        `${JSON.stringify(widened)} / ${JSON.stringify(narrow)}`);

    const fromOtt = settings.migrateStored({ settingsVersion: 5, limiterThreshold: -24, ottDepth: 1 });
    check('migration 5 -> 6 carries nothing over from the old multiband',
        fromOtt.limiterThreshold === undefined && fromOtt.ottDepth === undefined
            && fromOtt.settingsVersion === current, JSON.stringify(fromOtt));

    // 6 -> 7 resets every band value and both crossovers, set or not.
    const fourBand = {
        settingsVersion: 6, crossLowHz: 300, crossMidHz: 1200, crossHighHz: 6000,
        bandLowGainDb: 5, bandLowMidThresholdDb: -3, bandHighThresholdDb: -4, bandHighNrOffsetDb: 2,
        limiterReleaseMs: 200
    };
    const threeBand = settings.migrateStored(fourBand);
    const bandKeys = Object.keys(threeBand).filter((key) => /^band(Low|Mid|High)[A-Z]/.test(key));
    check('migration 6 -> 7 resets the crossovers and every band value, and nothing else',
        threeBand.crossLowHz === 150 && threeBand.crossHighHz === 2500 && bandKeys.length === 9
            && bandKeys.every((key) => threeBand[key] === 0) && threeBand.limiterReleaseMs === undefined
            && threeBand.settingsVersion === 7,
        JSON.stringify(threeBand));
    check('the four-band keys are listed for removal',
        ['crossMidHz', 'bandLowMidThresholdDb', 'bandHighMidNrOffsetDb'].every((key) => settings.REMOVED_KEYS.includes(key))
            && settings.REMOVED_KEYS.every((key) => !(key in settings.DEFAULTS)),
        settings.REMOVED_KEYS.join(', '));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures > 0 ? 1 : 0);
