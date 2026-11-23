// Chromium uses `chrome`, Safari uses `browser` - one shared runtime.
if (typeof chrome === "undefined" && typeof browser !== "undefined") {
  globalThis.chrome = browser;
}

const DEFAULTS = {
  enabled: true,
  displayMode: "arrows",
  moveTimeMs: 1000,
  multiPv: 1,
  showEval: true,
  showDepth: true,
  arrowColor: "#39ff88",
  secondaryArrowColor: "#ffd700",
  arrowWidth: 6,
  glowStrength: 70,
  pulse: true,
  showOpponentMove: true,
  overlayOpacity: 100,
  menuSounds: true,
  bestMoveChance: 90,
};

const DISPLAY_MODES = new Set(["arrows", "piece"]);

function $(id) {
  return document.getElementById(id);
}

function loadSettings() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    $("enabled").checked = items.enabled;
    $("displayMode").value = DISPLAY_MODES.has(items.displayMode)
      ? items.displayMode
      : DEFAULTS.displayMode;
    $("moveTime").value = items.moveTimeMs;
    $("moveTimeValue").textContent = `${items.moveTimeMs} ms`;
    $("multiPv").value = items.multiPv;
    $("multiPvValue").textContent = `${items.multiPv}`;
    $("showEval").checked = items.showEval;
    $("showDepth").checked = items.showDepth;
    $("arrowColor").value = items.arrowColor;
    $("arrowColorValue").textContent = items.arrowColor;
    $("secondaryArrowColor").value = items.secondaryArrowColor;
    $("secondaryArrowColorValue").textContent = items.secondaryArrowColor;
    $("arrowWidth").value = items.arrowWidth;
    $("arrowWidthValue").textContent = `${items.arrowWidth}`;
    $("glowStrength").value = items.glowStrength;
    $("glowStrengthValue").textContent = `${items.glowStrength}`;
    $("pulse").checked = items.pulse;
    $("showOpponentMove").checked = items.showOpponentMove;
    $("overlayOpacity").value = items.overlayOpacity;
    $("overlayOpacityValue").textContent = `${items.overlayOpacity}%`;
    $("menuSounds").checked = items.menuSounds;
    $("bestMoveChance").value = items.bestMoveChance;
    $("bestMoveChanceValue").textContent = `${items.bestMoveChance}%`;
  });
}

function saveSettings() {
  chrome.storage.sync.set({
    enabled: $("enabled").checked,
    displayMode: $("displayMode").value,
    moveTimeMs: parseInt($("moveTime").value, 10),
    multiPv: parseInt($("multiPv").value, 10),
    showEval: $("showEval").checked,
    showDepth: $("showDepth").checked,
    arrowColor: $("arrowColor").value,
    secondaryArrowColor: $("secondaryArrowColor").value,
    arrowWidth: parseInt($("arrowWidth").value, 10),
    glowStrength: parseInt($("glowStrength").value, 10),
    pulse: $("pulse").checked,
    showOpponentMove: $("showOpponentMove").checked,
    overlayOpacity: parseInt($("overlayOpacity").value, 10),
    menuSounds: $("menuSounds").checked,
    bestMoveChance: parseInt($("bestMoveChance").value, 10),
  });
}

$("enabled").addEventListener("change", saveSettings);
$("displayMode").addEventListener("change", saveSettings);

$("moveTime").addEventListener("input", () => {
  $("moveTimeValue").textContent = `${$("moveTime").value} ms`;
  saveSettings();
});

$("multiPv").addEventListener("input", () => {
  $("multiPvValue").textContent = $("multiPv").value;
  saveSettings();
});

$("showEval").addEventListener("change", saveSettings);
$("showDepth").addEventListener("change", saveSettings);

$("arrowColor").addEventListener("input", () => {
  $("arrowColorValue").textContent = $("arrowColor").value;
  saveSettings();
});

$("secondaryArrowColor").addEventListener("input", () => {
  $("secondaryArrowColorValue").textContent = $("secondaryArrowColor").value;
  saveSettings();
});

$("arrowWidth").addEventListener("input", () => {
  $("arrowWidthValue").textContent = $("arrowWidth").value;
  saveSettings();
});

$("glowStrength").addEventListener("input", () => {
  $("glowStrengthValue").textContent = $("glowStrength").value;
  saveSettings();
});

$("pulse").addEventListener("change", saveSettings);

$("showOpponentMove").addEventListener("change", saveSettings);

$("menuSounds").addEventListener("change", saveSettings);

$("bestMoveChance").addEventListener("input", () => {
  $("bestMoveChanceValue").textContent = `${$("bestMoveChance").value}%`;
  saveSettings();
});

$("overlayOpacity").addEventListener("input", () => {
  $("overlayOpacityValue").textContent = `${$("overlayOpacity").value}%`;
  saveSettings();
});

$("resetBtn").addEventListener("click", () => {
  chrome.storage.sync.set(DEFAULTS, loadSettings);
});

loadSettings();
