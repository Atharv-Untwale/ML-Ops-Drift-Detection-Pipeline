export const DETECTOR_COLORS = {
  ks_test: "#2C4A7A",
  psi: "#2E8B80",
  js_divergence: "#B58A2A",
  wasserstein: "#7A4B7E",
  domain_classifier: "#80858D",
  adwin: "#9B6B43",
  ddm: "#4F7F5B",
};

export const DETECTOR_LABELS = {
  ks_test: "KS test",
  psi: "PSI",
  js_divergence: "JS divergence",
  wasserstein: "Wasserstein",
  domain_classifier: "Domain classifier",
  adwin: "ADWIN",
  ddm: "DDM",
};

export const FAMILY_LABELS = {
  statistical: "statistical",
  distance: "distance",
  ml_based: "ml-based",
  streaming: "streaming",
};

export const DETECTOR_ORDER = ["ks_test", "psi", "js_divergence", "wasserstein", "domain_classifier", "adwin", "ddm"];
export const orderOf = (name) => {
  const i = DETECTOR_ORDER.indexOf(name);
  return i === -1 ? 99 : i;
};

export const colorOf = (name) => DETECTOR_COLORS[name] ?? "#80858D";
export const labelOf = (name) => DETECTOR_LABELS[name] ?? name;
