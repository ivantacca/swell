/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Top-down 8-bit swell: crests travel down the screen, slow and bend over
// shallow reefs, break where the water gets too shallow for their height,
// leave whitewash behind them and run up the beach. Past the water's edge the
// canvas is transparent, so the page itself is the shore.
(() => {
  const canvas = document.getElementById("hero-canvas");
  const hero = canvas?.parentElement;
  const ctx = canvas?.getContext("2d");
  if (!ctx) {
    return;
  }

  const PALETTE = [
    "#014378", "#01559A", "#0168BD", "#017CDF", "#1384E1", "#2890E4",
    "#3C9AE6", "#50A4E8", "#64AFEC", "#78B9EE", "#8BC3F0", "#9FCDF3",
    "#B3D7F5", "#C8E2F8", "#DCEDFB", "#EFF6FD", "#FFFFFF",
  ].map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
  const TOP = PALETTE.length - 1;
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(
    b => (b + 0.5) / 16 - 0.5
  );

  const FPS = 24;
  const SPEED = 8; // cells per second in deep water
  const PERIOD = 3.2; // seconds between crests

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

  let W, H, cell, depth, tau, foam, foamNext, image;
  let shore, runup, edge, rising, tauShore;
  let t = 0;

  function hash(x, y) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function noise(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi);
    const b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1);
    const d = hash(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }

  function fbm(x, y) {
    return 0.65 * noise(x, y) + 0.35 * noise(x * 2.1 + 17, y * 2.1 + 31);
  }

  function smoothstep(a, b, x) {
    const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return k * k * (3 - 2 * k);
  }

  function setup() {
    const rect = hero.getBoundingClientRect();
    cell = rect.width < 720 ? 5 : 6;
    W = Math.ceil(rect.width / cell);
    H = Math.ceil(rect.height / cell);
    canvas.width = W;
    canvas.height = H;
    canvas.style.width = `${W * cell}px`;
    canvas.style.height = `${H * cell}px`;
    image = ctx.createImageData(W, H);
    foam = new Float32Array(W * H);
    foamNext = new Float32Array(W * H);

    // Deep offshore, shoaling toward the bottom, with reefs and channels
    // that make each column break at a different place.
    depth = new Float32Array(W * H);
    // The still-water line, with bays and points, and how far a wave can run
    // up past it.
    shore = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const bays = (noise(x / 50, 2.2) - 0.5) * 0.16;
      const ripples = (noise(x / 14, 7.1) - 0.5) * 0.04;
      shore[x] = H * (0.78 + bays + ripples);
    }
    runup = H * 0.11;
    edge = new Float32Array(W);
    rising = new Uint8Array(W);

    for (let x = 0; x < W; x++) {
      const channel = (noise(x / 45, 3.7) - 0.5) * 0.25;
      for (let y = 0; y < H; y++) {
        const v = y / shore[x];
        const shelf = 1 - 0.95 * smoothstep(0.38, 1, v);
        const reefWeight = smoothstep(0.35, 0.8, v) * (1 - smoothstep(0.9, 1, v));
        const reef = (fbm(x / 26, y / 16) - 0.5) * 0.55 * reefWeight;
        depth[y * W + x] = Math.min(1, Math.max(0.04, shelf + reef + channel * reefWeight));
      }
    }

    // Travel time from the top edge: crests slow down as sqrt(depth).
    tau = new Float32Array(W * H);
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = 0; y < H; y++) {
        acc += 1 / (SPEED * Math.sqrt(Math.max(0.12, depth[y * W + x])));
        // Offshore the swell arrives slightly angled and uneven, so crests
        // are curved before they ever feel the bottom.
        const wobble = (fbm(x / 34, y / 50 + 9) - 0.5) * 2.2;
        tau[y * W + x] = acc + wobble + (x / W) * 0.9;
      }
    }
    const row = new Float32Array(W);
    for (let pass = 0; pass < 3; pass++) {
      for (let y = 0; y < H; y++) {
        const o = y * W;
        for (let x = 0; x < W; x++) {
          const l = tau[o + Math.max(0, x - 2)];
          const r = tau[o + Math.min(W - 1, x + 2)];
          row[x] = (l + 2 * tau[o + x] + r) / 4;
        }
        tau.set(row, o);
      }
    }
    tauShore = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      tauShore[x] = tau[Math.min(H - 1, Math.floor(shore[x]) - 3) * W + x];
    }
    // Each wave reaches the beach as one broad tongue of water, not a comb.
    for (let pass = 0; pass < 8; pass++) {
      let prev = tauShore[0];
      for (let x = 0; x < W; x++) {
        const cur = tauShore[x];
        tauShore[x] = (prev + 2 * cur + tauShore[Math.min(W - 1, x + 1)]) / 4;
        prev = cur;
      }
    }
    for (let x = 0; x < W; x++) {
      row[x] = tauShore[Math.max(0, x - 4)] + tauShore[Math.min(W - 1, x + 4)];
    }
    for (let x = 0; x < W; x++) {
      tauShore[x] = (tauShore[x] + row[x]) / 3;
    }
  }

  // How far up the beach the swash of a wave is, a fraction p of a period
  // after it reached the still-water line: a quick run up, a slow slide back.
  function swash(p) {
    if (p < 0.2) {
      return Math.sin((p / 0.2) * Math.PI / 2);
    }
    return 1 - smoothstep(0.2, 0.95, p);
  }

  // Size of crest number n along x, so sets vary and peaks shift between
  // waves.
  function waveSize(n, x) {
    const set = 0.55 + 0.45 * Math.sin(n * 0.83) * Math.sin(n * 0.31 + 1);
    const along = 0.45 + 0.75 * noise(x / 32 + n * 3.1, n * 0.7);
    return Math.max(0.15, set) * along;
  }

  function step(dt) {
    t += dt;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const up = y > 0 ? foam[i - W] : 0;
        const left = foam[i - (x > 0 ? 1 : 0)];
        const right = foam[i + (x < W - 1 ? 1 : 0)];
        foamNext[i] = 0.983 * (0.8 * foam[i] + 0.1 * up + 0.05 * (left + right));
      }
    }
    [foam, foamNext] = [foamNext, foam];

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = depth[i];
        const phase = (t - tau[i]) / PERIOD;
        const back = (phase - Math.floor(phase)) * SPEED * Math.sqrt(d) * PERIOD;
        if (back < 1.4 && d < 0.08 + 0.34 * waveSize(Math.floor(phase), x)) {
          foam[i] = 1;
        }
      }
    }

    for (let x = 0; x < W; x++) {
      const phase = (t - tauShore[x]) / PERIOD;
      const n = Math.floor(phase);
      const p = phase - n;
      edge[x] = shore[x] + runup * (waveSize(n, x) * swash(p) - 0.12);
      rising[x] = p < 0.2 ? 1 : 0;
    }
    for (let pass = 0; pass < 2; pass++) {
      let prev = edge[0];
      for (let x = 0; x < W; x++) {
        const cur = edge[x];
        edge[x] = (prev + 2 * cur + edge[Math.min(W - 1, x + 1)]) / 4;
        prev = cur;
      }
    }
    for (let x = 0; x < W; x++) {
      edge[x] = Math.min(H - 1, edge[x]);
      if (rising[x]) {
        for (let y = Math.max(0, Math.floor(edge[x]) - 2); y <= edge[x]; y++) {
          foam[y * W + x] = 1;
        }
      }
    }
  }

  function draw() {
    const data = image.data;
    const glint = Math.floor(t * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = i * 4;
        const dry = y - Math.floor(edge[x]);
        if (dry > 0) {
          data[o + 3] = 0;
          continue;
        }
        const d = depth[i];
        const lambda = SPEED * Math.sqrt(d) * PERIOD;
        const phase = (t - tau[i]) / PERIOD;
        const frac = phase - Math.floor(phase);
        const back = frac * lambda;
        const front = (1 - frac) * lambda;
        const size = waveSize(Math.floor(phase), x);

        let v = 1 + 4.8 * Math.pow(1 - d, 1.6);
        const crest = (0.15 + Math.max(0, size - 0.2)) * (1.6 - d * 0.7);
        if (back < 1.2) {
          v += 4.5 * crest;
        } else if (back < 5) {
          v -= 2.4 * (1 - back / 5) * crest;
        }
        if (front < 3) {
          v += 1.2 * (1 - front / 3) * crest;
        }
        if (d > 0.5 && back < 1.2 && hash(x * 7 + glint, y * 13 - glint) > 0.985) {
          v = 11;
        }

        const dither = BAYER[(y & 3) * 4 + (x & 3)];
        const f =
          foam[i] * (0.7 + 0.6 * noise(x / 3, y / 3 - t * 0.4)) + dither * 0.35;
        if (f > 0.22) {
          v = Math.max(v, 10 + 7 * Math.min(1, f));
        }

        // The swash: a white line of foam at the water's edge, softer behind
        // it as the wave slides back, then a clear sheet of shallow water.
        const shoreline = Math.min(
          Math.floor(edge[Math.max(0, x - 1)]),
          Math.floor(edge[Math.min(W - 1, x + 1)])
        );
        if (dry > -2 || y > shoreline - 1) {
          v = TOP;
        } else if (dry > -3) {
          v = rising[x] ? TOP : 13;
        } else if (dry > -7) {
          v = foam[i] > 0.6 ? 10 : 6;
        }

        const k = Math.min(TOP, Math.max(0, Math.round(v + dither)));
        const [r, g, b] = PALETTE[k];
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
  }

  let onscreen = true;
  let frame = 0;
  let last = 0;

  function loop(now) {
    frame = 0;
    if (!onscreen || document.hidden || reducedMotion.matches) {
      return;
    }
    if (now - last >= 1000 / FPS) {
      step(Math.min(0.1, (now - last) / 1000));
      draw();
      last = now;
    }
    frame = requestAnimationFrame(loop);
  }

  function start() {
    if (frame || reducedMotion.matches) {
      return;
    }
    last = performance.now();
    frame = requestAnimationFrame(loop);
  }

  function still() {
    t = 0;
    for (let n = 0; n < 220; n++) {
      step(1 / FPS);
    }
    draw();
  }

  setup();
  still();
  hero.classList.add("has-canvas");

  let width = hero.clientWidth;
  let height = hero.clientHeight;
  new ResizeObserver(() => {
    if (hero.clientWidth === width && Math.abs(hero.clientHeight - height) < 80) {
      return;
    }
    width = hero.clientWidth;
    height = hero.clientHeight;
    setup();
    still();
  }).observe(hero);

  new IntersectionObserver(entries => {
    onscreen = entries[0].isIntersecting;
    if (onscreen) {
      start();
    }
  }).observe(hero);

  document.addEventListener("visibilitychange", start);
  reducedMotion.addEventListener("change", start);
})();
