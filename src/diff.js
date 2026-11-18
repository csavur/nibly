// Word-level diff used to show what "Fix" changed. Classic script shared by the in-page UI
// (injected before content.js) and the settings page; exposes globalThis.NiblyDiff.
(() => {
  /** @param {string} text */
  function tokenize(text) {
    return text.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  }

  /**
   * Longest-common-subsequence diff over word tokens.
   * @returns {{ops: {type: "same" | "del" | "ins", text: string}[], changes: number} | null}
   *          null when the texts are too long to diff cheaply.
   */
  function diffWords(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length * b.length > 400_000) return null;
    const n = a.length;
    const m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    /** @type {{type: "same" | "del" | "ins", text: string}[]} */
    const ops = [];
    const push = (type, text) => {
      const last = ops[ops.length - 1];
      if (last?.type === type) last.text += text;
      else ops.push({ type, text });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) push("same", a[i++]), j++;
      else if (lcs[i + 1][j] >= lcs[i][j + 1]) push("del", a[i++]);
      else push("ins", b[j++]);
    }
    while (i < n) push("del", a[i++]);
    while (j < m) push("ins", b[j++]);
    // A "change" is a run of edits not separated by unchanged words (whitespace alone doesn't separate).
    let changes = 0;
    let inChange = false;
    for (const op of ops) {
      if (op.type === "same" && op.text.trim()) inChange = false;
      else if (op.type !== "same" && !inChange) {
        changes++;
        inChange = true;
      }
    }
    return { ops, changes };
  }

  globalThis.NiblyDiff = { diffWords, tokenize };
})();
