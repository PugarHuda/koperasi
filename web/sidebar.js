// The sidebar (desktop): marks the section in view, so a reader knows where they are on a long page.
// ponytail: an IntersectionObserver over the sections the sidebar links to; nothing else.
const links = [...document.querySelectorAll(".sidebar nav a[href^='#']")];
const byId = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
const seen = new Map();
const mark = () => {
  // the topmost section that is at least partly in view
  const top = [...seen].filter(([, v]) => v).map(([id]) => document.getElementById(id))
    .filter(Boolean).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];
  for (const a of links) a.removeAttribute("aria-current");
  if (top) byId.get(top.id)?.setAttribute("aria-current", "true");
};
const io = new IntersectionObserver((es) => {
  for (const e of es) seen.set(e.target.id, e.isIntersecting);
  mark();
}, { rootMargin: "-20% 0px -60% 0px" });
for (const id of byId.keys()) {
  const el = document.getElementById(id);
  if (el) io.observe(el);
}
