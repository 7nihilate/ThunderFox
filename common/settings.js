// Defaults, ranges and the Loudness morph, shared by the content script, the
// popup and the options page. Before this existed the popup declared its own
// copy of every range and they drifted: the EQ sliders were ±12 in the markup,
// ±18 once the popup's init() had run, and ±18 again in the content script's
// clamp. One definition, three consumers.
var ThunderFoxSettings = (function() {
    // 8 bands, roughly 1.1 octaves apart. The outer two are shelves so content
    // below 68 Hz and above 15 kHz is reachable at all; as peaking filters it
    // was not.
    const EQ_BANDS = [
        { frequency: 68, type: 'lowshelf', label: '68 Hz' },
        { frequency: 147, type: 'peaking', label: '147 Hz' },
        { frequency: 315, type: 'peaking', label: '315 Hz' },
        { frequency: 678, type: 'peaking', label: '678 Hz' },
        { frequency: 1464, type: 'peaking', label: '1.5 kHz' },
        { frequency: 3153, type: 'peaking', label: '3.2 kHz' },
        { frequency: 6787, type: 'peaking', label: '6.8 kHz' },
        { frequency: 14635, type: 'highshelf', label: '14.6 kHz' }
    ];

    // For a peaking biquad, Q = sqrt(2^BW) / (2^BW - 1). The bands sit
    // log2(147/68) = 1.11 octaves apart, so matched bandwidth wants 1.27. The
    // old Q of 1.0 is 1.39 octaves — 26% wider than the spacing, which is why
    // eight sliders at +12 dB used to give about +15 dB through the middle.
    const EQ_Q = 1.27;
    const EQ_GAIN_LIMIT = 18;
    const EQ_BAND_COUNT = EQ_BANDS.length;

    // Butterworth. The old value of 1.0 put a +1.25 dB resonant bump just above
    // the cutoff, on a control labelled "Bass cut".
    const HIGHPASS_Q = Math.SQRT1_2;
    const HIGHPASS_HZ = 200;

    // The Loudness slider sets the AGC's loudness target, in LUFS. The top is
    // kept well short of 0 so that the final limiter only ever catches stray
    // peaks: everything louder than this would have to come from limiting.
    const MIN_TARGET_LUFS = -30;
    const MAX_TARGET_LUFS = -12;

    const BAND_KEYS = ['Low', 'Mid', 'High'];

    const DEFAULTS = {
        enabled: true,
        hpEnabled: false,
        eqEnabled: true,
        nrEnabled: false,
        // 0..1 slider positions. Loudness 0.7 is a target of about -17.4
        // LUFS; Density 0.5 is 2:1 in every band.
        loudness: 0.7,
        density: 0.5,
        eqGains: [0, 0, 0, 0, 0, 0, 0, 0],
        advancedEnabled: false,

        preBoostDb: 0,

        // Auto level. The gate is relative to the programme's own recent
        // level: a drop deeper than this freezes the gain.
        agcEnabled: true,
        agcMaxBoostDb: 15,
        agcMaxCutDb: 20,
        agcSpeed: 0.5,
        agcGateDb: -20,

        crossLowHz: 150,
        crossHighHz: 2500,

        // Band riders: attack and release are time knobs (0.5 is the base,
        // the ends are 4x faster and 4x slower).
        bandAttack: 0.5,
        bandRelease: 0.5,
        bandMaxGainDb: 12,

        // Noise reduction: the threshold is a band peak level before the
        // auto level; the floor is the deepest cut.
        nrThresholdDb: -55,
        nrFloorDb: 12,
        nrSpeed: 0.5,

        bandLowThresholdDb: 0,
        bandLowGainDb: 0,
        bandLowNrOffsetDb: 0,
        bandMidThresholdDb: 0,
        bandMidGainDb: 0,
        bandMidNrOffsetDb: 0,
        bandHighThresholdDb: 0,
        bandHighGainDb: 0,
        bandHighNrOffsetDb: 0,

        limiterAttackMs: 5,
        limiterReleaseMs: 80,
        limiterHoldMs: 20,
        limiterCeilingDb: -0.3,
        limiterIsp: true,

        // The audio buffer the AudioContext asks for. 'auto' is 'balanced'
        // on Android and 'low' elsewhere; see AUDIO_LATENCY_HINTS.
        audioLatency: 'auto'
    };

    // unit drives both the slider mapping and the readout: 'db', 'percent'
    // and 'lu' are linear; 'ms' and 'hz' are logarithmic because those ranges
    // span three orders of magnitude and a linear slider buries everything
    // useful in the first pixels. The crossover range is 20 Hz - 18 kHz on
    // both.
    const LIMITS = {
        preBoostDb: { min: 0, max: 24, unit: 'db' },

        agcMaxBoostDb: { min: 0, max: 24, unit: 'db' },
        agcMaxCutDb: { min: 0, max: 30, unit: 'db' },
        agcSpeed: { min: 0, max: 1, unit: 'percent' },
        agcGateDb: { min: -40, max: -6, unit: 'lu' },

        crossLowHz: { min: 20, max: 18000, unit: 'hz' },
        crossHighHz: { min: 20, max: 18000, unit: 'hz' },

        bandAttack: { min: 0, max: 1, unit: 'percent' },
        bandRelease: { min: 0, max: 1, unit: 'percent' },
        bandMaxGainDb: { min: 0, max: 20, unit: 'db' },

        nrThresholdDb: { min: -80, max: -30, unit: 'db' },
        nrFloorDb: { min: 0, max: 24, unit: 'db' },
        nrSpeed: { min: 0, max: 1, unit: 'percent' },

        bandLowThresholdDb: { min: -12, max: 12, unit: 'db' },
        bandLowGainDb: { min: -12, max: 12, unit: 'db' },
        bandLowNrOffsetDb: { min: -12, max: 12, unit: 'db' },
        bandMidThresholdDb: { min: -12, max: 12, unit: 'db' },
        bandMidGainDb: { min: -12, max: 12, unit: 'db' },
        bandMidNrOffsetDb: { min: -12, max: 12, unit: 'db' },
        bandHighThresholdDb: { min: -12, max: 12, unit: 'db' },
        bandHighGainDb: { min: -12, max: 12, unit: 'db' },
        bandHighNrOffsetDb: { min: -12, max: 12, unit: 'db' },

        limiterAttackMs: { min: 0.2, max: 5, unit: 'ms' },
        limiterReleaseMs: { min: 10, max: 1000, unit: 'ms' },
        limiterHoldMs: { min: 0, max: 50, unit: 'ms' },
        limiterCeilingDb: { min: -3, max: 0, unit: 'db' }
    };

    // Advanced-only booleans, sanitised alongside the LIMITS keys. Noise
    // reduction lives under Advanced too, so it is off whenever Advanced is.
    const ADVANCED_FLAGS = ['agcEnabled', 'nrEnabled', 'limiterIsp'];

    // Advanced-only choices: the allowed values, the first being the default.
    const ADVANCED_CHOICES = {
        audioLatency: ['auto', 'low', 'balanced', 'stable']
    };

    // What each audioLatency choice asks the AudioContext for. A bigger
    // buffer survives a busy or slow device without underruns, at the cost
    // of output latency, which the page's video does not know about and so
    // shows up as audio lagging the picture: 'interactive' is typically
    // 10-20 ms, 'balanced' 20-40 ms and 'playback' 40-100+ ms, depending on
    // the device.
    const AUDIO_LATENCY_HINTS = {
        low: 'interactive',
        balanced: 'balanced',
        stable: 'playback'
    };

    // Keys earlier versions stored that nothing reads any more. The
    // background page removes them after migrating.
    const REMOVED_KEYS = [
        'crossMidHz',
        'bandLowMidThresholdDb', 'bandLowMidGainDb', 'bandLowMidNrOffsetDb',
        'bandHighMidThresholdDb', 'bandHighMidGainDb', 'bandHighMidNrOffsetDb'
    ];

    // Advanced-only keys: when the Advanced switch is off these revert to
    // DEFAULTS while the user's own values stay in storage.
    const ADVANCED_KEYS = Object.keys(LIMITS);

    // Every key the Advanced switch governs, of all three kinds.
    const ADVANCED_ALL_KEYS = ADVANCED_KEYS.concat(ADVANCED_FLAGS, Object.keys(ADVANCED_CHOICES));

    // Bumped whenever a default changes in a way stored values should follow.
    // Stored values silently override DEFAULTS, so without this a changed
    // default only ever reaches fresh installs. Storage that predates the key
    // is version 0.
    const SETTINGS_VERSION = 7;

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function isFiniteNumber(value) {
        return typeof value === 'number' && isFinite(value);
    }

    // MIGRATIONS[n] upgrades stored values from version n to n + 1. Each takes
    // the stored object as it stands and returns only the keys it changes. A
    // migration moves a value only when it still equals the old default: a
    // value the user set deliberately is theirs, even if it happens to be the
    // old default, and there is no way to tell the two apart, so equality is
    // the honest cut.
    //
    // Migrations 0 -> 1, 2 -> 3 and 3 -> 4 tuned the OTT-style multiband stage,
    // which version 6 replaced; their keys are no longer read, so they are
    // kept only as no-ops to preserve the numbering.
    const MIGRATIONS = [
        () => ({}),
        // 1 -> 2: limiter hold default moved from 2 ms to 20 ms, long enough
        // to cover one half-cycle of bass so the gain no longer moves within a
        // cycle under sustained limiting.
        (stored) => {
            const patch = {};
            if (stored.limiterHoldMs === 2) patch.limiterHoldMs = DEFAULTS.limiterHoldMs;
            return patch;
        },
        () => ({}),
        () => ({}),
        // 4 -> 5: the limiter's smoothing became a triangular kernel and its
        // default width moved from 2.5 ms to the full 5 ms look-ahead, which
        // is the smoothest gain curve the look-ahead allows.
        (stored) => {
            const patch = {};
            if (stored.limiterAttackMs === 2.5) patch.limiterAttackMs = DEFAULTS.limiterAttackMs;
            return patch;
        },
        // 5 -> 6: the multiband stage became auto level plus a four-band
        // gain rider, and Loudness now sets a loudness target instead of
        // driving the limiter. The old `limiterThreshold` and `ott*` values
        // mean nothing to the new stage, so they are not carried over: the new
        // keys start at their defaults.
        () => ({}),
        // 6 -> 7: four bands became three. A band's settings were tuned
        // against the band it used to be, and the low and high bands now
        // cover different ranges, so every band value and both crossovers go
        // back to their defaults, whatever they were set to. The keys of the
        // removed bands are listed in REMOVED_KEYS.
        () => {
            const patch = {
                crossLowHz: DEFAULTS.crossLowHz,
                crossHighHz: DEFAULTS.crossHighHz
            };
            BAND_KEYS.forEach((band) => {
                ['ThresholdDb', 'GainDb', 'NrOffsetDb'].forEach((suffix) => {
                    const key = `band${band}${suffix}`;
                    patch[key] = DEFAULTS[key];
                });
            });
            return patch;
        }
    ];

    // The patch that brings `stored` up to SETTINGS_VERSION, or an empty object
    // if it is current already. Storage from a newer version is left alone.
    function migrateStored(stored) {
        const source = stored || {};
        const from = isFiniteNumber(source.settingsVersion) ? source.settingsVersion : 0;
        if (from >= SETTINGS_VERSION) return {};

        const patch = {};
        for (let version = from; version < SETTINGS_VERSION; version++) {
            Object.assign(patch, MIGRATIONS[version](Object.assign({}, source, patch)));
        }
        patch.settingsVersion = SETTINGS_VERSION;
        return patch;
    }

    function sanitizeAdvanced(source) {
        const result = {};
        ADVANCED_KEYS.forEach((key) => {
            const limits = LIMITS[key];
            const value = source && isFiniteNumber(source[key]) ? source[key] : DEFAULTS[key];
            result[key] = clamp(value, limits.min, limits.max);
        });
        // Crossed crossovers would invert a band. Swap rather than clamp:
        // both chosen frequencies survive, in the only order the split makes
        // sense in.
        if (result.crossLowHz > result.crossHighHz) {
            const low = result.crossHighHz;
            result.crossHighHz = result.crossLowHz;
            result.crossLowHz = low;
        }
        ADVANCED_FLAGS.forEach((key) => {
            result[key] = source && typeof source[key] === 'boolean' ? source[key] : DEFAULTS[key];
        });
        Object.keys(ADVANCED_CHOICES).forEach((key) => {
            const allowed = ADVANCED_CHOICES[key];
            result[key] = source && allowed.includes(source[key]) ? source[key] : DEFAULTS[key];
        });
        return result;
    }

    // The AudioContext latencyHint for a stored audioLatency choice. 'auto'
    // takes the bigger buffer on Android, where the CPU is slower, the
    // scheduler is less generous with the audio thread and a dropout is more
    // likely than on a desktop.
    function latencyHint(choice, isAndroid) {
        const resolved = choice === 'auto' || !AUDIO_LATENCY_HINTS[choice]
            ? (isAndroid ? 'balanced' : 'low')
            : choice;
        return AUDIO_LATENCY_HINTS[resolved];
    }

    function sanitizeUnit(value, fallback) {
        return clamp(isFiniteNumber(value) ? value : fallback, 0, 1);
    }

    function sanitizeEqGains(value) {
        const source = Array.isArray(value) && value.length === EQ_BAND_COUNT
            ? value
            : DEFAULTS.eqGains;
        return source.map((gain) => clamp(isFiniteNumber(gain) ? gain : 0, -EQ_GAIN_LIMIT, EQ_GAIN_LIMIT));
    }

    function lerp(a, b, t) {
        return a + (b - a) * t;
    }

    /**
     * Loudness sets the auto level's target. The band thresholds follow the
     * target inside the worklet, so the whole chain moves together and the
     * output keeps the same distance from the limiter's ceiling at every
     * setting. Nothing drives the limiter any more.
     */
    function loudnessProfile(amount) {
        const t = sanitizeUnit(amount, DEFAULTS.loudness);
        return { targetLufs: lerp(MIN_TARGET_LUFS, MAX_TARGET_LUFS, t) };
    }

    /**
     * Density is the band riders' ratio exponent q = 1 - 1/ratio: 0 leaves
     * every band at unity, 0.5 is 2:1, 1 levels every band to its threshold.
     */
    function densityProfile(amount) {
        return { q: sanitizeUnit(amount, DEFAULTS.density) };
    }

    return {
        EQ_BANDS,
        EQ_BAND_COUNT,
        EQ_Q,
        EQ_GAIN_LIMIT,
        HIGHPASS_Q,
        HIGHPASS_HZ,
        MIN_TARGET_LUFS,
        MAX_TARGET_LUFS,
        BAND_KEYS,
        DEFAULTS,
        LIMITS,
        ADVANCED_KEYS,
        ADVANCED_FLAGS,
        ADVANCED_CHOICES,
        ADVANCED_ALL_KEYS,
        AUDIO_LATENCY_HINTS,
        REMOVED_KEYS,
        SETTINGS_VERSION,
        clamp,
        latencyHint,
        migrateStored,
        sanitizeAdvanced,
        sanitizeEqGains,
        sanitizeUnit,
        loudnessProfile,
        densityProfile
    };
})();
