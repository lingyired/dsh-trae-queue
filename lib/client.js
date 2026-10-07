/**
 * dsh-trae-queue — Client half.
 *
 * Ships as the loader's lazy-CJS factory artifact (hand-written: this package is
 * outside the dsh repository and has no toolchain). Registers one settings
 * section that polls the Host's `/api/trae/queue` projection, plus a
 * sidebar-foot indicator that appears **only while a request is really sitting
 * in Trae's upstream queue**.
 *
 * Only `react` is required from the module table; no other plugin's values are
 * imported, which the client bundle-purity gate requires.
 *
 * Copy is Chinese-only on purpose: this seat is read by one operator, and a
 * second locale table would be a promise this file does not keep.
 */
window.__ModuleLoader__.load({
  id: "dsh-trae-queue",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** Nav position: directly after the CLIProxyAPI status section (152). */
    const SECTION_ORDER = 153;
    const SECTION_ID = "trae-queue";
    /** Sidebar-foot seat, next to Settings. */
    const FOOTER_ORDER = 41;
    const FOOTER_ID = "trae-queue";
    const STATUS_PATH = "api/trae/queue";
    /** Matches the Host's 5s projection cache: polling faster only re-reads it. */
    const POLL_MS = 5000;
    const FETCH_TIMEOUT_MS = 15000;
    /** How many finished episodes the history table renders. */
    const RECENT_LIMIT = 5;

    const zh = {
      "section.title": "Trae · 排队",
      "action.refresh": "刷新",
      "action.refreshing": "刷新中…",
      "meta.fetched": "更新于 {time}",
      "meta.never": "尚未获取",
      "meta.now": "上游时间 {time}",
      "active.title": "排队中",
      "active.none": "当前没有请求排在 Trae 的队列里。",
      "active.noneHint": "一旦有请求进入上游排队，这里会立刻出现，sidebar 底部也会同时出现指示器。",
      "active.position": "第 {position} 位",
      "active.positionUnknown": "位次未知",
      "active.waited": "已等 {time}",
      "active.range": "位置区间 {min}–{max}",
      "active.updated": "{time}前上游更新",
      "active.count": "共 {count} 个请求在排队",
      "phase.queued": "排队中",
      "phase.processing": "处理中",
      "recent.title": "最近结束",
      "recent.none": "还没有结束的排队记录。",
      "recent.total": "共 {count} 条，显示最新 {shown} 条",
      "recent.outcome": "结果",
      "recent.account": "账号",
      "recent.best": "最高排到",
      "recent.waited": "等待",
      "recent.finished": "结束于",
      "recent.bestValue": "{position} 位",
      "outcome.started": "已开始回答",
      "outcome.error": "出错",
      "outcome.canceled": "已取消",
      "footer.action": "Trae 排队",
      "footer.note": "仅在有请求排队时出现",
      "footer.title": "{nickname} 正在排队：{summary}",
      "footer.summaryUnknown": "位次未知，{time}",
      "footer.summary": "第 {position} 位，已等 {time}",
      "footer.more": "共 {count} 个",
      "state.loading": "读取中…",
      "state.error": "读取失败：{error}",
      "state.unreachable": "无法读取 Trae 排队状态（{baseUrl}）：{error}",
    };

    /** Copy lookup with `{name}` placeholders. */
    function t(key, params) {
      let text = zh[key] ?? key;
      if (params !== undefined) {
        for (const name of Object.keys(params)) text = text.split("{" + name + "}").join(String(params[name]));
      }
      return text;
    }

    /** Short local clock for timestamps the Host sends as ISO strings. */
    function clock(value) {
      if (typeof value !== "string" || value === "") return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return value;
      const pad = (n) => String(n).padStart(2, "0");
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /** Short local clock for the Unix-millisecond stamps on finished episodes. */
    function clockMs(value) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return "—";
      const pad = (n) => String(n).padStart(2, "0");
      return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
    }

    /**
     * A duration in the words a person says out loud: "8 秒", "2 分 5 秒",
     * "1 小时 3 分".
     *
     * Milliseconds arrive as elapsed time (queued_ms, waited_ms) and as
     * time-since (updated_ms); both are the same kind of number here, so one
     * formatter covers them and the two never drift apart in wording. A missing
     * number renders as "—" rather than "NaN 秒", because a first SSE event
     * legitimately carries no timing yet.
     */
    function humanMs(ms) {
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
      const total = Math.round(ms / 1000);
      if (total < 60) return total + " 秒";
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      if (minutes < 60) return seconds === 0 ? minutes + " 分" : minutes + " 分 " + seconds + " 秒";
      const hours = Math.floor(minutes / 60);
      const rest = minutes % 60;
      return rest === 0 ? hours + " 小时" : hours + " 小时 " + rest + " 分";
    }

    /** A queue phase in words; an unexpected value is shown raw, never hidden. */
    function phaseLabel(phase) {
      if (phase === "queued") return t("phase.queued");
      if (phase === "processing") return t("phase.processing");
      return typeof phase === "string" && phase !== "" ? phase : undefined;
    }

    /** How one finished episode ended. */
    function outcomeLabel(outcome) {
      if (outcome === "started") return t("outcome.started");
      if (outcome === "error") return t("outcome.error");
      if (outcome === "canceled") return t("outcome.canceled");
      return typeof outcome === "string" && outcome !== "" ? outcome : "—";
    }

    /** True for the outcomes that did NOT end in an answer, so they can shout. */
    function failedOutcome(outcome) {
      return outcome === "error" || outcome === "canceled";
    }

    const muted = { opacity: 0.65 };
    const styles = {
      section: { display: "flex", flexDirection: "column", gap: "16px", color: "inherit" },
      header: { display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "12px" },
      title: { fontSize: "15px", fontWeight: 600, margin: 0 },
      meta: { fontSize: "12px", opacity: 0.65, display: "flex", gap: "10px", flexWrap: "wrap" },
      button: {
        appearance: "none", color: "inherit", font: "inherit", cursor: "pointer", fontSize: "12px",
        background: "transparent", border: "1px solid color-mix(in srgb, currentColor 30%, transparent)",
        borderRadius: "8px", padding: "4px 12px",
      },
      card: {
        border: "1px solid color-mix(in srgb, currentColor 14%, transparent)", borderRadius: "12px",
        padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px",
      },
      cardTitle: { fontSize: "12px", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", opacity: 0.6 },
      row: { display: "flex", gap: "10px", flexWrap: "wrap", fontSize: "13px", alignItems: "baseline" },
      kv: { display: "flex", gap: "6px", alignItems: "baseline" },
      // One waiting request: a hairline-separated block rather than a nested
      // card, so a queue of five reads as one list instead of five boxes.
      activeRow: {
        display: "flex", flexDirection: "column", gap: "4px", padding: "8px 0",
        borderTop: "1px solid color-mix(in srgb, currentColor 8%, transparent)",
      },
      // The position is the number this whole panel exists for, so it is the
      // one thing rendered larger than body text.
      position: { fontSize: "15px", fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
      message: {
        fontSize: "12px", opacity: 0.8, whiteSpace: "pre-wrap", wordBreak: "break-word",
        borderLeft: "2px solid color-mix(in srgb, currentColor 22%, transparent)", paddingLeft: "8px",
      },
      table: { width: "100%", borderCollapse: "collapse", fontSize: "13px" },
      th: {
        textAlign: "left", fontWeight: 600, fontSize: "11px", opacity: 0.6, padding: "4px 6px",
        borderBottom: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
      },
      td: { padding: "5px 6px", borderBottom: "1px solid color-mix(in srgb, currentColor 8%, transparent)", verticalAlign: "top" },
      num: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
      badge: {
        display: "inline-block", fontSize: "10px", fontWeight: 600, padding: "1px 7px", borderRadius: "999px",
        border: "1px solid color-mix(in srgb, currentColor 30%, transparent)", opacity: 0.85, whiteSpace: "nowrap",
      },
      warnBadge: {
        display: "inline-block", fontSize: "10px", fontWeight: 600, padding: "1px 7px", borderRadius: "999px",
        border: "1px solid color-mix(in srgb, #d97706 60%, transparent)", color: "#d97706", whiteSpace: "nowrap",
      },
      banner: {
        borderRadius: "8px", padding: "8px 12px", fontSize: "12px",
        background: "color-mix(in srgb, #dc2626 16%, transparent)",
      },
      empty: { fontSize: "13px", opacity: 0.6 },
      hint: { fontSize: "11px", opacity: 0.45 },
      // Sidebar-foot indicator. Same restraint as the sibling CLIProxyAPI seat:
      // mostly typography on a transparent background, inheriting the host's
      // tokens so it tracks the active theme. It renders NOTHING when the queue
      // is empty, so it never holds a seat open for "空闲".
      footWide: {
        appearance: "none", font: "inherit", cursor: "default", textAlign: "left",
        display: "flex", alignItems: "center", gap: "6px", width: "100%", minWidth: 0,
        padding: "6px 8px", borderRadius: "6px", fontSize: "12px", lineHeight: "16px",
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "transparent", border: "1px solid transparent",
      },
      // The 56px rail has ~36px of usable width: the glyph pair is all that fits,
      // and the full sentence lives in the tooltip.
      footRail: {
        appearance: "none", font: "inherit", cursor: "default", textAlign: "center",
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
        gap: "1px", width: "auto", padding: "2px 4px", borderRadius: "6px",
        fontSize: "10px", lineHeight: "11px", fontWeight: 600,
        color: "var(--dsw-alias-label-primary, inherit)",
        background: "transparent", border: "1px solid transparent",
      },
      footText: { fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
      footCount: { opacity: 0.5, whiteSpace: "nowrap", fontSize: "11px" },
      footNum: { fontVariantNumeric: "tabular-nums", fontWeight: 700 },
    };

    /** One fetch of the Host projection. */
    async function fetchStatus() {
      const response = await fetch(STATUS_PATH, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(STATUS_PATH + " answered " + response.status);
      return await response.json();
    }

    /** The still-waiting rows, closest to the front first (the Host sorted them). */
    function activeRows(status) {
      return status !== null && status !== undefined && Array.isArray(status.active) ? status.active : [];
    }

    /**
     * The finished rows to render. The Host already slices them; the local slice
     * is the fallback for a Host build that predates `recentShown`, so an older
     * Host cannot make this table render an unbounded list.
     */
    function recentRows(status) {
      if (status === null || status === undefined) return [];
      if (Array.isArray(status.recentShown)) return status.recentShown;
      if (!Array.isArray(status.recent)) return [];
      return status.recent.slice(0, RECENT_LIMIT);
    }

    /**
     * Poll the Host projection on an interval.
     *
     * Shared by the settings section and the sidebar-foot indicator: whichever
     * mounts first starts the interval, and each consumer keeps its own copy of
     * the document.
     *
     * @returns `[document, error, reload]` — the latest document (undefined
     *   until the first answer), the last transport error, and a manual reload.
     */
    function useStatusPoll() {
      const [status, setStatus] = react.useState(undefined);
      const [error, setError] = react.useState(undefined);

      const load = react.useCallback(async () => {
        try {
          setStatus(await fetchStatus())
          setError(undefined)
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        }
      }, []);

      react.useEffect(() => {
        let live = true
        const tick = () => { if (live) void load() }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { live = false; clearInterval(timer) }
      }, [load]);

      return [status, error, load]
    }

    /**
     * One waiting request.
     *
     * The upstream's own sentence is rendered verbatim underneath, because it is
     * the only place the exact wording ("Your queue position is 537") appears,
     * and an operator comparing this panel with a Trae log needs the original.
     */
    function ActiveRow(props) {
      const entry = props.entry
      const phase = phaseLabel(entry.phase)
      const range = entry.minPosition === undefined || entry.maxPosition === undefined
        ? undefined
        : t("active.range", { min: entry.minPosition, max: entry.maxPosition })
      const updated = entry.updatedMs === undefined ? undefined : t("active.updated", { time: humanMs(entry.updatedMs) })
      const account = [entry.nickname, entry.variant, entry.model].filter((part) => typeof part === "string" && part !== "").join(" · ")
      return h("div", { style: styles.activeRow },
        h("div", { style: styles.row },
          phase === undefined ? null : h("span", { style: styles.badge }, phase),
          h("span", { style: styles.position }, entry.position === undefined
            ? t("active.positionUnknown")
            : t("active.position", { position: entry.position })),
          h("span", null, account),
          h("span", { style: { ...muted, ...styles.num } }, t("active.waited", { time: humanMs(entry.queuedMs) })),
        ),
        entry.message === undefined ? null : h("div", { style: styles.message }, entry.message),
        range === undefined && updated === undefined ? null : h("div", { style: { ...muted, fontSize: "11px" } },
          [range, updated].filter((part) => part !== undefined).join(" · "),
        ),
      )
    }

    /** The finished queue episodes, newest first. */
    function RecentTable(props) {
      const rows = props.rows
      if (rows.length === 0) return h("div", { style: styles.empty }, t("recent.none"));
      const head = h("tr", null,
        h("th", { style: styles.th }, t("recent.outcome")),
        h("th", { style: styles.th }, t("recent.account")),
        h("th", { style: styles.th }, t("recent.best")),
        h("th", { style: styles.th }, t("recent.waited")),
        h("th", { style: styles.th }, t("recent.finished")),
      );
      const body = rows.map((entry, index) => h("tr", { key: (entry.uid ?? "row") + "/" + (entry.finishedAt ?? index) + "/" + index },
        h("td", { style: styles.td },
          h("span", { style: failedOutcome(entry.outcome) ? styles.warnBadge : styles.badge }, outcomeLabel(entry.outcome)),
        ),
        h("td", { style: styles.td },
          h("div", null, entry.nickname ?? "—"),
          h("div", { style: { ...muted, fontSize: "11px" } },
            [entry.variant, entry.model].filter((part) => typeof part === "string" && part !== "").join(" · ")),
        ),
        h("td", { style: { ...styles.td, ...styles.num } }, entry.maxPosition === undefined
          ? "—"
          : t("recent.bestValue", { position: entry.maxPosition })),
        h("td", { style: { ...styles.td, ...styles.num } }, humanMs(entry.waitedMs)),
        h("td", { style: { ...styles.td, ...styles.num } }, clockMs(entry.finishedAt)),
      ));
      return h("table", { style: styles.table }, h("thead", null, head), h("tbody", null, body));
    }

    /**
     * Sidebar-foot indicator: the live queue position, and nothing else.
     *
     * It renders NOTHING while the queue is empty — no "空闲" placeholder, no
     * greyed-out row. A seat that is present all the time stops being a signal,
     * and this one only has news when a request is actually waiting.
     *
     * Wide: `⏳ 537 位 · 24 秒` plus the waiter count when there is more than
     * one. Rail (56px, ~36px usable): the glyph over the number, with the whole
     * sentence in the tooltip, because a second line does not fit.
     */
    function QueueFooterIndicator(props) {
      const [status] = useStatusPoll()
      const active = activeRows(status)
      // Hooks above run unconditionally; the empty case simply renders nothing.
      if (status === null || status === undefined || status.ok !== true || active.length === 0) return null

      const wide = props?.wide === true
      const head = active[0]
      const waited = humanMs(head.queuedMs)
      const position = head.position
      const summary = position === undefined
        ? t("footer.summaryUnknown", { time: waited })
        : t("footer.summary", { position, time: waited })
      const title = t("footer.title", { nickname: head.nickname ?? "?", summary })
      const more = active.length > 1 ? t("footer.more", { count: active.length }) : undefined

      if (!wide) {
        // The glyph over the number, as one tight pair: 36px cannot hold a
        // sentence, and the countdown is the only part worth keeping.
        return h("div", { style: styles.footRail, title },
          h("span", { style: { opacity: 0.7 } }, "⏳"),
          position === undefined ? null : h("span", { style: styles.footNum }, String(position)),
        )
      }

      return h("div", { style: styles.footWide, title },
        h("span", { style: styles.footText }, position === undefined
          ? "⏳ " + waited
          : "⏳ " + position + " 位 · " + waited),
        more === undefined ? null : h("span", { style: styles.footCount }, "· " + more),
      )
    }

    /** The whole settings section. */
    function TraeQueueSection() {
      const [status, error, reload] = useStatusPoll();
      const [busy, setBusy] = react.useState(false);

      const manual = react.useCallback(async () => {
        setBusy(true)
        try {
          await reload()
        } finally {
          setBusy(false)
        }
      }, [reload]);

      const header = h("div", { style: styles.header },
        h("h3", { style: styles.title }, t("section.title")),
        h("button", { type: "button", style: styles.button, onClick: () => void manual(), disabled: busy },
          busy ? t("action.refreshing") : t("action.refresh")),
      );

      if (status === undefined) {
        return h("section", { style: styles.section }, header,
          h("div", { style: styles.empty }, error === undefined ? t("state.loading") : t("state.error", { error })),
        )
      }

      const active = activeRows(status)
      const recent = recentRows(status)
      const blocks = []

      blocks.push(h("div", { key: "meta", style: styles.meta },
        h("span", null, status.baseUrl ?? ""),
        h("span", null, status.fetchedAt === undefined ? t("meta.never") : t("meta.fetched", { time: clock(status.fetchedAt) })),
        typeof status.now === "string" && status.now !== "" ? h("span", null, t("meta.now", { time: status.now })) : null,
      ))

      if (status.ok !== true) {
        blocks.push(h("div", { key: "unreachable", style: styles.banner },
          t("state.unreachable", { baseUrl: status.baseUrl ?? "?", error: status.error ?? t("state.error", { error: "?" }) })))
        return h("section", { style: styles.section }, header, blocks)
      }

      blocks.push(h("div", { key: "active", style: styles.card },
        h("div", { style: styles.cardTitle }, active.length === 0
          ? t("active.title")
          : t("active.title") + " · " + t("active.count", { count: active.length })),
        active.length === 0
          ? h("div", null,
              h("div", { style: styles.empty }, t("active.none")),
              h("div", { style: styles.hint }, t("active.noneHint")),
            )
          : active.map((entry, index) => h(ActiveRow, { key: (entry.requestUuid ?? entry.queueId ?? "row") + "/" + index, entry })),
      ))

      blocks.push(h("div", { key: "recent", style: styles.card },
        h("div", { style: styles.cardTitle }, t("recent.title")),
        h(RecentTable, { rows: recent }),
        typeof status.recentTotal === "number" && status.recentTotal > recent.length
          ? h("div", { style: styles.hint }, t("recent.total", { count: status.recentTotal, shown: recent.length }))
          : null,
      ))

      return h("section", { style: styles.section }, header, blocks)
    }

    /** Required client services. */
    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: SECTION_ID,
        order: SECTION_ORDER,
        label: () => t("section.title"),
      }, TraeQueueSection));

      // Sidebar foot, beside Settings. The slot is a `list`, so our own id adds
      // a seat instead of replacing a shipped one. The owner passes `wide`, and
      // we render a rail form when the sidebar is collapsed. The occupant itself
      // returns null whenever the queue is empty, so the seat exists without
      // ever showing an idle placeholder.
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: FOOTER_ID,
        order: FOOTER_ORDER,
        label: () => t("footer.action"),
      }, QueueFooterIndicator));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
