# Text Effects — Reference

Use this file as the local HyperFrames vocabulary for deterministic text animation. Do not install or invoke a separate text-animation skill from ACS worker sessions; the effect IDs below are enough to plan the storyboard and implement the motion with GSAP, Anime.js, WAAPI, or CSS.

## ACS Contract

- Keep text effects deterministic and seekable. Build animations synchronously on the registered timeline.
- Use local/vendor JS only; no CDN dependencies.
- Split text in plain DOM during initialization, then animate spans on the main timeline. Do not split text in async callbacks.
- Effects are named design intents, not magic imports. If the storyboard says `soft-blur-in`, implement that behavior directly in the composition.

## Effect IDs

- **Per-character:** `soft-blur-in`, `per-character-rise`, `typewriter`, `bottom-up-letters`, `top-down-letters`, `stagger-from-center`, `stagger-from-edges`
- **Per-word:** `per-word-crossfade`, `spring-scale-in`, `shared-axis-y`, `blur-out-up`, `kinetic-center-build`, `short-slide-right`, `short-slide-down`, `depth-parallax-words`
- **Per-line:** `mask-reveal-up`, `line-by-line-slide`
- **Whole element:** `micro-scale-fade`, `shimmer-sweep`, `fade-through`, `shared-axis-z`, `scale-down-fade`, `focus-blur-resolve`, `shared-axis-x`

## Implementation Defaults

Use these as starting values, then adapt to the brand and beat duration:

| ID | Default behavior |
| --- | --- |
| `soft-blur-in` | characters/words start `opacity:0; filter:blur(12px); y:18`, stagger 35-55ms, ease `power3.out` |
| `per-character-rise` | characters rise from `y:0.8em`, opacity 0→1, stagger 28-42ms |
| `typewriter` | reveal characters with `steps(1, end)` or `tl.set()` calls; add cursor blink only if the brand supports it |
| `bottom-up-letters` | characters clipped by an overflow-hidden wrapper and enter from below |
| `top-down-letters` | same as above, entering from above |
| `stagger-from-center` | order characters by distance from center; reveal outward |
| `stagger-from-edges` | reveal from both edges toward center |
| `per-word-crossfade` | words fade/translate in sequence, 60-90ms stagger |
| `spring-scale-in` | words scale 0.86→1 with `back.out(1.4)` or similar, no bounce loops |
| `shared-axis-y` | text exits/enters along y axis with a small opacity crossfade |
| `blur-out-up` | outgoing phrase blurs and moves up before replacement enters |
| `kinetic-center-build` | central word locks first, surrounding words build around it |
| `short-slide-right` | compact x-axis entrance, `x:-24` to `0`, 60ms stagger |
| `short-slide-down` | compact y-axis entrance, `y:-20` to `0`, 60ms stagger |
| `depth-parallax-words` | words have slight z/scale/y offsets and converge to a flat readable state |
| `mask-reveal-up` | each line sits in an overflow-hidden wrapper and slides up into place |
| `line-by-line-slide` | full lines slide/fade in with 120-180ms stagger |
| `micro-scale-fade` | whole element `scale:0.98; opacity:0` to normal, subtle and fast |
| `shimmer-sweep` | local pseudo-element or gradient mask sweeps across text; no remote assets |
| `fade-through` | phrase A fades down before phrase B fades in; avoid simultaneous unreadable overlap |
| `shared-axis-z` | element scales 0.94→1 or 1.04→1 with opacity; reads like z-depth |
| `scale-down-fade` | large/near element settles down into final size while fading in |
| `focus-blur-resolve` | text starts slightly blurred and resolves to sharp focus |
| `shared-axis-x` | text moves along x axis with opacity crossfade |

## In The Storyboard

Name the effect ID for every meaningful text element:

```markdown
**Text Animations:**

- Main headline: `kinetic-center-build`
- Eyebrow label: `soft-blur-in`
- Body copy 3 lines: `mask-reveal-up`
```

## Build Pattern

1. Split text into spans at the required granularity: character, word, or line.
2. Build the static readable end-state first.
3. Add `tl.from()` / `tl.fromTo()` tweens from hidden/offset states into that end-state.
4. Keep stagger finite and deterministic. If a stagger order needs variation, compute it from a stable index or seeded helper.
5. Re-run `npx hyperframes lint`, `validate`, and `inspect` after implementing effects; text splitting is a common source of overflow.
