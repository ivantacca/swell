/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

// The glyph of a space button (an emoji or a letter) is drawn in the middle of
// its square: the ink of the glyph, measured on the screen, is within a pixel
// of the centre. The font's line box puts an emoji higher than that.

const GLYPHS = [
  "\u{1F444}",
  "\u{270C}\u{FE0F}",
  "\u{1F680}",
  "\u{1F600}",
  "\u{1F44B}",
];

function inkOffset(button) {
  const dpr = window.devicePixelRatio;
  const rect = button.getBoundingClientRect();
  const pad = 4;
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = Math.round((rect.width + pad * 2) * dpr);
  canvas.height = Math.round((rect.height + pad * 2) * dpr);
  const ctx = canvas.getContext("2d");
  ctx.drawWindow(
    window,
    rect.left - pad,
    rect.top - pad,
    rect.width + pad * 2,
    rect.height + pad * 2,
    "rgb(255,0,255)"
  );
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    canvas.width,
    canvas.height
  );
  const edge = Math.round(pad * dpr) + 3;
  const base = (edge * width + edge) * 4;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = edge; y < height - edge; y++) {
    for (let x = edge; x < width - edge; x++) {
      const i = (y * width + x) * 4;
      const difference =
        Math.abs(data[i] - data[base]) +
        Math.abs(data[i + 1] - data[base + 1]) +
        Math.abs(data[i + 2] - data[base + 2]);
      if (difference > 30) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    dx: (minX + maxX) / 2 / dpr - (rect.width / 2 + pad),
    dy: (minY + maxY) / 2 / dpr - (rect.height / 2 + pad),
  };
}

add_task(async function test_space_glyphs_are_centred_in_their_squares() {
  const { app } = await swellApp();
  const spaces = [];
  for (const glyph of GLYPHS) {
    const id = await app.core.createSpace(
      `Centre ${glyph}`,
      new Icon.Emoji({ glyph })
    );
    spaces.push({ id, glyph });
  }
  spaces.push({
    id: await app.core.createSpace("Plain", new Icon.Symbol({ name: "circle" })),
    glyph: "P",
  });
  for (const { id, glyph } of spaces) {
    const button = await rendered(
      () => document.querySelector(`#spaces .space[data-id="${id}"]`),
      `the button of ${glyph} shows`
    );
    const { dx, dy } = inkOffset(button);
    Assert.lessOrEqual(Math.abs(dx), 1, `${glyph} is centred across (${dx})`);
    Assert.lessOrEqual(Math.abs(dy), 0.75, `${glyph} is centred down (${dy})`);
  }
});

add_task(async function test_space_symbols_are_centred_in_their_squares() {
  const { app } = await swellApp();
  const id = await app.core.createSpace(
    "Symbol",
    new Icon.Symbol({ name: "yoga" })
  );
  const button = await rendered(
    () => document.querySelector(`#spaces .space[data-id="${id}"]`),
    "the button of the symbol shows"
  );
  const svg = await rendered(
    () => button.querySelector("svg.symbol"),
    "the symbol is drawn"
  );
  const outer = button.getBoundingClientRect();
  const inner = svg.getBoundingClientRect();
  Assert.lessOrEqual(
    Math.abs(inner.left + inner.width / 2 - (outer.left + outer.width / 2)),
    0.5,
    "the symbol is centred across"
  );
  Assert.lessOrEqual(
    Math.abs(inner.top + inner.height / 2 - (outer.top + outer.height / 2)),
    0.5,
    "the symbol is centred down"
  );
});
