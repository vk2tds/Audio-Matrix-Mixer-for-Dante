// Font Awesome 5.x style-family prefixes. The icon list itself lives in
// panel-icons-data-free.js or panel-icons-data-pro.js (FA_ICONS) — whichever
// tier is actually installed, picked by the backend (see dante_web_app.py).
const FA_STYLE_PREFIX = {
  solid: "fas",
  regular: "far",
  light: "fal",
  duotone: "fad",
  brands: "fab",
};

const FA_STYLE_LABELS = {
  solid: "Solid",
  regular: "Regular",
  light: "Light",
  duotone: "Duotone",
  brands: "Brands",
};

function faIconClass(style, name) {
  return `${FA_STYLE_PREFIX[style]} fa-${name}`;
}
