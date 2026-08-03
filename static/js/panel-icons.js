// Font Awesome Pro 5.x style-family prefixes. The icon list itself lives in
// panel-icons-data.js (FA_ICONS), generated from the licensed kit's metadata.
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
