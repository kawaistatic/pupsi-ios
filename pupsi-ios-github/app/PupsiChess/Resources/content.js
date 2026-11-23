/**
 * Chess.com Best Move Extension - Content Script
 *
 * Responsibilities:
 * - Detect the chess board on chess.com
 * - Extract the current position as a FEN string
 * - Run Stockfish via a Web Worker to analyze the position
 * - Draw SVG move guidance as arrows or as a source-piece hint
 * - Show evaluation and search depth in a small floating panel
 */

// Platform bridge: Chromium exposes WebExtension APIs as `chrome`, Safari as
// `browser`. Normalize once so the runtime below stays platform-agnostic.
if (typeof chrome === "undefined" && typeof browser !== "undefined") {
  globalThis.chrome = browser;
}

// ---------------------------------------------------------------------------
// Configuration defaults (overridden by popup settings)
// ---------------------------------------------------------------------------
const DISPLAY_MODES = {
  ARROWS: "arrows",
  PIECE: "piece",
};

const DEFAULT_CONFIG = {
  enabled: true,
  displayMode: DISPLAY_MODES.ARROWS,
  moveTimeMs: 1000,
  multiPv: 1,
  showEval: true,
  showDepth: true,
  arrowColor: "#39ff88",
  secondaryArrowColor: "#ffd700",
  arrowWidth: 6,
  arrowStyle: "classic",
  glowStrength: 70,
  pulse: true,
  showOpponentMove: true,
  overlayOpacity: 100,
  menuSounds: true,
  bestMoveChance: 90,
  menuBg: "void",
  gambitMode: false,
  gambitPick: "random",
};

// Settings that only touch rendering - changing them never restarts the engine.
const VISUAL_KEYS = new Set([
  "displayMode",
  "arrowColor",
  "secondaryArrowColor",
  "arrowWidth",
  "arrowStyle",
  "glowStrength",
  "pulse",
  "showOpponentMove",
  "showEval",
  "showDepth",
  "overlayOpacity",
  "menuSounds",
  "bestMoveChance",
  "menuBg",
  "gambitMode",
  "gambitPick",
]);

// Settings that never affect the SVG overlay - toggling them skips the redraw.
const MENU_ONLY_KEYS = new Set([
  "menuSounds",
  "menuBg",
]);

let config = { ...DEFAULT_CONFIG };

// Overlay DOM handles - declared early because applyTheme() touches them.
let overlayContainer = null;
let evalPanel = null;
let arrowSvg = null;
let svgDefs = null;
let depthDisplay = null;
let gambitLabel = null;
let menuPanel = null;

// --- color helpers -------------------------------------------------------
function toHexColor(value, fallback) {
  if (typeof value === "string") {
    const s = value.trim();
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    const m = s.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (m) {
      return (
        "#" +
        [1, 2, 3]
          .map((i) => Math.max(0, Math.min(255, +m[i])).toString(16).padStart(2, "0"))
          .join("")
      );
    }
  }
  return fallback;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function mixWhite(hex, t) {
  const { r, g, b } = hexToRgb(hex);
  const mix = (c) => Math.round(c + (255 - c) * t).toString(16).padStart(2, "0");
  return `#${mix(r)}${mix(g)}${mix(b)}`;
}

function primaryColor() {
  return toHexColor(config.arrowColor, DEFAULT_CONFIG.arrowColor);
}

function secondaryColor() {
  return toHexColor(config.secondaryArrowColor, DEFAULT_CONFIG.secondaryArrowColor);
}

function glowLevel() {
  const v = Number(config.glowStrength);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : DEFAULT_CONFIG.glowStrength;
}

// Push the live theme onto CSS custom properties the overlay styles consume.
function applyTheme() {
  const root = document.documentElement.style;
  const p = primaryColor();
  const s = secondaryColor();
  const k = glowLevel() / 100;
  const { r, g, b } = hexToRgb(p);
  root.setProperty("--ccbm-primary", p);
  root.setProperty("--ccbm-secondary", s);
  root.setProperty("--ccbm-glow", `rgba(${r}, ${g}, ${b}, ${(0.45 * k).toFixed(3)})`);
  root.setProperty("--ccbm-glow-strong", `rgba(${r}, ${g}, ${b}, ${(0.95 * k).toFixed(3)})`);
  root.setProperty("--ccbm-edge", `rgba(${r}, ${g}, ${b}, 0.5)`);
  root.setProperty("--ccbm-anim", config.pulse === false ? "none" : "ccbm-pulse");
  // Pulse on: a static drop-shadow (animating it re-blurred the SVG every
  // frame). Pulse off: back to the SVG glow filter, exactly as before.
  root.setProperty(
    "--ccbm-arrow-filter",
    config.pulse === false
      ? "url(#ccbm-arrow-glow)"
      : `drop-shadow(0 0 6px rgba(${r}, ${g}, ${b}, ${(0.7 * k).toFixed(3)}))`
  );
  applyMenuBg();
  applyOverlayOpacity();
}

// Blend (opacity) of the move arrow itself - eval/depth stay readable.
function applyOverlayOpacity() {
  if (!arrowSvg) return;
  const v = Number(config.overlayOpacity);
  const pct = Number.isFinite(v) ? Math.max(5, Math.min(100, v)) : 100;
  arrowSvg.style.opacity = String(pct / 100);
}

// ---------------------------------------------------------------------------
// Settings storage
// ---------------------------------------------------------------------------
chrome.storage.sync.get(DEFAULT_CONFIG, (items) => {
  config = { ...DEFAULT_CONFIG, ...items };
  applyTheme();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area && area !== "sync") return;
  let touched = false;
  let visualOnly = true;
  let overlayTouched = false;
  for (const key in changes) {
    if (key in DEFAULT_CONFIG) {
      config[key] = changes[key].newValue;
      touched = true;
      // Menu-chrome keys (sounds, bg preset) never change the overlay -
      // skipping the SVG rebuild keeps those toggles instant.
      if (!MENU_ONLY_KEYS.has(key)) overlayTouched = true;
    }
    if (!VISUAL_KEYS.has(key)) visualOnly = false;
  }
  if (!touched) return;
  applyTheme();
  updateGlowFilter();
  if (overlayTouched) drawMoveOverlay();
  if (!visualOnly) {
    lastAnalyzedFen = null;
    // Trigger a re-analysis with new settings
    scheduleAnalysis(100);
  }
});

// Glow slider drives the SVG filter blur radii live (0 = crisp, no halo).
function updateGlowFilter() {
  if (!svgDefs) return;
  const k = glowLevel() / 100;
  const blurs = svgDefs.querySelectorAll("feGaussianBlur");
  if (blurs[0]) blurs[0].setAttribute("stdDeviation", (1 + 5 * k).toFixed(2));
  if (blurs[1]) blurs[1].setAttribute("stdDeviation", (2 + 10 * k).toFixed(2));
}

applyTheme();

// ---------------------------------------------------------------------------
// Stockfish Worker
// ---------------------------------------------------------------------------
let stockfish = null;
let stockfishReady = false;
let currentFen = null;
let analysisTimer = null;
let lastAnalyzedFen = null;

function initStockfish() {
  if (stockfish) return;

  const scriptUrl = chrome.runtime.getURL("stockfish/stockfish-18-lite-single.js");
  const wasmUrl = chrome.runtime.getURL("stockfish/stockfish-18-lite-single.wasm");

  let workerUrl;
  try {
    // MV3 content scripts sometimes can't create chrome-extension:// workers directly.
    // Using a blob worker that imports the script via importScripts() is more robust.
    const workerScript = `self.importScripts("${scriptUrl}");`;
    const blob = new Blob([workerScript], { type: "application/javascript" });
    const blobUrl = URL.createObjectURL(blob);
    workerUrl = `${blobUrl}#${encodeURIComponent(wasmUrl)}`;
    console.log("[Chess.com Best Move] Using blob worker URL");
  } catch (e) {
    console.warn("[Chess.com Best Move] Blob worker creation failed, falling back to direct URL:", e);
    workerUrl = `${scriptUrl}#${encodeURIComponent(wasmUrl)}`;
  }

  try {
    stockfish = new Worker(workerUrl);
    stockfish.addEventListener("message", onStockfishMessage);
    stockfish.addEventListener("error", (e) => {
      console.error("[Chess.com Best Move] Stockfish worker error:", e);
    });
    sendStockfish("uci");
    console.log("[Chess.com Best Move] Stockfish worker created, waiting for uciok...");
  } catch (e) {
    console.error("[Chess.com Best Move] Failed to create Stockfish worker:", e);
  }
}

function sendStockfish(cmd) {
  if (!stockfish) return;
  try {
    stockfish.postMessage(cmd);
  } catch (e) {
    console.error("[Chess.com Best Move] Failed to send to Stockfish:", e);
  }
}

function onStockfishMessage(event) {
  const line = String(event.data);

  if (line === "uciok") {
    sendStockfish("setoption name UCI_ShowWDL value true");
    sendStockfish("isready");
    return;
  }

  if (line === "readyok") {
    stockfishReady = true;
    console.log("[Chess.com Best Move] Stockfish ready.");
    scheduleAnalysis(200);
    return;
  }

  // One split per line, shared by every parser below - Stockfish emits dozens
  // of info lines per second and each split used to cost a regex pass.
  const parts = line.startsWith("info ") ? line.trim().split(/\s+/) : null;

  // Capture depth from info lines
  const depth = parseSearchDepthLine(line, parts);
  if (depth) {
    updateDepthDisplay(depth);
  }

  // Capture principal variations (top moves)
  const pv = parsePrincipalVariationLine(line, parts);
  if (pv) {
    cacheCandidateMove(pv);
  }

  // Final bestmove
  if (line.startsWith("bestmove ")) {
    finalizeAnalysis(line);
  }
}

// ---------------------------------------------------------------------------
// Simple UCI protocol parsers (inline to keep the content script self-contained)
// ---------------------------------------------------------------------------
const UCI_MOVE_PATTERN = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/;

function normalizeUciMove(value) {
  const normalized = value.trim().toLowerCase();
  const match = UCI_MOVE_PATTERN.exec(normalized);
  if (!match) return null;
  const from = match[1];
  const to = match[2];
  const promotion = match[3];
  return promotion ? `${from}${to}${promotion}` : `${from}${to}`;
}

// ---------------------------------------------------------------------------
// Gambit repertoire
// Openings are stored as SAN move sequences. The next move is derived by
// replaying each line against the live position: the current FEN's move
// history is captured from the page-world bridge (see below), so a gambit
// fires only when the opponent followed the exact booked line.
// ---------------------------------------------------------------------------
const GAMBITS = [
  {
    id: "alien",
    name: "Alien Gambit",
    line: ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Nf6", "Ng5", "h6", "Nxf7"],
  },
  {
    id: "alienNd2",
    name: "Alien (Nd2)",
    line: ["e4", "c6", "d4", "d5", "Nd2", "dxe4", "Nxe4", "Nf6", "Ng5", "h6", "Nxf7"],
  },
  {
    id: "martian",
    name: "Martian Gambit",
    line: ["e4", "c6", "d4", "d5", "Nc3", "dxe4", "Nxe4", "Bf5", "Ng5", "Bg6", "N1f3", "h6", "Ne6"],
  },
  {
    id: "ulysses",
    name: "Ulysses Gambit",
    line: ["e4", "c6", "d4", "d5", "Nf3", "dxe4", "Ng5"],
  },
  {
    id: "danish",
    name: "Danish Gambit",
    line: ["e4", "e5", "d4", "exd4", "c3"],
  },
  {
    id: "smithMorra",
    name: "Smith-Morra",
    line: ["e4", "c5", "d4", "cxd4", "c3"],
  },
  {
    id: "evans",
    name: "Evans Gambit",
    line: ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "b4"],
  },
  {
    id: "kings",
    name: "King's Gambit",
    line: ["e4", "e5", "f4"],
  },
  {
    id: "queens",
    name: "Queen's Gambit",
    line: ["d4", "d5", "c4"],
  },
  {
    id: "scotch",
    name: "Scotch Gambit",
    line: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "Bc4"],
  },
  {
    id: "goring",
    name: "Göring Gambit",
    line: ["e4", "e5", "Nf3", "Nc6", "d4", "exd4", "c3"],
  },
  {
    id: "bdg",
    name: "Blackmar-Diemer",
    line: ["d4", "d5", "e4", "dxe4", "Nc3", "Nf6", "f3"],
  },
  {
    id: "vienna",
    name: "Vienna Gambit",
    line: ["e4", "e5", "Nc3", "Nf6", "f4"],
  },
  {
    id: "latvian",
    name: "Latvian Gambit",
    line: ["e4", "e5", "Nf3", "f5"],
  },
  {
    id: "budapest",
    name: "Budapest Gambit",
    line: ["d4", "Nf6", "c4", "e5"],
  },
  {
    id: "benko",
    name: "Benko Gambit",
    line: ["d4", "Nf6", "c4", "c5", "d5", "b5"],
  },
  {
    id: "halloween",
    name: "Halloween Gambit",
    line: ["e4", "e5", "Nf3", "Nc6", "Nc3", "Nf6", "Nxe5"],
  },
];

// Minimal chess move generator used only to translate SAN -> UCI. It never
// chooses moves - it just resolves booked notation to a from/to square pair.
const FILES = "abcdefgh";

// Board rows run 0..7 from Rank 8 down to Rank 1 (FEN order).
function sq(file, boardRow) {
  return FILES[file] + String(8 - boardRow);
}

function isSquareOnBoard(f, r) {
  return f >= 0 && f < 8 && r >= 0 && r < 8;
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function boardFromFen(fen) {
  const placement = (fen || "").split(" ")[0] || "";
  const board = Array.from({ length: 8 }, () => Array(8).fill(""));
  const rows = placement.split("/");
  if (rows.length !== 8) return null;
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        f += parseInt(ch, 10);
      } else {
        if (f >= 8) return null;
        board[r][f] = ch;
        f++;
      }
    }
    if (f !== 8) return null;
  }
  return board;
}

// Pseudo-legal candidate destinations for a piece; adequate for SAN
// disambiguation in short opening lines (no checks that would restrict
// king/other-piece escapes - booked moves are legal in the main lines).
function pseudoTargets(board, f, r, piece) {
  const type = piece.toLowerCase();
  const own = (ff, rr) => {
    const p = board[rr][ff];
    return p && p[0] === piece[0];
  };
  const out = [];
  if (type === "p") {
    const dir = piece === "P" ? -1 : 1;
    const startRank = piece === "P" ? 6 : 1;
    const promoRank = piece === "P" ? 0 : 7;
    const one = r + dir;
    if (isSquareOnBoard(f, one) && !board[one][f]) {
      out.push({ f, r: one, promo: one === promoRank });
      const two = r + 2 * dir;
      if (r === startRank && !board[two][f]) out.push({ f, r: two });
    }
    for (const df of [-1, 1]) {
      const tf = f + df;
      if (isSquareOnBoard(tf, one) && board[one][tf] && board[one][tf][0] !== piece[0]) {
        out.push({ f: tf, r: one, promo: one === promoRank });
      }
    }
    // en passant target from FEN is handled by the caller via epSquare
    return out;
  }
  if (type === "n") {
    for (const [df, dr] of [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]]) {
      const tf = f + df, tr = r + dr;
      if (isSquareOnBoard(tf, tr) && !own(tf, tr)) out.push({ f: tf, r: tr });
    }
    return out;
  }
  if (type === "b" || type === "r" || type === "q") {
    const dirs = [];
    if (type === "b" || type === "q") dirs.push([1,1],[1,-1],[-1,1],[-1,-1]);
    if (type === "r" || type === "q") dirs.push([1,0],[-1,0],[0,1],[0,-1]);
    for (const [df, dr] of dirs) {
      let tf = f + df, tr = r + dr;
      while (isSquareOnBoard(tf, tr)) {
        if (own(tf, tr)) break;
        out.push({ f: tf, r: tr });
        if (board[tr][tf]) break;
        tf += df; tr += dr;
      }
    }
    return out;
  }
  if (type === "k") {
    for (let df = -1; df <= 1; df++) for (let dr = -1; dr <= 1; dr++) {
      if (!df && !dr) continue;
      const tf = f + df, tr = r + dr;
      if (isSquareOnBoard(tf, tr) && !own(tf, tr)) out.push({ f: tf, r: tr });
    }
    // castling (white king sits on board row 7, black on row 0)
    if (piece === "K" && f === 4 && r === 7) {
      if (board[7][7] === "R" && !board[7][5] && !board[7][6]) {
        out.push({ f: 6, r: 7, castle: "K" });
      }
      if (board[7][0] === "R" && !board[7][1] && !board[7][2] && !board[7][3]) {
        out.push({ f: 2, r: 7, castle: "Q" });
      }
    }
    if (piece === "k" && f === 4 && r === 0) {
      if (board[0][7] === "r" && !board[0][5] && !board[0][6]) {
        out.push({ f: 6, r: 0, castle: "k" });
      }
      if (board[0][0] === "r" && !board[0][1] && !board[0][2] && !board[0][3]) {
        out.push({ f: 2, r: 0, castle: "q" });
      }
    }
    return out;
  }
  return out;
}

function applyMoveToBoard(board, move, piece, epSquare) {
  const b = cloneBoard(board);
  const isEpCapture = piece.toLowerCase() === "p" && epSquare && sq(move.f, move.r) === epSquare && !board[move.r][move.f];
  if (isEpCapture) b[move.fromR][move.f] = "";
  b[move.fromR][move.fromF] = "";
  b[move.r][move.f] = move.promo ? (move.promoPiece || piece) : piece;
  if (move.castle) {
    const rank = piece === "K" ? 7 : 0;
    if (move.castle.toUpperCase() === "K") {
      b[rank][5] = b[rank][7]; b[rank][7] = "";
    } else {
      b[rank][3] = b[rank][0]; b[rank][0] = "";
    }
  }
  return b;
}

function sanToMove(fen, san) {
  const board = boardFromFen(fen);
  if (!board) return null;
  const fields = fen.split(" ");
  const side = fields[1] === "b" ? "b" : "w";
  const epSquare = fields[3] && fields[3] !== "-" ? fields[3] : null;
  const clean = san.replace(/[+#?!]+/g, "");
  const castling = clean === "O-O" || clean === "0-0" ? "K"
    : clean === "O-O-O" || clean === "0-0-0" ? "Q" : null;
  const promoMatch = clean.match(/=([qrbn])/i);

  const candidates = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const piece = board[r][f];
    if (!piece) continue;
    if (side === "w" ? piece[0] !== piece.toUpperCase() : piece[0] !== piece.toLowerCase()) continue;
    for (const t of pseudoTargets(board, f, r, piece)) {
      if (castling && (!t.castle || t.castle.toUpperCase() !== castling)) continue;
      if (!castling && t.castle) continue;
      const move = { ...t, fromF: f, fromR: r };
      if (promoMatch && !move.promo) continue;
      if (!promoMatch && move.promo) continue;
      if (move.promo) move.promoPiece = side === "w" ? promoMatch[1].toUpperCase() : promoMatch[1].toLowerCase();
      candidates.push(move);
    }
  }

  let filtered = candidates;
  if (castling) {
    // already filtered by castle flag
  } else {
    const typeMatch = clean.match(/^([KQRBNP]?)/);
    let type = typeMatch[1] || "";
    if (!type) type = "P";
    const isPawnMove = /^[a-h]/.test(clean) || /x/.test(clean);
    if (isPawnMove && type === "P") {
      const destMatch = clean.match(/([a-h][1-8])$/);
      const fileMatch = clean.match(/^([a-h])/);
      filtered = filtered.filter((m) => {
        const dest = sq(m.f, m.r);
        if (destMatch && dest !== destMatch[1]) return false;
        if (fileMatch && FILES[m.fromF] !== fileMatch[1]) return false;
        return true;
      });
    } else {
      const dest = sqMatch(clean);
      // Disambiguation only when the piece letter is followed by an extra
      // file/rank before the destination: "Nbc3", "N1f3" - not plain "Nc3".
      const rest = clean.slice(type.length);
      const fromFile = rest.match(/^([a-h])(?=[a-h][1-8])/);
      const fromRank = rest.match(/^([1-8])(?=[a-h][1-8])/);
      filtered = filtered.filter((m) => {
        const piece = board[m.fromR][m.fromF];
        if (piece.toUpperCase() !== type) return false;
        if (dest && sq(m.f, m.r) !== dest) return false;
        if (fromFile && FILES[m.fromF] !== fromFile[1]) return false;
        if (fromRank && String(8 - m.fromR) !== fromRank[1]) return false;
        return true;
      });
    }
  }

  if (!filtered.length) return null;
  const m = filtered[0];
  const from = sq(m.fromF, m.fromR);
  const to = sq(m.f, m.r);
  const promo = m.promo ? m.promoPiece.toLowerCase() : "";
  const uci = from + to + promo;
  const nextFen = fenAfterMove(fen, m);
  return { uci, nextFen };
}

function sqMatch(san) {
  const m = san.match(/([a-h][1-8])(?![0-9])/);
  return m ? m[1] : null;
}

function fenAfterMove(fen, move) {
  const fields = fen.split(" ");
  const board = boardFromFen(fen);
  const piece = board[move.fromR][move.fromF];
  const captured = !!board[move.r][move.f];
  const epSquare = fields[3] && fields[3] !== "-" ? fields[3] : null;
  const b = applyMoveToBoard(board, move, piece, epSquare);
  const rows = [];
  // board[r] is already FEN row r (0 = Rank 8), so emit in ascending order.
  for (let r = 0; r < 8; r++) {
    let s = "", empty = 0;
    for (let f = 0; f < 8; f++) {
      if (!b[r][f]) { empty++; continue; }
      if (empty) { s += String(empty); empty = 0; }
      s += b[r][f];
    }
    if (empty) s += String(empty);
    rows.push(s);
  }
  let castling = fields[2] || "KQkq";
  if (move.castle) {
    castling = castling.replace(move.castle.toUpperCase() === "K" ? (move.castle === "K" ? "K" : "k") : "", "");
    castling = castling.replace(move.castle.toUpperCase() === "Q" ? (move.castle === "Q" ? "Q" : "q") : "", "");
  }
  // crude: rook/king moves remove their castling rights
  if (piece === "K") castling = castling.replace(/[KQ]/g, "");
  if (piece === "k") castling = castling.replace(/[kq]/g, "");
  if (move.fromF === 7 && move.fromR === 7) castling = castling.replace("K", "");
  if (move.fromF === 0 && move.fromR === 7) castling = castling.replace("Q", "");
  if (move.fromF === 7 && move.fromR === 0) castling = castling.replace("k", "");
  if (move.fromF === 0 && move.fromR === 0) castling = castling.replace("q", "");
  if (!castling) castling = "-";
  let ep = "-";
  if (piece.toLowerCase() === "p" && Math.abs(move.r - move.fromR) === 2) {
    ep = sq(move.fromF, (move.r + move.fromR) / 2);
  }
  const nextSide = fields[1] === "b" ? "w" : "b";
  const halfmove = piece.toLowerCase() === "p" || captured ? 0 : (parseInt(fields[4] || "0", 10) + 1);
  const fullmove = (parseInt(fields[5] || "1", 10)) + (nextSide === "w" ? 1 : 0);
  return `${rows.join("/")} ${nextSide} ${castling} ${ep} ${halfmove} ${fullmove}`;
}

let activeGambitId = null;
let gambitGameStamp = null;
let gambitLastPick = null;

// Replay the booked line from the start position up to the current position.
// Returns { uci, name } when the current position is one move before a booked
// white move (and the opponent followed the line), else null.
function findGambitMove(currentFen) {
  if (!config.gambitMode || !currentFen) return null;
  const fields = currentFen.split(" ");
  if (fields[1] !== "w") return null; // gambits are White weapons here

  const pick = config.gambitPick || "random";
  // New game (different starting position seen) -> pick a fresh random gambit.
  const stamp = fields[0] + "|" + fields[1] + "|" + fields[5];
  if (pick === "random" && stamp !== gambitGameStamp) {
    gambitGameStamp = stamp;
    activeGambitId = GAMBITS[Math.floor(Math.random() * GAMBITS.length)].id;
  }
  const pool = pick === "random"
    ? GAMBITS.filter((g) => g.id === activeGambitId)
    : GAMBITS.filter((g) => g.id === pick);
  if (!pool.length) return null;

  // Match on board placement + side only. Castling/ep/move counters differ
  // between chess.com's internal FEN and Stockfish and must not block a hit.
  const target = fields[0] + "|" + fields[1];
  const startFen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  for (const g of pool) {
    let fen = startFen;
    for (let i = 0; i < g.line.length; i++) {
      const f = fen.split(" ");
      if (i % 2 === 0 && f[0] + "|" + f[1] === target) {
        const move = sanToMove(fen, g.line[i]);
        if (move) return { uci: move.uci, name: g.name };
      }
      const move = sanToMove(fen, g.line[i]);
      if (!move) break;
      fen = move.nextFen;
    }
  }
  return null;
}

function parseSearchDepthLine(line, parts) {
  if (!line.startsWith("info ")) return null;
  parts = parts || line.trim().split(/\s+/);
  const idx = parts.indexOf("depth");
  const depth = idx >= 0 ? parseInt(parts[idx + 1] ?? "", 10) : NaN;
  return Number.isFinite(depth) && depth > 0 ? depth : null;
}

function parseEvaluationLine(line, parts) {
  if (!line.startsWith("info ")) return null;
  parts = parts || line.trim().split(/\s+/);
  const scoreIdx = parts.indexOf("score");
  if (scoreIdx < 0 || !parts[scoreIdx + 1] || !parts[scoreIdx + 2]) return null;
  const value = parseInt(parts[scoreIdx + 2] ?? "", 10);
  if (!Number.isFinite(value)) return null;
  if (parts[scoreIdx + 1] === "cp") return { kind: "centipawn", value };
  if (parts[scoreIdx + 1] === "mate") return { kind: "mate", value };
  return null;
}

function parsePrincipalVariationLine(line, parts) {
  if (!line.startsWith("info ")) return null;
  parts = parts || line.trim().split(/\s+/);
  const pvIdx = parts.indexOf("pv");
  const pvMove = pvIdx >= 0 ? parts[pvIdx + 1] : undefined;
  const uci = pvMove ? normalizeUciMove(pvMove) : null;
  if (!uci) return null;

  const multipvIdx = parts.indexOf("multipv");
  const parsedRank = parseInt(parts[multipvIdx + 1] ?? "1", 10);
  const rank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;
  const evaluation = parseEvaluationLine(line, parts);
  const searchDepth = parseSearchDepthLine(line, parts);

  return { rank, uci, evaluation, searchDepth };
}

// ---------------------------------------------------------------------------
// Analysis state
// ---------------------------------------------------------------------------
let candidateMoves = [];
let isSearching = false;
let pendingFen = null;
// Per-position roll: false = don't reveal the top move this time.
let showBestMove = true;
// A failed reveal roll retries on a short jittered timer instead of going
// dark until the opponent's next move - low "Reveal best" values delay the
// arrow (bounded) rather than hiding it for a whole move cycle.
let revealRetryTimer = 0;
let revealTries = 0;
const REVEAL_RETRY_MIN = 450;
const REVEAL_RETRY_MAX = 850;
const REVEAL_MAX_TRIES = 4;
// Randomized startup: engine boots after a short, non-fixed delay so the
// extension never behaves byte-identically between two launches.
const BOOT_DELAY_MS = 600 + Math.floor(Math.random() * 1800);

function cacheCandidateMove(move) {
  candidateMoves[move.rank - 1] = move;
}

function rollReveal() {
  return Math.random() * 100 < config.bestMoveChance;
}

function clearRevealRetry() {
  if (revealRetryTimer) {
    clearTimeout(revealRetryTimer);
    revealRetryTimer = 0;
  }
}

// Reveal roll failed: re-roll on a short jittered timer while the position
// is still current. REVEAL_MAX_TRIES forces the reveal, so the arrow can
// never stay dark longer than ~4x REVEAL_RETRY_MAX.
function scheduleRevealRetry() {
  if (revealRetryTimer || !config.enabled) return;
  revealTries++;
  const fenAtSchedule = currentFen;
  const delay =
    REVEAL_RETRY_MIN +
    Math.floor(Math.random() * (REVEAL_RETRY_MAX - REVEAL_RETRY_MIN));
  revealRetryTimer = setTimeout(() => {
    revealRetryTimer = 0;
    if (!config.enabled || currentFen !== fenAtSchedule) return;
    showBestMove = revealTries >= REVEAL_MAX_TRIES || rollReveal();
    drawMoveOverlay();
  }, delay);
}

function finalizeAnalysis(bestmoveLine) {
  isSearching = false;

  const parts = bestmoveLine.trim().split(/\s+/);
  if (parts[0] !== "bestmove" || !parts[1] || parts[1] === "(none)") {
    candidateMoves = [];
  } else {
    const bestUci = normalizeUciMove(parts[1]);
    if (bestUci) {
      const existing = candidateMoves.find((m) => m && m.uci === bestUci);
      if (!existing) {
        candidateMoves[0] = { rank: 1, uci: bestUci };
      }
    }
  }

  drawMoveOverlay();
  updateEvalDisplay();

  // If a new position was queued while searching, start analyzing it now
  if (pendingFen) {
    const fen = pendingFen;
    pendingFen = null;
    console.log("[Chess.com Best Move] Starting queued analysis for:", fen);
    startAnalysis(fen);
  }
}

// ---------------------------------------------------------------------------
// FEN extraction from chess.com
// ---------------------------------------------------------------------------
// Chrome content scripts run in an "isolated world" — they cannot read JS
// properties that the page attaches to DOM elements (e.g. wc-chess-board.game).
// To get the real FEN we inject a small script into the page's main world,
// which polls the internal game API and sends the FEN back via CustomEvent.
// ---------------------------------------------------------------------------

let latestFenFromPage = null;
let bridgeInjected = false;

function injectFenExtractor() {
  if (bridgeInjected) return;
  bridgeInjected = true;

  const src = chrome.runtime.getURL("page-bridge.js");
  const script = document.createElement("script");
  script.id = "ccbm-fen-bridge";
  script.src = src;
  script.type = "text/javascript";
  script.onload = () => console.log("[Chess.com Best Move] page-bridge.js loaded successfully.");
  script.onerror = () => console.error("[Chess.com Best Move] Failed to load page-bridge.js!");

  (document.head || document.documentElement).appendChild(script);
  console.log("[Chess.com Best Move] Injecting external FEN bridge script:", src);
}

let lastBridgeFen = null;
let bridgeEventThrottle = null;

window.addEventListener("chesscom-bestmove-fen", (event) => {
  const fen = event.detail;
  if (!fen || fen === lastBridgeFen) return;
  lastBridgeFen = fen;
  latestFenFromPage = fen;
  console.log("[Chess.com Best Move] Received FEN from page bridge:", fen);

  // Throttle: ignore rapid successive events (e.g. from mouse/keyboard interactions)
  if (bridgeEventThrottle) clearTimeout(bridgeEventThrottle);
  bridgeEventThrottle = setTimeout(() => {
    bridgeEventThrottle = null;
    scheduleAnalysis(100);
  }, 150);
});

const PIECE_MAP = {
  wp: "P", wn: "N", wb: "B", wr: "R", wq: "Q", wk: "K",
  bp: "p", bn: "n", bb: "b", br: "r", bq: "q", bk: "k",
};

function getBoardElement() {
  let board = document.querySelector("wc-chess-board");
  if (board) return board;

  board = document.querySelector("chess-board");
  if (board) return board;

  board = document.querySelector("#board-single");
  if (board) return board;

  board = document.querySelector(".board");
  if (board) return board;

  board = document.querySelector("#board-play-area .board");
  if (board) return board;

  return null;
}

function isEmptyBoardFen(fen) {
  if (!fen) return true;
  const placement = fen.split(" ")[0];
  return placement === "8/8/8/8/8/8/8/8";
}

function getFenFromBoard() {
  // 1. Use FEN from injected page script (most reliable for modern chess.com)
  if (latestFenFromPage && !isEmptyBoardFen(latestFenFromPage)) {
    return latestFenFromPage;
  }

  const board = getBoardElement();
  if (!board) return null;

  // 2. Parse from shadow DOM or regular DOM (legacy boards + modern wc-chess-board)
  const root = board.shadowRoot || board;
  let pieces = root.querySelectorAll(".piece");

  // Fallback: if no .piece elements, try to find pieces by other means
  if (pieces.length === 0) {
    // Modern chess.com may render pieces as <img> or <div> with data-square
    pieces = root.querySelectorAll('[data-square]');
    if (pieces.length === 0) {
      // Try looking for any elements that look like pieces (common chess.com patterns)
      pieces = root.querySelectorAll('.chess-piece, [class*="piece"], .piece-3d');
    }
    if (pieces.length === 0) {
      // Try the #board-layout-pieces container
      const layoutPieces = document.querySelector('#board-layout-pieces');
      if (layoutPieces) {
        pieces = layoutPieces.querySelectorAll('.piece, [data-square], [class*="piece"]');
      }
    }
    if (pieces.length === 0) {
      console.warn("[Chess.com Best Move] No piece elements found for DOM FEN extraction.");
      return null;
    }
  }

  const isFlipped =
    board.classList.contains("flipped") ||
    board.classList.contains("orientation-black");

  const squares = new Map();

  for (const piece of pieces) {
    let square = null;
    let pieceChar = null;

    // Method 1: class-based square and piece identification
    for (const cls of piece.classList) {
      if (cls.startsWith("square-")) {
        square = cls.replace("square-", "");
      } else if (cls.startsWith("data-square-")) {
        square = cls.replace("data-square-", "");
      } else if (PIECE_MAP[cls]) {
        pieceChar = PIECE_MAP[cls];
      }
    }

    // Method 2: data-square attribute
    if (!square && piece.hasAttribute("data-square")) {
      square = piece.getAttribute("data-square");
    }

    // Method 3: infer square from DOM position
    if (!square) {
      square = inferSquareFromPosition(piece, board);
    }

    // Method 4: look for piece type in other attributes or nested elements
    if (!pieceChar) {
      // Check for piece type in class names (e.g., "piece wp" or just "wp")
      const classes = Array.from(piece.classList).join(' ');
      for (const [key, val] of Object.entries(PIECE_MAP)) {
        if (classes.includes(key)) {
          pieceChar = val;
          break;
        }
      }
    }

    if (square && pieceChar) {
      squares.set(square, pieceChar);
    }
  }

  return buildFen(squares, isFlipped);
}

function inferSquareFromPosition(piece, board) {
  const boardRect = board.getBoundingClientRect();
  const pieceRect = piece.getBoundingClientRect();
  const squareSize = boardRect.width / 8;

  const fileIndex = Math.floor((pieceRect.left - boardRect.left) / squareSize);
  const rankIndex = Math.floor((pieceRect.top - boardRect.top) / squareSize);

  if (fileIndex < 0 || fileIndex > 7 || rankIndex < 0 || rankIndex > 7) return null;

  const file = String.fromCharCode("a".charCodeAt(0) + fileIndex);
  const rank = String(8 - rankIndex);
  return `${file}${rank}`;
}

function buildFen(squares, isFlipped) {
  const rows = [];
  for (let rank = 8; rank >= 1; rank--) {
    let row = "";
    let empty = 0;
    for (let file = 0; file < 8; file++) {
      const fileChar = String.fromCharCode("a".charCodeAt(0) + file);
      const square = `${fileChar}${rank}`;
      const piece = squares.get(square);
      if (piece) {
        if (empty > 0) {
          row += empty;
          empty = 0;
        }
        row += piece;
      } else {
        empty++;
      }
    }
    if (empty > 0) row += empty;
    rows.push(row);
  }

  const piecePlacement = rows.join("/");
  return `${piecePlacement} w KQkq - 0 1`;
}

// ---------------------------------------------------------------------------
// Analysis orchestration
// ---------------------------------------------------------------------------
function scheduleAnalysis(delayMs = 300) {
  if (analysisTimer) {
    clearTimeout(analysisTimer);
  }
  if (!config.enabled) {
    clearOverlay();
    return;
  }
  analysisTimer = setTimeout(runAnalysis, delayMs);
}

function startAnalysis(fen) {
  if (!stockfishReady || !stockfish) {
    console.log("[Chess.com Best Move] Cannot start analysis, Stockfish not ready.");
    scheduleAnalysis(500);
    return;
  }

  candidateMoves = [];
  lastAnalyzedFen = fen;
  isSearching = true;

  // Humanize: think time jitters +/-15% per position so no two runs match.
  const baseMoveTime = Math.min(Math.max(config.moveTimeMs || 1000, 100), 30000);
  const moveTime = Math.round(baseMoveTime * (0.85 + Math.random() * 0.3));

  // Honesty roll: only show the arrow in bestMoveChance% of positions.
  // Failed rolls retry on a short timer (scheduleRevealRetry) so a low
  // value delays the reveal instead of hiding it until the next move.
  clearRevealRetry();
  revealTries = 0;
  showBestMove = rollReveal();

  console.log("[Chess.com Best Move] Starting Stockfish analysis for FEN:", fen);
  sendStockfish("setoption name MultiPV value " + multiPvSafe());
  sendStockfish("isready");
  sendStockfish("position fen " + fen);
  sendStockfish("go movetime " + moveTime);
}

function multiPvSafe() {
  return Math.min(Math.max(config.multiPv || 1, 1), 3);
}

function runAnalysis() {
  if (!config.enabled) {
    clearOverlay();
    return;
  }

  // Ensure the page-world FEN bridge is present whenever we have a board
  if (getBoardElement()) {
    injectFenExtractor();
  }

  const fen = getFenFromBoard();
  if (!fen) {
    console.log("[Chess.com Best Move] No FEN available, skipping analysis.");
    return;
  }

  if (isEmptyBoardFen(fen)) {
    console.log("[Chess.com Best Move] Board appears empty, skipping analysis.");
    return;
  }

  if (fen === lastAnalyzedFen) return;
  currentFen = fen;

  if (!stockfishReady) {
    console.log("[Chess.com Best Move] FEN updated but Stockfish not ready yet, rescheduling...");
    scheduleAnalysis(500);
    return;
  }

  // If a search is already running, queue this FEN and ask Stockfish to stop.
  // We'll start the queued analysis only after receiving the 'bestmove' response.
  if (isSearching) {
    console.log("[Chess.com Best Move] Search in progress, queuing new FEN:", fen);
    pendingFen = fen;
    sendStockfish("stop");
    return;
  }

  startAnalysis(fen);
}

// ---------------------------------------------------------------------------
// DOM Overlay: move guidance + eval panel
// ---------------------------------------------------------------------------
function ensureOverlay() {
  if (overlayContainer) return;

  const board = getBoardElement();
  if (!board) return;

  const rect = board.getBoundingClientRect();
  const computed = getComputedStyle(board);

  overlayContainer = document.createElement("div");
  overlayContainer.id = "chess-com-best-move-overlay";
  overlayContainer.style.position = "absolute";
  overlayContainer.style.left = `${rect.left + window.scrollX}px`;
  overlayContainer.style.top = `${rect.top + window.scrollY}px`;
  overlayContainer.style.width = `${rect.width}px`;
  overlayContainer.style.height = `${rect.height}px`;
  overlayContainer.style.pointerEvents = "none";
  overlayContainer.style.zIndex = "9999";

  // SVG for arrow and piece-hint move indicators.
  arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrowSvg.setAttribute("width", "100%");
  arrowSvg.setAttribute("height", "100%");
  arrowSvg.style.position = "absolute";
  arrowSvg.style.top = "0";
  arrowSvg.style.left = "0";
  arrowSvg.style.overflow = "visible";

  // Glow filter (double blur + source) shared by every arrow shape
  svgDefs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  svgDefs.innerHTML = `
    <filter id="ccbm-arrow-glow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur1"/>
      <feGaussianBlur in="SourceGraphic" stdDeviation="8" result="blur2"/>
      <feMerge>
        <feMergeNode in="blur2"/>
        <feMergeNode in="blur1"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
  `;
  arrowSvg.appendChild(svgDefs);
  overlayContainer.appendChild(arrowSvg);
  updateGlowFilter();

  // Eval panel
  evalPanel = document.createElement("div");
  evalPanel.id = "chess-com-best-move-eval";
  evalPanel.textContent = "Analyzing...";
  overlayContainer.appendChild(evalPanel);

  // Depth display
  depthDisplay = document.createElement("div");
  depthDisplay.id = "chess-com-best-move-depth";
  depthDisplay.textContent = "";
  overlayContainer.appendChild(depthDisplay);

  gambitLabel = document.createElement("div");
  gambitLabel.id = "chess-com-best-move-gambit";
  gambitLabel.textContent = "";
  overlayContainer.appendChild(gambitLabel);

  document.body.appendChild(overlayContainer);
  applyOverlayOpacity();
  applyStealth();
}

function updateOverlayPosition() {
  const board = getBoardElement();
  if (!board || !overlayContainer) return;

  const rect = board.getBoundingClientRect();
  // The 500ms poll usually finds the board stationary - four no-op style
  // writes would dirty the overlay's style recalc on every tick otherwise.
  const l = `${rect.left + window.scrollX}px`;
  const t = `${rect.top + window.scrollY}px`;
  const w = `${rect.width}px`;
  const h = `${rect.height}px`;
  if (overlayContainer.style.left !== l) overlayContainer.style.left = l;
  if (overlayContainer.style.top !== t) overlayContainer.style.top = t;
  if (overlayContainer.style.width !== w) overlayContainer.style.width = w;
  if (overlayContainer.style.height !== h) overlayContainer.style.height = h;
}

function clearOverlay() {
  clearRevealRetry();
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
    arrowSvg = null;
    svgDefs = null;
    evalPanel = null;
    depthDisplay = null;
    gambitLabel = null;
  }
}

// ---------------------------------------------------------------------------
// Stealth: Ctrl+Shift+H hides/shows every overlay element instantly.
// The overlay is drawn only in this browser's DOM - nothing about it ever
// leaves the page, so nobody but the local viewer can see it. The hotkey is
// for screen-shares and streams.
// ---------------------------------------------------------------------------
let stealthHidden = false;

function applyStealth() {
  const mode = stealthHidden ? "none" : "";
  for (const id of [
    "chess-com-best-move-overlay",
    "chess-com-best-move-eval",
    "chess-com-best-move-depth",
    "chess-com-best-move-gear",
  ]) {
    const el = document.getElementById(id);
    if (el) el.style.display = mode;
  }
  // The panel keeps its own open/closed state - only force it shut when hidden.
  if (stealthHidden && menuPanel && menuPanel.style.display !== "none") {
    menuPanel.style.display = "none";
    stopMenuBg();
  }
}

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === "KeyH") {
    e.preventDefault();
    e.stopPropagation();
    stealthHidden = !stealthHidden;
    applyStealth();
    console.log("[Chess.com Best Move] stealth:", stealthHidden ? "HIDDEN" : "VISIBLE");
  }
}, true);

// ---------------------------------------------------------------------------
// Menu sounds - short synthesized blips via Web Audio (no files, no network).
// hover = tick, click = blip, slider = pitch follows the value.
// ---------------------------------------------------------------------------
let audioCtx = null;

function playMenuSound(kind, value) {
  if (!config.menuSounds) return;
  try {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();

    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    let freq = 660;
    let dur = 0.05;
    let vol = 0.05;
    let type = "sine";

    if (kind === "hover") {
      freq = 880;
      dur = 0.03;
      vol = 0.025;
      type = "sine";
    } else if (kind === "click") {
      freq = 520;
      dur = 0.09;
      vol = 0.07;
      type = "triangle";
    } else if (kind === "toggle") {
      freq = 760;
      dur = 0.07;
      vol = 0.06;
      type = "square";
    } else if (kind === "slider") {
      // value 0..1 -> 300..1100 Hz, very short tick
      const v = Math.max(0, Math.min(1, Number(value) || 0));
      freq = 300 + v * 800;
      dur = 0.025;
      vol = 0.03;
      type = "square";
    } else if (kind === "close") {
      freq = 340;
      dur = 0.1;
      vol = 0.06;
      type = "triangle";
    }

    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (kind === "click") {
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, now + dur);
    }
    gain.gain.setValueAtTime(vol, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.start(now);
    osc.stop(now + dur + 0.01);
  } catch (e) {
    // sound is a nicety - never let it break the menu
  }
}

// ---------------------------------------------------------------------------
// Menu background: canvas particle field in theme colors. Runs only while
// the panel is open (rAF is stopped on close - zero cost when hidden).
// ---------------------------------------------------------------------------
let bgCanvas = null;
let bgCtx = null;
let bgRaf = 0;
let bgTimer = 0;
let bgLastPaint = 0;
let bgParticles = [];
let bgDpr = 1;
let bgFrameCount = 0;
let bgW = 0; // cached panel size - clientWidth reads force layout when dirty,
let bgH = 0; // so they only run every 20th frame instead of every frame
let bgMeasureAt = -20;
let bgOrbA = null; // prerendered glow sprites: the gradient never changes,
let bgOrbB = null; // only its position - one drawImage per frame instead of
let bgOrbKey = ""; // two full-canvas radial-gradient fills

function bgResize() {
  if (!bgCanvas || !menuPanel) return;
  const w = menuPanel.clientWidth;
  const h = menuPanel.clientHeight;
  bgW = w;
  bgH = h;
  bgDpr = Math.min(window.devicePixelRatio || 1, 2);
  bgCanvas.width = Math.max(1, Math.floor(w * bgDpr));
  bgCanvas.height = Math.max(1, Math.floor(h * bgDpr));
  bgCanvas.style.width = w + "px";
  bgCanvas.style.height = h + "px";
  bgCtx.setTransform(bgDpr, 0, 0, bgDpr, 0, 0);
  bgOrbKey = ""; // sprite radius follows the panel width - rebuild on next paint
}

function bgSpawn(w, h) {
  const count = Math.round((w * h) / 4200);
  bgParticles = Array.from({ length: Math.min(Math.max(count, 18), 70) }, () => ({
    x: Math.random() * w,
    y: Math.random() * h,
    r: 0.6 + Math.random() * 1.8,
    vx: (Math.random() - 0.5) * 0.25,
    vy: -0.12 - Math.random() * 0.35,
    a: 0.15 + Math.random() * 0.5,
    ph: Math.random() * Math.PI * 2,
    sp: 0.4 + Math.random() * 1.2,
    tw: 0.3,
  }));
}

// One radial blob as a half-res canvas: it is pure falloff, so half the
// pixels look identical once scaled back up over the panel.
function bgOrbSprite(radiusCss, rgb, peak) {
  const px = Math.max(16, Math.round(radiusCss)); // draw size is 2x this
  const c = document.createElement("canvas");
  c.width = px;
  c.height = px;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  grad.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${peak})`);
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

function bgPaint(now) {
  // Coalesce: rAF and the interval watchdog share one paint gate (30fps is
  // plenty for orbs on an 18s drift and slow-rising particles).
  if (now - bgLastPaint < 33) return;
  bgLastPaint = now;
  if (!bgCtx || !menuPanel || !bgCanvas) return;

  // Re-measure the panel every 20 frames (submenu open/close, scrollbar).
  if (bgFrameCount - bgMeasureAt >= 20) {
    bgMeasureAt = bgFrameCount;
    const w = menuPanel.clientWidth;
    const h = menuPanel.clientHeight;
    if (w && h && (w !== bgW || h !== bgH || Math.abs(bgCanvas.width - w * bgDpr) > 2)) {
      bgResize();
      bgSpawn(w, h);
    }
  }
  const w = bgW;
  const h = bgH;
  if (!w || !h) return;

  bgCtx.clearRect(0, 0, w, h);

  const bgP = currentBgPreset();
  const primary = primaryColor();
  const secondary = secondaryColor();
  const pr = hexToRgb(bgP.blob1 || primary);
  const sr = hexToRgb(bgP.blob2 || secondary);
  const t = now;

  // Rebuild the sprites only when their color or radius actually changed.
  const orbKey = `${w}|${pr.r},${pr.g},${pr.b}|${sr.r},${sr.g},${sr.b}`;
  if (orbKey !== bgOrbKey) {
    bgOrbKey = orbKey;
    bgOrbA = bgOrbSprite(w * 0.55, pr, 0.14);
    bgOrbB = bgOrbSprite(w * 0.5, sr, 0.1);
  }

  // Two soft gradient orbs drifting on loops
  const r1 = w * 0.55;
  const o1x = w * (0.5 + 0.42 * Math.sin(t * 0.00035));
  const o1y = h * (0.5 + 0.4 * Math.cos(t * 0.00027));
  bgCtx.drawImage(bgOrbA, o1x - r1, o1y - r1, r1 * 2, r1 * 2);

  const r2 = w * 0.5;
  const o2x = w * (0.5 + 0.45 * Math.cos(t * 0.00022 + 1.7));
  const o2y = h * (0.5 + 0.42 * Math.sin(t * 0.00031 + 0.6));
  bgCtx.drawImage(bgOrbB, o2x - r2, o2y - r2, r2 * 2, r2 * 2);

  // Rising particles, twinkling on their own phase - updated first...
  for (const p of bgParticles) {
    p.x += p.vx + Math.sin(t * 0.001 * p.sp + p.ph) * 0.18;
    p.y += p.vy;
    if (p.y < -6) {
      p.y = h + 6;
      p.x = Math.random() * w;
    }
    if (p.x < -6) p.x = w + 6;
    else if (p.x > w + 6) p.x = -6;
    p.tw = p.a * (0.55 + 0.45 * Math.sin(t * 0.003 * p.sp + p.ph));
  }

  // ...then painted in six alpha buckets: one fillStyle + one path + one fill
  // per bucket instead of one per dot (up to 70 string builds a frame).
  const BUCKETS = 6;
  for (let b = 1; b <= BUCKETS; b++) {
    let opened = false;
    bgCtx.fillStyle = `rgba(${pr.r}, ${pr.g}, ${pr.b}, ${((b / BUCKETS) * 0.7).toFixed(3)})`;
    for (const p of bgParticles) {
      const bi = Math.min(BUCKETS, Math.max(1, Math.ceil((p.tw / 0.7) * BUCKETS)));
      if (bi !== b) continue;
      if (!opened) {
        bgCtx.beginPath();
        opened = true;
      }
      bgCtx.moveTo(p.x + p.r, p.y);
      bgCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    }
    if (opened) bgCtx.fill();
  }

  // Debug/telemetry: frame counter the E2E test can read off the DOM.
  bgFrameCount++;
  bgCanvas.dataset.frames = String(bgFrameCount);
}

// rAF driver - smooth when the tab is visible.
function bgLoop() {
  bgRaf = requestAnimationFrame(bgLoop);
  bgPaint(performance.now());
}

// Interval watchdog - keeps the animation alive when rAF is throttled
// (occluded/minimized window). bgPaint's 24ms gate coalesces both drivers.
function bgWatchdog() {
  bgPaint(performance.now());
}

function startMenuBg() {
  if (bgRaf || bgTimer || !menuPanel) return;
  if (!bgCanvas) {
    bgCanvas = document.createElement("canvas");
    bgCanvas.className = "ccbm-menu-bg";
    menuPanel.prepend(bgCanvas);
    bgCtx = bgCanvas.getContext("2d");
  }
  bgResize();
  bgSpawn(menuPanel.clientWidth, menuPanel.clientHeight);
  bgLastPaint = 0;
  bgRaf = requestAnimationFrame(bgLoop);
  // Watchdog: when rAF is throttled (occluded window) this keeps ~40fps.
  bgTimer = setInterval(bgWatchdog, 25);
}

function stopMenuBg() {
  if (bgRaf) {
    cancelAnimationFrame(bgRaf);
    bgRaf = 0;
  }
  if (bgTimer) {
    clearInterval(bgTimer);
    bgTimer = 0;
  }
}

// ---------------------------------------------------------------------------
// In-page settings menu (gear button -> panel). Every write goes through
// chrome.storage.sync, so the onChanged listener above repaints live.
// (menuPanel itself is declared with the other DOM handles at the top -
// applyTheme() runs during init and calls applyMenuBg().)
// ---------------------------------------------------------------------------

function menuRow(labelText, inputHtml) {
  return `<label class="ccbm-menu-row"><span>${labelText}</span>${inputHtml}</label>`;
}

// Color presets - each chip renders a real example arrow in its own colors.
const COLOR_PRESETS = [
  { name: "Neon", primary: "#39ff88", secondary: "#ffd700" },
  { name: "Cyan", primary: "#00e5ff", secondary: "#0066ff" },
  { name: "Pink", primary: "#ff2d95", secondary: "#b900ff" },
  { name: "Gold", primary: "#ffd700", secondary: "#ff8c00" },
  { name: "Fire", primary: "#ff4d00", secondary: "#ffd600" },
  { name: "Ice", primary: "#e6f0ff", secondary: "#5b8cff" },
  { name: "Purple", primary: "#b388ff", secondary: "#7c4dff" },
  { name: "Red", primary: "#ff1744", secondary: "#ff9100" },
  { name: "Mono", primary: "#ffffff", secondary: "#9aa0a6" },
];

function presetChip(preset, index) {
  const gid = `ccbm-pgi-${index}`;
  return `
    <button type="button" class="ccbm-preset" data-preset="${index}" title="${preset.name}"
            style="--p1:${preset.primary};--p2:${preset.secondary}">
      <span class="ccbm-preset-art">
        <svg viewBox="0 0 58 28" width="66" height="32" aria-hidden="true">
          <defs>
            <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="${preset.primary}" stop-opacity="0.3"/>
              <stop offset="55%" stop-color="${preset.primary}"/>
              <stop offset="100%" stop-color="${preset.secondary}"/>
            </linearGradient>
            <linearGradient id="${gid}-h" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stop-color="${preset.primary}"/>
              <stop offset="100%" stop-color="${preset.secondary}"/>
            </linearGradient>
            <filter id="${gid}-f" x="-70%" y="-70%" width="240%" height="240%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2.4" result="b1"/>
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b2"/>
              <feMerge>
                <feMergeNode in="b2"/>
                <feMergeNode in="b1"/>
                <feMergeNode in="SourceGraphic"/>
              </feMerge>
            </filter>
          </defs>
          <g filter="url(#${gid}-f)">
            <line x1="6" y1="14" x2="43" y2="14" stroke="url(#${gid})"
                  stroke-width="7" stroke-linecap="round"/>
            <path d="M54.5 14 Q46.8 9.8 40.8 7 Q45 14 40.8 21 Q46.8 18.2 54.5 14 Z"
                  fill="url(#${gid}-h)" stroke="${preset.primary}" stroke-width="1.4"
                  stroke-linejoin="round"/>
          </g>
        </svg>
      </span>
      <span class="ccbm-preset-foot">
        <i class="ccbm-preset-dot" style="background:${preset.primary};color:${preset.primary}"></i>
        <span>${preset.name}</span>
        <i class="ccbm-preset-dot" style="background:${preset.secondary};color:${preset.secondary}"></i>
      </span>
    </button>`;
}

// Arrow design presets - each chip previews its geometry in the live theme
// color (--p1 follows --ccbm-primary), the click writes config.arrowStyle.
const ARROW_STYLES = [
  { id: "classic", name: "Classic" },
  { id: "blade", name: "Blade" },
  { id: "chevron", name: "Chevron" },
  { id: "dotted", name: "Dotted" },
  { id: "ghost", name: "Ghost" },
  { id: "comet", name: "Comet" },
];

function gambitChip(gambit, index) {
  return `
    <button type="button" class="ccbm-gambitchip" data-gambit="${gambit.id}"
            title="${gambit.name}">${gambit.name}</button>`;
}

function styleChip(style) {
  const previews = {
    classic:
      '<line x1="7" y1="14" x2="41" y2="14" style="stroke:var(--p1,#39ff88);stroke-width:6;stroke-linecap:round;opacity:.85"/>' +
      '<path d="M54.5 14 L40 7.5 L40 20.5 Z" style="fill:var(--p1,#39ff88)"/>',
    blade:
      '<line x1="9" y1="14" x2="43" y2="14" style="stroke:var(--p1,#39ff88);stroke-width:3;stroke-linecap:round"/>' +
      '<path d="M55 14 L39 9.3 L39 18.7 Z" style="fill:var(--p1,#39ff88)"/>',
    chevron:
      '<path d="M39 5 L53 14 L39 23" style="fill:none;stroke:var(--p1,#39ff88);stroke-width:5;stroke-linecap:round;stroke-linejoin:round"/>' +
      '<path d="M22 8.5 L31 14 L22 19.5" style="fill:none;stroke:var(--p1,#39ff88);stroke-width:3.5;stroke-linecap:round;stroke-linejoin:round;opacity:.65"/>',
    dotted:
      '<line x1="7" y1="14" x2="41" y2="14" style="stroke:var(--p1,#39ff88);stroke-width:5;stroke-linecap:round;stroke-dasharray:0.01 8"/>' +
      '<path d="M54.5 14 L40 7.5 L40 20.5 Z" style="fill:var(--p1,#39ff88)"/>',
    ghost:
      '<line x1="8" y1="14" x2="42" y2="14" style="stroke:var(--p1,#39ff88);stroke-width:3.5;stroke-linecap:round"/>' +
      '<path d="M54.5 14 L40 7 L40 21 Z" style="fill:none;stroke:var(--p1,#39ff88);stroke-width:3;stroke-linejoin:round"/>',
    comet:
      '<path d="M6 10.5 L40 6.5 L55 14 L40 21.5 L6 17.5 Z" style="fill:var(--p1,#39ff88);opacity:.92"/>',
  };
  return `
    <button type="button" class="ccbm-preset ccbm-stylepreset" data-style="${style.id}"
            title="${style.name}"
            style="--p1:var(--ccbm-primary, #39ff88);--p2:var(--ccbm-primary, #39ff88)">
      <span class="ccbm-preset-art">
        <svg viewBox="0 0 58 28" width="66" height="32" aria-hidden="true">${previews[style.id] || previews.classic}</svg>
      </span>
      <span class="ccbm-preset-foot"><span>${style.name}</span></span>
    </button>`;
}

function menuSection(titleText, rowsHtml) {
  return `
    <div class="ccbm-menu-sect"><span>${titleText}</span></div>
    ${rowsHtml}`;
}

// Menu background presets - each tints the panel gradient, the glow blobs and
// the canvas particle field in its own colors. blob1/blob2 null = the blobs
// follow the arrow theme (the "Void" default keeps the original look).
const BG_PRESETS = [
  { id: "void", name: "Void",
    bg1: "rgba(14, 16, 15, 0.94)", bg2: "rgba(8, 10, 9, 0.96)",
    blob1: null, blob2: null },
  { id: "midnight", name: "Midnight",
    bg1: "rgba(10, 14, 31, 0.94)", bg2: "rgba(5, 7, 15, 0.96)",
    blob1: "#2b4cff", blob2: "#7a1fff" },
  { id: "blood", name: "Blood",
    bg1: "rgba(23, 10, 12, 0.94)", bg2: "rgba(12, 5, 7, 0.96)",
    blob1: "#ff2d55", blob2: "#ff7a00" },
  { id: "synth", name: "Synth",
    bg1: "rgba(21, 10, 30, 0.94)", bg2: "rgba(10, 5, 18, 0.96)",
    blob1: "#b388ff", blob2: "#ff2d95" },
  { id: "forest", name: "Forest",
    bg1: "rgba(10, 20, 16, 0.94)", bg2: "rgba(5, 12, 9, 0.96)",
    blob1: "#39ff88", blob2: "#00c853" },
  { id: "sand", name: "Sand",
    bg1: "rgba(23, 18, 8, 0.94)", bg2: "rgba(13, 10, 5, 0.96)",
    blob1: "#ffb347", blob2: "#ffd700" },
  { id: "arctic", name: "Arctic",
    bg1: "rgba(13, 20, 24, 0.94)", bg2: "rgba(7, 12, 16, 0.96)",
    blob1: "#00e5ff", blob2: "#5b8cff" },
  { id: "mono", name: "Mono",
    bg1: "rgba(18, 18, 18, 0.94)", bg2: "rgba(8, 8, 8, 0.96)",
    blob1: "#ffffff", blob2: "#8a8f8d" },
  { id: "ocean", name: "Ocean",
    bg1: "rgba(8, 20, 24, 0.94)", bg2: "rgba(4, 11, 14, 0.96)",
    blob1: "#00b8d4", blob2: "#0066ff" },
];

function currentBgPreset() {
  return BG_PRESETS.find((b) => b.id === config.menuBg) || BG_PRESETS[0];
}

// Push the background preset onto the panel - CSS consumes the vars, the
// canvas paint loop reads currentBgPreset() directly.
function applyMenuBg() {
  if (!menuPanel) return;
  const p = currentBgPreset();
  const st = menuPanel.style;
  st.setProperty("--ccbm-bg-1", p.bg1);
  st.setProperty("--ccbm-bg-2", p.bg2);
  if (p.blob1) {
    st.setProperty("--ccbm-blob-a", p.blob1);
    st.setProperty("--ccbm-blob-b", p.blob2);
  } else {
    st.removeProperty("--ccbm-blob-a");
    st.removeProperty("--ccbm-blob-b");
  }
  // Panel glow rides the background accent (void falls back to the arrow
  // theme, exactly like the blobs do) - strength still follows the Glow slider.
  const k = glowLevel() / 100;
  const gc = hexToRgb(p.blob1 || primaryColor());
  st.setProperty("--ccbm-menu-glow", `rgba(${gc.r}, ${gc.g}, ${gc.b}, ${(0.45 * k).toFixed(3)})`);
  st.setProperty("--ccbm-menu-glow-strong", `rgba(${gc.r}, ${gc.g}, ${gc.b}, ${(0.95 * k).toFixed(3)})`);
}

// Chip previews the actual panel: gradient bed + two glow blobs, mini style.
function bgPresetChip(preset) {
  const g1 = preset.blob1 || "#39ff88";
  const g2 = preset.blob2 || "#ffd700";
  const art = `radial-gradient(circle at 24% 28%, ${g1}66, transparent 58%),` +
    `radial-gradient(circle at 78% 72%, ${g2}55, transparent 60%),` +
    `linear-gradient(160deg, ${preset.bg1}, ${preset.bg2})`;
  return `
    <button type="button" class="ccbm-bgpreset" data-bgp="${preset.id}" title="${preset.name}"
            style="--g1:${g1};--g2:${g2}">
      <span class="ccbm-bgpreset-art" style="background:${art}"></span>
      <span>${preset.name}</span>
    </button>`;
}

function ensureMenu() {
  if (menuPanel) return;

  const gear = document.createElement("button");
  gear.id = "chess-com-best-move-gear";
  gear.type = "button";
  gear.title = "Pupsi v1 settings (Right Shift)";
  gear.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <g class="ccbm-gear-bars" fill="none" stroke="currentColor"
         stroke-width="2" stroke-linecap="round">
        <line x1="4" y1="7" x2="20" y2="7"/>
        <line x1="4" y1="12" x2="20" y2="12"/>
        <line x1="4" y1="17" x2="20" y2="17"/>
      </g>
      <circle class="ccbm-gear-knob k1" cx="9" cy="7" r="2.6"/>
      <circle class="ccbm-gear-knob k2" cx="15" cy="12" r="2.6"/>
      <circle class="ccbm-gear-knob k3" cx="7" cy="17" r="2.6"/>
    </svg>`;
  gear.addEventListener("mouseenter", () => playMenuSound("hover"));
  gear.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  document.body.appendChild(gear);

  menuPanel = document.createElement("div");
  menuPanel.id = "chess-com-best-move-menu";
  menuPanel.innerHTML = `
    <div class="ccbm-ring" aria-hidden="true"><div class="ccbm-ring-rot"></div></div>
    <div class="ccbm-menu-head">
      <div class="ccbm-head-text">
        <strong>Pupsi v1</strong>
        <em>made by static</em>
      </div>
      <button type="button" class="ccbm-menu-close" title="Close">&#10005;</button>
    </div>
    <div class="ccbm-menu-body">
      ${menuSection("General", `
        ${menuRow("Enabled", '<input type="checkbox" data-key="enabled">')}
        ${menuRow("Opponent's move", '<input type="checkbox" data-key="showOpponentMove">')}
        ${menuRow("Show evaluation", '<input type="checkbox" data-key="showEval">')}
        ${menuRow("Show depth", '<input type="checkbox" data-key="showDepth">')}`)}
      ${menuSection("Colors", `
        ${menuRow("Primary color", '<input type="color" data-key="arrowColor" class="ccbm-color">')}
        ${menuRow("Backup color", '<input type="color" data-key="secondaryArrowColor" class="ccbm-color">')}
        <div class="ccbm-presets">
          <div class="ccbm-presets-grid">${COLOR_PRESETS.map(presetChip).join("")}</div>
        </div>`)}
      ${menuSection("Background", `
        <div class="ccbm-presets">
          <div class="ccbm-presets-grid">${BG_PRESETS.map(bgPresetChip).join("")}</div>
        </div>`)}
      ${menuSection("Arrow", `
        <div class="ccbm-presets">
          <div class="ccbm-presets-grid">${ARROW_STYLES.map(styleChip).join("")}</div>
        </div>
        ${menuRow('Width <b data-val="arrowWidth"></b>',
          '<input type="range" data-key="arrowWidth" min="2" max="16" step="1">')}
        ${menuRow('Glow <b data-val="glowStrength"></b>',
          '<input type="range" data-key="glowStrength" min="0" max="100" step="5">')}
        ${menuRow('Blend <b data-val="overlayOpacity"></b>',
          '<input type="range" data-key="overlayOpacity" min="5" max="100" step="5">')}
        ${menuRow("Pulse animation", '<input type="checkbox" data-key="pulse">')}`)}
      ${menuSection("Engine", `
        ${menuRow('Lines <b data-val="multiPv"></b>',
          '<input type="range" data-key="multiPv" min="1" max="3" step="1">')}
        ${menuRow('Think time <b data-val="moveTimeMs"></b>',
          '<input type="range" data-key="moveTimeMs" min="200" max="5000" step="100">')}
        ${menuRow('Reveal best <b data-val="bestMoveChance"></b>',
          '<input type="range" data-key="bestMoveChance" min="50" max="100" step="5">')}`)}
      ${menuSection("Gambit", `
        ${menuRow("Gambit mode", '<input type="checkbox" data-key="gambitMode">')}
        <div class="ccbm-gambitgrid">
          <button type="button" class="ccbm-gambitchip" data-gambit="random" title="Random per game">Random</button>
          ${GAMBITS.map(gambitChip).join("")}
        </div>`)}
      ${menuSection("Menu", `
        ${menuRow("Sounds", '<input type="checkbox" data-key="menuSounds">')}`)}
    </div>
    <div class="ccbm-menu-foot">
      <button type="button" class="ccbm-menu-reset">Reset defaults</button>
    </div>
  `;
  document.body.appendChild(menuPanel);
  menuPanel.style.display = "none";

  // Stagger entrance: assign delays in real DOM order (sections + rows mixed).
  let step = 0;
  menuPanel
    .querySelectorAll(".ccbm-menu-body > .ccbm-menu-sect, .ccbm-menu-body > .ccbm-menu-row")
    .forEach((el) => {
      el.style.animationDelay = `${(0.04 + step * 0.045).toFixed(3)}s`;
      step++;
    });
  menuPanel.querySelectorAll(".ccbm-preset, .ccbm-bgpreset").forEach((chip, i) => {
    chip.style.animationDelay = `${(0.22 + i * 0.03).toFixed(3)}s`;
  });

  // Hover tick on every interactive piece (delegated, one listener).
  menuPanel.addEventListener("mouseover", (e) => {
    const hit = e.target.closest("button, .ccbm-menu-row, .ccbm-preset");
    if (!hit || hit.contains(e.relatedTarget)) return;
    playMenuSound("hover");
  });

  menuPanel.querySelector(".ccbm-menu-close").addEventListener("click", () => {
    playMenuSound("close");
    toggleMenu();
  });
  menuPanel.querySelector(".ccbm-menu-reset").addEventListener("click", () => {
    playMenuSound("click");
    chrome.storage.sync.set({ ...DEFAULT_CONFIG });
    syncMenu();
  });

  const save = (key, raw, type) => {
    let value = raw;
    if (type === "checkbox") value = !!raw;
    else if (type === "range") value = parseInt(raw, 10);
    chrome.storage.sync.set({ [key]: value });
  };

  menuPanel.querySelectorAll("[data-key]").forEach((input) => {
    const key = input.dataset.key;
    const type = input.type;
    const evt = type === "range" || type === "color" ? "input" : "change";
    input.addEventListener(evt, () => {
      const raw = type === "checkbox" ? input.checked : input.value;
      if (type === "range") {
        const val = menuPanel.querySelector(`[data-val="${key}"]`);
        if (val) {
          val.textContent = formatMenuValue(key, parseInt(raw, 10));
          val.classList.remove("pop");
          void val.offsetWidth; // restart the pop animation
          val.classList.add("pop");
        }
        // Pitch follows the normalized slider position.
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 100;
        playMenuSound("slider", (Number(raw) - min) / (max - min));
        input.style.setProperty(
          "--ccbm-fill",
          `${(((Number(raw) - min) / (max - min)) * 100).toFixed(1)}%`
        );
      } else if (type === "checkbox") {
        playMenuSound("toggle");
      } else if (type === "color") {
        playMenuSound("click");
      }
      save(key, raw, type);
    });
  });

  // Preset chips: write both colors in one go - repaints live via onChanged.
  menuPanel.querySelectorAll(".ccbm-preset").forEach((chip) => {
    chip.addEventListener("click", () => {
      const preset = COLOR_PRESETS[parseInt(chip.dataset.preset, 10)];
      if (!preset) return;
      playMenuSound("click");
      chrome.storage.sync.set({
        arrowColor: preset.primary,
        secondaryArrowColor: preset.secondary,
      });
    });
  });

  // Background preset chips: one key, panel + blobs + canvas repaint live.
  menuPanel.querySelectorAll(".ccbm-bgpreset").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (!chip.dataset.bgp) return;
      playMenuSound("click");
      chrome.storage.sync.set({ menuBg: chip.dataset.bgp });
    });
  });

  // Arrow design chips: one key, the overlay redraws live via onChanged.
  menuPanel.querySelectorAll(".ccbm-stylepreset").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (!chip.dataset.style) return;
      playMenuSound("click");
      chrome.storage.sync.set({ arrowStyle: chip.dataset.style });
    });
  });

  // Gambit chips: pick a repertoire entry (or Random for a fresh pick each
  // game). Enabling the mode is a separate checkbox.
  menuPanel.querySelectorAll(".ccbm-gambitchip").forEach((chip) => {
    chip.addEventListener("click", () => {
      if (!chip.dataset.gambit) return;
      playMenuSound("click");
      gambitGameStamp = null; // force a fresh random pick on the next position
      chrome.storage.sync.set({
        gambitPick: chip.dataset.gambit,
        gambitMode: true,
      });
    });
  });

  // Drag: grab the header to move the panel. First grab converts the centered
  // position to pixel coords; the entrance animation is dropped at that point
  // because its keyframes would re-center the panel on the next open. The
  // transition is cut too - chess.com forces transition-duration:.1ms on * via
  // !important, and a running transition outranks inline left/top in the cascade.
  let dragOff = null;
  const dragHead = menuPanel.querySelector(".ccbm-menu-head");
  dragHead.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest(".ccbm-menu-close")) return;
    const r = menuPanel.getBoundingClientRect();
    menuPanel.style.transition = "none";
    menuPanel.style.left = `${r.left}px`;
    menuPanel.style.top = `${r.top}px`;
    menuPanel.style.transform = "none";
    menuPanel.style.animation = "none";
    dragOff = { x: e.clientX - r.left, y: e.clientY - r.top };
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragOff) return;
    const x = Math.min(Math.max(0, e.clientX - dragOff.x), window.innerWidth - menuPanel.offsetWidth);
    const y = Math.min(Math.max(0, e.clientY - dragOff.y), window.innerHeight - 32);
    menuPanel.style.left = `${x}px`;
    menuPanel.style.top = `${y}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragOff) return;
    dragOff = null;
    // Hand the (harmless, .1ms) transitions back for theme/preset changes.
    menuPanel.style.transition = "";
  });

  syncMenu();
}

function formatMenuValue(key, v) {
  if (key === "moveTimeMs") return `${v} ms`;
  if (key === "overlayOpacity") return `${v}%`;
  if (key === "bestMoveChance") return `${v}%`;
  return String(v);
}

function syncMenu() {
  if (!menuPanel) return;
  chrome.storage.sync.get(DEFAULT_CONFIG, (items) => {
    menuPanel.querySelectorAll("[data-key]").forEach((input) => {
      const key = input.dataset.key;
      if (!(key in items)) return;
      if (input.type === "checkbox") input.checked = !!items[key];
      else input.value = items[key];
      const val = menuPanel.querySelector(`[data-val="${key}"]`);
      if (val) val.textContent = formatMenuValue(key, items[key]);
      if (input.type === "range") {
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 100;
        const pct = ((Number(items[key]) - min) / (max - min)) * 100;
        input.style.setProperty("--ccbm-fill", `${pct.toFixed(1)}%`);
      }
    });

    // Highlight the preset matching the current color pair.
    const p = toHexColor(items.arrowColor, DEFAULT_CONFIG.arrowColor);
    const s = toHexColor(items.secondaryArrowColor, DEFAULT_CONFIG.secondaryArrowColor);
    menuPanel.querySelectorAll(".ccbm-preset").forEach((chip) => {
      if (!chip.dataset.preset) return; // arrow-design chips share the class
      const preset = COLOR_PRESETS[parseInt(chip.dataset.preset, 10)];
      chip.classList.toggle(
        "active",
        !!preset && preset.primary === p && preset.secondary === s
      );
    });

    // Highlight the active arrow design chip.
    menuPanel.querySelectorAll(".ccbm-stylepreset").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.style === items.arrowStyle);
    });

    // Highlight the active background preset and repaint the panel.
    menuPanel.querySelectorAll(".ccbm-bgpreset").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.bgp === items.menuBg);
    });

    // Highlight the active gambit chip; a changed pick forces a fresh draw.
    if (items.gambitPick !== gambitLastPick) {
      gambitLastPick = items.gambitPick;
      gambitGameStamp = null;
    }
    menuPanel.querySelectorAll(".ccbm-gambitchip").forEach((chip) => {
      chip.classList.toggle("active", chip.dataset.gambit === items.gambitPick);
    });

    applyMenuBg();

  });
}

function toggleMenu() {
  ensureMenu();
  if (menuPanel.style.display === "none") {
    menuPanel.style.display = "flex";
    playMenuSound("click");
    syncMenu();
    startMenuBg();
  } else {
    menuPanel.style.display = "none";
    playMenuSound("close");
    stopMenuBg();
  }
}

// Create the gear as soon as the page is ready so it's always reachable.
if (document.body) {
  ensureMenu();
} else {
  document.addEventListener("DOMContentLoaded", ensureMenu, { once: true });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && menuPanel && menuPanel.style.display !== "none") syncMenu();
});

// Right Shift toggles the menu. The press only counts if it was not used as
// a modifier: any other key or mouse button between down and up cancels it,
// so shift+click, shift+selection and typing capitals stay untouched.
let rightShiftArmed = false;

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.code === "KeyM") {
    e.preventDefault();
    e.stopPropagation();
    toggleMenu();
    return;
  }
  if (e.code === "ShiftRight") {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
    const t = e.target;
    const typing =
      !!t && (t.isContentEditable === true || /^(input|textarea|select)$/i.test(t.tagName || ""));
    rightShiftArmed = !typing;
    return;
  }
  rightShiftArmed = false;
}, true);

document.addEventListener("keyup", (e) => {
  if (e.code === "ShiftRight" && rightShiftArmed) {
    rightShiftArmed = false;
    toggleMenu();
  }
}, true);

document.addEventListener("mousedown", () => {
  rightShiftArmed = false;
}, true);

function updateDepthDisplay(depth) {
  if (!config.showDepth || !depthDisplay) return;
  const text = `Depth ${depth}`;
  // Info lines arrive dozens per second - never touch the DOM for a no-op.
  if (depthDisplay.textContent !== text) depthDisplay.textContent = text;
}

function updateEvalDisplay() {
  if (!evalPanel) return;

  const best = candidateMoves.find((m) => m && m.rank === 1);
  if (!best || !best.evaluation) {
    evalPanel.textContent = "Analyzing...";
    return;
  }

  const ev = best.evaluation;
  let text = "";
  if (ev.kind === "mate") {
    text = `M${ev.value > 0 ? "" : "-"}${Math.abs(ev.value)}`;
  } else {
    const pawns = (ev.value / 100).toFixed(2);
    text = `${pawns > 0 ? "+" : ""}${pawns}`;
  }

  if (evalPanel.textContent !== text) {
    evalPanel.classList.remove("pop");
    void evalPanel.offsetWidth; // restart pop animation
    evalPanel.classList.add("pop");
    evalPanel.textContent = text;
  }
}

function getDisplayMode() {
  return config.displayMode === DISPLAY_MODES.PIECE
    ? DISPLAY_MODES.PIECE
    : DISPLAY_MODES.ARROWS;
}

function clearMoveIndicators() {
  if (!arrowSvg) return;

  // Preserve the glow filter; purge shapes and stale gradients between renders.
  const defs = arrowSvg.querySelector("defs");
  if (defs) {
    for (const child of Array.from(defs.children)) {
      if (child.tagName.toLowerCase() !== "filter") {
        child.remove();
      }
    }
  }
  for (const child of Array.from(arrowSvg.children)) {
    if (child.tagName.toLowerCase() !== "defs") {
      child.remove();
    }
  }
}

function drawMoveOverlay() {
  if (!config.enabled) {
    clearOverlay();
    return;
  }

  ensureOverlay();
  updateOverlayPosition();

  if (!arrowSvg) return;

  clearMoveIndicators();

  const board = getBoardElement();
  if (!board) return;

  const visibleMoveCount = Math.min(Math.max(config.multiPv || 1, 1), 3);
  let movesToDraw = candidateMoves
    .filter((m) => m && m.rank <= visibleMoveCount)
    .slice(0, 3);

  // Gambit override: when the live position matches a booked line, the
  // gambit move replaces the engine's top move and bypasses the reveal roll.
  const gambit = findGambitMove(currentFen);
  if (gambitLabel) {
    gambitLabel.textContent = gambit ? gambit.name : "";
  }
  if (gambit) {
    movesToDraw = [
      { rank: 1, uci: gambit.uci },
      ...movesToDraw.filter((m) => m.rank > 1),
    ];
    clearRevealRetry();
    showBestMove = true;
  }

  // Honesty roll failed (bestMoveChance% passes): hide the top line this
  // position. Backup lines still show; if none exist, no arrow at all -
  // schedule a short retry so the reveal comes soon instead of next move.
  if (!showBestMove) {
    movesToDraw = movesToDraw.filter((m) => m.rank > 1);
    if (!movesToDraw.length) {
      clearMoveIndicators();
      scheduleRevealRetry();
      return;
    }
  }

  const rect = board.getBoundingClientRect();
  const squareSize = rect.width / 8;

  // Detect flipped orientation
  const isFlipped = board.classList.contains("flipped") || board.classList.contains("orientation-black");

  // whose turn is it? FEN field 2 = side to move; player color follows the
  // board orientation (flipped board = playing black).
  const sideToMove = currentFen ? currentFen.split(" ")[1] : "w";
  const playerColor = isFlipped ? "b" : "w";
  const isOpponentTurn = sideToMove !== playerColor;

  // Setting off: no move guidance while the opponent is thinking.
  if (isOpponentTurn && !config.showOpponentMove) {
    clearMoveIndicators();
    return;
  }

  if (getDisplayMode() === DISPLAY_MODES.PIECE) {
    drawPieceHint(movesToDraw[0], squareSize, isFlipped);
    return;
  }

  const style =
    typeof config.arrowStyle === "string" ? config.arrowStyle : "classic";

  for (const move of movesToDraw) {
    if (!move || !move.uci) continue;
    const from = move.uci.slice(0, 2);
    const to = move.uci.slice(2, 4);

    const fromCoord = getSquareCenter(from, squareSize, isFlipped, rect);
    const toCoord = getSquareCenter(to, squareSize, isFlipped, rect);

    if (!fromCoord || !toCoord) continue;

    const isPrimary = move.rank === 1;
    const color = isPrimary ? primaryColor() : secondaryColor();
    const width = isPrimary ? config.arrowWidth : Math.max(2, config.arrowWidth - 2);

    const dx = toCoord.x - fromCoord.x;
    const dy = toCoord.y - fromCoord.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let headLen = Math.max(14, width * 3.2);
    let headHalf = Math.max(8, width * 1.9);
    if (style === "blade") {
      headLen *= 1.45; // long narrow tip, slim shaft
      headHalf *= 0.6;
    } else if (style === "chevron") {
      headLen *= 1.5; // wide V, no shaft
      headHalf *= 1.4;
    }
    // stop the shaft where the head begins so the tip lands exactly on the square center
    const shaftX = toCoord.x - ux * headLen * 0.85;
    const shaftY = toCoord.y - uy * headLen * 0.85;
    const baseX = toCoord.x - ux * headLen;
    const baseY = toCoord.y - uy * headLen;
    const perpX = -uy;
    const perpY = ux;

    // Neon arrow: glow filter + per-style body + idle pulse
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("filter", "url(#ccbm-arrow-glow)");
    g.classList.add("ccbm-neon-arrow");
    g.setAttribute("data-uci", move.uci);
    if (isPrimary) g.classList.add("ccbm-neon-primary");

    const svgNS = "http://www.w3.org/2000/svg";
    const gradId = isPrimary ? "ccbm-grad-primary" : "ccbm-grad-secondary";
    const grad = document.createElementNS(svgNS, "linearGradient");
    grad.id = gradId;
    grad.setAttribute("x1", fromCoord.x);
    grad.setAttribute("y1", fromCoord.y);
    grad.setAttribute("x2", toCoord.x);
    grad.setAttribute("y2", toCoord.y);
    grad.setAttribute("gradientUnits", "userSpaceOnUse");
    grad.innerHTML = isPrimary
      ? `<stop offset="0%" stop-color="${primaryColor()}" stop-opacity="0.55"/>
         <stop offset="60%" stop-color="${primaryColor()}"/>
         <stop offset="100%" stop-color="${mixWhite(primaryColor(), 0.75)}"/>`
      : `<stop offset="0%" stop-color="${secondaryColor()}" stop-opacity="0.5"/>
         <stop offset="100%" stop-color="${secondaryColor()}"/>`;
    if (style !== "chevron") svgDefs.appendChild(grad); // chevron draws no shaft

    if (style === "chevron") {
      // Two stroked V outlines along the move - no shaft, no solid head.
      const chev = (tipX, tipY, hl, hh, sw, op) => {
        const bX = tipX - ux * hl;
        const bY = tipY - uy * hl;
        const p = document.createElementNS(svgNS, "path");
        p.setAttribute(
          "d",
          `M${bX + perpX * hh},${bY + perpY * hh} ` +
            `L${tipX},${tipY} ` +
            `L${bX - perpX * hh},${bY - perpY * hh}`
        );
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", color);
        p.setAttribute("stroke-width", sw);
        p.setAttribute("stroke-linecap", "round");
        p.setAttribute("stroke-linejoin", "round");
        if (op) p.setAttribute("opacity", op);
        return p;
      };
      g.appendChild(chev(toCoord.x, toCoord.y, headLen, headHalf, Math.max(3, width)));
      g.appendChild(
        chev(fromCoord.x, fromCoord.y, headLen * 0.5, headHalf * 0.5,
             Math.max(2, width * 0.7), "0.65")
      );
    } else if (style === "comet") {
      // Tapered body: narrow tail at the origin, wide base, sharp tip.
      const tailHalf = Math.max(2.5, width * 0.55);
      const body = document.createElementNS(svgNS, "polygon");
      body.setAttribute(
        "points",
        `${toCoord.x},${toCoord.y} ` +
          `${baseX + perpX * headHalf},${baseY + perpY * headHalf} ` +
          `${fromCoord.x + perpX * tailHalf},${fromCoord.y + perpY * tailHalf} ` +
          `${fromCoord.x - perpX * tailHalf},${fromCoord.y - perpY * tailHalf} ` +
          `${baseX - perpX * headHalf},${baseY - perpY * headHalf}`
      );
      body.setAttribute("fill", `url(#${gradId})`);
      body.setAttribute("stroke", color);
      body.setAttribute("stroke-width", Math.max(1, width * 0.3));
      body.setAttribute("stroke-linejoin", "round");
      g.appendChild(body);
    } else {
      // Shaft: gradient (classic/blade), round dots (dotted) or thin solid
      // line (ghost) - head follows the same style.
      const shaft = document.createElementNS(svgNS, "line");
      shaft.setAttribute("x1", fromCoord.x);
      shaft.setAttribute("y1", fromCoord.y);
      shaft.setAttribute("x2", shaftX);
      shaft.setAttribute("y2", shaftY);
      shaft.setAttribute("stroke-width",
        style === "blade" ? Math.max(2, width * 0.7) : width);
      shaft.setAttribute("stroke-linecap", "round");
      if (style === "dotted") {
        shaft.setAttribute("stroke", color);
        shaft.setAttribute("stroke-dasharray", `0.01 ${Math.max(6, width * 2.1)}`);
      } else if (style === "ghost") {
        shaft.setAttribute("stroke", color);
        shaft.setAttribute("stroke-width", Math.max(2, width * 0.55));
        shaft.setAttribute("stroke-opacity", "0.9");
      } else {
        shaft.setAttribute("stroke", `url(#${gradId})`);
      }
      g.appendChild(shaft);

      const head = document.createElementNS(svgNS, "polygon");
      head.setAttribute("points",
        `${toCoord.x},${toCoord.y} ` +
        `${baseX + perpX * headHalf},${baseY + perpY * headHalf} ` +
        `${baseX - perpX * headHalf},${baseY - perpY * headHalf}`);
      head.setAttribute("fill", style === "ghost" ? "none" : color);
      head.setAttribute("stroke", color);
      head.setAttribute("stroke-width",
        style === "ghost" ? Math.max(2.5, width * 0.5) : Math.max(1.5, width * 0.35));
      head.setAttribute("stroke-linejoin", "round");
      g.appendChild(head);
    }

    arrowSvg.appendChild(g);

    // If this is a promotion move, draw a small circle on the target square
    if (move.uci.length === 5) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", toCoord.x);
      circle.setAttribute("cy", toCoord.y);
      circle.setAttribute("r", width * 1.5);
      circle.setAttribute("fill", color);
      g.appendChild(circle);
    }
  }
}

function drawPieceHint(move, squareSize, isFlipped) {
  if (!move || !move.uci) return;

  const from = move.uci.slice(0, 2);
  const fromCoord = getSquareCenter(from, squareSize, isFlipped);
  if (!fromCoord) return;

  const radius = squareSize * 0.38;
  const strokeWidth = Math.max(3, config.arrowWidth / 2);

  const highlight = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  highlight.setAttribute("cx", fromCoord.x);
  highlight.setAttribute("cy", fromCoord.y);
  highlight.setAttribute("r", radius);
  highlight.setAttribute("fill", primaryColor());
  highlight.setAttribute("fill-opacity", "0.18");
  highlight.setAttribute("stroke", primaryColor());
  highlight.setAttribute("stroke-opacity", "0.95");
  highlight.setAttribute("stroke-width", strokeWidth);

  arrowSvg.appendChild(highlight);
}

function getSquareCenter(square, squareSize, isFlipped, boardRect) {
  const file = square.charCodeAt(0) - "a".charCodeAt(0); // 0-7
  const rank = parseInt(square[1], 10); // 1-8

  if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;

  // In normal orientation, a1 is bottom-left.
  // In flipped orientation, a1 is top-right.
  let x, y;
  if (isFlipped) {
    x = (7 - file + 0.5) * squareSize;
    y = (rank - 1 + 0.5) * squareSize;
  } else {
    x = (file + 0.5) * squareSize;
    y = (8 - rank + 0.5) * squareSize;
  }

  return { x, y };
}

// ---------------------------------------------------------------------------
// Board change detection
// ---------------------------------------------------------------------------
let boardObserver = null;
let lastObservedBoard = null;
let spaCheckInterval = null;

function attachBoardObserver(board) {
  if (boardObserver) {
    boardObserver.disconnect();
    boardObserver = null;
  }
  lastObservedBoard = board;

  boardObserver = new MutationObserver(() => {
    // FEN comparison inside runAnalysis already filters no-op mutations -
    // never force a re-analysis here or every piece animation restarts the
    // engine on the same position.
    scheduleAnalysis(150);
  });

  const target = board.shadowRoot || board;
  boardObserver.observe(target, { childList: true, subtree: true, attributes: true });
}

function observeBoard() {
  if (spaCheckInterval) return; // already running

  spaCheckInterval = setInterval(() => {
    const currentBoard = getBoardElement();

    if (!currentBoard) {
      if (overlayContainer) {
        clearOverlay();
      }
      if (boardObserver) {
        boardObserver.disconnect();
        boardObserver = null;
        lastObservedBoard = null;
      }
      return;
    }

    if (currentBoard !== lastObservedBoard) {
      attachBoardObserver(currentBoard);
      lastAnalyzedFen = null;
      injectFenExtractor(); // inject bridge into page world to read internal API
      // A freshly mounted board needs one analysis kick; from here on the
      // bridge FEN events and the mutation observer drive it.
      if (config.enabled) scheduleAnalysis(400);
    }

    if (config.enabled) {
      updateOverlayPosition();
    }
  }, 500);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
function start() {
  // Randomized boot: engine and observer wake up after a non-fixed delay so
  // two launches never behave identically (timing differs per run).
  console.log("[Chess.com Best Move] boot delay", BOOT_DELAY_MS, "ms");
  setTimeout(() => {
    initStockfish();
    observeBoard();
  }, BOOT_DELAY_MS);
}

// Start immediately. On chess.com SPA, the board may appear after navigation.
// observeBoard() runs indefinitely and detects the board when it shows up.
start();
