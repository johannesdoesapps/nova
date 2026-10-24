// NOVA: small enhancements. The page works fully without this file.
document.documentElement.classList.add("js");
const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Sections fade in as they scroll into view (not when the visitor prefers less motion).
const reveals = document.querySelectorAll(".reveal");
if (calm || !("IntersectionObserver" in window)) reveals.forEach((el) => el.classList.add("in"));
else {
  const seen = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add("in");
      seen.unobserve(e.target);
    });
  }, { rootMargin: "0px 0px -10% 0px" });
  reveals.forEach((el) => seen.observe(el));
}

// Statistics count up once when they appear; the final value is already in the page.
const counters = document.querySelectorAll("[data-count]");
if (!calm && "IntersectionObserver" in window) {
  const run = (el) => {
    const end = Number(el.dataset.count);
    const suffix = el.dataset.suffix || "";
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / 1200);
      el.textContent = `${Math.round(end * (1 - Math.pow(1 - t, 3)))}${suffix}`;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const watch = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      run(e.target);
      watch.unobserve(e.target);
    });
  }, { threshold: 0.6 });
  counters.forEach((el) => watch.observe(el));
}

// The phone menu closes after choosing a section.
document.querySelectorAll(".menu nav a").forEach((a) => a.addEventListener("click", () => a.closest("details")?.removeAttribute("open")));
