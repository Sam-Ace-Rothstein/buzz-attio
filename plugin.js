// Attio deals for Buzz: Kybernesis plugin (API v1, plain JS, no imports).
// One file by design: Buzz loads a single self-contained ES module.
export const inject = ["react", "host", "pages", "panels", "conversation", "agents", "settingsCards", "navigation"];

export function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const API = "https://api.attio.com/v2";
  const KEY_HELP =
    "Add an Attio access token to your Mac's Keychain. In Terminal run: security add-generic-password -a \"$USER\" -s kybernesis-attio-api-key -w   then paste the token when asked.";
  const ACTIVE_STAGES = ["3-Discovery Held", "4-Audit Pitched", "5-Audit Delivery", "6-Readout", "7-Pilot-Expand"];
  const CLOSED_STAGES = ["Won", "Lost", "Nurture"];

  // ---------- Attio client ----------
  let cachedKey = null;
  let cachedSelf = null;
  let cachedStages = null;
  let cachedMembers = null;

  async function apiKey() {
    if (cachedKey) return cachedKey;
    const out = await ctx.host.runCommand("attio-key");
    const key = out && out.trim();
    if (!key) throw new Error("No Attio key found. " + KEY_HELP);
    cachedKey = key;
    return key;
  }

  async function attio(path, method, body) {
    const key = await apiKey();
    const res = await ctx.host.request({
      url: API + path,
      method: method || "GET",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeoutMs: 20000,
    });
    let data = null;
    try { data = res.body ? JSON.parse(res.body) : null; } catch (_) { data = null; }
    if (res.status === 401 || res.status === 403) {
      cachedKey = null;
      throw new Error("Attio refused the key (" + res.status + "). Check the token and its scopes. " + KEY_HELP);
    }
    if (res.status === 429) throw new Error("Attio rate limit hit. Try again in a few seconds.");
    if (res.status >= 400) {
      const msg = (data && (data.message || data.code)) || res.body || "error";
      throw new Error("Attio " + res.status + ": " + String(msg).slice(0, 300));
    }
    return data;
  }

  async function self() {
    if (!cachedSelf) cachedSelf = await attio("/self");
    return cachedSelf;
  }
  async function stages() {
    if (!cachedStages) {
      const r = await attio("/objects/deals/attributes/stage/statuses");
      cachedStages = (r.data || []).filter((s) => !s.is_archived).map((s) => s.title);
    }
    return cachedStages;
  }
  async function members() {
    if (!cachedMembers) {
      // Needs the token's "User management: read" scope. Without it, names and
      // assignees are left blank rather than breaking the panel.
      let r;
      try { r = await attio("/workspace_members"); } catch (_) { return []; }
      cachedMembers = (r.data || []).map((m) => ({
        id: m.id && m.id.workspace_member_id,
        name: [m.first_name, m.last_name].filter(Boolean).join(" "),
        email: m.email_address,
      }));
    }
    return cachedMembers;
  }
  async function dealUrl(id) {
    try {
      const s = await self();
      return "https://app.attio.com/" + s.workspace_slug + "/deals/record/" + id + "/overview";
    } catch (_) {
      return "https://app.attio.com";
    }
  }

  // Read one attribute value from an Attio record in a plain form.
  function val(rec, slug) {
    const arr = rec && rec.values && rec.values[slug];
    if (!arr || !arr.length) return null;
    const v = arr[0];
    switch (v.attribute_type) {
      case "status": return v.status && v.status.title;
      case "select": return v.option && v.option.title;
      case "currency": return v.currency_value;
      case "actor-reference": return v.referenced_actor_id;
      case "record-reference": return v.target_record_id;
      default: return v.value !== undefined ? v.value : null;
    }
  }
  const recId = (rec) => rec && rec.id && rec.id.record_id;

  function summarize(rec) {
    return {
      id: recId(rec),
      name: val(rec, "name"),
      stage: val(rec, "stage"),
      value: val(rec, "value"),
      owner_member_id: val(rec, "owner"),
      company_id: val(rec, "associated_company"),
      ai_maturity: val(rec, "ai_maturity"),
      audit_tier: val(rec, "audit_tier"),
      audit_fee: val(rec, "audit_fee"),
      implementation_package: val(rec, "implementation_package"),
      gate_coverage: val(rec, "gate_coverage"),
      budget_status: val(rec, "budget_status"),
      approvers_known: val(rec, "approvers_known"),
      decision_maker_known: val(rec, "decision_maker_known"),
      painpoint: val(rec, "painpoint_bottleneck"),
      pain_quote: val(rec, "pain_quote"),
      existing_systems: val(rec, "existing_systems_tools"),
      next_step: val(rec, "next_step"),
      next_step_date: val(rec, "next_step_date"),
      buzz_channel: val(rec, "buzz_channel"),
      map_url: val(rec, "map_url"),
    };
  }

  async function queryDeals(filter, limit) {
    const r = await attio("/objects/deals/records/query", "POST", {
      filter: filter || {},
      sorts: [{ attribute: "name", direction: "asc" }],
      limit: limit || 500,
    });
    return (r.data || []).map(summarize);
  }
  async function getDeal(id) {
    const r = await attio("/objects/deals/records/" + id);
    return summarize(r.data);
  }
  async function companyName(id) {
    if (!id) return null;
    try {
      const r = await attio("/objects/companies/records/" + id);
      return val(r.data, "name");
    } catch (_) { return null; }
  }
  async function dealForChannel(channelId) {
    if (!channelId) return null;
    const found = await queryDeals({ buzz_channel: { $contains: channelId } }, 5);
    return found[0] || null;
  }
  async function updateDeal(id, values) {
    const r = await attio("/objects/deals/records/" + id, "PATCH", { data: { values } });
    return summarize(r.data);
  }
  async function addNote(dealId, title, content) {
    const body = (format) => ({ data: { parent_object: "deals", parent_record_id: dealId, title, format, content } });
    try {
      return (await attio("/notes", "POST", body("markdown"))).data;
    } catch (e) {
      if (/400/.test(String(e.message))) return (await attio("/notes", "POST", body("plaintext"))).data;
      throw e;
    }
  }
  async function listNotes(dealId) {
    const r = await attio("/notes?parent_object=deals&parent_record_id=" + dealId + "&limit=20");
    return (r.data || []).map((n) => ({ id: n.id && n.id.note_id, title: n.title, created_at: n.created_at, text: n.content_plaintext }));
  }
  async function listTasks(dealId, includeDone) {
    let path = "/tasks?linked_object=deals&linked_record_id=" + dealId + "&limit=100&sort=created_at:asc";
    if (!includeDone) path += "&is_completed=false";
    const r = await attio(path);
    return (r.data || []).map((t) => ({
      id: t.id && t.id.task_id,
      content: t.content_plaintext,
      done: t.is_completed,
      deadline: t.deadline_at,
      assignee_ids: (t.assignees || []).map((a) => a.referenced_actor_id),
    }));
  }
  async function addTask(dealId, content, deadline, assigneeEmail) {
    let assignees = [];
    if (assigneeEmail) {
      const m = (await members()).find((x) => (x.email || "").toLowerCase() === assigneeEmail.toLowerCase());
      if (!m) throw new Error("No Attio member with email " + assigneeEmail);
      assignees = [{ referenced_actor_type: "workspace-member", referenced_actor_id: m.id }];
    }
    const r = await attio("/tasks", "POST", {
      data: {
        content,
        format: "plaintext",
        deadline_at: deadline ? new Date(deadline.length === 10 ? deadline + "T09:00:00+07:00" : deadline).toISOString() : null,
        is_completed: false,
        linked_records: [{ target_object: "deals", target_record_id: dealId }],
        assignees,
      },
    });
    return r.data && r.data.id && r.data.id.task_id;
  }
  async function setTaskDone(taskId, done) {
    await attio("/tasks/" + taskId, "PATCH", { data: { is_completed: done !== false } });
  }

  // ---------- design system (Buzz host classes + tokens only) ----------
  const T = {
    subtle: "var(--text-subtle)",
    meta: "var(--text-metadata, var(--text-subtle))",
    danger: "var(--text-danger, var(--color-danger))",
    success: "var(--text-success, var(--text-standard))",
    warning: "var(--text-warning, var(--text-standard))",
    border: "1px solid var(--border-standard)",
    inset: "var(--surface-inset, transparent)",
    small: "var(--text-body-sm)",
    caption: "var(--text-caption)",
  };
  const S = {
    page: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-section-gap, var(--space-6))", maxWidth: 1080, width: "100%", boxSizing: "border-box" },
    panel: { padding: "var(--space-panel-inset)", display: "flex", flexDirection: "column", gap: "var(--space-5)", boxSizing: "border-box", width: "100%", minWidth: 0 },
    stack: { display: "flex", flexDirection: "column", gap: "var(--space-2)" },
    row: { display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", minWidth: 0 },
    between: { display: "flex", gap: "var(--space-2)", alignItems: "center", justifyContent: "space-between", minWidth: 0 },
    label: { fontSize: T.caption, color: T.meta, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600, margin: 0 },
    muted: { color: T.subtle, fontSize: T.small },
    title: { fontSize: "var(--text-title)", fontWeight: "var(--font-weight-semibold, 600)", margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
    card: { border: T.border, borderRadius: "var(--radius-card)", padding: "var(--space-3) var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-2)", minWidth: 0 },
    tile: { border: T.border, borderRadius: "var(--radius-card)", padding: "var(--space-3)", minWidth: 0, flex: "1 1 0", display: "flex", flexDirection: "column", gap: 2 },
    num: { fontSize: "var(--text-heading)", fontWeight: 600, fontVariantNumeric: "tabular-nums" },
    divider: { borderTop: T.border, margin: 0 },
  };
  const money = (n) => (n === null || n === undefined || n === "" ? null : "$" + Number(n).toLocaleString("en-US"));
  const today = () => new Date().toISOString().slice(0, 10);
  const overdue = (d) => ACTIVE_STAGES.includes(d.stage) && !!d.next_step_date && d.next_step_date < today();
  const noNext = (d) => ACTIVE_STAGES.includes(d.stage) && !d.next_step;
  const needsAttention = (d) => overdue(d) || noNext(d);
  const fmtDate = (s) => {
    if (!s) return null;
    const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
    return isNaN(d) ? s : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const stageShort = (s) => (s || "").replace(/^\d-/, "");

  function useAsync(fn, deps) {
    const [state, set] = React.useState({ loading: true, data: null, error: null });
    const run = React.useCallback(() => {
      let live = true;
      set((s) => ({ ...s, loading: true, error: null }));
      fn().then(
        (data) => live && set({ loading: false, data, error: null }),
        (e) => live && set({ loading: false, data: null, error: String((e && e.message) || e) }),
      );
      return () => { live = false; };
    }, deps);
    React.useEffect(run, [run]);
    return [state, run];
  }

  // Buttons and inputs use Buzz's own classes so they look native in light and dark.
  function Btn(p) {
    return h("button", {
      type: "button", className: "buzz-button", "data-variant": p.variant || "glass", "data-button-shape": p.shape,
      disabled: p.disabled, onClick: p.onClick, title: p.title, style: p.style, "aria-pressed": p.pressed,
    }, h("span", { className: "buzz-button-label" }, p.children));
  }
  function Input(p) {
    return h("input", { className: "buzz-input", "data-size": "sm", ...p, style: { ...(p.style || {}) } });
  }
  function Select(p) {
    return h("select", { className: "buzz-input", "data-size": "sm", value: p.value, disabled: p.disabled, onChange: p.onChange, style: { width: "auto", cursor: "pointer", ...(p.style || {}) } },
      p.options.map((o) => h("option", { key: o.value, value: o.value }, o.label)));
  }
  function Chip(p) {
    const tones = {
      neutral: { color: T.subtle, borderColor: "var(--border-standard)" },
      good: { color: T.success, borderColor: "currentColor" },
      warn: { color: T.warning, borderColor: "currentColor" },
      bad: { color: T.danger, borderColor: "currentColor" },
      accent: { color: "var(--text-accent, var(--text-standard))", borderColor: "currentColor" },
    };
    return h("span", { style: {
      display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 8px", borderRadius: "var(--radius-chip, 999px)",
      border: "1px solid", fontSize: T.caption, lineHeight: 1.6, whiteSpace: "nowrap", ...tones[p.tone || "neutral"],
    } }, p.children);
  }
  function Section(p) {
    return h("section", { style: S.stack },
      h("div", { style: S.between }, h("h4", { style: S.label }, p.title), p.action || null),
      p.children);
  }
  function Empty(p) {
    return h("div", { style: { ...S.card, alignItems: "center", textAlign: "center", padding: "var(--space-6) var(--space-4)", borderStyle: "dashed" } },
      p.title && h("strong", null, p.title),
      h("span", { style: S.muted }, p.children),
      p.action || null);
  }
  function Loading(p) {
    return h("div", { style: { ...(p.page ? S.page : S.panel) }, "aria-busy": "true" },
      [0, 1, 2].map((i) => h("div", { key: i, style: { height: i === 0 ? 28 : 64, borderRadius: "var(--radius-card)", background: "var(--color-affordance-subtle, rgba(127,127,127,0.12))", opacity: 0.6 } })),
      h("span", { style: S.muted }, p.text || "Loading from Attio…"));
  }
  function Problem(p) {
    const keyIssue = /key|Keychain|token|refused/i.test(p.error);
    return h("div", { style: { ...(p.page ? S.page : S.panel) } },
      h("div", { style: { ...S.card, borderColor: "currentColor", color: T.danger } },
        h("strong", null, keyIssue ? "Attio isn't connected" : "Couldn't reach Attio"),
        h("span", { style: { color: "var(--text-standard)", fontSize: T.small } }, p.error)),
      h("div", { style: S.row },
        h(Btn, { variant: "prominent", onClick: p.retry }, "Try again"),
        keyIssue && h(Btn, { variant: "glass", onClick: () => ctx.navigation && ctx.navigation.open({ version: 1, kind: "settings" }) }, "Open settings")));
  }

  const STAGE_TONE = { Won: "good", Lost: "bad", Nurture: "neutral" };
  function StageTrack(p) {
    const idx = ACTIVE_STAGES.indexOf(p.stage);
    if (idx === -1) {
      return h("div", { style: S.row }, h(Chip, { tone: STAGE_TONE[p.stage] || "neutral" }, p.stage || "No stage"));
    }
    return h("div", { style: S.stack },
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(" + ACTIVE_STAGES.length + ", 1fr)", gap: 4 } },
        ACTIVE_STAGES.map((s, i) => h("div", { key: s, title: s, style: {
          height: 6, borderRadius: 3,
          background: i <= idx ? "var(--color-affordance-accent, var(--text-accent))" : "var(--color-affordance-subtle, rgba(127,127,127,0.2))",
        } }))),
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(" + ACTIVE_STAGES.length + ", 1fr)", gap: 4 } },
        ACTIVE_STAGES.map((s, i) => h("span", { key: s, style: {
          fontSize: T.caption, color: i === idx ? "var(--text-standard)" : T.meta, fontWeight: i === idx ? 600 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        } }, stageShort(s)))));
  }

  // ---------- channel header launcher ----------
  const ICON = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#8a8a8a" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 7h6M5 10h3"/></svg>');

  // ---------- channel panel: the client's deal ----------
  function DealPanel(props) {
    const cc = props.channelContext;
    const channelId = cc && cc.channelId;
    const channelName = cc && cc.channelName;
    const [state, reload] = useAsync(async () => {
      const deal = await dealForChannel(channelId);
      if (!deal) return { deal: null };
      const [tasks, notes, company, url, stageList, team] = await Promise.all([
        listTasks(deal.id, false), listNotes(deal.id), companyName(deal.company_id), dealUrl(deal.id), stages(), members(),
      ]);
      return { deal, tasks, notes, company, url, stageList, team };
    }, [channelId]);

    if (!channelId) return h("div", { style: S.panel }, h(Empty, { title: "Open from a client channel" }, "The deal panel shows the Attio deal linked to the channel you're in."));
    if (state.loading && !state.data) return h(Loading, { text: "Loading this channel's deal…" });
    if (state.error) return h(Problem, { error: state.error, retry: reload });
    if (!state.data.deal) return h(LinkDeal, { channelId, channelName, onLinked: reload });
    return h(DealCard, { ...state.data, reload, channelName, refreshing: state.loading });
  }

  function LinkDeal(props) {
    const [q, setQ] = React.useState(props.channelName ? props.channelName.replace(/^c-/, "").replace(/-/g, " ") : "");
    const [results, setResults] = React.useState(null);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const tag = (props.channelName ? "#" + props.channelName + " " : "") + "[" + props.channelId + "]";
    async function search() {
      setBusy(true); setError(null);
      try { setResults(await queryDeals(q.trim() ? { name: { $contains: q.trim() } } : {}, 20)); } catch (e) { setError(e.message); }
      setBusy(false);
    }
    React.useEffect(() => { if (q) search(); }, []);
    async function link(id) {
      setBusy(true); setError(null);
      try { await updateDeal(id, { buzz_channel: tag }); props.onLinked(); } catch (e) { setError(e.message); setBusy(false); }
    }
    async function create() {
      if (!q.trim()) { setError("Type the client's name first."); return; }
      setBusy(true); setError(null);
      try {
        const s = await self();
        const ownerId = s.authorized_by_workspace_member_id;
        if (!ownerId) throw new Error("Attio didn't say who owns this token, so the deal would have no owner. Create the deal in Attio, then link it here.");
        await attio("/objects/deals/records", "POST", { data: { values: {
          name: q.trim(), stage: "3-Discovery Held",
          owner: { referenced_actor_type: "workspace-member", referenced_actor_id: ownerId },
          buzz_channel: tag,
        } } });
        props.onLinked();
      } catch (e) { setError(e.message); setBusy(false); }
    }
    return h("div", { style: S.panel },
      h("div", { style: S.stack },
        h("h3", { style: S.title }, "Link a deal"),
        h("span", { style: S.muted }, "Connect #" + (props.channelName || "this channel") + " to its client's deal in Attio. Everyone in the channel will see it here.")),
      h("div", { style: S.row },
        h(Input, { value: q, placeholder: "Search deals by name", style: { flex: "1 1 160px" }, onChange: (e) => setQ(e.target.value), onKeyDown: (e) => e.key === "Enter" && search() }),
        h(Btn, { variant: "glass", disabled: busy, onClick: search }, "Search")),
      error && h("span", { role: "alert", style: { color: T.danger, fontSize: T.small } }, error),
      results && (results.length === 0
        ? h(Empty, { title: "No matching deal" }, "Create one below, or try another name.")
        : h("div", { style: { ...S.card, padding: 0, gap: 0 } },
            results.map((d, i) => h("div", { key: d.id, style: { ...S.between, padding: "var(--space-2) var(--space-3)", borderTop: i ? T.border : "none" } },
              h("div", { style: { ...S.stack, gap: 0, minWidth: 0 } },
                h("strong", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, d.name),
                h("span", { style: S.muted }, stageShort(d.stage) + (d.buzz_channel ? " · linked to " + d.buzz_channel.split(" [")[0] : ""))),
              h(Btn, { variant: "glass", disabled: busy, onClick: () => link(d.id) }, "Link"))))),
      h("hr", { style: S.divider }),
      h("div", { style: S.stack },
        h("span", { style: S.label }, "New client"),
        h("span", { style: S.muted }, "Creates a deal named “" + (q.trim() || "…") + "” at Discovery Held, owned by you, and links it to this channel."),
        h("div", null, h(Btn, { variant: "prominent", disabled: busy || !q.trim(), onClick: create }, "Create deal"))));
  }

  function Stat(p) {
    return h("div", { style: S.tile },
      h("span", { style: S.label }, p.label),
      h("span", { style: { ...S.num, color: p.value === null || p.value === undefined ? T.meta : undefined } }, p.value === null || p.value === undefined ? "—" : p.value),
      p.sub && h("span", { style: S.muted }, p.sub));
  }

  function DealCard(props) {
    const d = props.deal;
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(null);
    const [editNext, setEditNext] = React.useState(false);
    const [nextStep, setNextStep] = React.useState(d.next_step || "");
    const [nextDate, setNextDate] = React.useState(d.next_step_date || "");
    const [newTask, setNewTask] = React.useState("");
    const [taskDate, setTaskDate] = React.useState("");
    const [taskWho, setTaskWho] = React.useState("");
    const [noteText, setNoteText] = React.useState("");
    const [saved, setSaved] = React.useState(null);

    async function act(fn, msg) {
      setBusy(true); setError(null); setSaved(null);
      try { await fn(); if (msg) setSaved(msg); props.reload(); } catch (e) { setError(e.message); }
      setBusy(false);
    }
    const team = props.team || [];
    const owner = team.find((m) => m.id === d.owner_member_id);
    const nameOf = (ids) => { const m = team.find((x) => ids.includes(x.id)); return m ? m.name.split(" ")[0] : null; };
    const cov = d.gate_coverage;

    return h("div", { style: S.panel },
      // Header
      h("div", { style: S.stack },
        h("div", { style: S.between },
          h("h3", { style: S.title, title: d.name }, d.name),
          h("a", { href: props.url, target: "_blank", rel: "noreferrer", className: "buzz-button", "data-variant": "glass", style: { textDecoration: "none" } },
            h("span", { className: "buzz-button-label" }, "Open in Attio ↗"))),
        h("span", { style: S.muted }, [props.company, owner && "Owner " + owner.name].filter(Boolean).join(" · ") || "No company linked"),
      ),
      // Stage
      h(Section, {
        title: "Stage",
        action: h(Select, {
          value: d.stage || "", disabled: busy,
          onChange: (e) => act(() => updateDeal(d.id, { stage: e.target.value }), "Stage updated"),
          options: (props.stageList || []).map((s) => ({ value: s, label: s })),
        }),
      }, h(StageTrack, { stage: d.stage })),
      // Numbers
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "var(--space-2)" } },
        h(Stat, { label: "Deal value", value: money(d.value) }),
        h(Stat, { label: "Audit", value: money(d.audit_fee), sub: d.audit_tier }),
        h(Stat, { label: "Coverage", value: cov === null || cov === undefined ? null : cov + "%", sub: "of what we need" })),
      // Qualification chips
      h(Section, { title: "Qualification" },
        h("div", { style: S.row },
          h(Chip, { tone: d.ai_maturity ? "accent" : "neutral" }, "AI: " + (d.ai_maturity || "not set")),
          h(Chip, { tone: d.budget_status === "Approved" || d.budget_status === "Budget set aside" ? "good" : d.budget_status ? "warn" : "neutral" }, "Budget: " + (d.budget_status || "not discussed")),
          h(Chip, { tone: d.approvers_known ? "good" : "warn" }, d.approvers_known ? "Approvers known" : "Approvers unknown"),
          h(Chip, { tone: d.decision_maker_known === "Yes" ? "good" : "neutral" }, d.decision_maker_known === "Yes" ? "Decision-maker known" : "Decision-maker ?"),
          d.implementation_package && h(Chip, { tone: "accent" }, "Package " + d.implementation_package)),
        (d.painpoint || d.pain_quote) && h("div", { style: { ...S.card, gap: 4 } },
          d.painpoint && h("span", null, d.painpoint),
          d.pain_quote && h("span", { style: { ...S.muted, fontStyle: "italic" } }, "“" + d.pain_quote + "”")),
        d.map_url && h("a", { href: d.map_url, target: "_blank", rel: "noreferrer", style: { fontSize: T.small } }, "Engagement plan ↗")),
      // Next step
      h(Section, {
        title: "Next step",
        action: !editNext && h(Btn, { variant: "glass", onClick: () => setEditNext(true) }, d.next_step ? "Edit" : "Add"),
      },
        editNext
          ? h("div", { style: { ...S.card, gap: "var(--space-2)" } },
              h(Input, { value: nextStep, placeholder: "What happens next, and with whom?", autoFocus: true, onChange: (e) => setNextStep(e.target.value) }),
              h("div", { style: S.row },
                h(Input, { type: "date", value: nextDate, style: { width: "auto" }, onChange: (e) => setNextDate(e.target.value) }),
                h("div", { style: { flex: 1 } }),
                h(Btn, { variant: "subtle", onClick: () => { setEditNext(false); setNextStep(d.next_step || ""); setNextDate(d.next_step_date || ""); } }, "Cancel"),
                h(Btn, { variant: "prominent", disabled: busy || !nextStep.trim(), onClick: () => act(async () => { await updateDeal(d.id, { next_step: nextStep.trim(), next_step_date: nextDate || null }); setEditNext(false); }, "Next step saved") }, "Save")))
          : d.next_step
            ? h("div", { style: { ...S.card, flexDirection: "row", alignItems: "center", gap: "var(--space-3)" } },
                h("span", { style: { flex: 1, minWidth: 0 } }, d.next_step),
                d.next_step_date && h(Chip, { tone: overdue(d) ? "bad" : "neutral" }, (overdue(d) ? "Overdue · " : "") + fmtDate(d.next_step_date)))
            : h(Empty, null, "No next step yet. Every active deal should have one.")),
      // Tasks
      h(Section, { title: "Plan · " + props.tasks.length + " open" },
        props.tasks.length === 0
          ? h(Empty, null, "No open tasks. Add the client's next steps from the engagement template.")
          : h("div", { style: { ...S.card, padding: 0, gap: 0 } },
              props.tasks.map((t, i) => {
                const late = t.deadline && t.deadline.slice(0, 10) < today();
                return h("label", { key: t.id, style: { display: "flex", gap: "var(--space-3)", alignItems: "flex-start", padding: "var(--space-2) var(--space-3)", borderTop: i ? T.border : "none", cursor: "pointer" } },
                  h("input", { type: "checkbox", disabled: busy, style: { marginTop: 3 }, onChange: () => act(() => setTaskDone(t.id, true), "Task done") }),
                  h("span", { style: { flex: 1, minWidth: 0, ...S.stack, gap: 0 } },
                    h("span", null, t.content),
                    (nameOf(t.assignee_ids) || t.deadline) && h("span", { style: { ...S.muted, color: late ? T.danger : T.subtle } },
                      [nameOf(t.assignee_ids), t.deadline && (late ? "overdue " : "due ") + fmtDate(t.deadline)].filter(Boolean).join(" · "))));
              })),
        h("div", { style: { ...S.row, flexWrap: "wrap" } },
          h(Input, { value: newTask, placeholder: "Add a step…", style: { flex: "1 1 100%" }, onChange: (e) => setNewTask(e.target.value),
            onKeyDown: (e) => e.key === "Enter" && newTask.trim() && act(async () => { await addTask(d.id, newTask.trim(), taskDate || null, taskWho || null); setNewTask(""); setTaskDate(""); }, "Task added") }),
          newTask.trim() && h(React.Fragment, null,
            h(Input, { type: "date", value: taskDate, style: { width: "auto" }, onChange: (e) => setTaskDate(e.target.value) }),
            h(Select, { value: taskWho, onChange: (e) => setTaskWho(e.target.value), options: [{ value: "", label: "Unassigned" }].concat(team.map((m) => ({ value: m.email, label: m.name }))) }),
            h(Btn, { variant: "prominent", disabled: busy, onClick: () => act(async () => { await addTask(d.id, newTask.trim(), taskDate || null, taskWho || null); setNewTask(""); setTaskDate(""); }, "Task added") }, "Add")))),
      // Notes
      h(Section, { title: "Notes" },
        h("textarea", { className: "buzz-textarea", rows: 3, value: noteText, placeholder: "Meeting notes, a decision, what they said…", style: { minHeight: "4.5rem" }, onChange: (e) => setNoteText(e.target.value) }),
        noteText.trim() && h("div", { style: { ...S.row, justifyContent: "flex-end" } },
          h(Btn, { variant: "prominent", disabled: busy, onClick: () => act(async () => { await addNote(d.id, "Note from #" + (props.channelName || "Buzz"), noteText.trim()); setNoteText(""); }, "Note saved to Attio") }, "Save note")),
        props.notes.length > 0 && h("div", { style: { ...S.card, padding: 0, gap: 0 } },
          props.notes.slice(0, 5).map((n, i) => h("div", { key: n.id, style: { padding: "var(--space-2) var(--space-3)", borderTop: i ? T.border : "none", ...S.stack, gap: 2 } },
            h("div", { style: S.between }, h("strong", { style: { fontSize: T.small, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, n.title || "Note"), h("span", { style: S.muted }, fmtDate(n.created_at))),
            n.text && h("span", { style: { ...S.muted, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, n.text))))),
      // Status line
      (error || saved || busy || props.refreshing) && h("div", { role: error ? "alert" : "status", style: { fontSize: T.small, color: error ? T.danger : T.subtle } },
        error || (busy ? "Saving…" : props.refreshing ? "Refreshing…" : saved)));
  }

  ctx.panels.register({
    id: "deal",
    title: "Deal",
    matches: () => false,
    channelPlacement: "side",
    channelLauncher: function DealLauncher(props) {
      return h("button", {
        type: "button", className: "buzz-button", "data-variant": props.pressed ? "subtle" : "glass-ghost",
        title: "Show this channel's Attio deal", "aria-pressed": props.pressed,
        onClick: () => props.toggle("kybernesis-attio:deal"),
      }, h("span", { className: "buzz-button-label" },
        h("svg", { viewBox: "0 0 16 16", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true }, h("rect", { x: 2, y: 3, width: 12, height: 10, rx: 2 }), h("path", { d: "M5 7h6M5 10h3" })), "Deal"));
    },
    component: DealPanel,
  });

  // ---------- pipeline page ----------
  function Pipeline() {
    const [showClosed, setShowClosed] = React.useState(false);
    const [mine, setMine] = React.useState(false);
    const [q, setQ] = React.useState("");
    const [state, reload] = useAsync(async () => {
      const [deals, stageList, team, s] = await Promise.all([queryDeals({}, 500), stages(), members(), self()]);
      return { deals, stageList, team, slug: s.workspace_slug, me: s.authorized_by_workspace_member_id };
    }, []);
    if (state.loading && !state.data) return h(Loading, { page: true, text: "Loading the pipeline…" });
    if (state.error) return h(Problem, { page: true, error: state.error, retry: reload });
    const { deals, stageList, team, slug, me } = state.data;
    const filtered = deals.filter((d) => (!mine || d.owner_member_id === me) && (!q || (d.name || "").toLowerCase().includes(q.toLowerCase())));
    const active = filtered.filter((d) => ACTIVE_STAGES.includes(d.stage));
    const attention = active.filter(needsAttention);
    const activeValue = active.reduce((n, d) => n + (Number(d.value) || 0), 0);
    const auditValue = active.reduce((n, d) => n + (Number(d.audit_fee) || 0), 0);
    const shown = stageList.filter((s) => showClosed || !CLOSED_STAGES.includes(s));
    const link = (d) => "https://app.attio.com/" + slug + "/deals/record/" + d.id + "/overview";

    const row = (d, i) => {
      const owner = team.find((m) => m.id === d.owner_member_id);
      return h("div", { key: d.id, style: { display: "grid", gridTemplateColumns: "minmax(140px, 2fr) minmax(70px, 0.8fr) minmax(70px, 0.8fr) minmax(160px, 3fr)", gap: "var(--space-3)", alignItems: "center", padding: "var(--space-2) var(--space-4)", borderTop: i ? T.border : "none" } },
        h("div", { style: { ...S.stack, gap: 0, minWidth: 0 } },
          h("a", { href: link(d), target: "_blank", rel: "noreferrer", style: { fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "inherit" } }, d.name),
          d.buzz_channel && h("span", { style: { ...S.muted, fontSize: T.caption } }, d.buzz_channel.split(" [")[0])),
        h("span", { style: { fontVariantNumeric: "tabular-nums", color: d.value ? undefined : T.meta } }, money(d.value) || "—"),
        h("span", { style: S.muted }, owner ? owner.name.split(" ")[0] : "—"),
        h("div", { style: { ...S.row, flexWrap: "nowrap", minWidth: 0 } },
          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: d.next_step ? undefined : T.meta, fontSize: T.small } }, d.next_step || (ACTIVE_STAGES.includes(d.stage) ? "No next step" : "—")),
          d.next_step_date && h(Chip, { tone: overdue(d) ? "bad" : "neutral" }, fmtDate(d.next_step_date))));
    };

    return h("div", { style: S.page },
      h("div", { style: S.between },
        h("div", { style: S.stack },
          h("h1", { style: { margin: 0, fontSize: "var(--text-display, var(--text-title))" } }, "Pipeline"),
          h("span", { style: S.muted }, "Kybernesis deals from Attio")),
        h(Btn, { variant: "glass", onClick: reload, disabled: state.loading }, state.loading ? "Refreshing…" : "Refresh")),
      h("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "var(--space-3)" } },
        h(Stat, { label: "Active deals", value: String(active.length), sub: "Discovery to pilot" }),
        h(Stat, { label: "Active value", value: money(activeValue) || "$0" }),
        h(Stat, { label: "Audits quoted", value: money(auditValue) || "$0" }),
        h(Stat, { label: "Need attention", value: String(attention.length), sub: "overdue or no next step" })),
      h("div", { style: S.row },
        h(Input, { value: q, placeholder: "Filter by name", style: { flex: "1 1 200px", maxWidth: 320 }, onChange: (e) => setQ(e.target.value) }),
        h(Btn, { variant: mine ? "subtle" : "glass", pressed: mine, onClick: () => setMine(!mine) }, "Mine"),
        h(Btn, { variant: showClosed ? "subtle" : "glass", pressed: showClosed, onClick: () => setShowClosed(!showClosed) }, "Won, lost & nurture")),
      attention.length > 0 && h(Section, { title: "Needs attention" },
        h("div", { style: { ...S.card, padding: 0, gap: 0 } }, attention.map(row))),
      shown.map((stage) => {
        const list = filtered.filter((d) => d.stage === stage);
        const total = list.reduce((n, d) => n + (Number(d.value) || 0), 0);
        return h(Section, {
          key: stage,
          title: stageShort(stage) + " · " + list.length,
          action: total ? h("span", { style: S.muted }, money(total)) : null,
        }, list.length === 0
          ? h("div", { style: { ...S.muted, padding: "0 var(--space-1)" } }, "None")
          : h("div", { style: { ...S.card, padding: 0, gap: 0 } }, list.map(row)));
      }));
  }
  ctx.pages.register({ id: "pipeline", title: "Pipeline", primary: true, icon: ICON, component: Pipeline });

  // ---------- message action: save to Attio ----------
  ctx.conversation.registerMessageAction({
    id: "save-to-attio",
    title: "Save to Attio",
    matches: (message) => !!(message && message.content && message.content.trim()),
    component: function SaveToAttio(props) {
      const firstLine = (props.message.content || "").trim().split("\n")[0].slice(0, 80);
      const [title, setTitle] = React.useState(firstLine);
      const [state, setState] = React.useState({ phase: "finding", deal: null, error: null });
      React.useEffect(() => {
        let live = true;
        dealForChannel(props.message.channelId).then(
          (deal) => live && setState({ phase: deal ? "ready" : "unlinked", deal, error: null }),
          (e) => live && setState({ phase: "error", deal: null, error: String(e.message || e) }));
        return () => { live = false; };
      }, []);
      async function save() {
        setState((s) => ({ ...s, phase: "saving" }));
        try {
          await addNote(state.deal.id, title.trim() || "Saved from Buzz", props.message.content);
          setState((s) => ({ ...s, phase: "saved" }));
        } catch (e) { setState((s) => ({ ...s, phase: "error", error: String(e.message || e) })); }
      }
      const box = { padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-3)", width: 340, maxWidth: "100%", boxSizing: "border-box" };
      if (state.phase === "finding") return h("div", { style: box }, h("span", { style: S.muted }, "Finding this channel's deal…"));
      if (state.phase === "unlinked") return h("div", { style: box },
        h("strong", null, "No deal linked"),
        h("span", { style: S.muted }, "Link this channel to its Attio deal first: press Deal in the channel header."),
        h("div", { style: { ...S.row, justifyContent: "flex-end" } }, h(Btn, { variant: "glass", onClick: props.close }, "Close")));
      if (state.phase === "error") return h("div", { style: box },
        h("strong", { style: { color: T.danger } }, "Couldn't save to Attio"),
        h("span", { style: { fontSize: T.small } }, state.error),
        h("div", { style: { ...S.row, justifyContent: "flex-end" } }, h(Btn, { variant: "glass", onClick: props.close }, "Close")));
      if (state.phase === "saved") return h("div", { style: box },
        h("strong", null, "Saved to " + state.deal.name),
        h("span", { style: S.muted }, "It's a note on the deal in Attio now."),
        h("div", { style: { ...S.row, justifyContent: "flex-end" } }, h(Btn, { variant: "prominent", onClick: props.close }, "Done")));
      return h("div", { style: box },
        h("div", { style: S.stack },
          h("span", { style: S.label }, "Save to Attio"),
          h("strong", null, state.deal.name)),
        h(Input, { value: title, placeholder: "Note title", onChange: (e) => setTitle(e.target.value) }),
        h("div", { style: { ...S.muted, maxHeight: 96, overflow: "hidden", borderLeft: T.border, paddingLeft: "var(--space-2)", whiteSpace: "pre-wrap" } }, props.message.content.slice(0, 400)),
        h("div", { style: { ...S.row, justifyContent: "flex-end" } },
          h(Btn, { variant: "subtle", onClick: props.close }, "Cancel"),
          h(Btn, { variant: "prominent", disabled: state.phase === "saving", onClick: save }, state.phase === "saving" ? "Saving…" : "Save note")));
    },
  });

  // ---------- settings ----------
  ctx.settingsCards.register({
    id: "connection",
    title: "Attio",
    component: function AttioSettings() {
      const [state, reload] = useAsync(async () => {
        cachedKey = null; cachedSelf = null; cachedMembers = null;
        const s = await self();
        const team = await members();
        return { s, team };
      }, []);
      const status = state.loading
        ? h("div", { style: S.card }, h("span", { style: S.muted }, "Checking the connection…"))
        : state.error
          ? h("div", { style: { ...S.card, borderColor: "currentColor", color: T.danger } },
              h("strong", null, "Not connected"),
              h("span", { style: { color: "var(--text-standard)", fontSize: T.small } }, state.error))
          : h("div", { style: S.card },
              h("div", { style: S.between },
                h("div", { style: { ...S.stack, gap: 0 } },
                  h("strong", null, state.data.s.workspace_name),
                  h("span", { style: S.muted }, state.data.team.length ? state.data.team.length + " members" : "Member names hidden (token lacks User management: read)")),
                h(Chip, { tone: "good" }, "Connected")));
      return h("div", { style: { display: "flex", flexDirection: "column", gap: "var(--space-5)", maxWidth: 640 } },
        status,
        h("div", null, h(Btn, { variant: "glass", disabled: state.loading, onClick: reload }, "Check again")),
        h(Section, { title: "Set up on a new Mac" },
          h("ol", { style: { margin: 0, paddingLeft: "1.2em", display: "flex", flexDirection: "column", gap: "var(--space-2)", fontSize: T.small } },
            h("li", null, "In Attio: Settings → Developers → Access tokens → Create. Records, notes, tasks and list entries read-write; object configuration and User management read."),
            h("li", null, "In Terminal, run this, then paste the token when asked:"),
            h("code", { style: { display: "block", padding: "var(--space-2) var(--space-3)", borderRadius: "var(--radius-control)", background: T.inset, border: T.border, fontFamily: "var(--font-mono)", fontSize: T.caption, overflowX: "auto", whiteSpace: "nowrap" } },
              "security add-generic-password -U -a \"$USER\" -s kybernesis-attio-api-key -w"),
            h("li", null, "Come back here and press Check again. If macOS asks about the Keychain, choose Always Allow."))),
        h("span", { style: S.muted }, "The token stays in your Keychain and is only sent to api.attio.com."));
    },
  });

  // ---------- agent tools ----------
  const json = (x) => JSON.stringify(x, null, 1);
  ctx.agents.addTool({
    name: "attio_find_deals",
    description: "Find Attio deals by name (partial match), or list all deals when query is empty. Returns id, name, stage, value, next step and linked Buzz channel.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, stage: { type: "string", description: "Optional exact stage title, e.g. 4-Audit Pitched" } } },
    call: async (_c, _x, a) => {
      const f = [];
      if (a.query) f.push({ name: { $contains: a.query } });
      if (a.stage) f.push({ stage: a.stage });
      const deals = await queryDeals(f.length === 0 ? {} : f.length === 1 ? f[0] : { $and: f }, 100);
      return json(deals.map((d) => ({ id: d.id, name: d.name, stage: d.stage, value: d.value, next_step: d.next_step, next_step_date: d.next_step_date, buzz_channel: d.buzz_channel })));
    },
  });
  ctx.agents.addTool({
    name: "attio_deal_for_channel",
    description: "Get the Attio deal linked to a Buzz channel (by channel id), with its open tasks and recent note titles. Use this first when working in a client channel.",
    inputSchema: { type: "object", properties: { channel_id: { type: "string" } }, required: ["channel_id"] },
    call: async (_c, _x, a) => {
      const d = await dealForChannel(a.channel_id);
      if (!d) return "No Attio deal is linked to this channel. A teammate can link one from the Deal button in the channel header.";
      const [tasks, notes] = await Promise.all([listTasks(d.id, false), listNotes(d.id)]);
      return json({ deal: d, open_tasks: tasks, notes: notes.map((n) => ({ id: n.id, title: n.title, created_at: n.created_at })) });
    },
  });
  ctx.agents.addTool({
    name: "attio_get_deal",
    description: "Get one Attio deal by id with all Kybernesis fields, open tasks and recent notes (full text).",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" } }, required: ["deal_id"] },
    call: async (_c, _x, a) => {
      const [d, tasks, notes] = await Promise.all([getDeal(a.deal_id), listTasks(a.deal_id, false), listNotes(a.deal_id)]);
      return json({ deal: d, open_tasks: tasks, notes });
    },
  });
  ctx.agents.addTool({
    name: "attio_update_deal",
    description: "Update fields on an Attio deal. values maps attribute slugs to plain values: stage (status title), next_step, next_step_date (YYYY-MM-DD), value / audit_fee (USD number), ai_maturity (None|Building|Running), audit_tier (Focused|Standard|Multi-site|Custom), implementation_package (A|B|C|Custom), gate_coverage (0-100), budget_status (Not discussed|Needs business case|Budget set aside|Approved), approvers_known (bool), painpoint_bottleneck, pain_quote, existing_systems_tools, map_url, buzz_channel. Only change what the team confirmed.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" }, values: { type: "object" } }, required: ["deal_id", "values"] },
    call: async (_c, _x, a) => json(await updateDeal(a.deal_id, a.values)),
  });
  ctx.agents.addTool({
    name: "attio_add_note",
    description: "Add a markdown note to an Attio deal (meeting notes, the Deal Desk record, decisions).",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" }, title: { type: "string" }, content: { type: "string" } }, required: ["deal_id", "title", "content"] },
    call: async (_c, _x, a) => { const n = await addNote(a.deal_id, a.title, a.content); return "Note saved (" + (n && n.id && n.id.note_id) + ")."; },
  });
  ctx.agents.addTool({
    name: "attio_add_task",
    description: "Add a task to an Attio deal: one step of the client's engagement plan. deadline is YYYY-MM-DD; assignee_email must be an Attio member.",
    inputSchema: { type: "object", properties: { deal_id: { type: "string" }, content: { type: "string" }, deadline: { type: "string" }, assignee_email: { type: "string" } }, required: ["deal_id", "content"] },
    call: async (_c, _x, a) => "Task created (" + (await addTask(a.deal_id, a.content, a.deadline, a.assignee_email)) + ").",
  });
  ctx.agents.addTool({
    name: "attio_complete_task",
    description: "Mark an Attio task done (or not done with done=false).",
    inputSchema: { type: "object", properties: { task_id: { type: "string" }, done: { type: "boolean" } }, required: ["task_id"] },
    call: async (_c, _x, a) => { await setTaskDone(a.task_id, a.done); return "Task updated."; },
  });
  ctx.agents.addTool({
    name: "attio_pipeline",
    description: "Summary of the Attio deal pipeline: count and value per stage, and active deals whose next step is missing or overdue.",
    inputSchema: { type: "object", properties: {} },
    call: async () => {
      const deals = await queryDeals({}, 500);
      const byStage = {};
      deals.forEach((d) => { const k = d.stage || "No stage"; byStage[k] = byStage[k] || { count: 0, value: 0 }; byStage[k].count++; byStage[k].value += Number(d.value) || 0; });
      return json({ by_stage: byStage, needs_attention: deals.filter(needsAttention).map((d) => ({ id: d.id, name: d.name, stage: d.stage, next_step: d.next_step, next_step_date: d.next_step_date })) });
    },
  });

  ctx.agents.addInstructions({
    id: "attio",
    text:
      "Attio is Kybernesis's CRM and the source of truth for clients. Each client deal can be linked to a Buzz channel. In a client channel, call attio_deal_for_channel with the channel id before answering about that client. " +
      "Write to Attio only what a teammate said or confirmed; mark guesses as assumptions in notes, never in fields. Each step of a client's engagement plan is an Attio task on the deal. " +
      "Never send anything to a client; draft it for Tom or Ian to approve.",
  });
}
