/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

function wheel(deltaX, deltaY = 0) {
  document.getElementById("sidebar").dispatchEvent(
    new WheelEvent("wheel", {
      deltaX,
      deltaY,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      bubbles: true,
      cancelable: true,
    })
  );
}

add_task(async function test_sideways_scrolling_switches_one_space() {
  const { app } = await swellApp();
  await freshSpace(app, "Wheel one");
  await freshSpace(app, "Wheel two");
  await app.switchSpace(app.spaces[0].id);
  await rendered(() => app.activeSpaceId == app.spaces[0].id, "first space");

  wheel(0, 200);
  await new Promise(resolve => setTimeout(resolve, 300));
  Assert.equal(app.activeSpaceId, app.spaces[0].id, "vertical does nothing");

  // One swipe with a long tail: a single step.
  for (let i = 0; i < 30; i++) {
    wheel(20);
  }
  await rendered(() => app.activeSpaceId == app.spaces[1].id, "next space");
  await new Promise(resolve => setTimeout(resolve, 100));
  Assert.equal(app.activeSpaceId, app.spaces[1].id, "one swipe, one space");

  await new Promise(resolve => setTimeout(resolve, 400));
  for (let i = 0; i < 30; i++) {
    wheel(-20);
  }
  await rendered(() => app.activeSpaceId == app.spaces[0].id, "back");

  await new Promise(resolve => setTimeout(resolve, 400));
  for (let i = 0; i < 30; i++) {
    wheel(-20);
  }
  await rendered(() => app.downloads.visible, "left of the first: downloads");
  app.downloads.hide();
});

// A touchpad swipe's inertia tail lasts a second or more, and the next swipe
// can start inside it.
add_task(async function test_a_swipe_inside_the_tail_of_the_last_one() {
  const { app } = await swellApp();
  await app.switchSpace(app.spaces[0].id);
  await rendered(() => app.activeSpaceId == app.spaces[0].id, "first space");
  await new Promise(resolve => setTimeout(resolve, 400));
  const swipe = deltas => deltas.forEach(d => wheel(d));
  const tail = [30, 24, 18, 12, 8, 5, 3, 2, 1];

  swipe([5, 12, 20, 30, 40, ...tail]);
  await rendered(() => app.activeSpaceId == app.spaces[1].id, "next space");

  // Back at once, with no pause: the direction changed.
  swipe([-1, -5, -12, -25, -40, ...tail.map(d => -d)]);
  await rendered(() => app.activeSpaceId == app.spaces[0].id, "back again");

  // The same way again once the tail has died down, still without a pause.
  swipe([5, 12, 20, 30, 40, ...tail, 1, 2, 6, 12, 20, 30, 40]);
  await rendered(() => app.activeSpaceId == app.spaces[1].id, "next again");
  await new Promise(resolve => setTimeout(resolve, 100));
  Assert.equal(app.activeSpaceId, app.spaces[1].id, "two swipes, not three");
});
