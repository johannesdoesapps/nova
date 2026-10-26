# Add an effect: Animated light/dark switch

A sun/moon button that reveals the new theme as a circle growing out of the button (View Transitions API).

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

- A good place is the site header, next to the main links or the sign-in button.
- Not every browser has `document.startViewTransition`: check for it, and simply switch the theme when it is missing or when the visitor prefers reduced motion.
- Add this CSS, or the browser's default crossfade fights the circle: `::view-transition-old(root), ::view-transition-new(root) { animation: none; mix-blend-mode: normal; }`
- Use however the site already marks its theme (a `dark` class, a `data-theme` attribute, …) and the storage key it already uses. Apply the saved theme in a small script in `<head>` before the page paints, so there's no flash of the wrong theme.
- Keep a visible focus ring (the prompt's `focus:outline-none` removes it), and label the button with what it will do, such as "Switch to light theme".
- Use the site's text colour for the icon instead of fixed white and black, so it shows in both themes.
- Without a build step: the same button with inline SVG icons and a few lines of JavaScript; the View Transitions code works as is.

## The original prompt

You are given a task to integrate an existing React component in the codebase

The codebase should support:
- shadcn project structure
- Tailwind CSS
- Typescript

If it doesn't, provide instructions on how to setup project via shadcn CLI, install Tailwind or Typescript.

Determine the default path for components and styles.
If default path for components is not /components/ui, provide instructions on why it's important to create this folder
Copy-paste this component to /components/ui folder:
```tsx
animated-theme-toggler.tsx
"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import { flushSync } from "react-dom"

import { Moon, Sun } from "lucide-react"

import { motion, AnimatePresence } from "framer-motion"

import { cn } from "@/lib/utils"

type AnimatedThemeTogglerProps = {
  className?: string
}

export const AnimatedThemeToggler = ({ className }: AnimatedThemeTogglerProps) => {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [darkMode, setDarkMode] = useState(() =>
    typeof window !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : false
  )

  useEffect(() => {
    const syncTheme = () =>
      setDarkMode(document.documentElement.classList.contains("dark"))

    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])

  const onToggle = useCallback(async () => {
    if (!buttonRef.current) return

    await document.startViewTransition(() => {
      flushSync(() => {
        const toggled = !darkMode
        setDarkMode(toggled)
        document.documentElement.classList.toggle("dark", toggled)
        localStorage.setItem("theme", toggled ? "dark" : "light")
      })
    }).ready

    const { left, top, width, height } = buttonRef.current.getBoundingClientRect()
    const centerX = left + width / 2
    const centerY = top + height / 2
    const maxDistance = Math.hypot(
      Math.max(centerX, window.innerWidth - centerX),
      Math.max(centerY, window.innerHeight - centerY)
    )

    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${centerX}px ${centerY}px)`,
          `circle(${maxDistance}px at ${centerX}px ${centerY}px)`,
        ],
      },
      {
        duration: 700,
        easing: "ease-in-out",
        pseudoElement: "::view-transition-new(root)",
      }
    )
  }, [darkMode])

  return (
    <button
      ref={buttonRef}
      onClick={onToggle}
      aria-label="Switch theme"
      className={cn(
        "flex items-center justify-center p-2 rounded-full outline-none focus:outline-none active:outline-none focus:ring-0 cursor-pointer",
        className
      )}
      type="button"
    >
      <AnimatePresence mode="wait" initial={false}>
        {darkMode ? (
          <motion.span
            key="sun-icon"
            initial={{ opacity: 0, scale: 0.55, rotate: 25 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.33 }}
            className="text-white"
          >
            <Sun />
          </motion.span>
        ) : (
          <motion.span
            key="moon-icon"
            initial={{ opacity: 0, scale: 0.55, rotate: -25 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.33 }}
            className="text-black"
          >
            <Moon />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  )
}

demo.tsx
import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler"

export default function ThemeSwitchDemo() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background transition-colors">
      <AnimatedThemeToggler />
    </div>
  );
}
```

Install NPM dependencies:
```bash
lucide-react, framer-motion
```

Implementation Guidelines
 1. Analyze the component structure and identify all required dependencies
 2. Review the component's argumens and state
 3. Identify any required context providers or hooks and install them
 4. Questions to Ask
 - What data/props will be passed to this component?
 - Are there any specific state management requirements?
 - Are there any required assets (images, icons, etc.)?
 - What is the expected responsive behavior?
 - What is the best place to use this component in the app?

Steps to integrate
 0. Copy paste all the code above in the correct directories
 1. Install external dependencies
 2. Fill image assets with Unsplash stock images you know exist
 3. Use lucide-react icons for svgs or logos if component requires them
