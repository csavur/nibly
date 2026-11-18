// Injected on demand (activeTab + scripting) into the frame where the user right-clicked.
// Captures the selection, shows progress, and replaces the selected text with the AI result.
// Written as a classic script (no imports) because it is injected with chrome.scripting;
// src/diff.js is injected first and provides globalThis.NiblyDiff.

(() => {
  if (globalThis.__nibly) return;

  /**
   * @typedef {{kind: "input", el: HTMLInputElement | HTMLTextAreaElement, start: number, end: number}
   *   | {kind: "rich", root: HTMLElement, range: Range}
   *   | {kind: "static"}} Target
   */

  /**
   * snapshot: the target's text as read back by currentTargetText() at capture time. Compared with a
   * fresh read before replacing, so both sides use the same serialization (Selection.toString() adds
   * line breaks for <div>/<br> that Range.toString() does not).
   * @type {{jobId: string, actionId: "fix" | "rewrite", target: Target, snapshot: string | null, text: string,
   *   lead: string, trail: string, planNote: {text: string, link: {text: string, url: string}} | null, review: boolean,
   *   result: string | null} | null}
   */
  let job = null;

  // ------------------------------------------------------------------------------------------
  // Selection capture

  /** document.activeElement, descending into open shadow roots. */
  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  /** @param {Element | null} el */
  function isTextInput(el) {
    if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
    if (el instanceof HTMLInputElement) {
      const textTypes = ["text", "search", "email", "url", ""];
      return textTypes.includes(el.type) && !el.readOnly && !el.disabled;
    }
    return false;
  }

  /** @param {Node | null} node */
  function editableRoot(node) {
    let el = node instanceof Element ? node : node?.parentElement;
    if (!el?.isContentEditable) return null;
    while (el.parentElement?.isContentEditable) el = el.parentElement;
    return el;
  }

  /** @returns {{target: Target, text: string} | null} */
  function captureSelection() {
    const active = deepActiveElement();
    if (isTextInput(active)) {
      const el = /** @type {HTMLInputElement | HTMLTextAreaElement} */ (active);
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (end > start) return { target: { kind: "input", el, start, end }, text: el.value.slice(start, end) };
    }

    const root = active?.shadowRoot ?? document;
    const sel = "getSelection" in root && typeof root.getSelection === "function" ? root.getSelection() : getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    const rich = editableRoot(range.commonAncestorContainer);
    if (rich) return { target: { kind: "rich", root: rich, range: range.cloneRange() }, text };
    return { target: { kind: "static" }, text };
  }

  // ------------------------------------------------------------------------------------------
  // Replacement

  /** Text currently covered by the captured target, to detect edits made while the AI was working. */
  function currentTargetText(target) {
    if (target.kind === "input") return target.el.value.slice(target.start, target.end);
    if (target.kind === "rich") return target.range.toString();
    return null;
  }

  /**
   * Replace the captured selection. Uses execCommand("insertText") so the change goes through the
   * editor's own input pipeline (works with Gmail, Outlook, React inputs) and stays undoable.
   * @param {Target} target @param {string} text
   */
  function replaceTarget(target, text) {
    if (target.kind === "input") {
      const { el, start, end } = target;
      el.focus();
      el.setSelectionRange(start, end);
      if (!document.execCommand("insertText", false, text)) {
        el.setRangeText(text, start, end, "end");
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: text }));
      }
      return true;
    }
    if (target.kind === "rich") {
      target.root.focus();
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(target.range);
      if (document.execCommand("insertText", false, text)) return true;
      // Fallback for editors that block execCommand: plain DOM replacement.
      target.range.deleteContents();
      target.range.insertNode(document.createTextNode(text));
      target.root.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText" }));
      return true;
    }
    return false;
  }

  /** Undo the last replacement through the editor's own undo stack. */
  function undoTarget(target) {
    if (target.kind === "input") target.el.focus();
    else if (target.kind === "rich") target.root.focus();
    else return false;
    return document.execCommand("undo");
  }

  // ------------------------------------------------------------------------------------------
  // UI (isolated in a shadow root so page styles cannot interfere)

  const LABELS = {
    fix: { busy: "Fixing…", done: "Fixed", review: "Review fix", again: "Try again", none: "Looks good - no mistakes found" },
    rewrite: { busy: "Rewriting…", done: "Rewritten", review: "Review rewrite", again: "Another version", none: "Nothing to change" },
  };
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  const UNDO_KEYS = isMac ? "⌘Z" : "Ctrl+Z";

  const ICONS = {
    logo: `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f77828"/><stop offset="1" stop-color="#d6400c"/></linearGradient></defs><rect width="24" height="24" rx="6" fill="url(#g)"/><g transform="rotate(45 11.5 12.5)"><rect x="8.6" y="3.6" width="5.8" height="2.6" rx=".5" fill="#fff"/><path d="M11.5 21.2 7.6 13.4c-.3-2.3.3-4.1 1.2-5.3h5.4c.9 1.2 1.5 3 1.2 5.3z" fill="#fff"/><circle cx="11.5" cy="12.6" r="1.1" fill="#e8590c"/><path d="M11.2 13.4h.6l-.1 5.6h-.4z" fill="#e8590c"/></g><path d="M18.6 3.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z" fill="#fff"/></svg>`,
    close: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`,
    check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    alert: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.8v3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="11" r=".9" fill="currentColor"/></svg>`,
    info: `<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7.2v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="8" cy="5" r=".9" fill="currentColor"/></svg>`,
    retry: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  const host = document.createElement("nibly-ui");
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        --bg: #ffffff; --fg: #1f2328; --muted: #5d6670; --line: #e3e6ea; --soft: #f5f6f8;
        --accent: #e8590c; --accent-hover: #d14f0a; --accent-fg: #fff; --ok: #1a7f37; --err: #cf222e;
        --ins-bg: #dafbe1; --ins-fg: #116329; --del-bg: #ffebe9; --del-fg: #a40e26;
        --shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .08);
        position: fixed; z-index: 2147483647; right: 20px; bottom: 20px; box-sizing: border-box;
        width: min(400px, calc(100vw - 32px));
        font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
        box-shadow: var(--shadow); overflow: hidden; text-align: left;
        animation: enter .18s cubic-bezier(.2, .8, .2, 1);
      }
      @media (prefers-color-scheme: dark) {
        .card {
          --bg: #1c1f24; --fg: #e8eaed; --muted: #9aa3ad; --line: #30353c; --soft: #24282e;
          --accent: #f0702a; --accent-hover: #f5844a; --ok: #3fb950; --err: #ff7b72;
          --ins-bg: rgba(46, 160, 67, .22); --ins-fg: #7ee787; --del-bg: rgba(248, 81, 73, .2); --del-fg: #ffa198;
          --shadow: 0 12px 32px rgba(0, 0, 0, .5);
        }
      }
      @media (prefers-reduced-motion: reduce) { .card, .bar::after, .spinner { animation: none !important; } }
      @keyframes enter { from { opacity: 0; transform: translateY(8px) scale(.98); } }
      *, *::before, *::after { box-sizing: border-box; }

      header { display: flex; align-items: center; gap: 10px; padding: 12px 12px 0 14px; }
      .logo { width: 22px; height: 22px; flex: none; display: block; }
      .logo svg { width: 100%; height: 100%; display: block; }
      .title { font-weight: 600; font-size: 14px; flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; }
      .title .icon { width: 16px; height: 16px; flex: none; }
      .title.ok .icon { color: var(--ok); }
      .title.err .icon { color: var(--err); }
      .title.info .icon { color: var(--muted); }
      .chip { font-size: 12px; font-weight: 500; color: var(--muted); background: var(--soft); border-radius: 999px; padding: 1px 8px; white-space: nowrap; }
      .x { all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; color: var(--muted); flex: none; }
      .x:hover { background: var(--soft); color: var(--fg); }
      .x svg { width: 14px; height: 14px; }

      .body { padding: 8px 14px 0 46px; }
      .msg { color: var(--muted); margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
      .box {
        margin: 2px 0 0; padding: 10px 12px; max-height: min(42vh, 320px); overflow: auto; white-space: pre-wrap;
        overflow-wrap: anywhere; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; font-size: 14px;
      }
      .body.wide { padding-left: 14px; }
      .stream { color: var(--muted); max-height: 4.5em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent); white-space: pre-wrap; overflow-wrap: anywhere; }
      ins { background: var(--ins-bg); color: var(--ins-fg); text-decoration: none; border-radius: 3px; padding: 0 1px; }
      del { background: var(--del-bg); color: var(--del-fg); text-decoration: line-through; text-decoration-thickness: 1px; border-radius: 3px; padding: 0 1px; }
      .reason { font-size: 12.5px; color: var(--muted); margin: 0 0 8px; }

      footer { display: flex; align-items: center; gap: 8px; padding: 12px 12px 12px 14px; }
      footer .grow { flex: 1; min-width: 0; }
      .note { font-size: 12px; color: var(--muted); }
      .note a, .msg a { color: var(--accent); text-decoration: none; font-weight: 500; }
      .note a:hover, .msg a:hover { text-decoration: underline; }
      .keys { font-size: 11.5px; color: var(--muted); padding: 0 14px 10px; margin-top: -4px; text-align: right; }
      kbd { font: inherit; font-size: 11px; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: var(--soft); }

      button.btn {
        all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
        height: 32px; padding: 0 14px; border-radius: 8px; font-size: 13px; font-weight: 600; white-space: nowrap;
        border: 1px solid var(--line); background: var(--bg); color: var(--fg); transition: background .12s, border-color .12s;
      }
      button.btn:hover { background: var(--soft); }
      button.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
      button.btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
      button.btn.ghost { border-color: transparent; background: transparent; color: var(--muted); padding: 0 8px; }
      button.btn.ghost:hover { color: var(--fg); background: var(--soft); }
      button.btn[disabled] { opacity: .45; cursor: not-allowed; }
      button.btn svg { width: 14px; height: 14px; }
      button:focus-visible, .x:focus-visible, a:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 2px; }

      .spinner { width: 16px; height: 16px; border-radius: 50%; flex: none; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin .7s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      .bar { height: 3px; background: var(--soft); position: relative; overflow: hidden; margin-top: 12px; }
      .bar::after { content: ""; position: absolute; inset: 0 auto 0 0; width: 35%; background: var(--accent); border-radius: 3px; animation: slide 1.1s ease-in-out infinite; }
      @keyframes slide { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
      .skeleton { display: grid; gap: 6px; }
      .skeleton i { display: block; height: 9px; border-radius: 4px; background: var(--soft); }
      .skeleton i:nth-child(2) { width: 82%; }
      .compact header { padding-bottom: 12px; }
      .compact .title { font-weight: 500; }
    </style>
    <div class="card"></div>`;
  const card = /** @type {HTMLDivElement} */ (shadow.querySelector(".card"));
  let hideTimer = 0;
  let hovering = false;
  card.addEventListener("mouseenter", () => (hovering = true));
  card.addEventListener("mouseleave", () => {
    hovering = false;
    if (card.dataset.autohide) scheduleHide(Number(card.dataset.autohide));
  });

  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
    clearTimeout(hideTimer);
    delete card.dataset.autohide;
  }

  function hide() {
    clearTimeout(hideTimer);
    host.remove();
  }

  /** @param {number} ms */
  function scheduleHide(ms) {
    card.dataset.autohide = String(ms);
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => !hovering && hide(), ms);
  }

  /** Tiny element helper: h("div", {className: "x"}, child, "text", ...). */
  function h(tag, props = {}, ...children) {
    const node = Object.assign(document.createElement(tag), props);
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function svg(markup, className = "icon") {
    const span = h("span", { className });
    span.innerHTML = markup; // static, trusted markup from ICONS
    return span;
  }

  function linkEl(link) {
    return h("a", { href: link.url, target: "_blank", rel: "noopener noreferrer", textContent: link.text });
  }

  /**
   * @param {{title: string | Node, icon?: "ok" | "err" | "info" | "spin", chip?: string, onClose?: () => void}} opts
   */
  function header({ title, icon, chip, onClose = dismiss }) {
    const iconEl =
      icon === "spin" ? h("span", { className: "spinner", role: "presentation" })
      : icon === "ok" ? svg(ICONS.check)
      : icon === "err" ? svg(ICONS.alert)
      : icon === "info" ? svg(ICONS.info)
      : null;
    const close = h("button", { className: "x", title: "Close (Esc)", ariaLabel: "Close", onclick: onClose });
    close.innerHTML = ICONS.close;
    return h(
      "header",
      {},
      svg(ICONS.logo, "logo"),
      h("div", { className: `title ${icon ?? ""}` }, iconEl, h("span", { textContent: title }), chip ? h("span", { className: "chip", textContent: chip }) : null),
      close,
    );
  }

  /** @param {...Node} nodes */
  function render(className, role, ...nodes) {
    mount();
    card.className = `card ${className}`;
    card.setAttribute("role", role);
    card.setAttribute("aria-label", "Nibly");
    card.replaceChildren(...nodes);
  }

  function planNoteEl(note) {
    return note ? h("div", { className: "note grow" }, `${note.text} · `, linkEl(note.link)) : h("div", { className: "grow" });
  }

  // --- States ---------------------------------------------------------------------------------

  function showWorking() {
    const labels = LABELS[job.actionId];
    render(
      "working",
      "status",
      header({ title: labels.busy, icon: "spin", onClose: cancelJob }),
      h("div", { className: "body" }, h("div", { className: "skeleton", ariaHidden: "true" }, h("i"), h("i"))),
      h("footer", {}, planNoteEl(job.planNote), h("span", { className: "note" }, "Esc to cancel")),
      h("div", { className: "bar" }),
    );
  }

  /** @param {string} text */
  function showProgress(text) {
    const body = card.querySelector(".working .body");
    if (!body || !text) return;
    const stream = body.querySelector(".stream") ?? h("div", { className: "stream" });
    stream.textContent = text.length > 400 ? `…${text.slice(-400)}` : text;
    body.replaceChildren(stream);
  }

  /** Short confirmation after an automatic replacement, with Undo. */
  function showDone(title, chip, target) {
    let undone = false;
    const undo = h("button", {
      className: "btn",
      textContent: "Undo",
      onclick: () => {
        if (undone) return;
        undone = undoTarget(target);
        showToast(undone ? "Change undone" : `Press ${UNDO_KEYS} in the text to undo`, undone ? "ok" : "info");
      },
    });
    render(
      "compact",
      "status",
      h(
        "header",
        {},
        svg(ICONS.logo, "logo"),
        h("div", { className: "title ok" }, svg(ICONS.check), h("span", { textContent: title }), chip ? h("span", { className: "chip", textContent: chip }) : null),
        undo,
        closeButton(),
      ),
    );
    scheduleHide(5000);
  }

  function closeButton() {
    const close = h("button", { className: "x", title: "Close (Esc)", ariaLabel: "Close", onclick: dismiss });
    close.innerHTML = ICONS.close;
    return close;
  }

  /** @param {string} title @param {"ok" | "info"} kind */
  function showToast(title, kind = "ok") {
    render(
      "compact",
      "status",
      h("header", {}, svg(ICONS.logo, "logo"), h("div", { className: `title ${kind}` }, svg(kind === "ok" ? ICONS.check : ICONS.info), h("span", { textContent: title })), closeButton()),
    );
    scheduleHide(2500);
  }

  /**
   * Review panel: the result (with highlighted changes for Fix), Try again, Copy and Replace.
   * Replace is always shown; it is disabled with the reason when the selection can't be replaced.
   */
  function showReview() {
    const current = job;
    const labels = LABELS[current.actionId];
    const result = current.result;
    const diff = current.actionId === "fix" ? globalThis.NiblyDiff.diffWords(current.text, result) : null;
    const blocked = replaceBlockedReason(current);

    const content = h("div", { className: "box", tabIndex: 0, ariaLabel: "Result" });
    if (diff) {
      for (const op of diff.ops) content.append(op.type === "same" ? op.text : h(op.type, { textContent: op.text }));
    } else {
      content.textContent = result;
    }

    const replaceBtn = h("button", {
      className: "btn primary",
      textContent: "Replace",
      disabled: !!blocked,
      title: blocked || `Replace the selected text (${UNDO_KEYS} to undo)`,
      onclick: () => {
        if (job !== current) return hide();
        if (replaceBlockedReason(current)) return showReview(); // re-render with the reason
        replaceTarget(current.target, current.lead + result + current.trail);
        job = null;
        showDone(labels.done, diff ? changesLabel(diff.changes) : "", current.target);
      },
    });
    const copyBtn = h("button", {
      className: "btn",
      textContent: "Copy",
      onclick: async () => {
        await copy(result);
        copyBtn.replaceChildren(svg(ICONS.check), "Copied");
        setTimeout(() => copyBtn.isConnected && copyBtn.replaceChildren("Copy"), 1600);
      },
    });
    const againBtn = h("button", { className: "btn ghost", title: labels.again, onclick: () => retry() }, svg(ICONS.retry), labels.again);

    render(
      "review",
      "dialog",
      header({ title: labels.review, chip: diff ? changesLabel(diff.changes) : "" }),
      h("div", { className: "body wide" }, blocked ? h("p", { className: "reason", textContent: blocked }) : null, content),
      h("footer", {}, againBtn, h("div", { className: "grow" }), copyBtn, replaceBtn),
      h(
        "div",
        { className: "keys" },
        current.planNote ? h("span", {}, `${current.planNote.text} · `, linkEl(current.planNote.link), " · ") : null,
        ...(blocked ? [] : [h("kbd", { textContent: "Enter" }), " replace · "]),
        h("kbd", { textContent: "Esc" }),
        " close",
      ),
    );
    (blocked ? copyBtn : replaceBtn).focus();
  }

  /** @param {number} n */
  function changesLabel(n) {
    return n === 1 ? "1 change" : `${n} changes`;
  }

  /**
   * @param {{title: string, message: string, link?: {text: string, url: string}, actions?: string[], kind?: "err" | "info"}} e
   */
  function showError({ title, message, link, actions = [], kind = "err" }) {
    const buttons = [];
    if (actions.includes("retry") && job) {
      buttons.push(h("button", { className: "btn", onclick: () => retry() }, svg(ICONS.retry), "Try again"));
    }
    if (actions.includes("settings")) {
      buttons.push(
        h("button", {
          className: buttons.length ? "btn" : "btn primary",
          textContent: "Open settings",
          onclick: () => {
            chrome.runtime.sendMessage({ type: "nibly:openSettings" });
            dismiss();
          },
        }),
      );
    }
    if (link) buttons.push(h("button", { className: "btn primary", textContent: link.text, onclick: () => window.open(link.url, "_blank", "noopener") }));
    render(
      "error",
      kind === "err" ? "alert" : "status",
      header({ title, icon: kind }),
      h("div", { className: "body" }, h("p", { className: "msg", textContent: message })),
      buttons.length ? h("footer", {}, h("div", { className: "grow" }), ...buttons) : h("div", { style: "height:12px" }),
    );
    // No autofocus here: the user may still be typing in the page, and Enter must not trigger a button.
  }

  /** @param {string} text */
  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = h("textarea", { value: text });
      shadow.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  /** Why the job's selection cannot be replaced right now, or "" if it can. */
  function replaceBlockedReason(current) {
    if (!current) return "The selection is no longer available. Copy the text instead.";
    if (current.target.kind === "static") return "This text isn't editable, so you can copy the result instead.";
    if (currentTargetText(current.target) !== current.snapshot) {
      return "The original text was edited in the meantime, so it can no longer be replaced. Copy the result instead.";
    }
    return "";
  }

  /** Ask the service worker for a new result for the same text ("Try again" / "Another version"). */
  function retry() {
    if (!job) return;
    job.jobId = crypto.randomUUID();
    job.result = null;
    showWorking();
    chrome.runtime.sendMessage({ type: "nibly:retry", jobId: job.jobId, actionId: job.actionId, text: job.text, review: job.review });
  }

  function cancelJob() {
    job = null;
    hide();
  }

  /** Close the card; an in-flight request's result is then ignored. */
  function dismiss() {
    if (job && !job.result) job = null;
    hide();
  }

  addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && host.isConnected) {
        e.stopPropagation();
        dismiss();
      }
    },
    true,
  );

  // ------------------------------------------------------------------------------------------
  // Messages from the service worker

  /** @param {any} msg */
  function handle(msg) {
    switch (msg.type) {
      case "capture": {
        const captured = captureSelection();
        if (!captured || !captured.text.trim()) {
          job = null;
          return { ok: false };
        }
        const { text, target } = captured;
        job = {
          jobId: msg.jobId,
          actionId: msg.actionId in LABELS ? msg.actionId : "fix",
          target,
          snapshot: currentTargetText(target),
          text: text.trim(),
          lead: text.match(/^\s*/)[0],
          trail: text.match(/\s*$/)[0],
          planNote: safeNote(msg.planNote),
          review: msg.review === true, // "Fix and review…": keep reviewing on Try again
          result: null,
        };
        showWorking();
        return { ok: true, text: job.text, editable: target.kind !== "static" };
      }

      case "progress": {
        if (job?.jobId === msg.jobId && !job.result) showProgress(String(msg.text ?? ""));
        return { ok: true };
      }

      case "result": {
        if (!job || job.jobId !== msg.jobId) return { ok: false }; // dismissed by the user
        const labels = LABELS[job.actionId];
        job.result = String(msg.text);
        if (job.result.trim() === job.text) {
          job = null;
          showToast(labels.none, "ok");
          return { ok: true };
        }
        if (!msg.preview && !replaceBlockedReason(job)) {
          const { target, lead, trail, actionId, text } = job;
          replaceTarget(target, lead + job.result + trail);
          const diff = actionId === "fix" ? globalThis.NiblyDiff.diffWords(text, job.result) : null;
          job = null;
          showDone(labels.done, diff ? changesLabel(diff.changes) : "", target);
        } else {
          showReview();
        }
        return { ok: true };
      }

      case "error": {
        if (msg.jobId && (!job || job.jobId !== msg.jobId)) return { ok: false };
        if (!msg.jobId) job = null;
        showError({
          title: String(msg.title ?? "Nibly"),
          message: String(msg.message ?? ""),
          link: safeLink(msg.link),
          actions: Array.isArray(msg.actions) ? msg.actions : [],
          kind: msg.jobId ? "err" : "info",
        });
        return { ok: true };
      }
    }
    return { ok: false };
  }

  /** Only allow https links (defense in depth; messages come from our own worker). */
  function safeLink(link) {
    return link && typeof link.url === "string" && link.url.startsWith("https://") ? { text: String(link.text), url: link.url } : undefined;
  }

  function safeNote(note) {
    const link = note && safeLink(note.link);
    return link ? { text: String(note.text), link } : null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      sendResponse(handle(msg));
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  });

  globalThis.__nibly = true;
})();
