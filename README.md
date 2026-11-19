# ThunderFox — Loudness Normalizer

Is the dialogue too quiet in the movie you're watching? And are the explosions too loud? This extension will even out the audio levels, ensuring a more predictable listening experience. ThunderFox is a lightweight Firefox extension that applies loudness maximization to media elements (audio and video) on web pages. Additionally, a customizable EQ can be applied.

The processing has four stages: an auto level, a three-band compressor with optional noise reduction, a graphic equaliser and a look-ahead brickwall limiter. It runs on Firefox for desktop and Firefox for Android.

## Features

- **Auto level**: a slow, LUFS-style loudness rider that brings every tab and every video to the same target level, and holds still through pauses instead of turning up the silence.
- **Three-band gain-riding compressor** in an AudioWorklet, split by 4th-order Linkwitz-Riley crossovers at 150 Hz and 2.5 kHz (adjustable under Advanced). One **Density** control sets how hard it works.
- Optional **noise reduction**: a per-band downward expander that pulls hiss and room tone down in pauses, keyed on the level *before* the auto level so its boost never fools it.
- A true look-ahead brickwall limiter in an AudioWorklet: no clipping, no saturation, no waveshaping. The stages before it set the level, so it only catches stray peaks.
- A **program-dependent release** in the limiter: transients recover in milliseconds, sustained limiting recovers over seconds, so it does not pump.
- **Inter-sample peak (true peak) detection** in the limiter, so the output does not overshoot 0 dBFS once a downstream resampler or codec reconstructs it.
- 8-band equaliser with shelves at the extremes and a live response curve.
- Global highpass ("Bass cut"), user-toggleable, between the multiband stage and the limiter.
- Input and output level meters, plus live auto level gain and limiter reduction readouts.
- A site exemption list, and automatic detection of media ThunderFox cannot safely process.
- Built to keep up on a phone: the audio thread costs about 1.5% of its deadline on a desktop during playback, under 1% while paused, and allocates nothing.

## Signal chain

```
media element(s)
  -> shared input
  -> pre-boost (0 to +24 dB, user)
  -> dynamics worklet:
       auto level (K-weighted loudness, gated)
       -> LR4 three-band split
       -> per band { gain rider x expander (noise reduction) x band gain }
  -> highpass (optional)
  -> 8-band EQ (optional)
  -> limiter worklet: look-ahead brickwall limiter (5 ms, true-peak)
  -> destination
```

Every media element on the page feeds one shared chain, so two videos playing at once share a master bus rather than each getting its own compressor.

Three properties of this chain matter:

- **The level is set before the limiter, not by it.** Loudness sets the auto level's target, and the band thresholds follow that target, so the programme arrives at the limiter with its peaks already near the ceiling rather than over it. Nothing drives the limiter, and nothing adds level after it. At the default settings the test suite measures the limiter's reduction at 0 dB 95% of the time across the whole Loudness range, with an occasional peak caught by well under 1 dB.
- **The crossover sums flat.** The three bands reconstruct to the same allpass at every frequency, so there is no empirical band trim anywhere in the code.
- **The limiter is transparent, not a clipper.** It delays the signal and computes the gain envelope from samples that have not played yet, so peaks are handled by a smooth gain curve rather than by reshaping the waveform.

Do not add a dry path around the whole chain: the limiter's look-ahead delays the wet path, and an undelayed dry sum would comb.

### Auto level

The auto level measures loudness much as a broadcast loudness meter does. A K-weighting pre-filter (a +4 dB shelf above about 1.5 kHz and a 38 Hz high-pass) feeds summed channel power into 100 ms blocks, and the mean of the last four blocks (400 ms) is the level. Once per block the gain moves towards `target − level`, within the maximum boost and cut:

- **Down** with a time constant of about 1 s, so a loud advert is brought down within a second or two.
- **Up** with about 8 s, at half speed within 3 dB of the target and never faster than 3 dB/s, so riding inside a song stays inaudible.

Rising is what turns pauses and noise up, so it is **gated against the programme's own level**, a slow follower of the measured level that only moves while the gate is open. Within 10 LU of the programme the gain rises normally; between that and the Pause gate (20 LU below by default) it rises at quarter speed; below the gate, or below −60 LUFS outright, it is frozen. A steadily quiet source is therefore still brought up, while a pause or a sudden drop inside it is not. A faster copy of the same gate (20 ms windows) freezes the rise within a few tens of milliseconds of a pause starting.

Two rules handle the start of something new. If the level stays gated with sound present for 2.5 s, the quieter sound is accepted as the new programme, which is what happens when a quiet video follows a loud one. And for 3 s after a start, or after 5 s of silence, the rise is four times faster, so a new video reaches its level quickly while gain riding within a programme stays slow.

### The band split

A Linkwitz-Riley 4th-order filter is two cascaded Butterworth sections, and its two halves do not sum to unity. They sum to a second-order allpass:

```
LP_LR4 + HP_LR4 = (s^2 - sqrt2 s + 1) / (s^2 + sqrt2 s + 1)
```

because `(s^2 + 1)^2 - 2 s^2 = s^4 + 1`. The low crossover splits first, the upper side is split again at the high crossover, and the low band gets an allpass at the high crossover to match the phase that split gives the other two:

```
x -> LP4(f1) -> AP(f2)  = low
x -> HP4(f1) -> LP4(f2) = mid
             -> HP4(f2) = high
```

so the three bands sum to `AP(f1) * AP(f2)`: flat magnitude, no crossover notch. That is 9 biquads per channel.

The filters run a whole render quantum at a time, one section after another, with coefficients and state held in local variables, rather than every section once per sample. Their state is flushed to zero once it decays below 10^-30, and a silent quantum through settled filters skips them altogether (see [Performance](#performance)).

A crossover that is moved glides there at up to 1/64 octave per render quantum, about six octaves a second. Retuning in one step would click, and the host's own 20 ms ramp still makes a large first step.

### Band riders

Each band has one gain, shared by both channels. The rider compares the band's *output* level, a 1 ms power envelope of the louder channel, against the band's threshold. While the band is over, the gain falls with the band's attack time (about 30 / 12 / 5 ms from low to high, and four times faster when a transient lands more than 6 dB over). While it is under, the gain rises at a steady rate in dB per second (about 10 / 20 / 30 dB/s), slowing a little as it grows, up to the maximum gain. The gain therefore settles where the band's level sits at its threshold, or at the maximum gain if the band is quieter than that.

The gain actually applied is the rider gain raised to the power of **Density**, `G = g^q` with `q = 1 − 1/ratio`:

| Density | Ratio above the threshold | Lift for a quiet band |
| --- | --- | --- |
| 0% | 1:1 (bypass) | none |
| 50% | 2:1 | half the max gain (+6 dB) |
| 100% | ∞:1, every band levelled | the full max gain (+12 dB) |

The thresholds are relative to the auto level's target and are calibrated so pink noise at the target settles every band at about +3.5 dB. The multiband adds density without tilting a balanced spectrum. A detector on power rather than raw sample peaks matters at high frequencies: the largest sample in each cycle of a high tone swings by up to 1.5 dB as the sampling grid beats against it, and a peak detector turns that into gain dither and audible sidebands. The applied gain also runs through a 0.2 ms smoother. With both, the worst alias spur on 6 to 12 kHz tones driven hard is below −78 dBc at 48 and 44.1 kHz. The riders share the auto level's fast gate, so their gain stops rising in pauses too.

### Noise reduction

Each band also has a downward expander, switched by **Noise reduction → On** under Advanced (and off whenever Advanced is). It is keyed on the band's level *before* the auto level, so the auto level's boost never changes its decision: a noise floor that is quiet in the source stays classified as quiet however far the auto level turns it up. Below the threshold the expander turns the band down 1 dB for every 1 dB under (a 1:2 expansion), as far as the floor, 12 dB by default. It opens within a few milliseconds of a sound starting and closes over about 50 ms once the band falls under the threshold.

The rider measures the band before the expander, and the two gains are applied together. If the expander came first, the rider would see the quieter band and turn it straight back up.

## The Loudness and Density controls

**Loudness** sets the auto level's target, from −30 LUFS at 0% to −12 LUFS at 100%. The default, 70%, is about −17 LUFS. The top of the range is kept well short of what a limiter would have to supply, so turning Loudness up raises the level of the whole chain rather than squashing peaks.

**Density** is the band riders' ratio (see the table above). Turning it up makes the sound denser and more even, and lifts quiet bands. Turning it to 0% leaves only the auto level and the limiter.

## Installation (Developer / Temporary)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on..." and select the `manifest.json` file from this repository.
3. The extension will appear in the toolbar. Use the popup to enable and configure.

## Usage

1. Click the ThunderFox toolbar icon to open the popup.
2. Toggle the main switch to enable processing.
3. Toggle "Bass cut" to insert or remove a 200 Hz highpass after the multiband stage and before the limiter.
4. Adjust "Loudness" for the level every tab is brought to, and "Density" for how hard the multiband works.
5. Use the "Equalizer" section for tonal shaping, and "Reset" to flatten it.
6. Switch on "Advanced" for auto level, band, noise reduction and limiter controls (see below). Noise reduction is switched on there, under Noise reduction → On.
7. Use "Exempt this site" to make ThunderFox ignore the current site, or "Manage exempt sites" to edit the whole list.

Under the meters, "Auto level" shows the gain it is applying (dimmed while its gate is holding it during a pause), and "Limiter" shows the deepest reduction since the last reading. At the default settings the limiter should read 0.0 dB nearly all the time.

## Site compatibility

ThunderFox only takes over a media element's audio when it can do so safely, and it decides **before** touching the element, because the decision cannot be undone.

- **Cross-origin media without CORS headers is skipped.** `createMediaElementSource()` on such an element produces silence, per spec, and there is no way to hand the element back. Media served from `blob:`, `data:` or the page's own origin is safe, which covers YouTube, Twitch and essentially every adaptive/MSE player.
- **Cross-origin media *with* CORS headers is reloaded in CORS mode and then taken.** The page's own `fetch()` probes the URL first; if that passes, the element gets `crossorigin="anonymous"`, is reloaded, and its position and play state are put back. If the CORS load fails anyway the attribute is cleared and the element reloaded once more, leaving it as the page had it. Reddit's direct MP4s (`v.redd.it`) take this path; Bandcamp's streams (`t4.bcbits.com`) send no CORS headers, which is why `bandcamp.com` is exempted by default and cannot be processed.
- **DRM (EME) content is skipped.** The element is checked for `mediaKeys` and watched for the `encrypted` event from the moment it is discovered.
- **Wiring is deferred until first playback.** At page load `currentSrc` is often empty and `setMediaKeys()` has not been called yet, so neither check above can be made. Waiting for the first `playing` event also means the `AudioContext` is created at a point where the browser will let it start.
- **Media inside shadow DOM and `about:blank`/`srcdoc` frames is discovered**, so players built as web components are covered. `Element.prototype.attachShadow` is hooked in the page's world at `document_start`, because attaching a shadow root produces no mutation record and players like Reddit's attach theirs only once their bundle has loaded. Closed roots are covered too. The hook is removed again on an exempted page.
- **A silence watchdog** compares what the page claims to be playing against what actually reaches the graph. If the page is playing but the audio reads as digital silence for two seconds, the popup says so and points at the exemption, which does restore it.

If a site still misbehaves, exempt it — the popup reloads the tab, which is the only genuine bypass.

## Advanced settings

The Advanced section is off by default. While it is off, the built-in defaults are used; your own values stay in storage and come back when you switch it on again.

| Control | Range | Default | Applies to |
| --- | --- | --- | --- |
| In gain | 0 to +24 dB | 0 dB | Input gain ahead of everything |
| Auto level: On | on/off | on | The auto level; off holds it at unity |
| Max boost | 0 to +24 dB | +15 dB | The most the auto level may raise a quiet programme |
| Max cut | 0 to 30 dB | 20 dB | The most it may lower a loud one |
| Speed | 0-100% | 50% | Auto level time constants (4x slower to 4x faster) |
| Pause gate | −40 to −6 LU | −20 LU | How far below the programme the level must drop to freeze the rise |
| Crossover | 20 Hz to 18 kHz | 150 Hz / 2.5 kHz | The two band-split points, two thumbs on one slider |
| Bands: Attack / Release | 0-100% | 50% | Rider times, all bands (4x faster to 4x slower) |
| Bands: Max gain | 0 to +20 dB | +12 dB | The most a rider may lift a band, before Density |
| NR: On | on/off | off | Per-band noise reduction |
| NR: Threshold | −80 to −30 dBFS | −55 dBFS | Band level, before the auto level, below which noise reduction acts |
| NR: Depth | 0 to 24 dB | 12 dB | The deepest cut noise reduction makes |
| NR: Speed | 0-100% | 50% | Noise reduction open/close times |
| Band: Threshold | ±12 dB | 0 dB | Per-band offset of the rider threshold |
| Band: Gain | ±12 dB | 0 dB | Per-band output gain |
| Band: NR offset | ±12 dB | 0 dB | Per-band offset of the noise reduction threshold |
| Attack (limiter) | 0.2-5 ms | 5 ms | Limiter gain-envelope smoothing |
| Release (limiter) | 10-1000 ms | 80 ms | Limiter recovery after a transient; scales the slow recovery too |
| Hold | 0-50 ms | 20 ms | Delay before the limiter starts recovering |
| Ceiling | −3 to 0 dB | −0.3 dB | Limiter output ceiling |
| True peak | on/off | on | Inter-sample peak detection |
| Audio buffer | Auto / Low latency / Balanced / Stable | Auto | The AudioContext's output buffer; applies after the page reloads |

**Pause gate** is relative to the programme, not to the target: −20 LU means the auto level stops rising when the level falls 20 LU below what has been playing. Raise it towards −6 LU to freeze on smaller drops (more conservative on speech with pauses); lower it to keep riding quiet passages.

**Band Threshold** moves one band's threshold up or down. Lower means that band is held down sooner (less of it at the output), higher means it is lifted more before being held.

**Attack (limiter)** is the width of the limiter's gain smoothing, not a conventional attack time. A look-ahead limiter has no attack in the usual sense, because the gain is already in position when the peak arrives; what this sets is how gradually it gets there. The smoothing is a triangular window, so the gain moves along an S-curve with no corner at either end, and it is applied after the release, so the start of a recovery is rounded the same way. It is capped at the worklet's 5 ms look-ahead, since the envelope cannot be smoothed over more samples than it can see. The default is the full 5 ms, the smoothest curve available; shorter settings leave the gain untouched until closer to the peak, at the cost of a steeper curve.

**Release (limiter)** is program-dependent. The limiter keeps its gain reduction in two parts. A new peak goes into the fast part, which recovers exponentially in decibels; Release is the time that takes to give back 90% of a transient's reduction, once the hold has run out. Reduction the programme keeps asking for moves across to the slow part, which recovers along a straight line in decibels: about 3 dB per second at the default, in proportion to the Release setting (half the Release, twice the slope). How readily reduction moves across depends on how long the programme has been over the ceiling, so a lone click comes back entirely on the fast release, while dense material ends up almost entirely in the slow part. There is no switch between the two rates to hear, only a transfer between two continuous quantities.

**Hold** keeps the gain where it is for that long after the detector last asked for it, and restarts each time it asks again. Both parts of the release wait for it. The 20 ms default covers one half-cycle down to 25 Hz, which is what keeps the limiter from modulating bass within the cycle.

**In gain** sits before the auto level. With the auto level on it mostly changes how the noise reduction and the gate see the input; with it off, it drives the bands harder.

**Crossover** is one slider with two thumbs: low/mid and mid/high. The split stays sum-flat wherever they sit. The thumbs cannot cross: each stops one step (about 0.1 octave) short of the other, so the mid band never collapses to nothing. Crossed values are put back in order when read.

**Audio buffer** sets how much output buffering the AudioContext asks for. A bigger buffer survives a busy or slow device without dropouts, but the page's video does not know about it, so the sound lags the picture by that much more: typically 10–20 ms at Low latency, 20–40 ms at Balanced and 40–100 ms or more at Stable, depending on the device. Auto is Balanced on Android and Low latency elsewhere. The buffer is fixed for the life of the AudioContext, and the context for the life of the page (an element's audio cannot be moved to a new one), so a change applies after the page reloads. The console logs the context's actual latency when it starts.

The time and frequency sliders are logarithmic, because a linear control across three orders of magnitude would bunch every useful value into the first few pixels. Decibels and percentages are linear.

## Firefox for Android

The manifest declares Android support (`gecko_android`), and the extension is built with a phone in mind:

- **Bigger buffer by default.** Auto picks the Balanced buffer on Android. If audio still drops out, choose Stable under Advanced → Audio buffer and reload the page.
- **Media is never silenced by autoplay rules.** Taking a media element's audio into an AudioContext that is not allowed to start yet would mute it until the next tap, and it cannot be undone. Android's autoplay rules are stricter than the desktop's, so before taking an element ThunderFox checks that the context is running or can start (`navigator.getAutoplayPolicy`, then a short `resume()`). If it cannot, the element is left playing natively and taken on the next tap or key press.
- **The context sleeps when nothing plays.** After 30 seconds with no processed media playing, the AudioContext is suspended, which stops the audio thread and lets the output device sleep. It is resumed on the next `play` event, which arrives before any audio is rendered. It is only suspended when the page has had a user gesture, so that resuming is allowed. Returning to a backgrounded tab resumes it as well.
- **The popup is a full page there**, so its sliders, checkboxes and the two-thumb crossover get larger touch targets.

## Performance

The audio thread has a deadline every render quantum (128 samples, 2.7 ms at 48 kHz), and missing it is a dropout. Measured offline on a desktop, per quantum, for dynamics and limiter together:

| | Before | Now |
| --- | --- | --- |
| Playback, mean | 3.9% of the deadline | 1.5% |
| Playback, 99th percentile | 10.2% | 2.3% |
| The 30 s after audio stops, mean | 32% | 0.7% |
| The 30 s after audio stops, 99th percentile | 58% | 1.4% |

A mid-range phone is roughly four times slower than that desktop. The bottom two rows were the real problem: after audio stopped, the filter states decayed exponentially into the subnormal range, where floating-point arithmetic is many times slower on most CPUs, so a paused or quiet page cost more than a playing one. On a phone that alone would exceed the deadline. What changed:

- **Three bands instead of four**: 9 biquads per channel instead of 14.
- **Blockwise filtering**: each section runs a whole quantum in a tight loop with its coefficients and state in locals. The band riders likewise run one band at a time over the quantum, after a short pass that works out the auto level gain and the gate state per sample, so the result is the same as interleaving them.
- **Denormal flush**: filter state and envelopes below 10^-30 are set to zero at the end of each quantum.
- **Silence fast paths**: a silent quantum through settled filters skips the dynamics filters; once the limiter's input has been silent longer than its look-ahead and its envelope is back at zero, a silent quantum skips its loop entirely. Both leave the state exactly as running everything would, which the tests check bit for bit.
- **An exact true-peak skip**: the limiter's interpolator only runs while a sample loud enough to need it is in its 12-sample window. An interpolated value is at most the sum of the kernel's absolute weights times the loudest tap, so below that the inter-sample peak cannot reach the ceiling and could not have set the reduction.
- **No allocation in the render loop**, and no doubles passed into non-inlined calls every quantum, which some engines box.
- **Analysers only while read**: the level meters' analysers are connected only while the popup is open (and the input one while the silence watchdog runs).

## Site exemptions

- A rule matches the listed domain and all of its subdomains.
- Exempting a page also exempts everything it embeds in an iframe. A frame cannot read its top-level URL cross-origin, so the background page resolves it.
- On an exempted page the content script creates no `AudioContext`, observes no DOM and never touches a media element. The `attachShadow` hook has to be installed at `document_start`, before the exemption list has been read, so while that read is in flight the hook only queues the shadow roots it sees. A page that turns out to be exempted drops the queue and gets the original `attachShadow` back; any other page has the queued roots observed and scanned. (Before this, a shadow root attached in that window stayed observed on an exempted page, and media added to it later was taken.)
- **Changing an exemption requires a page reload, and the popup toggle performs one for you.** Once `createMediaElementSource()` has been called on a `<video>` or `<audio>` element, that element's audio belongs to the `AudioContext` permanently. Disconnecting only reroutes it; it cannot be handed back to the browser.
- Turning off an exemption that came from a parent domain removes the parent rule, which affects that domain's other subdomains too. The popup says so before you click.

## Tuning guidance

- If tabs still differ in level, check "Auto level" under the meters: if it sits at the Max boost or Max cut, widen that range.
- If the level audibly creeps up during quiet passages, raise "Pause gate" (towards −6 LU) or lower the auto level "Speed".
- If the sound is too dense or breathes, lower "Density", or raise the band "Release" to slow the riders down.
- If transients sound dulled, raise the band "Attack" (slower) so the riders let the first moments of a hit through.
- If noise reduction chops the ends of words, lower its "Threshold" or "Depth"; if hiss still comes up in pauses, raise the threshold.
- For less bass movement specifically, raise the low band's "Threshold" so it is held down later, rather than changing anything global.

## Troubleshooting

- **No audio at all on one site.** Check the console. ThunderFox logs which elements it skipped and why (`cross-origin`, `drm`), and whether a cross-origin element was reloaded with CORS. If it logs that the page reads as silent, the media is being tainted in a way the pre-check missed — exempt the site.
- **Some videos on a site are processed and others are not.** The ones left alone are usually served cross-origin from a host that sends no CORS headers; the console says so per element.
- **Very quiet output.** Raise "Loudness". If the auto level is already at its Max boost, raise that under Advanced.
- **Distortion.** The limiter applies a gain envelope and nothing else, and at the defaults it is barely working (watch the "Limiter" readout). The riders' gain moves only on the band's 1 ms power envelope and is smoothed over 0.2 ms. If something sounds driven, back off In gain first.
- **Audio and video drift out of sync.** The chain adds about 5.1 ms: the limiter's look-ahead plus 6 samples for the true-peak detector. The dynamics stage is IIR and adds none. That is well inside lip-sync tolerance. The AudioContext's output buffer adds more; if the sound lags, set Advanced → Audio buffer to Low latency and reload.
- **Crackles or dropouts**, especially on a phone. Set Advanced → Audio buffer to Balanced or Stable and reload the page.

## Development notes

- **Offline DSP tests: `npm test`** (or `node tests/run.js`, no dependencies). `tests/harness.js` evaluates the two worklet files in a `vm` context with `AudioWorkletProcessor`, `registerProcessor` and `sampleRate` shimmed, so the file the extension ships is what runs. Its `prepareChain` builds a browser-style render loop over several processors, with every view and parameter array made ahead so the loop itself allocates nothing, and times each quantum. `tests/signals.js` has tone, stepped-tone, impulse, pulse-wave (naive and band-limited) and Schroeder-phased multitone generators, deterministic white and pink noise and a drums-over-a-bed programme, plus peak, true-peak, RMS, Goertzel THD, gain-trajectory, gain-pumping, worst-spur, magnitude-response, notch-depth, AM-sideband, SMPTE and twin-tone IMD, click (energy above a high-pass) and stereo-residual measurements.
  - **Limiter:** the ceiling on tones, impulses and dense material at 48 and 44.1 kHz and while the smoothing and drive controls move, true peak with ISP on, measured against reported latency, transient versus sustained recovery, no pumping or stepping on dense material driven 12 and 24 dB over, distortion on driven bass, and that gain reduction is reported only while metering.
  - **Dynamics:** the band split is flat at every crossover setting and routes tones to the right band; the auto level converges to its target from above and below, falls fast and rises slowly and rate-capped, holds still through pauses, accepts a quiet video after a loud one, and acquires quickly after a start; the riders give the right static curve at Density 0, 0.5 and 1, link the channels, time in milliseconds at both rates, stay clean on steady tones, stay bounded on kick and bass, and survive impulses and NaNs; alias spurs stay under −78 dBc at 48 and 44.1 kHz (a guarded max that skips a band around every harmonic, because the audible defect is a discrete folded tone); and noise reduction is a true no-op when off, settles at its floor, passes signal above its threshold, opens within 5 ms, ignores the auto level's boost, and is not undone by the riders.
  - **Chain:** dynamics into the limiter across the Loudness range and at two input levels, with the limiter required to stay under 1 dB 95% of the time and never pass 6 dB; distortion of a steady tone through the whole chain.
  - **Audio quality:** rider calibration on pink noise; band isolation (a pulsing bass note must leave no sidebands on a 6 kHz tone: under −100 dBc with the auto level off, −60 dBc with it on); SMPTE and 19 + 20 kHz twin-tone intermodulation through the chain; a panned source keeping its image exactly; exact silence in and out, and every state flushed to zero after a pause; a −80 dBFS tone passing untouched; no clicks when controls move as the host ramps them, when the crossovers are stepped, or when noise reduction and auto level are switched; flatness, ceiling and alias spurs at 88.2 and 96 kHz; two minutes of programme without drift; and the fast paths bit-identical to running everything.
  - **Real time:** per-quantum cost of the chain against the 2.7 ms deadline (mean and tail, with a projection to a device four times slower); silence costing no more than sound, with and without the fast paths; and no allocation in per-quantum code, checked per site with V8's sampling heap profiler. These use freshly loaded worklets, so the JIT sees what a page would rather than every shape of test that ran before.
  - **Settings:** crossover ordering, booleans, the buffer choice and its latency hints, the Loudness range and the migrations.

  Measured values are printed next to each result so tuning changes can be compared.

- **Both worklets or neither.** If either AudioWorklet module fails to load, `buildAudioContext()` closes the context and throws, and the page plays natively. A partially built chain — band gain with no limiter behind it — is worse than not processing at all.
- **The limiter has to be an AudioWorklet.** Look-ahead means reading samples before they play, which no built-in node can do. `DynamicsCompressorNode` has no look-ahead so it always overshoots, and a `WaveShaper` bounds the output only by reshaping the waveform, which is distortion by definition.
- The limiter's guarantee is structural, and [content/limiter-processor.js](content/limiter-processor.js) carries the proof in its header comment: the reduction applied to any sample is a weighted average of envelope values, each of which is at least a running maximum whose window contains that sample, so it can never be less than what that sample required. The release lives inside that bound: anything added to the gain path must only ever *lower* the gain.
- `LOOKAHEAD_SECONDS` is fixed on purpose. Changing it while audio is running would resize the delay line and click, so the user-facing timing control adjusts the smoothing width within that window instead. The true-peak history delay is applied whether or not ISP is enabled, for the same reason.
- **The dynamics worklet does no per-sample transcendental math in the common path.** The auto level computes one `log10` and one `exp` per 100 ms block and interpolates its gain linearly; the riders keep their applied gain `g^q` in step by multiplying on attack and recomputing `pow` only every 32 samples; the expander updates every 4 samples; the level parameters are converted to linear only when they change. It allocates nothing per render quantum. See [Performance](#performance) for what keeps it fast and how that is tested.
- **The fast paths must stay exact.** Each one advances the state precisely as the full loop would, and `fastPath = false` on either processor turns them off; the tests compare the two bit for bit. Anything new added to a processor's state needs handling in its fast path too, or those tests fail.
- **Structural worklet parameters must be stepped, not ramped.** `setTargetAtTime` on the limiter's `smoothing` makes it a different integer on nearly every render quantum, and each change rebuilds the smoothing sums on the audio thread. The dynamics worklet's on/off switches (`agcEnabled`, `nrEnabled`) are stepped for the same reason. `setParam()` exists for these; `rampParam()` is for everything else.
- **Do not delete entries from `STATE.mediaNodes`.** A `MediaElementAudioSourceNode` binds to its element permanently and cannot be recreated; a second `createMediaElementSource()` on the same element throws. Dropping the entry is what used to mute an element for good the moment a framework re-rendered it.
- **Removing a media element from the DOM does not disconnect it.** Players move their media: YouTube re-parents its whole player on every switch to or from theater mode and fullscreen, as a removal and an addition in the same task. Disconnecting on the removal and reconnecting at the next scan used to cut about 0.2 s out of the sound each time. An element that really is removed is paused by the browser (the HTML spec pauses media taken out of the document), so it goes silent without help and is still connected if it comes back.
- Settings are applied by comparing against the last applied value (`STATE.applied`). The popup both writes storage and messages the tab, so every change arrives twice; without the comparison the second arrival's `cancelScheduledValues` cuts the first ramp short.
- `common/settings.js` holds defaults, ranges and the Loudness and Density mappings, and is loaded by the content script and the popup. Before it existed the popup declared its own copy of every range and they drifted — the EQ sliders were ±12 in the markup and ±18 everywhere else.
- **Stored settings carry a schema version.** `SETTINGS_VERSION` in `common/settings.js` is bumped whenever a default changes in a way stored values should follow, with a matching entry in `MIGRATIONS`. The background page runs `migrateStored()` on install and update. A migration moves a value only when it still equals the old default, because a stored value silently overrides `DEFAULTS` and there is no other way to tell "never touched" from "set deliberately". Version 6 replaced the multiband stage; the old Loudness and multiband values are not carried over, because they meant something else. Version 7 went from four bands to three and resets both crossovers and every band value, whatever they were set to, since each was tuned against a band that no longer exists; the background page also removes the keys of the bands that went (`REMOVED_KEYS`).
- The EQ's `Q` is 1.27, matched to the 1.11-octave band spacing (`Q = sqrt(2^BW) / (2^BW - 1)`). At `Q = 1.0` the bands are 26% wider than their spacing and eight sliders at +12 dB give about +15 dB. The highpass `Q` is `1/sqrt(2)`; at 1.0 it puts a +1.25 dB bump just above cutoff, on a control called "Bass cut".
- Switch inputs are hidden with `opacity: 0`, never `display: none`, which would take them out of the tab order and the accessibility tree.
- **Metering only runs while a popup is open.** Level meters are two `AnalyserNode` taps — one on the shared input, one on the limiter output — polled from the content script. The auto level gain and the limiter's reduction come from the worklets themselves, but only after the content script sends them `{type: 'meters', on: true}`, and they stop when the popup disconnects, so a page nobody is looking at does no metering work on the audio thread. The analyser window (4096 samples, 85 ms at 48 kHz) is deliberately longer than the 60 ms poll interval so the windows overlap and no peak falls between two reads.
- The popup scrolls past 580 px rather than trying to fit Advanced's rows. `.controls` sets `grid-template-columns: minmax(0, 1fr)` because grid items default to `min-width: auto`, which otherwise lets a row's min-content width push the column wider than the popup.

## License

AGPL3
