/** Touch screens: a pinch or a drag moves the map or the 3D view, never the
 * page. The canvases already say so (`touch-action: none`, set by MapLibre
 * and by three's controls), which Chrome honours; Safari (iPad, iPhone)
 * still zooms the page on a pinch, and ignores the viewport's
 * `user-scalable=no`. Its own gesture events can be stopped: the app is a
 * full-screen view, there is no page to zoom. */
export function keepPageStill(): void {
  const stop = (event: Event) => event.preventDefault();
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, stop, { passive: false });
  }
}
