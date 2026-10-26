# Add an effect: Gooey menu

Round buttons that melt out of one another like liquid when a menu opens (liquid-gooey from Libraries.dev).

This file was added by the Orbis template "Add an effect". It holds the full instructions for the effect: Orbis's notes first, then the original prompt.

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

- A good fit is a "+" button that opens two to four round actions.
- While the menu is closed, its buttons must be hidden from the keyboard and screen readers too (for example `visibility: hidden` plus `inert`), not just faded out.
- The goo filter only draws inside its own box, so give the layer room for the open position, and let clicks pass through the empty parts of it (`pointer-events: none` on the layer, `auto` on the buttons).
- Escape and a click outside should close it, and focus should return to the "+" button.
- Without a build step: an SVG `feGaussianBlur` + `feColorMatrix` "goo" filter on a wrapper, with the buttons moved by CSS transitions, gives the same effect.

## The original prompt

Add the Gooey effect from Libraries.dev to my React app.

Install:
npm install liquid-gooey

Usage:
import { Liquid } from 'liquid-gooey'

<Liquid blur={6} contrast={18} fill="#fff">
  <Liquid.Item x={open ? -54 : 0} y={open ? -34 : 0} transition="bouncy">
    <button className="round-btn">…</button>
  </Liquid.Item>
</Liquid>

Props:
- Liquid: blur (goo softness), contrast (edge tightness), fill, shadow
- Liquid.Item: effect ("morph" | "move" | "melt" | "bend"), x, y, transition, delay

Wrap the pieces that should merge in <Liquid> and mark each one <Liquid.Item>.
Touching items melt into each other while their text stays crisp. Cross-browser,
Safari included; zero runtime dependencies, React 18 or newer.
Docs: https://libraries.dev/gooey.html
