'use strict';

/**
 * Runs the AudioWorklet processors outside a browser.
 *
 * Each processor file is evaluated in its own vm context with the handful of
 * globals the AudioWorklet scope provides: `AudioWorkletProcessor`,
 * `registerProcessor` and `sampleRate`. Nothing in either processor touches
 * anything else, so the same file the extension ships is what gets tested.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RENDER_QUANTUM = 128;
const ROOT = path.resolve(__dirname, '..');

// Counts fresh loads, so each one's source is unique.
let freshLoads = 0;

/**
 * `fresh` gives the file a unique trailing comment. V8 caches compiled code
 * by source text, and with it the record of how often each function has
 * been deoptimised; a function deoptimised often enough is never optimised
 * again, in any context that shares that source. A test that measures speed
 * or allocation wants the code as a page that only ever plays audio would
 * get it, not as every other test has left it.
 */
function loadProcessor(relativePath, sampleRate, fresh) {
    let source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    if (fresh) source += `
// fresh load ${++freshLoads}
`;
    const registered = {};

    class AudioWorkletProcessor {
        constructor() {
            // Messages the processor posts are kept, so a test can read the
            // latency report the limiter sends from its constructor.
            const posted = [];
            this.port = {
                onmessage: null,
                posted,
                postMessage(message) { posted.push(message); }
            };
        }
    }

    const sandbox = {
        sampleRate,
        AudioWorkletProcessor,
        registerProcessor(name, ctor) { registered[name] = ctor; },
        console
    };
    vm.createContext(sandbox);
    vm.runInContext(source, sandbox, { filename: relativePath });

    const names = Object.keys(registered);
    if (names.length !== 1) throw new Error(`${relativePath} registered ${names.length} processors`);
    const Processor = registered[names[0]];

    const descriptors = Processor.parameterDescriptors;
    const defaults = {};
    descriptors.forEach((d) => { defaults[d.name] = d.defaultValue; });

    return {
        name: names[0],
        sampleRate,
        defaults,
        create() { return new Processor(); },

        /**
         * Push `input` (array of Float32Array channels, equal length) through
         * `processor` and return the output channels. `params` maps parameter
         * names to a number, or to a function of the block's start frame that
         * returns one, so a test can move a control mid-run. `onBlock`, if
         * given, is called with (processor, startFrame) after every quantum.
         * `quantum` overrides the 128-frame render quantum; a test that wants
         * the processor's internal state sample by sample passes 1.
         */
        run(processor, input, params, onBlock, quantum) {
            const step = quantum || RENDER_QUANTUM;
            const channels = input.length;
            const length = input[0].length;
            const output = [];
            for (let c = 0; c < channels; c++) output.push(new Float32Array(length));

            const merged = Object.assign({}, defaults, params || {});
            const paramArrays = {};
            Object.keys(merged).forEach((key) => { paramArrays[key] = new Float32Array(1); });

            for (let start = 0; start < length; start += step) {
                const frames = Math.min(step, length - start);
                const inBlock = input.map((ch) => ch.subarray(start, start + frames));
                const outBlock = output.map((ch) => ch.subarray(start, start + frames));

                Object.keys(merged).forEach((key) => {
                    const value = merged[key];
                    paramArrays[key][0] = typeof value === 'function' ? value(start) : value;
                });

                processor.process([inBlock], [outBlock], paramArrays);
                if (onBlock) onBlock(processor, start);
            }

            return output;
        },

        /**
         * A browser-like render loop over a chain of processors of this and
         * other loaded types: `stages` is an array of { processor, params }
         * (params as numbers only), and each stage's output feeds the next.
         * Every block view and parameter array is built before the loop, so
         * the loop itself allocates nothing, as on the audio thread. With
         * `timed`, the time each quantum took through the whole chain is
         * recorded, in milliseconds.
         */
        runChain(stages, input, timed) {
            return runChain(stages, input, timed);
        }
    };
}

function runChain(stages, input, timed) {
    return prepareChain(stages, input).run(timed);
}

/**
 * Everything runChain needs, built up front, and a run(timed) that does only
 * the render loop: so a test can measure what the loop alone allocates. Each
 * run continues from the processors' current state.
 */
function prepareChain(stages, input) {
    const channels = input.length;
    const length = input[0].length;
    const blocks = Math.ceil(length / RENDER_QUANTUM);

    // One output buffer per stage, and per block the views into each.
    const buffers = stages.map(() => {
        const out = [];
        for (let c = 0; c < channels; c++) out.push(new Float32Array(length));
        return out;
    });
    const views = [];
    for (let k = 0; k < blocks; k++) {
        const start = k * RENDER_QUANTUM;
        const end = Math.min(length, start + RENDER_QUANTUM);
        const stageViews = [[input.map((ch) => ch.subarray(start, end))]];
        buffers.forEach((out) => stageViews.push([out.map((ch) => ch.subarray(start, end))]));
        views.push(stageViews);
    }
    const paramSets = stages.map((stage) => {
        const arrays = {};
        const descriptors = stage.processor.constructor.parameterDescriptors;
        descriptors.forEach((d) => {
            const value = stage.params && stage.params[d.name] !== undefined ? stage.params[d.name] : d.defaultValue;
            arrays[d.name] = new Float32Array([value]);
        });
        return arrays;
    });

    const now = typeof performance !== 'undefined' ? () => performance.now() : null;
    return {
        run(timed) {
            const times = timed ? new Float64Array(blocks) : null;
            for (let k = 0; k < blocks; k++) {
                const stageViews = views[k];
                const begin = timed ? now() : 0;
                for (let s = 0; s < stages.length; s++) {
                    stages[s].processor.process(stageViews[s], stageViews[s + 1], paramSets[s]);
                }
                if (timed) times[k] = now() - begin;
            }
            return { output: buffers[buffers.length - 1], outputs: buffers, times };
        }
    };
}

module.exports = { loadProcessor, runChain, prepareChain, RENDER_QUANTUM };
