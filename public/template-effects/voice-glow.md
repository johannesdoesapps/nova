# Add an effect: Voice glow

A sound-reactive glow along the bottom edge of an input or card that rises with the voice (voice-glow from Libraries.dev).

This file was added by the Orbis template "Add an effect to your website". It holds the full instructions for the effect: Orbis's notes first, then the original prompt.

## How to use these instructions

The prompt below was written for a React project with Tailwind CSS and TypeScript (a shadcn-style setup).

- **React project with a build step** (it has a package.json with React): follow the prompt. Install only the packages it names, and adapt the component to this project's own colours, fonts and folders rather than adding a second design system.
- **Plain HTML, CSS and JavaScript** (Orbis website projects are, unless you changed them): don't add React, Tailwind or a build step. Recreate the same effect, with the same look and behaviour, in plain HTML, CSS and JavaScript in this project's files. Treat the React code below as the reference for what it should do.

Either way:

- Use the site's existing colours, fonts and spacing so the effect looks like part of the site.
- Respect `prefers-reduced-motion`: give people who ask for less motion a calm version that still works.
- Keep it usable with a keyboard and a screen reader: real buttons, visible focus, sensible labels.
- Check it in the browser at desktop and phone widths, in every theme the site has, and make sure nothing scrolls sideways.
- When it works, delete this file.

## Notes from adding this effect to Orbis

- In voice-glow 0.3.0 (the version current when Orbis added it) `VoiceBeam` has no `processing` prop, even though the prompt mentions one. To show "working", drive `level` yourself, for example with a gentle sine wave.
- Ask for the microphone only after a click, stop it when listening ends, and keep everything working when microphone access is refused. The microphone needs https (or localhost).
- Without a build step: use the Web Audio API (`getUserMedia` + `AnalyserNode`) for the level, and a blurred gradient positioned along the bottom edge whose height and opacity follow it.

## The original prompt

Add the Voice effect from Libraries.dev to my React app.

Install:
npm install voice-glow

Usage:
import { VoiceBeam, useMicrophone } from 'voice-glow';

const mic = useMicrophone();

<VoiceBeam stream={mic.stream} processing={thinking}>
  <ChatInput />
</VoiceBeam>

<button onClick={mic.state === 'live' ? mic.stop : mic.start}>
  {mic.state === 'live' ? 'Stop' : 'Listen'}
</button>

// Without a microphone, drive it yourself (0–1, a number or a per-frame getter):
<VoiceBeam level={() => meter.current}>
  <Card />
</VoiceBeam>

Props:
- type: "default" | "pill" | "mobile" — geometry preset for a ~350px chat input, a ~150×44 recording pill or the bottom of a phone screen
- stream: MediaStream to react to (wins over level); level: 0–1 number or getter
- processing: boolean, gathers the glow into a beam that travels its range while work is in progress
- colorVariant: "colorful" | "mono" | "ocean" | "sunset" | "forest" | "candy" | "ice" | "gold"
- colors: up to 7 lobe colours; bandColors: { core, above, mid, below }
- sensitivity, threshold, attack, release: the input chain (gain, gate, envelope)
- reach, spread, flow, bend, idle: the shape of the reaction
- theme: "dark" | "light" | "auto"
- strength: 0-1, effect opacity; active, paused; scale

Voice wraps a child element and overlays a sound-reactive glow along its
bottom edge: a centered, colorful beam that rises and blooms with the
voice. It auto-detects the child's border radius, ships zero runtime
dependencies and needs React 18 or newer. The microphone needs a secure
context (https or localhost) and mic.start() called from a user gesture.
Docs: https://libraries.dev/voice.html
