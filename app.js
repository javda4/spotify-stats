// Spotify stream analytics dashboard. Reads the Supabase tables/views filled
// daily by the scrape-kworb edge function.
(() => {
  "use strict";

  const { supabaseUrl, supabaseKey, artistId } = window.APP_CONFIG;
  const MAX_COMPARE = 5;
  const GRAIN_NOUN = { day: "day", week: "week", month: "month", year: "year" };

  const state = {
    grain: "day",
    songs: [],            // song_latest rows
    artistSnaps: [],      // artist_snapshots rows, oldest first
    periodRows: new Map(),// track_id -> song_period_stats row for the current period
    selected: [],         // track_ids in the explorer, in color-slot order
    sort: { key: "rank_total", dir: 1 },
    charts: {},
  };

  // ---------- data ----------

  async function api(path) {
    const rows = [];
    const page = 1000;
    for (let from = 0; ; from += page) {
      const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          Range: `${from}-${from + page - 1}`,
        },
      });
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
      const batch = await res.json();
      rows.push(...batch);
      if (batch.length < page) return rows;
    }
  }

  const inList = (ids) => `in.(${ids.map((id) => `"${id}"`).join(",")})`;

  // ---------- formatting ----------

  const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat("en");
  const fmt = (n) => (n == null ? "–" : compact.format(n));
  const fmtFull = (n) => (n == null ? "–" : full.format(n));
  const pct = (a, b) => (a == null || b == null || b === 0 ? null : (100 * (a - b)) / b);
  const utc = (d) => new Date(`${d}T00:00:00Z`);

  function fmtDate(d, grain = "day") {
    const date = utc(d);
    const opts = { timeZone: "UTC" };
    if (grain === "year") return String(date.getUTCFullYear());
    if (grain === "month") return date.toLocaleDateString("en", { ...opts, month: "short", year: "numeric" });
    const s = date.toLocaleDateString("en", { ...opts, month: "short", day: "numeric" });
    return grain === "week" ? `Wk of ${s}` : s;
  }

  function periodStart(d, grain) {
    const date = utc(d);
    if (grain === "year") return `${date.getUTCFullYear()}-01-01`;
    if (grain === "month") return d.slice(0, 7) + "-01";
    if (grain === "week") {
      const dow = (date.getUTCDay() + 6) % 7; // Monday = 0, matching Postgres date_trunc('week')
      date.setUTCDate(date.getUTCDate() - dow);
      return date.toISOString().slice(0, 10);
    }
    return d;
  }

  function deltaEl(change, suffix) {
    const el = document.createElement("div");
    el.className = "delta";
    if (change == null) {
      el.textContent = suffix ? `No prior ${suffix} yet` : "";
      return el;
    }
    const up = change >= 0;
    const arrow = document.createElement("span");
    arrow.className = up ? "up" : "down";
    arrow.textContent = `${up ? "▲" : "▼"} ${Math.abs(change).toFixed(1)}%`;
    el.append(arrow, ` vs previous ${suffix}`);
    return el;
  }

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const seriesColor = (i) => css(`--series-${i + 1}`);

  // ---------- tooltip & crosshair ----------

  const tooltipEl = document.getElementById("tooltip");

  function externalTooltip({ chart, tooltip }) {
    if (!tooltip.opacity || !tooltip.dataPoints?.length) {
      tooltipEl.hidden = true;
      return;
    }
    tooltipEl.replaceChildren();
    const title = document.createElement("div");
    title.className = "t-title";
    title.textContent = tooltip.title.join(" ");
    tooltipEl.append(title);
    for (const p of tooltip.dataPoints) {
      const row = document.createElement("div");
      row.className = "t-row";
      const key = document.createElement("i");
      key.className = "line";
      key.style.background = p.dataset.backgroundColor instanceof Array
        ? p.dataset.backgroundColor[p.dataIndex]
        : p.dataset.borderColor || p.dataset.backgroundColor;
      const value = document.createElement("strong");
      value.textContent = p.dataset.formatValue ? p.dataset.formatValue(p.raw) : fmtFull(p.raw);
      const label = document.createElement("span");
      label.textContent = p.dataset.label;
      row.append(key, value, label);
      tooltipEl.append(row);
      if (p.dataset.hint) {
        const hint = document.createElement("div");
        hint.className = "t-title";
        hint.style.margin = "4px 0 0";
        hint.textContent = p.dataset.hint(p.dataIndex);
        tooltipEl.append(hint);
      }
    }
    tooltipEl.hidden = false;
    const rect = chart.canvas.getBoundingClientRect();
    const x = rect.left + tooltip.caretX + 14;
    const y = rect.top + tooltip.caretY - 10;
    const w = tooltipEl.offsetWidth;
    tooltipEl.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
    tooltipEl.style.top = `${Math.max(8, y)}px`;
  }

  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      if (chart.config.type !== "line") return;
      const active = chart.tooltip?.getActiveElements?.();
      if (!active?.length) return;
      const { ctx, chartArea } = chart;
      const x = active[0].element.x;
      ctx.save();
      ctx.strokeStyle = css("--baseline");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };
  Chart.register(crosshair);

  function baseOptions({ indexAxis = "x", stacked = false } = {}) {
    const grid = css("--grid");
    const muted = css("--text-muted");
    const valueAxis = {
      stacked,
      beginAtZero: true,
      grid: { color: grid, drawTicks: false },
      border: { display: false },
      ticks: { color: muted, callback: (v) => compact.format(v), padding: 8, maxTicksLimit: 6 },
    };
    const catAxis = {
      stacked,
      grid: { display: false },
      border: { color: css("--baseline") },
      ticks: { color: muted, autoSkip: true, maxRotation: 0 },
    };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis,
      interaction: { mode: indexAxis === "y" ? "nearest" : "index", intersect: indexAxis === "y", axis: indexAxis },
      plugins: { legend: { display: false }, tooltip: { enabled: false, external: externalTooltip } },
      scales: indexAxis === "y" ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
      font: { family: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
    };
  }

  function draw(id, config) {
    state.charts[id]?.destroy();
    Chart.defaults.font.family = "system-ui, -apple-system, 'Segoe UI', sans-serif";
    Chart.defaults.color = css("--text-muted");
    state.charts[id] = new Chart(document.getElementById(id), config);
  }

  function legend(el, items, kind) {
    el.replaceChildren();
    if (items.length < 2) return; // a single series is named by the chart title
    for (const { label, color } of items) {
      const key = document.createElement("span");
      key.className = "key";
      const mark = document.createElement("i");
      mark.className = kind;
      mark.style.background = color;
      const text = document.createElement("span");
      text.textContent = label;
      key.append(mark, text);
      el.append(key);
    }
  }

  const barStyle = (color) => ({
    backgroundColor: color,
    borderColor: css("--surface-1"),
    borderWidth: { top: 2 }, // surface gap between stacked segments
    borderRadius: 4,
    borderSkipped: "start",
    maxBarThickness: 24,
  });

  const lineStyle = (color, points) => ({
    borderColor: color,
    backgroundColor: color,
    borderWidth: 2,
    borderCapStyle: "round",
    borderJoinStyle: "round",
    tension: 0.2,
    pointRadius: points <= 1 ? 5 : 0,
    pointHoverRadius: 5,
    pointBorderColor: css("--surface-1"),
    pointBorderWidth: 2,
    spanGaps: true,
  });

  // ---------- overall performance ----------

  async function renderOverview() {
    const tiles = document.getElementById("tiles");
    const snaps = state.artistSnaps;
    const latest = snaps[snaps.length - 1];
    if (!latest) {
      tiles.textContent = "No data yet — the first scrape hasn't run.";
      return;
    }
    let current, previous, avgDaily, daysTracked;
    if (state.grain === "day") {
      current = latest.total_daily;
      previous = snaps.length > 1 ? snaps[snaps.length - 2].total_daily : null;
      avgDaily = current;
      daysTracked = snaps.length;
    } else {
      const rows = await api(
        `artist_period_stats?artist_id=eq.${artistId}&grain=eq.${state.grain}&order=period_start`,
      );
      const cur = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      current = cur?.streams;
      previous = prev?.streams ?? null;
      daysTracked = cur?.days_tracked;
      avgDaily = cur && current != null ? Math.round(current / cur.days_tracked) : null;
    }

    const noun = GRAIN_NOUN[state.grain];
    const tile = (label, value, delta, hero) => {
      const el = document.createElement("div");
      el.className = `tile${hero ? " hero" : ""}`;
      const l = document.createElement("div");
      l.className = "label";
      l.textContent = label;
      const v = document.createElement("div");
      v.className = "value";
      v.textContent = fmt(value);
      v.title = fmtFull(value);
      el.append(l, v);
      if (delta) el.append(delta);
      return el;
    };
    const periodLabel = state.grain === "day" ? "Latest daily streams" : `Streams this ${noun}`;
    const partial = state.grain !== "day" && daysTracked ? ` (${daysTracked} day${daysTracked > 1 ? "s" : ""} tracked)` : "";
    tiles.replaceChildren(
      tile(periodLabel + partial, current, deltaEl(pct(current, previous), noun), true),
      tile("All-time streams", latest.total_streams),
      tile(state.grain === "day" ? "Tracks" : "Average per day", state.grain === "day" ? latest.total_tracks : avgDaily),
      tile("Average per song", latest.total_tracks && current != null ? Math.round(current / latest.total_tracks) : null),
    );
  }

  // ---------- song filtering & current-period stats ----------

  async function loadPeriodRows() {
    state.periodRows.clear();
    if (state.grain === "day" || !state.songs.length) return;
    const start = periodStart(state.songs[0].snapshot_date, state.grain);
    const rows = await api(
      `song_period_stats?artist_id=eq.${artistId}&grain=eq.${state.grain}&period_start=eq.${start}` +
        `&select=track_id,streams,pct_change,days_tracked`,
    );
    for (const r of rows) state.periodRows.set(r.track_id, r);
  }

  function periodStats(song) {
    if (state.grain === "day") {
      return { streams: song.daily_streams, change: pct(song.daily_streams, song.daily_1d_ago) };
    }
    const r = state.periodRows.get(song.track_id);
    return { streams: r?.streams ?? null, change: r?.pct_change ?? null };
  }

  // ---------- table ----------

  function renderTable() {
    const noun = GRAIN_NOUN[state.grain];
    document.getElementById("period-col").textContent = state.grain === "day" ? "Latest day" : `This ${noun}`;
    const q = document.getElementById("table-search").value.trim().toLowerCase();
    const rows = state.songs
      .filter((s) => !q || s.title.toLowerCase().includes(q))
      .map((s) => ({ ...s, period_streams: periodStats(s).streams, change: periodStats(s).change }));
    const { key, dir } = state.sort;
    rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (typeof av === "string" ? av.localeCompare(bv) : av - bv) * dir;
    });

    const tbody = document.querySelector("#songs-table tbody");
    tbody.replaceChildren(
      ...rows.map((s) => {
        const tr = document.createElement("tr");
        tr.tabIndex = 0;
        tr.title = "Add to song explorer";
        const cell = (text, cls) => {
          const td = document.createElement("td");
          if (cls) td.className = cls;
          td.textContent = text;
          return td;
        };
        const title = document.createElement("td");
        const link = el("a", { textContent: s.title, href: `#/song/${s.track_id}`, className: "song-link", title: "Open song insights" });
        link.addEventListener("click", (e) => e.stopPropagation());
        title.append(link);
        const change = cell(s.change == null ? "–" : `${s.change >= 0 ? "▲" : "▼"} ${Math.abs(s.change).toFixed(1)}%`, "num");
        if (s.change != null) change.classList.add(s.change >= 0 ? "up" : "down");
        tr.append(
          cell(s.rank_total, "num"),
          title,
          cell(fmtFull(s.total_streams), "num"),
          cell(fmtFull(s.daily_streams), "num"),
          cell(fmtFull(s.period_streams), "num"),
          change,
        );
        const add = () => addSong(s.track_id);
        tr.addEventListener("click", add);
        tr.addEventListener("keydown", (e) => e.key === "Enter" && add());
        return tr;
      }),
    );
    document.querySelectorAll("#songs-table th").forEach((th) => {
      if (th.dataset.sort === key) th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
  }

  // ---------- share chart ----------

  /** Songs with daily streams, biggest first, and their share of the total. */
  function shareRanking() {
    const songs = state.songs.filter((s) => s.daily_streams != null)
      .sort((a, b) => b.daily_streams - a.daily_streams);
    const total = songs.reduce((sum, s) => sum + s.daily_streams, 0);
    return { songs, total, share: (s) => (total ? (100 * s.daily_streams) / total : 0) };
  }

  function renderShare() {
    const { songs, total } = shareRanking();
    const top = songs.slice(0, 10);
    const other = total - top.reduce((sum, s) => sum + s.daily_streams, 0);
    const labels = [...top.map((s) => s.title), `Other ${songs.length - top.length} songs`];
    const values = [...top.map((s) => s.daily_streams), other];
    const shares = values.map((v) => (total ? (100 * v) / total : 0));
    const colors = [...top.map(() => css("--series-1")), css("--other")];

    draw("share-chart", {
      type: "bar",
      data: {
        labels: labels.map((l) => (l.length > 38 ? l.slice(0, 36) + "…" : l)),
        datasets: [{
          label: "Share of daily streams",
          data: shares,
          ...barStyle(colors),
          borderWidth: 0,
          borderSkipped: "start",
          formatValue: (v) => `${v.toFixed(1)}%`,
          hint: (i) => (i < top.length ? "Click for song insights" : "Click to see every song's share"),
        }],
      },
      options: (() => {
        const o = baseOptions({ indexAxis: "y" });
        // Whole row is the hit target (label, bar and the air after it), not just the painted bar.
        o.interaction = { mode: "y", intersect: false, axis: "y" };
        o.onHover = (evt, els) => { evt.native.target.style.cursor = els.length ? "pointer" : "default"; };
        o.onClick = (evt, els) => {
          if (!els.length) return;
          const i = els[0].index;
          location.hash = i < top.length ? `#/song/${top[i].track_id}` : "#/share";
        };
        o.scales.x.ticks.callback = (v) => `${v}%`;
        o.scales.y.ticks.autoSkip = false;
        o.layout = { padding: { right: 48 } };
        return o;
      })(),
      plugins: [{
        id: "tipLabels",
        afterDatasetsDraw(chart) {
          const { ctx } = chart;
          ctx.save();
          ctx.fillStyle = css("--text-secondary");
          ctx.font = "12px system-ui, -apple-system, sans-serif";
          ctx.textBaseline = "middle";
          chart.getDatasetMeta(0).data.forEach((bar, i) => {
            ctx.fillText(`${shares[i].toFixed(1)}%`, bar.x + 6, bar.y);
          });
          ctx.restore();
        },
      }],
    });
  }

  // ---------- song explorer ----------

  function renderChips() {
    const chips = document.getElementById("chips");
    chips.replaceChildren(
      ...state.selected.map((id, i) => {
        const song = state.songs.find((s) => s.track_id === id);
        const chip = document.createElement("span");
        chip.className = "chip";
        const dot = document.createElement("i");
        dot.className = "dot";
        dot.style.background = seriesColor(i);
        const name = document.createElement("span");
        name.textContent = song?.title ?? id;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove ${song?.title ?? id}`);
        remove.addEventListener("click", () => {
          state.selected = state.selected.filter((t) => t !== id);
          renderExplorer();
        });
        chip.append(dot, name, remove);
        return chip;
      }),
    );
    const input = document.getElementById("song-search");
    input.disabled = state.selected.length >= MAX_COMPARE;
    input.placeholder = input.disabled ? `Up to ${MAX_COMPARE} songs` : "Add a song…";
  }

  function addSong(trackId) {
    if (state.selected.includes(trackId) || state.selected.length >= MAX_COMPARE) return;
    state.selected.push(trackId);
    renderExplorer();
    document.getElementById("explorer-h").scrollIntoView({ behavior: "smooth" });
  }

  async function renderExplorer() {
    renderChips();
    const ids = state.selected;
    const noun = GRAIN_NOUN[state.grain];
    const box = document.getElementById("explorer-chart").parentElement;
    box.classList.add("loading");

    let labels = [], byTrack = new Map();
    let peaks = new Map();
    if (ids.length) {
      const [series, yearly] = await Promise.all([
        state.grain === "day"
          ? api(`song_snapshots?track_id=${inList(ids)}&select=track_id,period_start:snapshot_date,streams:daily_streams&order=snapshot_date`)
          : api(`song_period_stats?grain=eq.${state.grain}&track_id=${inList(ids)}&select=track_id,period_start,streams&order=period_start`),
        api(`song_period_stats?grain=eq.year&track_id=${inList(ids)}&select=track_id,peak_daily,days_tracked`),
      ]);
      labels = [...new Set(series.map((r) => r.period_start))].sort();
      for (const id of ids) byTrack.set(id, new Map());
      for (const r of series) byTrack.get(r.track_id).set(r.period_start, r.streams);
      for (const r of yearly) {
        const p = peaks.get(r.track_id) ?? { peak: 0, days: 0 };
        peaks.set(r.track_id, { peak: Math.max(p.peak, r.peak_daily ?? 0), days: p.days + r.days_tracked });
      }
    }

    const songOf = (id) => state.songs.find((s) => s.track_id === id);
    document.getElementById("explorer-chart-title").textContent =
      ids.length === 1 ? `${songOf(ids[0])?.title} — streams per ${noun}` : `Streams per ${noun}`;
    legend(
      document.getElementById("explorer-legend"),
      ids.map((id, i) => ({ label: songOf(id)?.title ?? id, color: seriesColor(i) })),
      "line",
    );
    draw("explorer-chart", {
      type: "line",
      data: {
        labels: labels.map((d) => fmtDate(d, state.grain)),
        datasets: ids.map((id, i) => ({
          label: songOf(id)?.title ?? id,
          data: labels.map((d) => byTrack.get(id).get(d) ?? null),
          ...lineStyle(seriesColor(i), labels.length),
        })),
      },
      options: baseOptions(),
    });
    box.classList.remove("loading");

    const cards = document.getElementById("compare-cards");
    cards.replaceChildren(
      ...ids.map((id, i) => {
        const s = songOf(id);
        const ps = periodStats(s);
        const card = document.createElement("div");
        card.className = "card compare-card";
        const h = document.createElement("h4");
        const key = document.createElement("i");
        key.className = "line";
        key.style.background = seriesColor(i);
        const t = document.createElement("span");
        t.textContent = s.title;
        h.append(key, t);
        const dl = document.createElement("dl");
        const row = (label, value, cls) => {
          const dt = document.createElement("dt");
          dt.textContent = label;
          const dd = document.createElement("dd");
          dd.textContent = value;
          if (cls) dd.className = cls;
          dl.append(dt, dd);
        };
        row("All-time streams", fmtFull(s.total_streams));
        row("Latest daily", fmtFull(s.daily_streams));
        row("Daily rank", s.rank_daily ? `#${s.rank_daily}` : "–");
        row(state.grain === "day" ? "Change vs prior day" : `This ${noun}`,
          state.grain === "day"
            ? (ps.change == null ? "–" : `${ps.change >= 0 ? "+" : ""}${ps.change.toFixed(1)}%`)
            : fmtFull(ps.streams),
          ps.change == null ? "" : ps.change >= 0 ? "up" : "down");
        if (state.grain !== "day") {
          row(`vs previous ${noun}`, ps.change == null ? "–" : `${ps.change >= 0 ? "+" : ""}${Number(ps.change).toFixed(1)}%`,
            ps.change == null ? "" : ps.change >= 0 ? "up" : "down");
        }
        row("Last 7 days", fmtFull(s.streams_last_7d));
        row("Last 30 days", fmtFull(s.streams_last_30d));
        row("Best day tracked", fmtFull(peaks.get(id)?.peak || null));
        row("Days tracked", fmtFull(peaks.get(id)?.days ?? null));
        card.append(h, dl);
        return card;
      }),
    );
  }

  // ---------- daily summary ----------

  async function rpc(fn, params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}?${qs}`, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    });
    if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }

  const signed = (n) => `${n >= 0 ? "+" : "−"}${fmtFull(Math.abs(n))}`;
  const pctText = (p) => `${p >= 0 ? "up" : "down"} ${Math.abs(p).toFixed(1)}%`;

  function el(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children.filter((c) => c != null));
    return node;
  }

  function renderSummary(sum) {
    const c = sum.catalog ?? {};
    const date = sum.snapshot_date ? fmtDate(sum.snapshot_date) : "–";
    const vsPrev = pct(c.daily, c.prev_daily);
    const vs7 = pct(c.daily, c.avg_7d);

    let line = `On ${date}, the catalog drew ${fmtFull(c.daily)} streams`;
    const parts = [];
    if (vsPrev != null) parts.push(`${pctText(vsPrev)} vs the day before`);
    if (vs7 != null) parts.push(`${pctText(vs7)} vs the ${c.avg_7d_days}-day average`);
    line += parts.length ? ` — ${parts.join(" and ")}.` : ". Day-over-day comparisons start tomorrow.";
    document.getElementById("summary-headline").textContent = line;

    const tile = (label, value, deltaNode) =>
      el("div", { className: "tile" },
        el("div", { className: "label", textContent: label }),
        el("div", { className: "value", textContent: value }),
        deltaNode);
    const alerts = sum.alerts ?? { up: 0, down: 0 };
    document.getElementById("summary-tiles").replaceChildren(
      tile("Latest day's streams", fmt(c.daily), deltaEl(vsPrev, "day")),
      tile("7-day average", fmt(c.avg_7d),
        el("div", { className: "delta", textContent: vs7 == null ? "Needs 1+ prior day" : `Latest day is ${pctText(vs7)}` })),
      tile("All-time streams", fmt(c.total_streams)),
      tile("Trend alerts", `${alerts.up + alerts.down}`,
        el("div", { className: "delta" },
          el("span", { className: "up", textContent: `▲ ${alerts.up} up` }), "  ",
          el("span", { className: "down", textContent: `▼ ${alerts.down} down` }))),
    );

    const items = [];
    const item = (icon, cls, ...content) =>
      items.push(el("li", {}, el("span", { className: `ico ${cls}`, textContent: icon }), el("span", {}, ...content)));
    const songLink = (s) => {
      return el("a", { textContent: s.title, href: `#/song/${s.track_id}`, className: "song-link" });
    };

    if (sum.last_scrape?.status === "error") {
      item("!", "warn", el("span", { className: "warn", textContent: `Latest scrape failed: ${sum.last_scrape.error}` }));
    }
    if (sum.top_song) {
      item("★", "", "Top song: ", songLink(sum.top_song),
        el("span", { className: "sub", textContent: ` — ${fmtFull(sum.top_song.daily)} streams` }));
    }
    if (sum.biggest_gainer) {
      item("▲", "up", "Biggest gainer: ", songLink(sum.biggest_gainer),
        el("span", { className: "sub", textContent: ` ${signed(sum.biggest_gainer.change)} vs the day before (${pctText(pct(sum.biggest_gainer.daily, sum.biggest_gainer.prev_daily))})` }));
    }
    if (sum.biggest_drop) {
      item("▼", "down", "Biggest drop: ", songLink(sum.biggest_drop),
        el("span", { className: "sub", textContent: ` ${signed(sum.biggest_drop.change)} vs the day before (${pctText(pct(sum.biggest_drop.daily, sum.biggest_drop.prev_daily))})` }));
    }
    for (const m of (sum.milestones ?? []).slice(0, 3)) {
      item("◎", "", songLink(m),
        el("span", { className: "sub", textContent: ` is on pace to pass ${fmt(m.milestone)} streams in ~${m.days_left} day${m.days_left === 1 ? "" : "s"} (now ${fmtFull(m.total)})` }));
    }
    const fresh = sum.new_songs ?? [];
    if (fresh.length) {
      item("+", "", `${fresh.length} new song${fresh.length > 1 ? "s" : ""} appeared: `,
        ...fresh.slice(0, 3).flatMap((s, i) => [i ? ", " : "", songLink(s)]),
        fresh.length > 3 ? ` and ${fresh.length - 3} more` : "");
    }
    document.getElementById("summary-list").replaceChildren(...items);
  }

  // ---------- trend alerts ----------

  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { return []; } },
    set(key, v) { try { localStorage.setItem(key, JSON.stringify(v.slice(-500))); } catch { /* storage unavailable */ } },
  };

  function strength(z) {
    if (z == null) return "no prior variance";
    const a = Math.abs(z);
    return a >= 6 ? "extremely unusual" : a >= 3 ? "very unusual" : "unusual";
  }

  function alertCard(a, unread, linked = true) {
    const card = el("article", { className: `alert is-${a.direction} ${a.scope}` },
      el("div", { className: "a-head" },
        el("span", { className: "a-dir", textContent: `${a.direction === "up" ? "▲ Outperforming" : "▼ Underperforming"}` }),
        unread ? el("span", { className: "unread", textContent: "New" }) : null),
      el("div", { className: "a-subject", textContent: a.subject }),
      el("p", { className: "a-msg", textContent: `${a.direction === "up" ? "Up" : "Down"} ${Math.abs(a.pct_change).toFixed(1)}% vs its usual performance — ${strength(a.z_score)}.` }),
      el("dl", {},
        el("dt", { textContent: "Latest day" }), el("dt", { textContent: "Usual" }),
        el("dt", { textContent: "Difference" }), el("dt", { textContent: "Z-score" }),
        el("dd", { textContent: fmtFull(a.current_value) }),
        el("dd", { textContent: fmtFull(a.baseline_value), title: `${a.baseline_days}-day average` }),
        el("dd", { textContent: signed(a.current_value - a.baseline_value) }),
        el("dd", { textContent: a.z_score == null ? "–" : Number(a.z_score).toFixed(1) })));
    if (a.track_id && linked) card.addEventListener("click", () => { location.hash = `#/song/${a.track_id}`; });
    return card;
  }

  function renderAlerts(alerts) {
    const latestDate = state.artistSnaps[state.artistSnaps.length - 1]?.snapshot_date;
    const seen = new Set(store.get("seenAlerts"));
    const today = alerts.filter((a) => a.snapshot_date === latestDate);
    const earlier = alerts.filter((a) => a.snapshot_date !== latestDate);
    const list = document.getElementById("alert-list");

    if (today.length) {
      list.replaceChildren(...today.map((a) => alertCard(a, !seen.has(a.id))));
    } else {
      const days = state.artistSnaps.length;
      const msg = days < 8
        ? `Alerts start once there are 7 days of history to define "usual" (${days} so far).`
        : "Every song is streaming within its usual range today.";
      list.replaceChildren(el("div", { className: "empty", textContent: msg }));
    }

    const history = document.getElementById("alert-history");
    history.hidden = !earlier.length;
    const byDay = Map.groupBy ? Map.groupBy(earlier, (a) => a.snapshot_date)
      : earlier.reduce((m, a) => m.set(a.snapshot_date, [...(m.get(a.snapshot_date) ?? []), a]), new Map());
    document.getElementById("alert-history-list").replaceChildren(
      ...[...byDay].flatMap(([day, rows]) => [
        el("div", { className: "alert-day", textContent: fmtDate(day) }),
        ...rows.map((a) => alertCard(a, false)),
      ]),
    );

    const unseen = alerts.filter((a) => !seen.has(a.id));
    const badge = document.getElementById("bell-count");
    badge.hidden = !unseen.length;
    badge.textContent = unseen.length > 99 ? "99+" : String(unseen.length);
    document.getElementById("bell").onclick = () => {
      store.set("seenAlerts", [...seen, ...unseen.map((a) => a.id)]);
      badge.hidden = true;
      document.getElementById("alerts").scrollIntoView({ behavior: "smooth" });
    };

    notify(today);
  }

  // Browser notifications for alerts this browser hasn't been notified about yet.
  function notify(alerts) {
    const btn = document.getElementById("notify-btn");
    if (!("Notification" in window)) return;
    btn.hidden = Notification.permission !== "default";
    btn.onclick = async () => {
      await Notification.requestPermission();
      btn.hidden = Notification.permission !== "default";
      notify(alerts);
    };
    if (Notification.permission !== "granted") return;

    const notified = new Set(store.get("notifiedAlerts"));
    const fresh = alerts.filter((a) => !notified.has(a.id));
    if (!fresh.length) return;
    if (fresh.length <= 3) {
      for (const a of fresh) new Notification(`${a.subject} ${pctText(Number(a.pct_change))} vs usual`, { body: a.message, tag: `alert-${a.id}` });
    } else {
      const up = fresh.filter((a) => a.direction === "up").length;
      new Notification(`${fresh.length} trend alerts`, {
        body: `${up} outperforming, ${fresh.length - up} underperforming their usual trend. Biggest: ${fresh[0].message}`,
        tag: "alert-batch",
      });
    }
    store.set("notifiedAlerts", [...notified, ...fresh.map((a) => a.id)]);
  }

  async function loadSummaryAndAlerts() {
    const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const [summary, alerts] = await Promise.all([
      rpc("get_daily_summary", { p_artist: artistId }),
      api(`trend_alerts?artist_id=eq.${artistId}&snapshot_date=gte.${since}&order=snapshot_date.desc,pct_change.desc`),
    ]);
    // Biggest movers first within each day.
    alerts.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date) || Math.abs(b.pct_change) - Math.abs(a.pct_change));
    renderSummary(summary);
    renderAlerts(alerts);
  }

  // ---------- song insights page (#/song/<id>) ----------

  const songPage = { id: null, grain: "day", daily: [], periods: [] };
  const DAY_MS = 864e5;

  /** Latest day vs the previous ≤28 days — same rule as generate_trend_alerts. */
  function trendOf(daily) {
    const pts = daily.filter((d) => d.daily_streams != null);
    const cur = pts[pts.length - 1];
    if (!cur) return { status: "insufficient", days: 0 };
    const from = utc(cur.snapshot_date) - 28 * DAY_MS;
    const prior = pts.slice(0, -1).filter((d) => utc(d.snapshot_date) >= from).map((d) => d.daily_streams);
    if (prior.length < 7) return { status: "insufficient", days: prior.length, current: cur.daily_streams };
    const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
    const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / (prior.length - 1));
    const change = mean ? (100 * (cur.daily_streams - mean)) / mean : null;
    const z = sd ? (cur.daily_streams - mean) / sd : null;
    const flagged = change != null && Math.abs(change) >= 10 && (z == null || Math.abs(z) >= 2);
    return {
      status: flagged ? (change > 0 ? "up" : "down") : "normal",
      current: cur.daily_streams, usual: Math.round(mean), change, z, days: prior.length,
    };
  }

  function renderTrend(t) {
    const box = document.getElementById("song-trend");
    const label = {
      up: ["▲", "Outperforming its usual trend"],
      down: ["▼", "Underperforming its usual trend"],
      normal: ["●", "Within its usual range"],
      insufficient: ["…", "Not enough history yet"],
    }[t.status];
    const detail = t.status === "insufficient"
      ? `Trend comparison needs 7 days of history to define "usual" (${t.days} so far).`
      : `Latest day is ${pctText(t.change)} vs its ${t.days}-day average` +
        (t.z != null ? ` (z-score ${t.z.toFixed(1)}, ${strength(t.z)}).` : ".");
    const num = (k, v) => el("div", {}, el("span", { textContent: k }), el("b", { textContent: v }));
    box.replaceChildren(el("div", { className: "trend-card-body" },
      el("h3", { textContent: "Current trend" }),
      el("div", { className: `trend-status is-${t.status}` },
        el("span", { className: "ico", textContent: label[0] }), el("span", { textContent: label[1] })),
      el("div", { className: "trend-detail", textContent: detail }),
      t.status === "insufficient" ? null : el("div", { className: "trend-nums" },
        num("Latest day", fmtFull(t.current)),
        num(`Usual (${t.days}-day avg)`, fmtFull(t.usual)),
        num("Difference", signed(t.current - t.usual)),
        num("Change", `${t.change >= 0 ? "+" : "−"}${Math.abs(t.change).toFixed(1)}%`))));
  }

  function table(tableEl, headers, rows) {
    tableEl.replaceChildren(
      el("thead", {}, el("tr", {}, ...headers.map(([h, cls]) => el("th", { textContent: h, className: cls ?? "" })))),
      el("tbody", {}, ...rows.map((cells) =>
        el("tr", {}, ...cells.map((c, i) => {
          const td = el("td", { className: headers[i][1] ?? "" });
          if (c instanceof Node) td.append(c); else td.textContent = c ?? "–";
          return td;
        })))),
    );
  }

  function changeCell(change) {
    if (change == null) return "–";
    return el("span", { className: change >= 0 ? "up" : "down", textContent: `${change >= 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(1)}%` });
  }

  function renderGlance(song) {
    const d = songPage.daily.filter((x) => x.daily_streams != null);
    const last = d[d.length - 1], prev = d[d.length - 2];
    const rows = [["Day", last && fmtDate(last.snapshot_date), last?.daily_streams, prev?.daily_streams,
      pct(last?.daily_streams, prev?.daily_streams), last?.daily_streams, last?.daily_streams, `#${song.rank_daily}`, last ? 1 : 0]];
    for (const g of ["week", "month", "year"]) {
      const ps = songPage.periods.filter((p) => p.grain === g);
      const cur = ps[ps.length - 1], before = ps[ps.length - 2];
      rows.push([g[0].toUpperCase() + g.slice(1), cur && fmtDate(cur.period_start, g), cur?.streams, before?.streams,
        cur?.pct_change ?? null, cur?.avg_daily, cur?.peak_daily, cur?.period_rank ? `#${cur.period_rank}` : null, cur?.days_tracked]);
    }
    table(document.getElementById("song-glance"),
      [["Scale"], ["Current period"], ["Streams", "num"], ["Previous", "num"], ["Change", "num"],
        ["Avg / day", "num"], ["Best day", "num"], ["Rank", "num"], ["Days", "num"]],
      rows.map(([scale, label, cur, before, change, avg, peak, rank, days]) =>
        [scale, label ?? "No data yet", fmtFull(cur), fmtFull(before), changeCell(change), fmtFull(avg), fmtFull(peak), rank, days ?? "–"]));
  }

  function renderSongGrain() {
    const g = songPage.grain;
    document.querySelectorAll("#song-grain button").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.grain === g)));
    document.getElementById("song-chart-title").textContent = `Streams per ${GRAIN_NOUN[g]}`;
    const color = seriesColor(0);
    if (g === "day") {
      const d = songPage.daily;
      draw("song-chart", {
        type: "line",
        data: { labels: d.map((x) => fmtDate(x.snapshot_date)), datasets: [{ label: "Daily streams", data: d.map((x) => x.daily_streams), ...lineStyle(color, d.length) }] },
        options: baseOptions(),
      });
      const rows = [...d].reverse().map((x, i, arr) => [fmtDate(x.snapshot_date), fmtFull(x.daily_streams), fmtFull(x.total_streams),
        changeCell(pct(x.daily_streams, arr[i + 1]?.daily_streams))]);
      table(document.getElementById("song-periods"), [["Date"], ["Daily streams", "num"], ["Total streams", "num"], ["vs prior day", "num"]], rows);
      return;
    }
    const ps = songPage.periods.filter((p) => p.grain === g);
    draw("song-chart", {
      type: "bar",
      data: { labels: ps.map((p) => fmtDate(p.period_start, g)), datasets: [{ label: `Streams per ${g}`, data: ps.map((p) => p.streams), ...barStyle(color) }] },
      options: baseOptions(),
    });
    const rows = [...ps].reverse().map((p) => [fmtDate(p.period_start, g), fmtFull(p.streams), fmtFull(p.avg_daily), fmtFull(p.peak_daily),
      p.days_tracked, changeCell(p.pct_change), p.period_rank ? `#${p.period_rank}` : "–"]);
    table(document.getElementById("song-periods"),
      [[GRAIN_NOUN[g][0].toUpperCase() + GRAIN_NOUN[g].slice(1)], ["Streams", "num"], ["Avg / day", "num"], ["Best day", "num"],
        ["Days tracked", "num"], [`vs previous ${g}`, "num"], ["Rank", "num"]], rows);
  }

  async function renderSongPage(id) {
    const song = state.songs.find((s) => s.track_id === id);
    const title = document.getElementById("song-title");
    if (!song) { title.textContent = "Song not found"; return; }
    songPage.id = id;
    title.textContent = song.title;
    document.title = `${song.title} · Spotify Stats`;
    document.getElementById("song-meta").textContent =
      `#${song.rank_total} by total streams · tracked since ${fmtDate(song.first_seen)}`;
    document.getElementById("song-spotify").href = `https://open.spotify.com/track/${id}`;

    const { songs, share } = shareRanking();
    const shareRank = songs.findIndex((s) => s.track_id === id) + 1;
    const tile = (label, value, sub) => el("div", { className: "tile" },
      el("div", { className: "label", textContent: label }), el("div", { className: "value", textContent: value }), sub);
    document.getElementById("song-tiles").replaceChildren(
      tile("All-time streams", fmt(song.total_streams), el("div", { className: "delta", textContent: fmtFull(song.total_streams) })),
      tile("Latest daily streams", fmt(song.daily_streams), deltaEl(pct(song.daily_streams, song.daily_1d_ago), "day")),
      tile("Share of daily streams", song.daily_streams == null ? "–" : `${share(song).toFixed(2)}%`,
        el("div", { className: "delta", textContent: shareRank ? `#${shareRank} of ${songs.length} songs` : "" })),
      tile("Last 7 / 30 days", `${fmt(song.streams_last_7d)} / ${fmt(song.streams_last_30d)}`,
        el("div", { className: "delta", textContent: song.streams_last_7d == null ? "Fills in as history builds" : "streams gained" })),
    );

    const [daily, periods, alerts] = await Promise.all([
      api(`song_snapshots?track_id=eq.${id}&select=snapshot_date,total_streams,daily_streams&order=snapshot_date`),
      api(`song_period_stats?track_id=eq.${id}&order=period_start`),
      api(`trend_alerts?track_id=eq.${id}&order=snapshot_date.desc`),
    ]);
    if (songPage.id !== id) return; // navigated away meanwhile
    Object.assign(songPage, { daily, periods });
    renderTrend(trendOf(daily));
    renderGlance(song);
    renderSongGrain();
    document.getElementById("song-alerts").replaceChildren(...(alerts.length
      ? alerts.map((a) => alertCard(a, false, false))
      : [el("div", { className: "empty", textContent: "No trend alerts for this song yet." })]));
  }

  // ---------- all songs' share page (#/share) ----------

  function renderSharePage() {
    const { songs, total, share } = shareRanking();
    const includeTop = document.getElementById("share-include-top").checked;
    const q = document.getElementById("share-search").value.trim().toLowerCase();
    const others = songs.slice(10);
    const otherShare = others.reduce((a, s) => a + share(s), 0);
    document.title = "Share of daily streams · Spotify Stats";
    document.getElementById("share-sub").textContent = includeTop
      ? `All ${songs.length} songs with daily streams, ${fmtFull(total)} streams in total on the latest day.`
      : `The ${others.length} songs outside the top 10 add up to ${otherShare.toFixed(1)}% of the latest day's ${fmtFull(total)} streams. Click a song for its insights.`;

    const rows = songs.map((s, i) => ({ s, rank: i + 1 }))
      .filter(({ rank }) => includeTop || rank > 10)
      .filter(({ s }) => !q || s.title.toLowerCase().includes(q));
    const max = Math.max(...rows.map(({ s }) => share(s)), 0.0001);
    document.getElementById("share-list").replaceChildren(...rows.map(({ s, rank }) =>
      el("a", { className: "share-row", href: `#/song/${s.track_id}`, role: "listitem", title: `${s.title}: ${share(s).toFixed(2)}%` },
        el("span", { className: "rank", textContent: rank }),
        el("span", { className: "title", textContent: s.title }),
        el("span", { className: "track" }, el("div", { className: "bar", style: `width:${(100 * share(s)) / max}%` })),
        el("span", { className: "pct", textContent: `${share(s) < 0.01 ? "<0.01" : share(s).toFixed(2)}%` }),
        el("span", { className: "streams", textContent: fmtFull(s.daily_streams) }))));
  }

  // ---------- routing ----------

  let dashboardScroll = 0;
  let baseTitle = document.title;

  function route() {
    const hash = location.hash.replace(/^#\/?/, "");
    const [page, arg] = hash.split("/");
    const view = page === "song" && arg ? "song" : page === "share" ? "share" : "dashboard";
    const current = ["dashboard", "song", "share"].find((v) => !document.getElementById(`view-${v}`).hidden);
    if (current === "dashboard" && view !== "dashboard") dashboardScroll = window.scrollY;
    for (const v of ["dashboard", "song", "share"]) document.getElementById(`view-${v}`).hidden = v !== view;
    tooltipEl.hidden = true;

    if (view === "song") { renderSongPage(arg).catch(showError); window.scrollTo(0, 0); }
    else if (view === "share") { renderSharePage(); window.scrollTo(0, 0); }
    else { document.title = baseTitle; window.scrollTo(0, dashboardScroll); }
  }

  // ---------- wiring ----------

  async function renderAll() {
    document.body.classList.add("loading");
    try {
      await loadPeriodRows();
      await Promise.all([renderOverview(), renderExplorer()]);
      renderShare();
      renderTable();
    } catch (e) {
      showError(e);
    } finally {
      document.body.classList.remove("loading");
    }
  }

  function showError(e) {
    console.error(e);
    const n = document.getElementById("history-notice");
    n.hidden = false;
    n.textContent = `Couldn't load data: ${e.message}`;
  }

  function bindControls() {
    document.querySelectorAll("#grain button").forEach((btn) =>
      btn.addEventListener("click", () => {
        state.grain = btn.dataset.grain;
        document.querySelectorAll("#grain button").forEach((b) =>
          b.setAttribute("aria-checked", String(b === btn)),
        );
        renderAll();
      }),
    );
    document.getElementById("table-search").addEventListener("input", renderTable);
    document.querySelectorAll("#songs-table th").forEach((th) =>
      th.addEventListener("click", () => {
        const key = th.dataset.sort;
        state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === "title" || key === "rank_total" ? 1 : -1 };
        renderTable();
      }),
    );
    const search = document.getElementById("song-search");
    search.addEventListener("change", () => {
      const song = state.songs.find((s) => s.title === search.value);
      if (song) addSong(song.track_id);
      search.value = "";
    });
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { renderAll(); route(); });
    document.querySelectorAll("#song-grain button").forEach((btn) =>
      btn.addEventListener("click", () => { songPage.grain = btn.dataset.grain; renderSongGrain(); }));
    document.getElementById("share-search").addEventListener("input", renderSharePage);
    document.getElementById("share-include-top").addEventListener("change", renderSharePage);
    window.addEventListener("hashchange", route);
  }

  async function init() {
    bindControls();
    try {
      const [artists, songs, snaps] = await Promise.all([
        api(`artists?id=eq.${artistId}&select=name`),
        api(`song_latest?artist_id=eq.${artistId}&order=rank_total`),
        api(`artist_snapshots?artist_id=eq.${artistId}&order=snapshot_date`),
      ]);
      state.songs = songs;
      state.artistSnaps = snaps;

      const name = artists[0]?.name ?? "Artist";
      document.getElementById("artist-name").textContent = `${name} — Spotify streams`;
      document.title = baseTitle = `${name} Spotify Stats`;
      route(); // deep links (#/song/…, #/share) work once songs are loaded
      const first = snaps[0]?.snapshot_date;
      const last = snaps[snaps.length - 1]?.snapshot_date;
      document.getElementById("freshness").textContent = last
        ? `kworb data as of ${fmtDate(last)}, ${utc(last).getUTCFullYear()} · ${songs.length} songs · tracking since ${fmtDate(first)} (${snaps.length} day${snaps.length > 1 ? "s" : ""})`
        : "No data yet";
      if (snaps.length && snaps.length < 30) {
        const n = document.getElementById("history-notice");
        n.hidden = false;
        n.textContent =
          `History started on ${fmtDate(first)}. kworb only publishes current totals, so this dashboard ` +
          `builds its history one day at a time. Weekly comparisons fill in after 7 days and monthly ones after about 30.`;
      }

      const options = document.getElementById("song-options");
      options.replaceChildren(...songs.map((s) => Object.assign(document.createElement("option"), { value: s.title })));
      state.selected = [...songs]
        .filter((s) => s.daily_streams != null)
        .sort((a, b) => b.daily_streams - a.daily_streams)
        .slice(0, 3)
        .map((s) => s.track_id);
      await Promise.all([renderAll(), loadSummaryAndAlerts().catch(showError)]);
    } catch (e) {
      showError(e);
    }
  }

  init();
})();
