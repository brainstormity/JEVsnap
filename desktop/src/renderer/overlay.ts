(() => {
  type Rect = { x: number; y: number; width: number; height: number };
  const api = (window as unknown as { overlay: { onInit(cb: (d: { image: string }) => void): void; done(r: Rect | null): void } }).overlay;
  const shot = document.getElementById("shot") as HTMLElement;
  const dim = document.getElementById("dim") as HTMLElement;
  const sel = document.getElementById("sel") as HTMLElement;
  const hint = document.getElementById("hint") as HTMLElement;
  let start: { x: number; y: number } | null = null;

  api.onInit((d) => { shot.style.backgroundImage = `url("${d.image}")`; });

  const rectOf = (e: MouseEvent): Rect => {
    const x = Math.min(start!.x, e.clientX), y = Math.min(start!.y, e.clientY);
    return { x, y, width: Math.abs(e.clientX - start!.x), height: Math.abs(e.clientY - start!.y) };
  };
  const draw = (r: Rect) => {
    sel.hidden = false;
    sel.style.left = `${r.x}px`; sel.style.top = `${r.y}px`;
    sel.style.width = `${r.width}px`; sel.style.height = `${r.height}px`;
  };

  window.addEventListener("mousedown", (e) => {
    if (e.button === 2) { api.done(null); return; }
    start = { x: e.clientX, y: e.clientY };
    dim.style.display = "none"; // the selection box dims everything outside itself
    hint.hidden = true;
  });
  window.addEventListener("mousemove", (e) => { if (start) draw(rectOf(e)); });
  window.addEventListener("mouseup", (e) => {
    if (!start) return;
    const r = rectOf(e);
    start = null;
    api.done(r.width < 4 || r.height < 4 ? null : r);
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") api.done(null); });
  window.addEventListener("contextmenu", (e) => { e.preventDefault(); api.done(null); });
})();
