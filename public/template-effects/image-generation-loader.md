# Add an effect: Image generation loader

A WebGL pixel mosaic that churns while an image is on its way, then resolves into the real image (img-fx from Libraries.dev).

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

- Use it where an image takes a moment to arrive: a gallery, a product photo or an AI-generated image. Start the reveal only once the image has loaded.
- Without a build step: draw the mosaic on a `<canvas>` (2D or WebGL) over the image's box, then fade it out as the image appears.
- With reduced motion, show a simple soft pulse in the image's box instead of the moving mosaic.
- `three` is a peer dependency of img-fx; install both when using the package.

## The original prompt

Add the Image generation effect from Libraries.dev to my React app.

Install:
npm install img-fx three

Usage:
import { ImageGeneration } from 'img-fx';

<ImageGeneration
  preset="pixels-organic"
  images={['/img/a.jpg', '/img/b.jpg']}
  autoReveal
>
  <div className="card" style={{ width: 320, height: 320, borderRadius: 20 }} />
</ImageGeneration>

Props:
- preset: "pixels-organic" | "pixels-mechanic" | "sweep-gradient"
- images: array of image URLs the loader dissolves into
- autoReveal: boolean, runs the reveal cycle on its own

Image generation is a WebGL loader: a churning pixel-mosaic shader that resolves
into the real image. `three` is a peer dependency; needs React 18 or newer.
Docs: https://libraries.dev/image.html
