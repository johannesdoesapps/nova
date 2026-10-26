import * as THREE from "three";
import { LOWER, orbisConfig, type OrbisConfig, type QualityTier } from "./config";
import { ParticleSystem } from "./particles";
import { ease, VISUALS, type Visual } from "./state";

/**
 * OrbisScene: renders the ORBIS core with three.js.
 *
 * - OrbisCore: points drawn with a soft round glow, brighter toward the centre, dimmer with depth, flashing and
 *   lit by waves of light that travel outward from the centre (thinking, speaking).
 * - Links: line segments with additive colour, fading with distance.
 * - OrbisLighting: two additive glow sprites (a bright centre and a wide, faint atmosphere). No full-screen
 *   post-processing, so the particles stay crisp and the GPU work stays small.
 * - OrbisGrid: a perspective floor drawn in a shader, fading into the dark, with a faint light sweep.
 *
 * The loop pauses when stopped (hidden page, off screen); dispose() frees every GPU resource.
 */

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute float aBright;
attribute float aFlash;
attribute float aRadial;
uniform float uPixel;
uniform float uBright;
uniform vec3 uPulseR;
uniform vec3 uPulseS;
uniform float uNear;
uniform float uDepth;
varying float vAlpha;
varying float vCore;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = clamp((-mv.z - uNear) / uDepth, 0.0, 1.0);
  float pulse = 0.0;
  for (int k = 0; k < 3; k++) {
    float d = aRadial - uPulseR[k];
    pulse += uPulseS[k] * exp(-d * d * 36.0);
  }
  float centre = smoothstep(1.05, 0.0, aRadial);
  float b = aBright * uBright * (0.75 + 0.85 * centre) + aFlash * 1.8 + pulse * 1.2;
  b *= mix(1.45, 0.5, depth);
  vAlpha = b;
  vCore = centre;
  gl_PointSize = 0.1 * aSize * uPixel * (1.0 + aFlash * 0.9 + pulse * 0.6) / -mv.z;
}`;

const POINT_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCoreColor;
varying float vAlpha;
varying float vCore;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;
  float glow = exp(-d2 * 26.0) + 0.38 * exp(-d2 * 6.0);
  vec3 col = mix(uColor, uCoreColor, clamp(vCore * 0.55 + (vAlpha - 1.0) * 0.5, 0.0, 1.0));
  gl_FragColor = vec4(col * glow * vAlpha, 1.0);
}`;

const GRID_VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const GRID_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uCam;
uniform float uTime;
uniform float uCell;
uniform float uNear;
uniform float uFar;
uniform float uStrength;
varying vec3 vWorld;
void main() {
  vec2 p = vWorld.xz / uCell;
  vec2 g = abs(fract(p - 0.5) - 0.5) / fwidth(p);
  float line = 1.0 - min(min(g.x, g.y), 1.0);
  float dist = length(vWorld.xz - uCam.xz);
  float fade = smoothstep(uFar, uNear, dist);
  float sweepZ = mod(uTime * 5.0, 160.0) - 120.0;
  float sweep = exp(-pow((vWorld.z - sweepZ) / 7.0, 2.0));
  gl_FragColor = vec4(uColor * line * fade * uStrength * (0.32 + 0.55 * sweep), 1.0);
}`;

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.45)");
  g.addColorStop(0.6, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export interface SceneOptions {
  tier: QualityTier;
  reducedMotion: boolean;
  pointer: boolean;
  /** 0–1: microphone or speech level, read every frame. */
  audioLevel?: () => number;
  /** Called when the GPU context is lost (the page shows the simple core instead). */
  onLost?: () => void;
}

const FOV = 36;
const BACKGROUND = 0x020604;

export class OrbisScene {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 600);
  private cfg: OrbisConfig;
  private tier: QualityTier;
  private system: ParticleSystem;
  private readonly points: THREE.Points;
  private readonly pointGeo = new THREE.BufferGeometry();
  private readonly pointMat: THREE.ShaderMaterial;
  private readonly lines: THREE.LineSegments;
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly lineMat = new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  private readonly glowTex = glowTexture();
  private readonly core: THREE.Sprite;
  private readonly halo: THREE.Sprite;
  private readonly fog: THREE.Sprite;
  private readonly grid: THREE.Mesh;
  private readonly gridMat: THREE.ShaderMaterial;
  private linePos!: Float32Array;
  private lineCol!: Float32Array;

  private visual: Visual = { ...VISUALS.idle };
  private target: Visual = VISUALS.idle;
  private color = new THREE.Color();
  private readonly palette: Record<number, { p: THREE.Color; c: THREE.Color; l: THREE.Color }>;
  private hueTarget = 0;
  private hue = [1, 0, 0, 0];
  private angle = 0;
  private time = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private pulses: { r: number; s: number }[] = [];
  private nextAutoPulse = 0;
  private pointerNdc: { x: number; y: number } | null = null;
  private readonly ray = new THREE.Raycaster();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly hit = new THREE.Vector3();
  private slowFrames = 0;
  private frames = 0;
  private width = 1;
  private height = 1;
  private readonly opts: SceneOptions;
  private readonly onLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.opts.onLost?.();
  };

  constructor(canvas: HTMLCanvasElement, opts: SceneOptions) {
    this.opts = opts;
    this.tier = opts.tier;
    this.cfg = orbisConfig(opts.tier, { pointer: opts.pointer && !opts.reducedMotion });
    // Throws when WebGL isn't available; the component then shows the simple core.
    // Opaque: the dark background is part of the picture, so additive light never shows seams over the page.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setClearColor(BACKGROUND, 1);
    canvas.addEventListener("webglcontextlost", this.onLost);

    const pal = this.cfg.palette;
    const rgb = (v: readonly number[]) => new THREE.Color(v[0], v[1], v[2]);
    this.palette = {
      0: { p: rgb(pal.particle), c: rgb(pal.core), l: rgb(pal.link) },
      1: { p: rgb(pal.error), c: rgb([1, 0.78, 0.66]), l: rgb([0.9, 0.3, 0.2]) },
      2: { p: rgb(pal.warn), c: rgb([1, 0.95, 0.75]), l: rgb([0.85, 0.62, 0.22]) },
      3: { p: rgb(pal.particle).multiplyScalar(0.55), c: rgb(pal.core).multiplyScalar(0.5), l: rgb(pal.link).multiplyScalar(0.5) },
    };

    this.system = new ParticleSystem(this.cfg);
    this.pointMat = new THREE.ShaderMaterial({
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uPixel: { value: 1000 },
        uBright: { value: 1 },
        uPulseR: { value: new THREE.Vector3(-1, -1, -1) },
        uPulseS: { value: new THREE.Vector3() },
        uNear: { value: 20 },
        uDepth: { value: 20 },
        uColor: { value: new THREE.Color() },
        uCoreColor: { value: new THREE.Color() },
      },
    });
    this.points = new THREE.Points(this.pointGeo, this.pointMat);
    this.lines = new THREE.LineSegments(this.lineGeo, this.lineMat);
    this.buildBuffers();

    const sprite = (opacity: number) => new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity }));
    this.halo = sprite(0.22);
    this.core = sprite(0.6);
    this.fog = sprite(0.12);
    const R = this.cfg.radius;
    this.fog.scale.setScalar(R * 7);
    this.fog.position.z = -R * 2;
    this.halo.scale.setScalar(R * 3.4);
    this.core.scale.setScalar(R * 1.1);

    this.gridMat = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uColor: { value: rgb(pal.link) },
        uCam: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uCell: { value: R * 0.24 },
        uNear: { value: R * 2.6 },
        uFar: { value: R * 9 },
        uStrength: { value: 1.1 },
      },
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(R * 40, R * 40), this.gridMat);
    this.grid.rotation.x = -Math.PI / 2;
    this.grid.position.y = -R * 1.42;

    this.scene.add(this.fog, this.grid, this.halo, this.lines, this.points, this.core);
    this.applyVisual();
  }

  private buildBuffers() {
    const s = this.system;
    this.pointGeo.setAttribute("position", new THREE.BufferAttribute(s.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute("aSize", new THREE.BufferAttribute(s.size, 1));
    this.pointGeo.setAttribute("aBright", new THREE.BufferAttribute(s.bright, 1));
    this.pointGeo.setAttribute("aFlash", new THREE.BufferAttribute(s.flash, 1).setUsage(THREE.DynamicDrawUsage));
    this.pointGeo.setAttribute("aRadial", new THREE.BufferAttribute(s.radial, 1));
    this.pointGeo.setDrawRange(0, s.active);
    this.pointGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.cfg.radius * 2);
    this.linePos = new Float32Array(this.cfg.maxLinks * 6);
    this.lineCol = new Float32Array(this.cfg.maxLinks * 6);
    this.lineGeo.setAttribute("position", new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.setAttribute("color", new THREE.BufferAttribute(this.lineCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.cfg.radius * 2);
  }

  get quality(): { tier: QualityTier; particles: number; links: number } {
    return { tier: this.tier, particles: this.system.active, links: this.system.linkCount };
  }

  /** Size the drawing to its box, and place the camera so the core fills about 70% of the height (and fits the width). */
  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const ratio = Math.min(window.devicePixelRatio || 1, this.cfg.maxPixelRatio);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.width, this.height, false);
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    const R = this.cfg.radius;
    const tan = Math.tan(((FOV / 2) * Math.PI) / 180);
    const diameter = R * 2.25;
    const d = Math.max(diameter / (0.76 * 2 * tan), diameter / (0.92 * 2 * tan * aspect));
    this.camera.position.set(0, R * 0.1, d);
    this.camera.lookAt(0, -R * 0.14, 0);
    this.camera.updateProjectionMatrix();
    const u = this.pointMat.uniforms;
    u.uPixel!.value = (this.height * ratio) / (2 * tan);
    u.uNear!.value = d - R;
    u.uDepth!.value = R * 2;
    this.render();
  }

  /** The look to ease toward. */
  setTarget(key: keyof typeof VISUALS) {
    this.target = VISUALS[key];
    this.hueTarget = this.target.hue;
    if (this.opts.reducedMotion) {
      this.visual = { ...this.target };
      this.hue = [0, 1, 2, 3].map((h) => (h === this.hueTarget ? 1 : 0));
      this.applyVisual();
      this.render();
    }
  }

  /** A wave of light from the centre (e.g. a spoken word). */
  pulse(strength = 1) {
    if (this.opts.reducedMotion) return;
    if (this.pulses.length >= 3) this.pulses.shift();
    this.pulses.push({ r: 0, s: Math.min(1.2, strength) });
  }

  setPointer(ndc: { x: number; y: number } | null) {
    this.pointerNdc = this.cfg.pointer ? ndc : null;
  }

  setPointerEnabled(on: boolean) {
    this.cfg = { ...this.cfg, pointer: on && !this.opts.reducedMotion };
    if (!this.cfg.pointer) this.pointerNdc = null;
  }

  start() {
    if (this.running || this.opts.reducedMotion) {
      this.render();
      return;
    }
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this.step(dt);
      this.adapt(dt);
      this.render();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** Advance the animation by dt seconds (also used to draw a still frame). */
  step(dt: number) {
    this.time += dt;
    this.visual = ease(this.visual, this.target, dt);
    const k = 1 - Math.exp(-dt * 2.4);
    this.hue = this.hue.map((h, i) => h + ((i === this.hueTarget ? 1 : 0) - h) * k);
    this.angle += this.visual.rotation * dt;

    if (this.target.autoPulse > 0 && this.time >= this.nextAutoPulse) {
      this.pulse(0.7);
      this.nextAutoPulse = this.time + this.target.autoPulse;
    }
    for (const p of this.pulses) {
      p.r += dt * 0.85;
      p.s *= Math.exp(-dt * 0.9);
    }
    this.pulses = this.pulses.filter((p) => p.r < 1.5 && p.s > 0.02);

    let pointer: { x: number; y: number; z: number } | null = null;
    if (this.pointerNdc) {
      this.ray.setFromCamera(new THREE.Vector2(this.pointerNdc.x, this.pointerNdc.y), this.camera);
      if (this.ray.ray.intersectPlane(this.plane, this.hit)) pointer = { x: this.hit.x, y: this.hit.y, z: this.hit.z };
    }
    const level = Math.min(1, Math.max(0, this.opts.audioLevel?.() ?? 0));
    this.system.update({ t: this.time, dt, angle: this.angle, visual: this.visual, audio: level, pointer });
    this.applyVisual();

    // Gentle parallax: the camera leans a little toward the pointer.
    if (this.cfg.pointer) {
      const R = this.cfg.radius;
      const tx = (this.pointerNdc?.x ?? 0) * R * 0.08;
      const ty = R * 0.1 + (this.pointerNdc?.y ?? 0) * R * 0.05;
      this.camera.position.x += (tx - this.camera.position.x) * k;
      this.camera.position.y += (ty - this.camera.position.y) * k;
      this.camera.lookAt(0, -R * 0.14, 0);
    }
  }

  private mix(which: "p" | "c" | "l"): THREE.Color {
    this.color.setRGB(0, 0, 0);
    let sum = 0;
    this.hue.forEach((w, i) => {
      if (w <= 0.001) return;
      const c = this.palette[i]![which];
      this.color.r += c.r * w;
      this.color.g += c.g * w;
      this.color.b += c.b * w;
      sum += w;
    });
    return this.color.multiplyScalar(1 / (sum || 1));
  }

  private applyVisual() {
    const v = this.visual;
    const u = this.pointMat.uniforms;
    (u.uColor!.value as THREE.Color).copy(this.mix("p"));
    (u.uCoreColor!.value as THREE.Color).copy(this.mix("c"));
    u.uBright!.value = v.brightness;
    const r = u.uPulseR!.value as THREE.Vector3;
    const s = u.uPulseS!.value as THREE.Vector3;
    r.set(-1, -1, -1);
    s.set(0, 0, 0);
    this.pulses.forEach((p, i) => {
      r.setComponent(i, p.r);
      s.setComponent(i, p.s);
    });
    const glowColor = this.mix("c");
    (this.core.material as THREE.SpriteMaterial).color.copy(glowColor);
    (this.core.material as THREE.SpriteMaterial).opacity = 0.5 * v.glow + this.pulses.reduce((a, p) => a + p.s * 0.12, 0);
    (this.halo.material as THREE.SpriteMaterial).color.copy(this.mix("p"));
    (this.halo.material as THREE.SpriteMaterial).opacity = 0.2 * v.glow;
    (this.fog.material as THREE.SpriteMaterial).color.copy(this.mix("l"));
    (this.fog.material as THREE.SpriteMaterial).opacity = 0.1 + 0.06 * v.glow;
    (this.gridMat.uniforms.uColor!.value as THREE.Color).copy(this.mix("l"));
    this.gridMat.uniforms.uTime!.value = this.time;
    (this.gridMat.uniforms.uCam!.value as THREE.Vector3).copy(this.camera.position);

    const n = this.system.writeLinks(this.linePos, this.lineCol, this.mix("l").toArray() as [number, number, number], v.links);
    this.lineGeo.setDrawRange(0, n * 2);
    this.lineGeo.attributes.position!.needsUpdate = true;
    this.lineGeo.attributes.color!.needsUpdate = true;
    this.pointGeo.setDrawRange(0, this.system.active);
    this.pointGeo.attributes.position!.needsUpdate = true;
    this.pointGeo.attributes.aFlash!.needsUpdate = true;
  }

  /** Step down when frames run slow: fewer particles first, then a lower tier. */
  private adapt(dt: number) {
    this.frames++;
    if (this.frames < 30) return;
    this.slowFrames = dt > 1 / 40 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 0.5);
    if (this.slowFrames < 45) return;
    this.slowFrames = 0;
    if (this.system.active > this.system.count * 0.55) {
      this.system.setActive(this.system.active * 0.75);
      return;
    }
    const lower = LOWER[this.tier];
    if (!lower) return;
    this.tier = lower;
    this.cfg = orbisConfig(lower, { pointer: this.cfg.pointer });
    this.system = new ParticleSystem(this.cfg);
    this.buildBuffers();
    this.resize(this.width, this.height);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    this.renderer.domElement.removeEventListener("webglcontextlost", this.onLost);
    this.pointGeo.dispose();
    this.pointMat.dispose();
    this.lineGeo.dispose();
    this.lineMat.dispose();
    this.grid.geometry.dispose();
    this.gridMat.dispose();
    (this.core.material as THREE.SpriteMaterial).dispose();
    (this.halo.material as THREE.SpriteMaterial).dispose();
    (this.fog.material as THREE.SpriteMaterial).dispose();
    this.glowTex.dispose();
    this.renderer.dispose();
  }
}
