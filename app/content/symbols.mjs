/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SYMBOL_CATEGORIES } from "chrome://swell/content/symbol-data.mjs";

const SVG_NS = "http://www.w3.org/2000/svg";

const MARKUP = new Map(
  SYMBOL_CATEGORIES.flatMap(category =>
    category.symbols.map(([name, , markup]) => [name, markup])
  )
);

export { SYMBOL_CATEGORIES };

export function hasSymbol(name) {
  return MARKUP.has(name);
}

// The symbol as an inline SVG that takes the colour of the text around it.
export function symbolSVG(doc, name) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("symbol");
  const template = new doc.defaultView.DOMParser().parseFromString(
    `<svg xmlns="${SVG_NS}">${MARKUP.get(name)}</svg>`,
    "image/svg+xml"
  );
  svg.append(...doc.importNode(template.documentElement, true).childNodes);
  return svg;
}

// Shows what a space's icon is on an element: its emoji, one of the symbols,
// or the first letter of its name (an icon the picker does not offer, such as
// one imported from Arc, or none, which is stored as the symbol "circle").
export function showSpaceIcon(element, space) {
  const { glyph, name } = space.icon;
  const symbol = glyph == null && hasSymbol(name);
  if (symbol) {
    element.replaceChildren(symbolSVG(element.ownerDocument, name));
  } else {
    element.textContent = glyph ?? space.title.charAt(0).toUpperCase();
  }
  element.classList.toggle("has-emoji", !!glyph);
  element.classList.toggle("has-symbol", symbol);
}
