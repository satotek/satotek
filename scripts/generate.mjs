// Generates the profile cards under assets/ from public GitHub data.
// Runs daily in .github/workflows/cards.yml; no dependencies beyond Node 22+.
import { mkdir, writeFile } from "node:fs/promises";

const USER = "satotek";
const DOTFILES = "dotfiles";
const TZ_OFFSET_HOURS = 9; // JST has no DST, so a fixed offset is exact.
const OUT = new URL("../assets/", import.meta.url);

// Static rows of the fetch card. Counts are filled in from the dotfiles repo.
const PROFILE = {
  host: "satotek@kitakyushu",
  os: "macOS · Linux (nix-darwin / home-manager)",
  shell: "zsh",
  editor: "Neovim",
  terminal: "Ghostty",
  work: "TypeScript · React · Azure · Terraform",
  hobby: "Swift · Kotlin",
  learning: "Rust",
};

// Colors are pinned per language, not per rank, so a reshuffle in the ranking
// never repaints a language. The set was checked for color-vision separation on
// both GitHub surfaces. A language without an entry falls into "Other".
const LANG_COLORS = {
  dark: { Swift: "#d95926", Kotlin: "#9085e9", CSS: "#d55181", TypeScript: "#3987e5", Rust: "#c98500", Nix: "#199e70", Other: "#6e7681" },
  light: { Swift: "#eb6834", Kotlin: "#6250d6", CSS: "#e87ba4", TypeScript: "#2a78d6", Rust: "#eda100", Nix: "#1baf7a", Other: "#8c959f" },
};
const MAX_LANGS = 6;

// The hour chart is a single series; it gets a hue no language uses so it does
// not read as "commits in Kotlin" or similar.
const THEMES = {
  dark: { fg: "#e6edf3", sub: "#9198a1", mute: "#6e7681", track: "#21262d", line: "#30363d", win: "#161b22", accent: "#3fb950", accentDim: "#1f5f2b" },
  light: { fg: "#1f2328", sub: "#59636e", mute: "#818b98", track: "#eff2f5", line: "#d1d9e0", win: "#f6f8fa", accent: "#1a7f37", accentDim: "#aceebb" },
};

const MONO = "ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace";
const W = 720;

// ---------- GitHub API ----------

const token = process.env.GITHUB_TOKEN;
async function gh(path) {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": `${USER}-profile-cards`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  // An empty repository answers 409 on /commits; treat it as no data.
  if (res.status === 409) return [];
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${path}`);
  return res.json();
}

async function ghAll(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await gh(`${path}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

async function publicRepos() {
  const repos = await ghAll(`users/${USER}/repos?type=owner`);
  return repos.filter((r) => !r.fork && !r.archived && !r.private);
}

async function languageBytes(repos) {
  const totals = {};
  for (const r of repos) {
    const langs = await gh(`repos/${r.full_name}/languages`);
    for (const [name, bytes] of Object.entries(langs)) totals[name] = (totals[name] ?? 0) + bytes;
  }
  const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const shown = ranked.filter(([name]) => name in LANG_COLORS.dark && name !== "Other").slice(0, MAX_LANGS);
  const shownNames = new Set(shown.map(([n]) => n));
  const other = ranked.filter(([n]) => !shownNames.has(n)).reduce((s, [, v]) => s + v, 0);
  return { rows: other > 0 ? [...shown, ["Other", other]] : shown, repoCount: repos.length };
}

async function commitHours(repos) {
  const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString();
  const hours = Array(24).fill(0);
  for (const r of repos) {
    const commits = await ghAll(`repos/${r.full_name}/commits?author=${USER}&since=${since}`);
    for (const c of commits) {
      const d = new Date(c.commit.author.date);
      hours[(d.getUTCHours() + TZ_OFFSET_HOURS) % 24]++;
    }
  }
  return hours;
}

async function dotfilesStats() {
  const lock = await gh(`repos/${USER}/${DOTFILES}/contents/flake.lock`);
  const parsed = JSON.parse(Buffer.from(lock.content, "base64").toString());
  // Count only the flake's own inputs; transitive nodes would inflate the number.
  const inputs = Object.keys(parsed.nodes[parsed.root].inputs ?? {}).length;
  const repo = await gh(`repos/${USER}/${DOTFILES}`);
  const tree = await gh(`repos/${USER}/${DOTFILES}/git/trees/${repo.default_branch}?recursive=1`);
  const hosts = tree.tree.filter((t) => t.type === "blob" && /^nix\/hosts\/.+\.nix$/.test(t.path)).length;
  return { inputs, hosts };
}

// ---------- SVG ----------

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function frame(t, height, cmd, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${MONO}" font-size="13">
<rect x="0.5" y="0.5" width="${W - 1}" height="${height - 1}" rx="10" fill="${t.win}" stroke="${t.line}"/>
<path d="M0.5 36 H${W - 0.5}" stroke="${t.line}"/>
<circle cx="22" cy="18" r="6" fill="${t.line}"/><circle cx="42" cy="18" r="6" fill="${t.line}"/><circle cx="62" cy="18" r="6" fill="${t.line}"/>
<text x="${W / 2}" y="22" text-anchor="middle" font-size="12" fill="${t.mute}">${USER} — zsh</text>
<text x="24" y="62" fill="${t.sub}"><tspan fill="${t.accent}">❯</tspan> ${esc(cmd)}</text>
${body}
</svg>
`;
}

function fetchCard(mode, stats) {
  const t = THEMES[mode];
  // Drawn as rects rather than block characters, whose width and height vary
  // with whatever monospace font the viewer happens to have.
  const art = ["11111 11111", "10000 00100", "11111 00100", "00001 00100", "11111 00100"];
  const cell = 15;
  let s = "";
  art.forEach((line, row) => [...line].forEach((bit, col) => {
    if (bit === "1") s += `<rect x="${32 + col * cell}" y="${90 + row * cell}" width="${cell - 2}" height="${cell - 2}" rx="2" fill="${t.accent}"/>`;
  }));
  const rows = [
    [null, PROFILE.host, true],
    [null, "─".repeat(PROFILE.host.length), false],
    ["OS", PROFILE.os],
    ["Shell", PROFILE.shell],
    ["Editor", PROFILE.editor],
    ["Terminal", PROFILE.terminal],
    ["Nix", `${stats.inputs} flake inputs · ${stats.hosts} hosts`],
    ["Work", PROFILE.work],
    ["Hobby", PROFILE.hobby],
    ["Learning", PROFILE.learning],
  ];
  rows.forEach(([key, value, bold], i) => {
    const y = 92 + i * 22;
    s += key
      ? `\n<text x="230" y="${y}"><tspan fill="${t.accent}" font-weight="600">${key}</tspan><tspan fill="${t.mute}">:</tspan></text><text x="330" y="${y}" fill="${t.fg}">${esc(value)}</text>`
      : `\n<text x="230" y="${y}" fill="${bold ? t.fg : t.mute}" font-weight="${bold ? 700 : 400}">${esc(value)}</text>`;
  });
  const swatchY = 92 + rows.length * 22 - 4;
  Object.values(LANG_COLORS[mode]).forEach((c, i) => {
    s += `\n<rect x="${230 + i * 30}" y="${swatchY}" width="26" height="14" rx="2" fill="${c}"/>`;
  });
  return frame(t, swatchY + 40, "fastfetch", s);
}

function langCard(mode, { rows, repoCount }) {
  const t = THEMES[mode];
  const colors = LANG_COLORS[mode];
  const total = rows.reduce((s, [, v]) => s + v, 0);
  const max = Math.max(...rows.map(([, v]) => v));
  const pct = (v) => `${((v / total) * 100).toFixed(1)}%`;
  const size = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${Math.round(v / 1e3)} KB`);
  const top = 96;
  const rowH = 26;
  let s = "";
  rows.forEach(([name, v], i) => {
    const y = top + i * rowH;
    const bw = Math.max((300 * v) / max, 4);
    s += `\n<text x="40" y="${y}" fill="${t.fg}">${esc(name)}</text>`
      + `\n<rect x="160" y="${y - 10}" width="300" height="10" rx="2" fill="${t.track}"/>`
      + `\n<rect x="160" y="${y - 10}" width="${bw.toFixed(1)}" height="10" rx="2" fill="${colors[name]}"/>`
      + `\n<text x="560" y="${y}" text-anchor="end" fill="${t.fg}">${pct(v)}</text>`
      + `\n<text x="680" y="${y}" text-anchor="end" fill="${t.sub}">${size(v)}</text>`;
  });
  const footY = top + rows.length * rowH + 18;
  s += `\n<text x="24" y="${footY}" font-size="12" fill="${t.mute}">${size(total)} across ${repoCount} public repos · by bytes</text>`;
  return frame(t, footY + 24, "linguist --public --by bytes", s);
}

// Finds the contiguous 6-hour window (wrapping past midnight) with the most commits.
function busiestWindow(hours, span = 6) {
  let best = { start: 0, sum: -1 };
  for (let start = 0; start < 24; start++) {
    let sum = 0;
    for (let k = 0; k < span; k++) sum += hours[(start + k) % 24];
    if (sum > best.sum) best = { start, sum };
  }
  return { ...best, end: (best.start + span) % 24 };
}

function hourCard(mode, hours) {
  const t = THEMES[mode];
  const total = hours.reduce((a, b) => a + b, 0);
  const max = Math.max(...hours, 1);
  const peak = hours.indexOf(max);
  const win = busiestWindow(hours);
  const inWindow = (h) => (h - win.start + 24) % 24 < 6;
  const x0 = 40;
  const bw = 24;
  const gap = 2;
  const base = 200;
  const ph = 110;
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  let s = `<path d="M${x0} ${base + 0.5} H${x0 + 24 * (bw + gap) - gap}" stroke="${t.line}"/>`;
  hours.forEach((v, h) => {
    const x = x0 + h * (bw + gap);
    const bh = Math.max((ph * v) / max, 2);
    const r = Math.min(3, bh / 2);
    s += `\n<path d="M${x} ${base} V${(base - bh + r).toFixed(1)} q0 -${r} ${r} -${r} h${bw - 2 * r} q${r} 0 ${r} ${r} V${base} Z" fill="${inWindow(h) ? t.accent : t.accentDim}"/>`;
    if (h % 3 === 0) s += `\n<text x="${x + bw / 2}" y="${base + 18}" text-anchor="middle" font-size="11" fill="${t.mute}">${String(h).padStart(2, "0")}</text>`;
  });
  const px = x0 + peak * (bw + gap) + bw / 2;
  const anchor = peak > 18 ? "end" : peak < 4 ? "start" : "middle";
  s += `\n<text x="${px}" y="${base - ph - 8}" text-anchor="${anchor}" font-size="12" fill="${t.fg}">${hh(peak)} peak · ${max}</text>`;
  const share = total ? Math.round((win.sum / total) * 100) : 0;
  s += `\n<text x="24" y="${base + 44}" fill="${t.sub}"><tspan fill="${t.fg}">${share}%</tspan> of ${total} commits land between ${hh(win.start)} and ${hh(win.end)} JST</text>`;
  return frame(t, base + 70, "commits --by-hour --tz Asia/Tokyo --since 1y", s);
}

// ---------- main ----------

const repos = await publicRepos();
const [langs, hours, stats] = await Promise.all([languageBytes(repos), commitHours(repos), dotfilesStats()]);

await mkdir(OUT, { recursive: true });
for (const mode of ["dark", "light"]) {
  await writeFile(new URL(`fetch-${mode}.svg`, OUT), fetchCard(mode, stats));
  await writeFile(new URL(`languages-${mode}.svg`, OUT), langCard(mode, langs));
  await writeFile(new URL(`hours-${mode}.svg`, OUT), hourCard(mode, hours));
}
console.log(JSON.stringify({ repos: repos.length, langs: langs.rows, hours, stats }));
