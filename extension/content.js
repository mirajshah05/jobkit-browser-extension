/* SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 */
/** MV3 content script — fill forms, auto-learn answers, and require user submit. */

const KNOCKOUT_PATTERNS = [/sponsor/i, /authorization/i, /clearance/i, /salary/i, /felon/i];
const FILL_RUN_BUDGET_MS = 20000;
const MAX_REPAIR_PASSES = 1;
const MAX_PACKAGE_RETRIES = 1;
const BOARD_HINTS = {
  stripe: "stripe",
  pinterest: "pinterest",
  discord: "discord",
  datadog: "datadog",
  plaid: "plaid",
  mongodb: "mongodb",
};

function boardTokenFromHost(host) {
  const h = (host || "").toLowerCase();
  if (h === "127.0.0.1" || h === "localhost") return "jobkit-test";
  for (const [needle, token] of Object.entries(BOARD_HINTS)) {
    if (h.includes(needle)) return token;
  }
  return null;
}

let ctx = null;
let captureTimer = null;
let userEditedSinceCapture = false;
let lastCaptureKey = "";
let formObserver = null;
let autoFlowStarted = false;
let fillInProgress = false;
let packageRetryTimer = null;
let autoFillDebounceTimer = null;
let dynamicFillTimer = null;
let reviewTimer = null;
let reviewInterval = null;
let reviewRemaining = 0;
let userStarted = false;
let fillDeadline = 0;
let repairPasses = 0;
let packageRetryCount = 0;
const knownQuestionKeys = new Set();

function detectPlatform() {
  const host = location.hostname;
  if (host.includes("greenhouse.io")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("ashbyhq.com")) return "ashby";
  if (host.includes("stripe.com")) return "greenhouse";
  if (boardTokenFromHost(host)) return "greenhouse";
  return null;
}

function parseJobFromUrl() {
  const platform = detectPlatform();
  const url = location.href;
  const params = new URLSearchParams(location.search);
  const ghJid = params.get("gh_jid");
  if (ghJid) {
    return {
      platform: platform || "greenhouse",
      jobId: ghJid,
      boardToken: boardTokenFromHost(location.hostname),
      url,
    };
  }
  const path = location.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (platform === "greenhouse" && location.hostname.includes("greenhouse.io")) {
    const embedBoard = params.get("for");
    const embedJob = params.get("token");
    if (embedBoard && embedJob) {
      return { platform, boardToken: embedBoard, jobId: embedJob, url };
    }
  }
  if (platform === "greenhouse" && location.hostname.includes("stripe.com") && parts.includes("apply")) {
    const last = parts[parts.length - 1];
    if (/^\d+$/.test(last)) {
      return { platform, boardToken: "stripe", jobId: last, url };
    }
  }
  if (platform === "greenhouse" && parts.length >= 3 && parts[1] === "jobs") {
    return { platform, boardToken: parts[0], jobId: parts[2], url };
  }
  if (platform === "lever" && parts.length >= 2) {
    return { platform, boardToken: parts[0], jobId: parts[1], url };
  }
  if (platform === "ashby" && parts.length >= 2) {
    return { platform, boardToken: parts[0], jobId: parts[1], url };
  }
  return { platform, boardToken: null, jobId: null, url };
}

function currentJobKey(job = parseJobFromUrl()) {
  return [job.platform || "", job.boardToken || "", job.jobId || ""].join(":");
}

function jobStorageKey(base, job = parseJobFromUrl()) {
  return `${base}:${currentJobKey(job)}`;
}

function isInApplyFrame() {
  return (
    location.hostname.includes("greenhouse.io") ||
    location.pathname.includes("/apply/") ||
    new URLSearchParams(location.search).has("gh_jid")
  );
}

function isVisible(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function fieldLabel(el) {
  const labelFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
  const labelledBy = String(el.getAttribute?.("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim())
    .filter(Boolean)
    .join(" ");
  return (
    el.labels?.[0]?.textContent ||
    labelFor?.textContent ||
    labelledBy ||
    el.closest("label")?.textContent ||
    el.getAttribute("aria-label") ||
    el.getAttribute("placeholder") ||
    el.name ||
    el.id ||
    ""
  ).trim();
}

function questionRoot(el) {
  if (!el) return null;
  return (
    el.closest(
      '.field, .question, .select-field, [class*="field-wrapper"], [class*="FieldWrapper"], .application-question, [class*="Question"], [data-question], fieldset',
    ) || el.parentElement?.parentElement || el.parentElement
  );
}

function cleanQuestionText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*\*\s*$/g, "")
    .trim()
    .slice(0, 1200);
}

function fieldQuestionText(el) {
  const root = questionRoot(el);
  const parts = [];
  const add = (value) => {
    const text = cleanQuestionText(value);
    if (text && !parts.includes(text)) parts.push(text);
  };

  const labelledBy = String(el?.getAttribute?.("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean);
  labelledBy.forEach((id) => add(document.getElementById(id)?.textContent));
  const describedBy = String(el?.getAttribute?.("aria-describedby") || "")
    .split(/\s+/)
    .filter(Boolean);
  describedBy.forEach((id) => add(document.getElementById(id)?.textContent));
  add(fieldLabel(el));

  if (root) {
    root.querySelectorAll("label, legend, .field-label, [class*='description'], [class*='helper'], p")
      .forEach((node) => {
        if (!isVisible(node) || node.closest('[role="option"], [role="listbox"], .select__menu, [class*="menu"]')) return;
        add(node.textContent);
      });
  }
  return cleanQuestionText(parts.join(" — ") || fieldLabel(el) || el?.name || el?.id || "Question");
}

function stableDomFieldName(el, question) {
  const explicit = el?.name || el?.id;
  const root = questionRoot(el);
  const isCombobox =
    el?.getAttribute?.("role") === "combobox" || el?.getAttribute?.("aria-haspopup") === "listbox";
  const namedBackingInput =
    isCombobox
      ? root?.querySelector?.('input[type="hidden"][name], input[tabindex="-1"][name]')
      : null;
  if (namedBackingInput?.name) return namedBackingInput.name;
  if (isCombobox && question && ctx?.field_meta?.length) {
    let bestMeta = null;
    let bestScore = 0;
    for (const meta of ctx.field_meta) {
      if (!meta?.name) continue;
      const score = Math.max(
        tokenOverlap(question, meta.question || ""),
        tokenOverlap(question, meta.label || ""),
      );
      if (score > bestScore) {
        bestScore = score;
        bestMeta = meta;
      }
    }
    if (bestMeta && bestScore >= 0.65) return bestMeta.name;
  }
  if (explicit) return explicit;
  const shellName = fieldNameFromShell(el?.closest?.(".select-shell, .select"));
  if (shellName) return shellName;
  const slug = String(question || "question")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `dom_question_${slug || "unknown"}`;
}

function requiredForField(el, root = questionRoot(el)) {
  return !!(
    el?.required ||
    el?.getAttribute?.("aria-required") === "true" ||
    root?.querySelector?.("[required], [aria-required='true'], .required, [class*='required']") ||
    /\*/.test(root?.querySelector?.("label, legend, .field-label")?.textContent || "")
  );
}

function visibleOptionsForField(el, root = questionRoot(el)) {
  if (el?.tagName === "SELECT") {
    return [...el.options].map((opt) => opt.text.trim()).filter(Boolean);
  }
  const shell = el?.closest?.(".select-shell, .select") || root?.querySelector?.(".select-shell, .select");
  const openOptions = shell ? getSelectOptionsForShell(shell) : [];
  if (openOptions.length) return openOptions.map((opt) => cleanQuestionText(opt.textContent)).filter(Boolean);
  const metaName = stableDomFieldName(el, fieldQuestionText(el));
  return fieldOptionsFromMeta(metaName).map((opt) => cleanQuestionText(opt)).filter(Boolean);
}

function readFieldValue(el, root = questionRoot(el)) {
  if (!el && !root) return "";
  if (el?.tagName === "SELECT") return el.options[el.selectedIndex]?.text?.trim() || "";
  if (el?.type === "checkbox") return el.checked ? (el.value || "Yes") : "";
  if (el?.type === "radio") return el.checked ? (el.value || fieldLabel(el) || "Yes") : "";
  if (el?.getAttribute?.("role") === "combobox" || el?.getAttribute?.("aria-haspopup") === "listbox") {
    const shell = el.closest?.('.select-shell, .select');
    if (shell) {
      const selected = selectedLabelsForShell(shell);
      if (selected.length) return selected.join(', ');
    }
    const backingInput = root?.querySelector?.('input[type="hidden"][name], input[tabindex="-1"][name]');
    if (backingInput) return String(backingInput.value || "").trim();
    const displayed = String(el.textContent || "").replace(/\s+/g, " ").trim();
    if (displayed && !/^(select|choose)( one|\.\.\.)?$/i.test(displayed)) return displayed;
    return "";
  }
  if (el && typeof el.value !== "undefined") return String(el.value || "").trim();
  const multi = [...(root?.querySelectorAll?.(".select__multi-value__label") || [])]
    .map((n) => n.textContent.trim()).filter(Boolean);
  const single = root?.querySelector?.(".select__single-value")?.textContent?.trim();
  return multi.length ? multi.join(", ") : single || "";
}

function fieldSnapshot(el, widget = null) {
  const root = questionRoot(el);
  const question = fieldQuestionText(el || root);
  const name = stableDomFieldName(el, question);
  const detected = widget || (el?.tagName === "SELECT" ? "select" : el?.type === "checkbox" ? "checkbox" : el?.type === "radio" ? "radio" : el?.tagName?.toLowerCase() || "text");
  return {
    name,
    label: fieldLabel(el || root) || name,
    question,
    value: readFieldValue(el, root),
    widget: detected,
    options: visibleOptionsForField(el, root),
    required: requiredForField(el, root),
  };
}

function scrapeFormQuestions() {
  const byName = new Map();
  const add = (snapshot) => {
    if (!snapshot?.name || !snapshot.question) return;
    const prior = byName.get(snapshot.name);
    if (!prior || snapshot.question.length > prior.question.length || snapshot.options.length > prior.options.length) {
      byName.set(snapshot.name, { ...prior, ...snapshot, options: snapshot.options.length ? snapshot.options : (prior?.options || []) });
    }
  };
  document.querySelectorAll(formFieldSelector()).forEach((el) => {
    if (!isVisible(el) || el.type === "hidden" || el.type === "file" || el.type === "password") return;
    add(fieldSnapshot(el));
  });
  document.querySelectorAll(".select-shell, .select").forEach((shell) => {
    if (!isVisible(shell)) return;
    add(fieldSnapshot(shell, shell.querySelector(".select__control, [role='combobox']") ? "select" : "custom_select"));
  });
  document.querySelectorAll("[role='combobox'], [aria-haspopup='listbox']").forEach((el) => {
    if (!isVisible(el)) return;
    add(fieldSnapshot(el, "combobox"));
  });
  return [...byName.values()];
}

function formFieldSelector() {
  return "input[name], textarea[name], select[name], input[id], textarea[id], select[id]";
}

function isCaptchaField(el) {
  if (!el) return false;
  const hay = `${el.name || ""} ${el.id || ""} ${el.className || ""}`.toLowerCase();
  return /recaptcha|captcha|g-recaptcha|h-captcha|cf-turnstile|turnstile/.test(hay);
}

function isHiddenReactSelectRequiredInput(el) {
  if (!el || el.tagName !== "INPUT") return false;
  if (el.getAttribute("aria-hidden") !== "true") return false;
  if (String(el.className || "").includes("requiredInput")) return true;
  return el.tabIndex === -1 && !!el.closest(".select-shell, .select__container");
}

function reactSelectShell(el) {
  return el?.closest(".select-shell, .select, .select__container");
}

function reactSelectIsFilled(shell) {
  if (!shell) return false;
  if (selectedLabelsForShell(shell).length) return true;
  const placeholder = shell.querySelector(".select__placeholder");
  if (placeholder && !isVisible(placeholder)) return true;
  const hidden = shell.querySelector('input[tabindex="-1"][aria-hidden="true"]');
  if (hidden && String(hidden.value || "").trim()) return true;
  return false;
}

function shouldSkipValidationField(el) {
  if (!el || !isVisible(el)) return true;
  if (el.type === "hidden") return true;
  if (isCaptchaField(el)) return true;
  if (isHiddenReactSelectRequiredInput(el)) return true;
  const shell = reactSelectShell(el);
  if (shell && (el.getAttribute("role") === "combobox" || el.classList.contains("select__input"))) {
    return reactSelectIsFilled(shell);
  }
  return false;
}

function selectValueAliases(value, labelHint = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const hint = String(labelHint || "").toLowerCase();
  if (/don'?t wish|decline|do not want to answer|prefer not/i.test(lower)) {
    return [
      raw,
      "I don't wish to answer",
      "Decline To Self Identify",
      "Decline to Self Identify",
      "I do not want to answer",
    ];
  }
  if (lower === "no") {
    const aliases = [raw, "No"];
    if (/veteran/.test(hint)) {
      aliases.push("I am not a protected veteran", "Not a protected veteran", "Not a veteran");
    }
    if (/disabilit/.test(hint)) {
      aliases.push(
        "No, I don't have a disability or have a history/record of having a disability",
        "No, I do not have a disability",
        "I don't have a disability",
      );
    }
    if (/hispanic|latino/.test(hint)) {
      aliases.push("Not Hispanic or Latino", "No, not Hispanic or Latino");
    }
    return aliases;
  }
  if (lower === "yes") return [raw, "Yes"];
  if (/^(united states|us|usa)(\s*\(?\+1\)?)?$/.test(lower)) {
    return [raw, 'United States', 'United States +1', 'United States (+1)'];
  }
  if (lower === "male") {
    if (/transgender/.test(hint)) return [raw, "No"];
    return [raw, "Male", "Man"];
  }
  if (lower === "female") return [raw, "Female", "Woman"];
  if (lower === "indian" || lower === "south asian" || lower.includes("indian subcontinent")) {
    return [
      "South Asian (inclusive of Afghani, Bangladeshi, Bhutanese, Indian, Nepali, Pakistani, and Sri Lankan)",
      "South Asian",
      "Asian (inclusive of Indian subcontinent)",
      "Asian",
    ];
  }
  if (lower === "asian") {
    return [raw, "Asian", "Asian (Not Hispanic or Latino)", "South Asian"];
  }
  if (/^i am not a protected veteran$/i.test(raw)) {
    return [raw, "I am not a protected veteran", "Not a protected veteran", "No"];
  }
  return [raw];
}

function scrapeFormFields() {
  const fields = [];
  const seen = new Set();
  const pushField = (name, label, value, widget, el = null) => {
    if (!name || !value || !String(value).trim()) return;
    const key = `${name}:${String(value).trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({
      name,
      label: label || name,
      value: String(value).trim(),
      widget: widget || "text",
      question: fieldQuestionText(el) || label || name,
      options: visibleOptionsForField(el),
      required: requiredForField(el),
    });
  };

  document.querySelectorAll(formFieldSelector()).forEach((el) => {
    if (!isVisible(el) || !el.closest("form")) return;
    if (el.type === "file" || el.type === "hidden" || el.type === "password" || isCaptchaField(el)) return;
    let value = el.value;
    if (el.type === "checkbox") value = el.checked ? "Yes" : "No";
    if (el.type === "checkbox") {
      const groupSize = el.name
        ? document.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(el.name)}"]`).length
        : 0;
      const isCheckboxGroup = el.name?.endsWith("[]") || groupSize > 1;
      if (isCheckboxGroup) {
        // A checkbox group's answer is the selected option label. Do not emit
        // unchecked siblings: merge_captured_fields() is keyed by name, so a
        // later unchecked option would otherwise overwrite a checked one.
        if (!el.checked) return;
        value = fieldLabel(el) || el.value || "Yes";
      }
    }
    if (el.type === "radio") {
      if (!el.checked) return;
      value = el.value || "Yes";
    }
    if (el.tagName === "SELECT") value = el.options[el.selectedIndex]?.text || el.value;
    pushField(el.name || el.id, fieldLabel(el), value, el.type === "checkbox" ? "checkbox" : el.tagName.toLowerCase(), el);
  });

  document.querySelectorAll(".select-shell, .select").forEach((shell) => {
    if (!isVisible(shell)) return;
    const name = fieldNameFromShell(shell);
    if (!name) return;
    const multi = [...shell.querySelectorAll(".select__multi-value__label")].map((n) => n.textContent.trim()).filter(Boolean);
    const single = shell.querySelector(".select__single-value")?.textContent?.trim();
    const value = multi.length ? multi.join(", ") : single;
    if (!value) return;
    pushField(name, fieldLabel(shell), value, multi.length ? "multi_select" : "select", shell);
  });

  document.querySelectorAll("[role='combobox'], [aria-haspopup='listbox']").forEach((el) => {
    if (!isVisible(el) || el.closest(".select-shell, .select")) return;
    const root = questionRoot(el);
    const value = readFieldValue(el, root);
    pushField(stableDomFieldName(el, fieldQuestionText(el)), fieldLabel(el), value, "combobox", el);
  });

  return fields;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extensionContextAlive() {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function showContextInvalidated() {
  const msg = "Extension reloaded — hard-refresh this tab (Cmd+Shift+R), then Connect API";
  if (typeof setPanelStatus === "function") setPanelStatus(msg);
  const panel = document.getElementById("jobkit-panel");
  if (panel && !document.getElementById("jobkit-invalid-banner")) {
    const banner = document.createElement("div");
    banner.id = "jobkit-invalid-banner";
    banner.className = "jobkit-note";
    banner.textContent = msg;
    panel.appendChild(banner);
  }
}

function safeSendMessage(message) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => finish({ error: "Jobkit background request timed out" }), 8000);
    if (!extensionContextAlive()) {
      showContextInvalidated();
      finish({ error: "Extension context invalidated — refresh page" });
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (/invalidated/i.test(err.message || "")) showContextInvalidated();
          finish({ error: err.message || String(err) });
          return;
        }
        finish(resp ?? {});
      });
    } catch (err) {
      if (/invalidated/i.test(String(err))) showContextInvalidated();
      finish({ error: String(err) });
    }
  });
}

function fillBudgetExpired() {
  return fillDeadline > 0 && Date.now() >= fillDeadline;
}

function fillBudgetRemaining(fallbackMs = 0) {
  if (!fillDeadline) return fallbackMs;
  return Math.max(0, Math.min(fallbackMs, fillDeadline - Date.now()));
}

async function safeStorageGet(keys) {
  if (!extensionContextAlive()) {
    showContextInvalidated();
    return {};
  }
  try {
    return await chrome.storage.local.get(keys);
  } catch (err) {
    if (/invalidated/i.test(String(err))) showContextInvalidated();
    return {};
  }
}

async function safeStorageSet(obj) {
  if (!extensionContextAlive()) return false;
  try {
    await chrome.storage.local.set(obj);
    return true;
  } catch (err) {
    if (/invalidated/i.test(String(err))) showContextInvalidated();
    return false;
  }
}

async function safeStorageRemove(keys) {
  if (!extensionContextAlive()) return false;
  try {
    await chrome.storage.local.remove(keys);
    return true;
  } catch (err) {
    if (/invalidated/i.test(String(err))) showContextInvalidated();
    return false;
  }
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripHtml(text) {
  return String(text || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\*+$/, "")
    .trim();
}

function labelPatternFromText(label) {
  const plain = stripHtml(label);
  if (!plain) return null;
  const words = plain.split(/\s+/).filter(Boolean);
  const snippet = words.slice(0, Math.min(8, words.length)).join(" ");
  return snippet ? new RegExp(escapeRegex(snippet), "i") : null;
}

function findFieldRootByName(name) {
  const escapedName = CSS.escape(name);
  const el = document.querySelector(
    `input[name="${escapedName}"], select[name="${escapedName}"], textarea[name="${escapedName}"], #${escapedName}`,
  );
  if (!el) return null;
  return (
    el.closest(
      '.field, .question, .select-field, [class*="field-wrapper"], [class*="FieldWrapper"], .application-question, [class*="Question"], [class*="select"]',
    ) || el.parentElement?.parentElement
  );
}

function findFieldRoot(labelRe) {
  const nodes = document.querySelectorAll("label, legend, .field-label, h3, p, span");
  for (const node of nodes) {
    const text = (node.textContent || "").replace(/\*/g, "").trim();
    if (!text || !labelRe.test(text)) continue;
    const root =
      node.closest(
        '.field, .question, .select-field, [class*="field-wrapper"], [class*="FieldWrapper"], .application-question',
      ) || node.parentElement?.parentElement;
    if (root) return root;
  }
  return null;
}

function setNativeValue(el, value) {
  if (!el || !["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return false;
  const proto =
    el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  return true;
}

function pickSelectOption(selectEl, value) {
  const target = String(value).trim().toLowerCase();
  const indianRace = target === "indian" || target === "south asian" || target.includes("indian subcontinent");
  if (indianRace) {
    const options = [...selectEl.options].filter((opt) => {
      const text = opt.text.trim().toLowerCase();
      return !/american indian|alaskan native|native american|indigenous american/.test(text);
    });
    const preferred = options.find((opt) => /south asian|indian subcontinent/.test(opt.text.trim().toLowerCase()));
    if (preferred) return preferred.index;
    const exact = options.find((opt) => opt.text.trim().toLowerCase() === "indian");
    if (exact) return exact.index;
    const generic = options.find((opt) => opt.text.trim().toLowerCase() === "asian");
    if (generic) return generic.index;
  }
  for (const opt of selectEl.options) {
    const text = opt.text.trim();
    if (text === value || opt.value === value) return opt.index;
    if (text.toLowerCase() === target) return opt.index;
  }
  for (const opt of selectEl.options) {
    if (opt.text.trim().toLowerCase().includes(target) || target.includes(opt.text.trim().toLowerCase())) {
      return opt.index;
    }
  }
  return -1;
}

function safeSetValue(el, value) {
  if (!el || !isVisible(el)) return false;
  if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) return false;
  if (["file", "password", "hidden"].includes(el.type) || isCaptchaField(el)) return false;
  if (el.getAttribute("role") === "combobox" || el.classList.contains("select__input")) return false;
  if (reactSelectShell(el)) return false;
  const strVal = String(value).trim();
  if (!strVal) return false;

  el.focus();

  if (el.type === "checkbox") {
    el.checked = /^(yes|true|1)$/i.test(strVal);
  } else if (el.type === "radio") {
    const group = document.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`);
    let matched = false;
    group.forEach((radio) => {
      const radioLabel = fieldLabel(radio);
      const hit =
        radio.value.toLowerCase() === strVal.toLowerCase() ||
        radioLabel.toLowerCase().includes(strVal.toLowerCase()) ||
        strVal.toLowerCase().includes(radioLabel.toLowerCase());
      if (hit) {
        radio.checked = true;
        radio.dispatchEvent(new Event("input", { bubbles: true }));
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        matched = true;
      }
    });
    return matched;
  } else if (el.tagName === "SELECT") {
    const idx = pickSelectOption(el, strVal);
    if (idx < 0) return false;
    el.selectedIndex = idx;
  } else {
    setNativeValue(el, strVal);
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
  return true;
}

function findSelectShellByFieldName(name) {
  if (!name) return null;
  const selectors = [];
  if (name.startsWith("demographic_")) {
    const demoId = name.split("_").pop();
    selectors.push(`#${CSS.escape(`react-select-${demoId}-live-region`)}`);
  }
  selectors.push(`#${CSS.escape(`react-select-${name}-live-region`)}`, `#${CSS.escape(`react-select-question_${name}-live-region`)}`);
  for (const sel of selectors) {
    const live = document.querySelector(sel);
    if (live) return live.closest(".select-shell, .select");
  }
  const label =
    document.querySelector(`label[for="${CSS.escape(name)}"]`) ||
    document.querySelector(`#${CSS.escape(name)}-label`);
  return label?.closest(".field-wrapper, .select, .field, .question")?.querySelector(".select-shell, .select");
}

function selectShellShowsValue(shell, value) {
  if (!shell || !value) return false;
  const target = String(value).trim().toLowerCase();
  const chosenValues = selectedLabelsForShell(shell);
  const multi = chosenValues;
  if (!chosenValues.length) return false;
  const chosen = chosenValues.join(", ").toLowerCase();
  const raceField = /race|ethnic/i.test(`${labelHintFromShell(shell)} ${fieldNameFromShell(shell) || ""}`);
  const raceTarget = String(value).trim().toLowerCase();
  if (raceField && (raceTarget === "indian" || raceTarget === "south asian" || raceTarget.includes("indian subcontinent"))) {
    // Generic "Asian" must not satisfy an Indian/South Asian request when a
    // board exposes a more specific option.
    return /south asian|indian subcontinent|\bindian\b/.test(chosen) &&
      !/american indian|alaskan native|native american|indigenous american/.test(chosen);
  }
  if (chosen === target) return true;
  if (selectTextContains(chosen, target) || selectTextContains(target, chosen)) return true;
  if (multi.some((selected) => selectValueAliases(value).some((alias) => {
    const a = alias.trim().toLowerCase();
    const s = selected.toLowerCase();
    return s === a || selectTextContains(s, a) || selectTextContains(a, s);
  }))) return true;
  return selectValueAliases(value).some((alias) => {
    const a = alias.trim().toLowerCase();
    return chosen === a || selectTextContains(chosen, a) || selectTextContains(a, chosen);
  });
}

function selectedLabelsForShell(shell) {
  if (!shell) return [];
  if (comboboxInputForShell(shell)?.id === 'country' && shell.querySelector('.select__single-value .iti__us')) {
    return ['United States +1'];
  }
  const labels = [shell.querySelector('.select__single-value')?.textContent?.trim(),
    ...[...shell.querySelectorAll('.select__multi-value__label')].map(node => node.textContent.trim())].filter(Boolean);
  if (labels.length) return labels;
  const input = comboboxInputForShell(shell);
  const requiredInput = shell.querySelector('input[aria-hidden="true"][required]');
  // Some Greenhouse controls display their committed label inside the
  // input. An empty required sentinel means it is still search text.
  if (input?.value?.trim() && input.getAttribute('aria-expanded') !== 'true' &&
      (!requiredInput || String(requiredInput.value || '').trim())) return [input.value.trim()];
  return [];
}

function fieldNameFromShell(shell) {
  if (!shell) return null;
  const live = shell.querySelector('[id^="react-select-"][id$="-live-region"]');
  if (live?.id) {
    const token = live.id.replace(/^react-select-/, "").replace(/-live-region$/, "");
    if (token.startsWith("question_")) return token;
    if (/^\d+$/.test(token)) return `demographic_${token}`;
    return token;
  }
  const input = shell.querySelector("[role='combobox']");
  if (input?.id) return input.id;
  return null;
}

function fieldOptionsFromMeta(name) {
  if (!name) return [];
  const meta = (ctx?.field_meta || []).find((f) => f.name === name);
  return meta?.options || [];
}

function detectSelectWidget(root) {
  if (!root) return "unknown";
  const shell = root.closest?.(".select-shell, .select") || root.querySelector?.(".select-shell, .select");
  if (shell?.querySelector?.(".select__control, [role='combobox']")) return "react-select";
  if (root.tagName === "SELECT" || root.querySelector?.("select")) return "native-select";
  if (root.querySelector?.("[role='combobox'], [aria-haspopup='listbox']")) return "combobox";
  if (root.querySelector?.(".select-shell, .select__control")) return "react-select";
  return "unknown";
}

function labelHintFromShell(shell) {
  if (!shell) return "";
  const label =
    shell.querySelector("label")?.textContent ||
    shell.closest(".field-wrapper, .field, .question")?.querySelector("label")?.textContent ||
    "";
  return label.trim();
}

function closeOpenSelectMenus() {
  const active = document.activeElement;
  active?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  if (active?.getAttribute("role") === "combobox") active.blur();
}

function comboboxInputForShell(shell) {
  return shell?.querySelector("input.select__input, [role='combobox']") || null;
}

function getSelectOptionsForShell(shell) {
  if (!shell) return [];
  const input = comboboxInputForShell(shell);
  const controlsId = input?.getAttribute("aria-controls");
  if (controlsId) {
    const listbox = document.getElementById(controlsId);
    if (listbox) {
      return [...listbox.querySelectorAll('[role="option"], .select__option')].filter(isVisible);
    }
  }
  const menu = shell.querySelector(".select__menu, [class*='select__menu-list']");
  if (menu && isVisible(menu)) {
    return [...menu.querySelectorAll('[role="option"], .select__option')].filter(isVisible);
  }
  // Portaled menus must be linked by aria-controls. Never borrow options
  // from another dropdown or an unrelated extension sidebar.
  return [];
}

async function waitForSelectMenu(shell, timeoutMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fillBudgetExpired()) break;
    const options = getSelectOptionsForShell(shell);
    if (options.length) return options;
    await sleep(25);
  }
  return getSelectOptionsForShell(shell);
}

async function clickReactSelectOption(option) {
  if (!option) return false;
  option.scrollIntoView({ block: "nearest", behavior: "instant" });
  option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  await sleep(10);
  option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  option.click();
  await sleep(40);
  return true;
}

function scoreSelectOption(text, aliases) {
  const tl = String(text || '').trim().toLowerCase();
  if (!tl) return -1;
  let bestScore = -1;
  for (const alias of aliases) {
    const target = String(alias).trim().toLowerCase();
    if (!target) continue;
    if (tl === target) bestScore = Math.max(bestScore, 100);
    else if (selectTextContains(tl, target) || selectTextContains(target, tl)) bestScore = Math.max(bestScore, 70);
  }
  return bestScore;
}

function selectTextContains(text, value) {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(value)}($|[^a-z0-9])`, 'i').test(text);
}

async function chooseReactSelectOption(shell, value, metaOptions = []) {
  const labelHint = labelHintFromShell(shell);
  const aliases = selectValueAliases(value, labelHint);
  if (metaOptions.length) {
    for (const optLabel of metaOptions) {
      if (scoreSelectOption(optLabel, aliases) >= 70) aliases.unshift(optLabel);
    }
  }

  let options = getSelectOptionsForShell(shell);
  if (!options.length) {
    await openReactSelectShell(shell);
    options = await waitForSelectMenu(shell);
  }
  if (!options.length) return false;

  const raceValue = String(value || "").trim().toLowerCase();
  if (raceValue === "indian" || raceValue === "south asian" || raceValue.includes("indian subcontinent")) {
    options = options.filter((opt) => {
      const text = (opt.textContent || "").toLowerCase();
      return !/american indian|alaskan native|native american|indigenous american/.test(text);
    });
  }

  let best = null;
  let bestScore = -1;
  for (const opt of options) {
    const score = scoreSelectOption(opt.textContent || "", aliases);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  if (!best || bestScore < 70) return false;
  await clickReactSelectOption(best);
  if (selectShellShowsValue(shell, value)) return true;

  closeOpenSelectMenus();
  await sleep(120);
  await openReactSelectShell(shell);

  const retryOptions = await waitForSelectMenu(shell);
  const retryFilteredOptions = (String(value || "").trim().toLowerCase() === "indian" ||
    String(value || "").trim().toLowerCase() === "south asian" ||
    String(value || "").toLowerCase().includes("indian subcontinent"))
    ? retryOptions.filter((opt) => !/american indian|alaskan native|native american|indigenous american/i.test(opt.textContent || ""))
    : retryOptions;
  let retryBest = null;
  let retryScore = -1;
  for (const opt of retryFilteredOptions) {
    const score = scoreSelectOption(opt.textContent || "", aliases);
    if (score > retryScore) {
      retryScore = score;
      retryBest = opt;
    }
  }
  if (retryBest && retryScore >= 70) {
    await clickReactSelectOption(retryBest);
  }
  return selectShellShowsValue(shell, value);
}

async function filterReactSelectOnce(input, text) {
  if (!input || !text) return;
  if (fillBudgetExpired()) return;
  input.focus();
  setNativeValue(input, "");
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  await sleep(60);
  setNativeValue(input, text);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(450);
}

async function openReactSelectShell(shell) {
  if (!shell) return null;
  if (fillBudgetExpired()) return null;
  const input = comboboxInputForShell(shell);
  if (input?.getAttribute("aria-expanded") === "true") return input;
  closeOpenSelectMenus();
  shell.scrollIntoView({ block: "center", behavior: "instant" });
  const toggle = shell.querySelector('button[aria-label="Toggle flyout"]');
  const control = shell.querySelector(".select__control");
  input?.focus();
  if (control) {
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  } else if (input) {
    input.focus();
    input.click();
  } else if (toggle) {
    toggle.click();
  }
  await sleep(40);
  if (input && input.getAttribute('aria-expanded') !== 'true') {
    input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    input.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    input.click();
    await sleep(40);
  }
  return input;
}

async function fillReactSelectByFieldName(name, value, options = {}) {
  const { skipReadyCheck = false } = options;
  if (fillBudgetExpired() || !name || !value || (!skipReadyCheck && !packageIsReady(ctx))) return false;
  const shell = findSelectShellByFieldName(name);
  if (!shell) return false;
  const fieldMeta = (ctx?.field_meta || []).find((field) => field.name === name);
  if (selectShellShowsValue(shell, value)) return true;

  const metaOptions = fieldOptionsFromMeta(name);
  await openReactSelectShell(shell);

  if (name === 'candidate-location') {
    const input = comboboxInputForShell(shell);
    await filterReactSelectOnce(input, String(value).trim());
    return chooseReactSelectOption(shell, value, metaOptions);
  }

  if (await chooseReactSelectOption(shell, value, metaOptions)) return true;

  const input = shell.querySelector("input.select__input") || shell.querySelector("[role='combobox']");
  if (input && String(value).trim().length >= 2) {
    await filterReactSelectOnce(input, String(value).trim());
    if (await chooseReactSelectOption(shell, value, metaOptions)) return true;
  }

  return selectShellShowsValue(shell, value);
}

async function fillReactSelect(root, value) {
  if (fillBudgetExpired() || !root || !value) return false;
  const shell = root.closest?.(".select-shell, .select") || root.querySelector?.(".select-shell, .select") || root;
  if (shell?.classList?.contains("select-shell") || shell?.querySelector?.(".select__control")) {
    const name = fieldNameFromShell(shell);
    if (name && (await fillReactSelectByFieldName(name, value))) return true;
    if (selectShellShowsValue(shell, value)) return true;
    closeOpenSelectMenus();
    await sleep(100);
    await openReactSelectShell(shell);
    if (await chooseReactSelectOption(shell, value)) return true;
    const input = shell.querySelector("input.select__input, [role='combobox']");
    if (input && String(value).trim().length >= 2) {
      await filterReactSelectOnce(input, String(value).trim());
      if (await chooseReactSelectOption(shell, value)) return true;
    }
    return selectShellShowsValue(shell, value) || reactSelectIsFilled(shell);
  }

  root.scrollIntoView({ block: "center", behavior: "instant" });

  const native = root.querySelector("select");
  if (native) {
    const idx = pickSelectOption(native, value);
    if (idx >= 0 && safeSetValue(native, native.options[idx].text)) return true;
  }

  const hidden = root.querySelector('input[type="hidden"][name], input[name][type="text"][tabindex="-1"]');
  const trigger = root.querySelector(
    '[role="combobox"], [class*="select__control"], button[aria-haspopup="listbox"], .select-shell, .select__button, [class*="Select__control"]',
  );
  if (!trigger) return false;

  trigger.focus();
  trigger.click();
  await sleep(350);

  const scopedShell = shell?.classList?.contains("select-shell") ? shell : root.closest?.(".select-shell, .select");
  let options = scopedShell ? getSelectOptionsForShell(scopedShell) : [];
  if (!options.length) {
    const menus = [...document.querySelectorAll('[class*="select__menu"], [role="listbox"], [class*="Select__menu"]')].filter(
      isVisible,
    );
    const menu = menus[menus.length - 1];
    options = menu
      ? [...menu.querySelectorAll('[role="option"], [class*="select__option"], [class*="Select__option"]')]
      : [];
  }

  const target = String(value).trim().toLowerCase();
  const indianRace = target === "indian" || target === "south asian" || target.includes("indian subcontinent");
  const optionPool = indianRace
    ? options.filter((opt) => !/american indian|alaskan native|native american|indigenous american/i.test(opt.textContent || ""))
    : options;
  const aliases = selectValueAliases(value, fieldLabel(root));
  let bestOption = null;
  let bestOptionScore = -1;
  for (const opt of optionPool) {
    const score = scoreSelectOption(opt.textContent || "", aliases);
    if (score > bestOptionScore) {
      bestOptionScore = score;
      bestOption = opt;
    }
  }
  if (bestOption && bestOptionScore >= 70) {
    await clickReactSelectOption(bestOption);
    return scoreSelectOption(readFieldValue(trigger, root), aliases) >= 70;
  }
  for (const opt of optionPool) {
    const text = opt.textContent.trim();
    if (text === value || text.toLowerCase() === target) {
      await clickReactSelectOption(opt);
      return scoreSelectOption(readFieldValue(trigger, root), aliases) >= 70;
    }
  }
  for (const opt of options) {
    const text = opt.textContent.trim().toLowerCase();
    if (text.includes(target) || target.includes(text)) {
      await clickReactSelectOption(opt);
      return scoreSelectOption(readFieldValue(trigger, root), aliases) >= 70;
    }
  }
  if (options.length === 1) {
    await clickReactSelectOption(options[0]);
    return scoreSelectOption(readFieldValue(trigger, root), aliases) >= 70;
  }

  document.body.click();
  return false;
}

async function fillMultiSelectByFieldName(name, value) {
  if (!name || !value) return false;
  const rawName = name.replace(/\[\]$/, "");
  const targets = String(value)
    .split(/[,;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!targets.length) return false;

  let touched = 0;
  const checkboxSelector = `input[type="checkbox"][name="${CSS.escape(name)}"], input[type="checkbox"][name="${CSS.escape(rawName)}[]"]`;
  for (const target of targets) {
    const boxes = document.querySelectorAll(checkboxSelector);
    for (const box of boxes) {
      if (!isVisible(box)) continue;
      const label = fieldLabel(box) || box.closest("label")?.textContent?.trim() || "";
      if (scoreSelectOption(label, selectValueAliases(target)) < 70) continue;
      if (!box.checked) {
        box.click();
      }
      if (box.checked) touched += 1;
    }
    if (!boxes.length && await fillReactSelectByFieldName(rawName, target, { skipReadyCheck: true })) touched += 1;
  }
  return touched > 0;
}

async function fillSelectByName(name, value) {
  if (!name || !value || !packageIsReady(ctx)) return false;
  if (name.endsWith("[]") || name.includes("[]")) {
    if (await fillMultiSelectByFieldName(name, value)) return true;
  }
  if (await fillReactSelectByFieldName(name, value)) return true;

  const escapedName = CSS.escape(name);
  const native = document.querySelector(`select[name="${escapedName}"], select#${escapedName}`);
  if (native) return safeSetValue(native, value);

  const root = findFieldRootByName(name);
  if (root && (await fillReactSelect(root, value))) return true;

  const meta = (ctx?.field_meta || []).find((f) => f.name === name);
  const labelPattern = labelPatternFromText(meta?.question || meta?.label || "");
  if (labelPattern && (await fillSelectByLabel(labelPattern, value))) return true;

  return fillSelectByLabel(new RegExp(escapeRegex(name.replace(/_/g, " ")), "i"), value);
}

async function fillNativeSelectInRoot(root, value) {
  const select = root.tagName === "SELECT" ? root : root.querySelector("select");
  if (!select) return false;
  const idx = pickSelectOption(select, value);
  if (idx < 0) return false;
  if (select.selectedIndex === idx) return true;
  return safeSetValue(select, select.options[idx].text);
}

async function fillGenericCombobox(root, value) {
  if (fillBudgetExpired()) return false;
  const combobox = root.querySelector("[role='combobox'], [aria-haspopup='listbox']");
  if (!combobox) return false;
  const shell = combobox.closest(".select-shell, .field, .question") || root;
  combobox.focus();
  combobox.click();
  await sleep(400);
  const controlsId = combobox.getAttribute("aria-controls");
  let options = [];
  if (controlsId) {
    const listbox = document.getElementById(controlsId);
    if (listbox) options = [...listbox.querySelectorAll('[role="option"]')].filter(isVisible);
  }
  if (!options.length) {
    const listbox = root.querySelector("[role='listbox']") || document.querySelector("[role='listbox']");
    if (listbox) options = [...listbox.querySelectorAll('[role="option"]')].filter(isVisible);
  }
  const labelHint = fieldLabel(combobox);
  const aliases = selectValueAliases(value, labelHint);
  let best = null;
  let bestScore = -1;
  for (const opt of options) {
    const score = scoreSelectOption(opt.textContent || "", aliases);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  if (!best || bestScore < 70) return false;
  await clickReactSelectOption(best);
  const chosenText = readFieldValue(combobox, shell);
  return scoreSelectOption(chosenText, aliases) >= 70;
}

async function fillAnySelectInRoot(root, value) {
  if (!root || !value) return false;
  const widget = detectSelectWidget(root);
  if (widget === "native-select") return fillNativeSelectInRoot(root, value);
  if (widget === "react-select") return fillReactSelect(root, value);
  if (widget === "combobox") return fillGenericCombobox(root, value);
  return fillReactSelect(root, value);
}

async function fillSelectByLabel(labelRe, value) {
  if (!value) return false;
  const root = findFieldRoot(labelRe);
  if (!root) return false;
  return fillAnySelectInRoot(root, value);
}

async function fillLocationCity(cityText) {
  if (fillBudgetExpired()) return false;
  const city = cityText || ctx?.contact?.location || ctx?.field_values?.location;
  if (!city) return false;

  const greenhouseCity = document.querySelector('#candidate-location');
  const cityShell = greenhouseCity?.closest('.select-shell');
  if (cityShell) {
    return fillReactSelectByFieldName('candidate-location', city, { skipReadyCheck: true });
  }

  let input =
    document.querySelector("#location-input") ||
    document.querySelector('input[placeholder*="City"]') ||
    document.querySelector('input[aria-label*="Location"]') ||
    document.querySelector('input[name*="location"]:not([type="hidden"])');

  if (!input) {
    const root = findFieldRoot(/location\s*\(city\)|^location$/i);
    input = root?.querySelector('input[type="text"], input:not([type="hidden"])');
  }
  if (!input || input.type === "hidden") return false;

  input.focus();
  setNativeValue(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(100);

  for (const ch of city) {
    if (fillBudgetExpired()) return false;
    setNativeValue(input, input.value + ch);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(20);
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(700);

  const suggestionSelectors = [
    '[class*="suggestion"]',
    '[role="option"]',
    ".tt-suggestion",
    "li[data-value]",
    '[class*="menu"] li',
    '[class*="dropdown"] li',
    "ul[role='listbox'] li",
  ];
  let suggestions = [];
  for (const sel of suggestionSelectors) {
    suggestions = [...document.querySelectorAll(sel)].filter(isVisible);
    if (suggestions.length) break;
  }

  const cityRoot = city.split(",")[0].trim().toLowerCase();
  for (const item of suggestions) {
    const text = item.textContent.trim();
    if (text.toLowerCase().includes(cityRoot)) {
      item.click();
      await sleep(150);
      return true;
    }
  }
  // Do not select an unrelated city or report that typing was a committed
  // autocomplete selection. Plain text city inputs can keep their value.
  return input.getAttribute('role') !== 'combobox' && !input.hasAttribute('aria-controls') && !suggestions.length;
}

async function fillPhoneCountryCode() {
  const requested = ctx?.field_values?.country || staticPrefs().country;
  if (!requested) return false;
  const candidates = selectValueAliases(requested);
  const phoneInput = document.querySelector('input[name="phone"], input[id="phone"]');
  const country = document.querySelector('#country');
  const countryShell = country?.closest('.select-shell');
  if (countryShell) {
    return fillReactSelectByFieldName('country', requested, { skipReadyCheck: true });
  }
  const phoneRoot =
    phoneInput?.closest(".field, .question, .application-question, .phone-input, form") ||
    findFieldRoot(/^phone$/i);
  if (phoneRoot) {
    for (const val of candidates) {
      if (fillBudgetExpired()) return false;
      const shell = phoneRoot.querySelector(".select-shell, .select");
      if (shell && (await fillReactSelect(shell, val))) return true;
    }
    for (const val of candidates) {
      if (fillBudgetExpired()) return false;
      if (await fillReactSelect(phoneRoot, val)) return true;
    }
  }
  const countryInPhone = findFieldRoot(/country\s*code|phone.*country/i);
  if (countryInPhone) {
    for (const val of candidates) {
      if (fillBudgetExpired()) return false;
      if (await fillReactSelect(countryInPhone, val)) return true;
    }
  }
  const native = phoneRoot?.querySelector('select[name*="country"], select[id*="country"]')
    || document.querySelector('select[name*="country"], select[id*="country"]');
  if (native) {
    for (const val of candidates) {
      if (safeSetValue(native, val)) return true;
    }
  }
  return false;
}

async function fillCurrentEmployer() {
  const val =
    ctx?.field_values?.question_15141009008 ||
    ctx?.learned_answers?.["field:question_15141009008"] ||
    ctx?.learned_answers?.["at which company are you currently working? *"] ||
    staticPrefs().current_employer || "";
  const byName = document.querySelector(
    'input[name="question_15141009008"], textarea[name="question_15141009008"]',
  );
  if (byName && safeSetValue(byName, val)) return true;
  const root = findFieldRoot(/currently working/i);
  const input = root?.querySelector('input[type="text"], textarea, input:not([type="hidden"])');
  return !!(input && safeSetValue(input, val));
}

async function fillPackageFieldsByName() {
  const values = ctx?.field_values || {};
  const meta = ctx?.field_meta || [];
  const metaByName = new Map(meta.map((f) => [f.name, f]));
  let filled = 0;

  for (const [name, value] of Object.entries(values)) {
    if (fillBudgetExpired()) break;
    if (!value || String(value).trim() === "") continue;
    if (shouldSkipVoluntaryField(metaByName.get(name)?.label || name, name)) continue;
    if (isSponsorshipFollowup(name, name) && !sponsorRequired()) continue;
    const fieldMeta = metaByName.get(name);
    const question = fieldMeta?.question || fieldMeta?.label || name;
    const fillValue = isRaceField(name, question) && staticPrefs().race
      ? staticPrefs().race
      : value;
    const widget = fieldMeta?.widget || "";
    const isSelect = widget === "select" || widget === "multi_select" || !!findSelectShellByFieldName(name);
    const isLocation = widget === "location" || name === "location" || name === "candidate-location";

    if (name.endsWith("[]") || widget === "checkbox") {
      if (await fillMultiSelectByFieldName(name, fillValue)) filled += 1;
      continue;
    }

    if (isLocation) {
      if (await fillLocationCity(fillValue)) filled += 1;
      continue;
    }

    if (isSelect) {
      closeOpenSelectMenus();
      await sleep(60);
      if (widget === "multi_select") {
        if (await fillMultiSelectByFieldName(name, fillValue)) {
          filled += 1;
          continue;
        }
      }
      if (await fillReactSelectByFieldName(name, fillValue, { skipReadyCheck: true })) {
        filled += 1;
        continue;
      }
      // Generic ARIA comboboxes often keep the package field name on a
      // sibling hidden input rather than on the visible trigger. Resolve the
      // named field container before falling back to label matching so these
      // widgets do not get mistaken for unsupported React selects.
      const namedRoot = findFieldRootByName(name);
      if (namedRoot && (await fillAnySelectInRoot(namedRoot, fillValue))) {
        filled += 1;
        continue;
      }
      const labelPattern = labelPatternFromText(fieldMeta?.label || question);
      if (labelPattern && (await fillSelectByLabel(labelPattern, fillValue))) {
        filled += 1;
        continue;
      }
    }

    const els = document.querySelectorAll(`[name="${CSS.escape(name)}"], #${CSS.escape(name)}`);
    for (const el of els) {
      if (fillBudgetExpired()) break;
      if (!isVisible(el) || el.type === "file" || el.type === "hidden" || el.type === "checkbox") continue;
      if (el.tagName === "SELECT") {
        if (await fillSelectByName(name, fillValue)) filled += 1;
      } else if (el.type === "radio") {
        if (safeSetValue(el, fillValue)) filled += 1;
      } else if (safeSetValue(el, fillValue)) {
        filled += 1;
      }
    }
  }
  return filled;
}

async function fillCriticalSelects() {
  const values = ctx?.field_values || {};
  const meta = ctx?.field_meta || [];
  const eeo = eeoAnswers();
  let filled = 0;

  for (const field of meta) {
    if (fillBudgetExpired()) break;
    const value = isRaceField(field.name, field.label) && staticPrefs().race
      ? staticPrefs().race
      : values[field.name];
    if (!value) continue;
    closeOpenSelectMenus();
    await sleep(60);
    if (field.widget === "multi_select") {
      if (await fillMultiSelectByFieldName(field.name, value)) filled += 1;
      continue;
    }
    if (field.widget === "select" && (await fillReactSelectByFieldName(field.name, value, { skipReadyCheck: true }))) {
      filled += 1;
    }
  }

  const labelFills = [
    [/visa sponsorship|require visa sponsorship for employment/i, values.question_68319125 || values.question_66419387 || sponsorshipKnockoutAnswer()],
    [/legally authorized to work/i, values.question_68319124 || authorizationAnswer()],
    [/country/i, values.country || staticPrefs().country || ""],
    [/u\.s\. state.*reside/i, values.question_65249873 || staticPrefs().us_state || ""],
    [/hispanic.*latino/i, values.hispanic_latino || eeo.hispanic],
    [/transgender/i, values.demographic_606 || values.transgender || eeo.transgender],
    [/gender identity|describe your gender/i, values.demographic_605 || values.gender || eeo.gender],
    [/^gender$/i, values.gender || eeo.gender],
    [/race\/ethnicity|^race$/i, values.race || values.ethnicity || eeo.race],
    [/veteran status/i, values.veteran_status || eeo.veteran],
    [/disability status/i, values.disability_status || eeo.disability],
  ];
  for (const [labelRe, value] of labelFills) {
    if (fillBudgetExpired()) break;
    if (!value) continue;
    closeOpenSelectMenus();
    await sleep(60);
    if (await fillSelectByLabel(labelRe, value)) filled += 1;
  }
  return filled;
}

async function fillRequiredDemographicDeclines() {
  let filled = 0;
  for (const shell of document.querySelectorAll('.select-shell')) {
    const input = comboboxInputForShell(shell);
    if (!input || input.getAttribute('aria-required') !== 'true' || reactSelectIsFilled(shell)) continue;
    const name = fieldNameFromShell(shell);
    if (!name?.startsWith('demographic_')) continue;
    if (ctx?.field_values?.[name]) continue;
    // A required demographic response without a saved answer must decline,
    // never infer sexual orientation or family/education background.
    if (await fillReactSelectByFieldName(name, 'Prefer not to say', { skipReadyCheck: true })) filled += 1;
  }
  return filled;
}

async function fillStructuredFields() {
  let filled = 0;
  const values = ctx?.field_values || {};
  const meta = ctx?.field_meta || [];
  const staticNo = staticPrefs().interviewed_before || "";
  const staticApplied = staticPrefs().applied_to_role_before || "";
  const skipVoluntary = !staticPrefs().fill_voluntary_eeo;

  for (const field of meta) {
    if (skipVoluntary && shouldSkipVoluntaryField(field.label, field.name)) continue;
    const value = isRaceField(field.name, field.label) && staticPrefs().race
      ? staticPrefs().race
      : values[field.name];
    if (!value) continue;
    if (field.widget === "location") {
      if (await fillLocationCity(value)) filled += 1;
      continue;
    }
    if (field.widget === "select" || field.widget === "multi_select") {
      closeOpenSelectMenus();
      await sleep(60);
      if (field.widget === "multi_select") {
        if (await fillMultiSelectByFieldName(field.name, value)) {
          filled += 1;
          continue;
        }
      }
      if (await fillReactSelectByFieldName(field.name, value, { skipReadyCheck: true })) {
        filled += 1;
        continue;
      }
      const labelPattern = labelPatternFromText(field.label);
      if (labelPattern && (await fillSelectByLabel(labelPattern, value))) filled += 1;
    }
  }

  const labelFills = [
    [/country/i, values.country || staticPrefs().country || ""],
    [/legally authorized/i, values.question_37463308002 || authorizationAnswer()],
    [/located in the us/i, staticPrefs().located_in_us],
    [/bay area/i, staticPrefs().bay_area],
    [/ai policy/i, values.question_15076690008 || staticPrefs().ai_policy_acknowledged],
    [/why anthropic/i, values.question_15076691008],
    [/visa sponsorship/i, values.question_15076692008 || sponsorshipKnockoutAnswer()],
    [/employment visa sponsorship/i, values.question_15076693008 || sponsorshipKnockoutAnswer()],
    [/open to relocation/i, values.question_15076696008 || relocationAnswer()],
    [/ever interviewed|interviewed.*before|interviewed at/i, values.question_15076698008 || staticNo],
    [/applied.*(this )?role before|applied for this role before/i, values.question_15141008008 || staticApplied],
    [/arbitration agreement below/i, values.question_18371805008],
    [/agreement to arbitrate/i, values.question_18374631008],
    [/currently working/i, values.question_15141009008 || staticPrefs().current_employer || ""],
    [/hispanic.*latino/i, values.hispanic_latino || staticPrefs().hispanic_latino || ""],
  ];
  if (!skipVoluntary) {
    const eeo = eeoAnswers();
    labelFills.splice(
      1,
      0,
      [/gender(?!.*identity)/i, values.gender || values.demographic_29783 || eeo.gender],
      [/race\/ethnicity|race(?!.*hispanic)/i, staticPrefs().race || values.race || values.demographic_29784 || eeo.race],
      [/veteran status/i, values.veteran_status || values.demographic_29785 || eeo.veteran],
      [/disability status/i, values.disability_status || values.demographic_29786 || eeo.disability],
    );
  }
  labelFills.splice(
    1,
    0,
    [/u\.s\. state.*reside/i, values.question_65249873 || staticPrefs().us_state || ""],
    [/legally authorized to work in the country/i, values.question_66419405 || authorizationAnswer()],
    [/require employer sponsorship/i, values.question_66419387 || sponsorshipKnockoutAnswer()],
  );
  for (const [re, val] of labelFills) {
    if (fillBudgetExpired()) break;
    if (!val) continue;
    if (await fillSelectByLabel(re, val)) filled += 1;
    else {
      const root = findFieldRoot(re);
      const textarea = root?.querySelector("textarea, input[type=text]:not([role='combobox']):not(.select__input)");
      if (textarea && !reactSelectShell(textarea) && safeSetValue(textarea, val)) filled += 1;
    }
  }

  if (!filled && values.location) {
    if (await fillLocationCity(values.location)) filled += 1;
  }
  return filled;
}

function tokenOverlap(a, b) {
  const ta = new Set(String(a).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  const tb = new Set(String(b).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
  if (!ta.size || !tb.size) return 0;
  let overlap = 0;
  ta.forEach((t) => {
    if (tb.has(t)) overlap += 1;
  });
  return overlap / Math.max(ta.size, tb.size);
}

function isRaceField(name, label) {
  const hay = `${name || ""} ${label || ""}`;
  return /race|ethnic/i.test(hay) && !/hispanic|latino/i.test(hay);
}

function staticPrefs() {
  return ctx?.static_answers || {};
}

function canonicalEmail() {
  return (
    ctx?.field_values?.email ||
    ctx?.contact?.email ||
    staticPrefs().email ||
    ""
  );
}

function isEmailField(name, label) {
  const hay = `${name || ""} ${label || ""}`.toLowerCase();
  if (/linkedin/.test(hay)) return false;
  const nm = String(name || "").toLowerCase();
  if (nm === "email" || nm.endsWith("_email") || nm === "_systemfield_email") return true;
  return /\bemail\b|e-mail/.test(hay);
}

async function fillCanonicalContact() {
  const email = canonicalEmail();
  if (!email) return 0;
  let filled = 0;
  document.querySelectorAll(formFieldSelector()).forEach((el) => {
    if (!isVisible(el) || el.type === "file" || el.type === "hidden") return;
    if (!isEmailField(el.name || el.id, fieldLabel(el))) return;
    if (safeSetValue(el, email)) filled += 1;
  });
  return filled;
}

function fillPlainPackageFields() {
  let filled = 0;
  document.querySelectorAll(formFieldSelector()).forEach((el) => {
    if (el.closest('#jobkit-panel, #jobright-helper-root') || el.type === 'checkbox' || el.type === 'radio' || el.tagName === 'SELECT') return;
    const value = matchFieldValue(el.name || el.id, fieldQuestionText(el), ctx?.field_values, ctx?.learned_answers);
    if (value && safeSetValue(el, value)) filled += 1;
  });
  return filled;
}

function shouldSkipVoluntaryField(label, name) {
  if (staticPrefs().fill_voluntary_eeo === true) return false;
  const hay = `${label || ""} ${name || ""}`.toLowerCase();
  return /gender|race|ethnic|veteran|disability|lgbtq|self.?identify|demographic|voluntary/.test(hay);
}

function matchLearnedAnswer(name, label, learned) {
  if (!learned) return null;
  if (isEmailField(name, label)) return null;
  if (isSponsorshipKnockoutField(name, label)) return sponsorshipKnockoutAnswer();
  if (isSponsorshipFollowup(name, label) && !sponsorRequired()) return null;
  const fieldKey = `field:${String(name || "").toLowerCase()}`;
  if (/\bwhy\b/i.test(label)) {
    const normalized = String(label || "").toLowerCase().replace(/\s+/g, " ").replace(/\s*\*+$/, "").trim();
    const direct = learned[normalized];
    if (direct) return direct;
    const byField = learned[fieldKey];
    return byField && ctx?.company && String(byField).toLowerCase().includes(ctx.company.toLowerCase()) ? byField : null;
  }
  if (learned[fieldKey]) {
    if (isSponsorshipFollowup(name, label) && !sponsorRequired()) return null;
    return learned[fieldKey];
  }

  let best = null;
  let bestScore = 0;
  for (const [question, answer] of Object.entries(learned)) {
    if (question.startsWith("field:")) continue;
    if (/if you do require.*sponsor/i.test(question) && !sponsorRequired()) continue;
    const score = Math.max(tokenOverlap(label, question), tokenOverlap(name, question));
    if (score > bestScore && score >= 0.65) {
      bestScore = score;
      best = answer;
    }
  }
  return best;
}

function matchFieldValue(name, label, fieldValues, learned) {
  if (shouldSkipVoluntaryField(label, name)) return null;

  const lowerName = (name || "").toLowerCase();
  const lowerLabel = (label || "").toLowerCase();
  const staticNo = staticPrefs().interviewed_before || "";
  const staticApplied = staticPrefs().applied_to_role_before || "";

  if (isEmailField(name, label)) return canonicalEmail();

  if (isRaceField(name, label)) {
    return staticPrefs().race || fieldValues?.race || fieldValues?.ethnicity || null;
  }

  if (isSponsorshipKnockoutField(name, label)) {
    return sponsorshipKnockoutAnswer();
  }

  if (/transgender/i.test(lowerLabel + lowerName)) {
    return transgenderAnswer();
  }

  if (/ever interviewed|interviewed.*before|interviewed at/i.test(lowerLabel + lowerName)) {
    return fieldValues?.question_15076698008 || learned?.["field:interviewed_before"] || staticNo;
  }
  if (/applied.*(this )?role before|applied for this role before/i.test(lowerLabel + lowerName)) {
    return fieldValues?.question_15141008008 || learned?.["field:applied_to_role_before"] || staticApplied;
  }
  if (/arbitration agreement below/i.test(lowerLabel + lowerName)) {
    return (
      fieldValues?.question_18371805008 ||
      learned?.["field:question_18371805008"] ||
      matchLearnedAnswer(name, label, learned)
    );
  }
  if (/agreement to arbitrate/i.test(lowerLabel + lowerName)) {
    return (
      fieldValues?.question_18374631008 ||
      learned?.["field:question_18374631008"] ||
      matchLearnedAnswer(name, label, learned)
    );
  }

  if (/if you do require.*sponsor|list the type of support/i.test(lowerLabel + lowerName)) {
    if (!sponsorRequired()) return null;
    return fieldValues?.question_66419403 || staticPrefs().sponsorship_assistance_detail || null;
  }

  for (const [key, val] of Object.entries(fieldValues || {})) {
    const lk = key.toLowerCase().replace(/\[\]/g, "");
    if (lowerName && (lowerName.includes(lk) || lk.includes(lowerName.replace(/\[\]/g, "")))) return val;
    if (lowerLabel && lk && lowerLabel.includes(lk.replace(/_/g, " "))) return val;
  }
  if (/first.?name/i.test(lowerLabel + lowerName)) return fieldValues?.first_name;
  if (/last.?name/i.test(lowerLabel + lowerName)) return fieldValues?.last_name;
  if (/phone/i.test(lowerLabel + lowerName)) return fieldValues?.phone;
  if (/linkedin/i.test(lowerLabel + lowerName))
    return fieldValues?.question_68404692 || fieldValues?.linkedin;
  if (/currently working|current company/i.test(lowerLabel + lowerName))
    return (
      fieldValues?.question_15141009008 ||
      learned?.["field:question_15141009008"] ||
      learned?.["at which company are you currently working? *"] ||
      staticPrefs().current_employer || ""
    );
  if (/sponsor/i.test(lowerLabel + lowerName) && !/if you do require|list the type of support/i.test(lowerLabel + lowerName)) {
    return sponsorshipKnockoutAnswer();
  }

  if (isSponsorshipFollowup(name, label)) return null;

  return matchLearnedAnswer(name, label, learned);
}

async function loadContext() {
  const job = parseJobFromUrl();
  if (!job.platform || !job.jobId) {
    return { job, ctx: null, error: "Open a specific job application to load its package" };
  }
  const resp = await safeSendMessage({
    type: "GET_CONTEXT",
    url: job.url,
    platform: job.platform,
    boardToken: job.boardToken,
    jobId: job.jobId,
  });
  if (resp && !resp.error && !contextMatchesJob(resp, job)) {
    return { job, ctx: null, error: "API package belongs to a different job — reconnect API" };
  }
  return { job, ctx: resp?.error ? null : resp, error: resp?.error };
}

function contextMatchesJob(context, job) {
  return !!job.platform && !!job.jobId &&
    context?.platform === job.platform &&
    String(context?.job_id || "") === String(job.jobId) &&
    (!job.boardToken || context?.board_token === job.boardToken);
}

async function refreshContext() {
  const loaded = await loadContext();
  const job = loaded.job;
  const cacheKey = jobStorageKey("jobkitLastCtx", job);
  if (loaded.ctx) {
    ctx = loaded.ctx;
    await safeStorageSet({
      [cacheKey]: {
        cached_at: Date.now(),
        application_id: ctx.application_id,
        platform: ctx.platform,
        board_token: ctx.board_token,
        job_id: ctx.job_id,
        automation: ctx.automation,
        field_values: ctx.field_values,
        learned_answers: ctx.learned_answers,
        static_answers: ctx.static_answers,
        field_meta: ctx.field_meta,
        contact: ctx.contact,
        company: ctx.company,
        job_title: ctx.job_title,
        automation_session: ctx.automation_session,
        resume_filename: ctx.resume_filename,
        resume_download_url: ctx.resume_download_url,
        approved_pdf_url: ctx.approved_pdf_url,
        job_key: currentJobKey(job),
      },
    });
  } else {
    const stored = await safeStorageGet([cacheKey, "jobkitLastCtx"]);
    const cached = stored[cacheKey] || stored.jobkitLastCtx;
    if (
      cached && Date.now() - Number(cached.cached_at || 0) < 15 * 60 * 1000 && contextMatchesJob(cached, job) &&
      (!cached.job_key || cached.job_key === currentJobKey(job)) &&
      String(cached.job_id || "") === String(job.jobId || "") &&
      (!job.boardToken || String(cached.board_token || "") === String(job.boardToken || ""))
    ) {
      ctx = cached;
    } else {
      ctx = null;
    }
  }
  return loaded;
}

function packageIsReady(ctxObj) {
  if (!ctxObj?.application_id) return false;
  const values = ctxObj.field_values || {};
  const keys = Object.keys(values);
  if (keys.length < 3) return false;
  if (!values.first_name && !values.email) return false;
  return true;
}

async function ensurePackageReady(options = {}) {
  const { silent = false, maxWaitMs = 20000, retryMs = 600 } = options;
  if (packageIsReady(ctx)) {
    if (!silent) {
      setPanelStatus(
        `Package ready · app #${ctx.application_id} · ${Object.keys(ctx.field_values || {}).length} answers`,
      );
    }
    return { ok: true, ctx };
  }
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < maxWaitMs) {
    attempt += 1;
    if (!silent) setPanelStatus(`Loading package… (${attempt})`);
    const loaded = await refreshContext();
    if (packageIsReady(loaded.ctx)) {
      ctx = loaded.ctx;
      if (!silent) {
        setPanelStatus(
          `Package ready · app #${ctx.application_id} · ${Object.keys(ctx.field_values).length} answers`,
        );
      }
      return { ok: true, ctx: loaded.ctx };
    }
    if (loaded.error && attempt >= 3 && !ctx) {
      return { ok: false, error: loaded.error || "Could not load package from API" };
    }
    await sleep(retryMs);
  }
  return {
    ok: false,
    error: "Package not ready — run `agent apply-next`, then Connect API in extension popup",
  };
}

function schedulePackageRetry() {
  if (!userStarted || packageRetryCount >= MAX_PACKAGE_RETRIES) return;
  packageRetryCount += 1;
  clearTimeout(packageRetryTimer);
  packageRetryTimer = setTimeout(() => {
    autoFlowStarted = false;
    void runAutoApplyFlow();
  }, 2500);
}

async function sendCapture(submitted = false, extra = {}) {
  if (!userStarted) return null;
  const job = parseJobFromUrl();
  let fields = (submitted || userEditedSinceCapture) ? scrapeFormFields() : [];
  fields = sanitizeCapturedFields(fields);
  const questions = scrapeFormQuestions();
  if (!fields.length && !questions.length && !(extra.validation_errors || []).length) return null;
  const submitFailed = !!extra.submit_failed;
  const key = JSON.stringify({ fields, questions }) + String(submitted) + String(submitFailed);
  if (key === lastCaptureKey && !submitted && !submitFailed) return null;
  lastCaptureKey = key;

  return safeSendMessage({
    type: "CAPTURE_ANSWERS",
    payload: {
      url: job.url,
      platform: job.platform || ctx?.platform,
      board_token: job.boardToken || ctx?.board_token,
      job_id: job.jobId || ctx?.job_id,
      application_id: ctx?.application_id || null,
      fields,
      questions,
      submitted: submitted && !submitFailed,
      submit_failed: submitFailed,
      validation_errors: extra.validation_errors || [],
      event: submitted ? (submitFailed ? "submit_failed" : "submit") : submitFailed ? "submit_failed" : "change",
    },
  });
}

function mergeLiveContext(resp) {
  if (!resp || resp.error || !ctx) return;
  if (resp.learned_answers) ctx.learned_answers = { ...(ctx.learned_answers || {}), ...resp.learned_answers };
  if (resp.cache_size != null) ctx.profile_cache_size = resp.cache_size;
  if (resp.question_count != null) ctx.question_count = resp.question_count;
}

function scheduleCapture() {
  if (!userStarted || !userEditedSinceCapture || fillInProgress) return;
  clearTimeout(captureTimer);
  captureTimer = setTimeout(() => {
    sendCapture(false).then(resp => { userEditedSinceCapture = false; updateLearnStatus(resp); });
  }, 1500);
}

function reportFillResult(filled, source) {
  const elapsedMs = fillDeadline ? Date.now() - (fillDeadline - FILL_RUN_BUDGET_MS) : 0;
  console.info(`[Jobkit] Fill completed in ${elapsedMs}ms (${filled} fields)`);
  void safeStorageSet({
    jobkitLastFill: {
      filled,
      elapsed_ms: elapsedMs,
      source,
      frame: location.hostname,
      at: Date.now(),
      application_id: ctx?.application_id || null,
      job_key: currentJobKey(),
    },
  });
}

function detectSubmitSuccess() {
  const text = document.body?.innerText || "";
  if (/thank you|application submitted|we received your application|confirmation/i.test(text)) return true;
  if (!findSubmitButton() && !document.querySelector(formFieldSelector())) return true;
  return false;
}

function detectValidationErrors() {
  const errors = [];
  const seen = new Set();
  const pushError = (name, label, message, el = null) => {
    if (el && shouldSkipValidationField(el)) return;
    if (isCaptchaField({ name, id: name })) return;
    const key = name || label;
    if (!key || seen.has(key)) return;
    seen.add(key);
    errors.push({ name: name || "", label: label || name || "Unknown field", message: message || "Validation error" });
  };

  document.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
    if (shouldSkipValidationField(el)) return;
    pushError(el.name || el.id, fieldLabel(el), "Invalid value", el);
  });

  document.querySelectorAll('.helper-text--error, [class*="error"]:not(svg):not(path)').forEach((node) => {
    if (!isVisible(node)) return;
    const root = node.closest(".field, .question, .application-question") || node.parentElement;
    const input = root?.querySelector("input, textarea, select, [role=combobox]");
    if (input && shouldSkipValidationField(input)) return;
    pushError(input?.name || input?.id, fieldLabel(input || root), node.textContent?.trim(), input);
  });

  document.querySelectorAll("input, textarea, select").forEach((el) => {
    if (shouldSkipValidationField(el)) return;
    const required = el.required || el.getAttribute("aria-required") === "true";
    if (!required) return;
    let empty = false;
    if (el.type === "file") empty = !el.files?.length;
    else if (el.type === "checkbox" || el.type === "radio") {
      const group = el.name
        ? [...document.querySelectorAll(`input[type="${el.type}"][name="${CSS.escape(el.name)}"]`)]
        : [el];
      empty = !group.some((option) => option.checked);
    }
    else if (el.tagName === "SELECT") empty = !el.value && el.selectedIndex <= 0;
    else empty = !String(el.value || "").trim();
    if (empty) pushError(el.name || el.id, fieldLabel(el), "Required field empty", el);
  });

  document.querySelectorAll(".select-shell, .select").forEach((shell) => {
    if (!isVisible(shell)) return;
    if (reactSelectIsFilled(shell)) return;
    const root = shell.closest(".field, .question, .application-question, .select__container") || shell.parentElement;
    const label = fieldLabel(shell);
    const required =
      root?.querySelector(".required, [class*='required']") ||
      shell.querySelector("[aria-required='true']") ||
      root?.querySelector("[aria-required='true']");
    const invalid = shell.querySelector('[aria-invalid="true"]') || root?.querySelector('[aria-invalid="true"]');
    if (!required && !invalid) return;
    const name = fieldNameFromShell(shell);
    pushError(name, label, "Required select empty", shell);
  });

  return errors;
}

function filterActionableValidationErrors(errors) {
  return (errors || []).filter((err) => !isCaptchaField({ name: err.name, id: err.name }));
}

function hasPendingCaptcha() {
  return [...document.querySelectorAll("textarea, input")].some(
    (el) => isCaptchaField(el) && (el.required || el.getAttribute("aria-required") === "true"),
  );
}

async function waitForApplyFormReady(timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fillBudgetExpired()) return false;
    const basic = document.querySelector(
      'input[name="first_name"], input[name="email"], input[id="first_name"], input[id="email"]',
    );
    const selects = document.querySelector(".select__control, .select-shell");
    if (basic && selects) return true;
    await sleep(250);
  }
  return !!document.querySelector(formFieldSelector());
}

async function repairMissingFields() {
  if (repairPasses >= MAX_REPAIR_PASSES) {
    const errors = filterActionableValidationErrors(detectValidationErrors());
    return { ok: !errors.length, errors, exhausted: true };
  }
  repairPasses += 1;
  if (!packageIsReady(ctx)) {
    const ready = await ensurePackageReady({ silent: true, maxWaitMs: 8000 });
    if (!ready.ok) return { ok: false, errors: [], waiting: true };
  }

  const errors = filterActionableValidationErrors(detectValidationErrors());
  if (!errors.length) {
    if (hasPendingCaptcha()) {
      setPanelStatus("Complete CAPTCHA in the form, then click Submit now");
    }
    return { ok: true, errors: [], captcha_pending: hasPendingCaptcha() };
  }

  setPanelStatus(`Repairing ${errors.length} missing/invalid field(s)…`);
  await waitForApplyFormReady();
  // fillForm performs the canonical select/package passes. Avoid running the
  // same select pass twice during repair, which made the tab feel frozen.
  await fillForm({ force: true, silent: false, skipRepair: true });
  await sleep(fillBudgetRemaining(300));

  const remaining = filterActionableValidationErrors(detectValidationErrors());
  if (remaining.length) {
    await sendCapture(false, { submit_failed: true, validation_errors: remaining });
    setPanelStatus(
      `Still need input: ${remaining
        .slice(0, 4)
        .map((e) => e.label.replace(/\*+$/, "").trim())
        .join("; ")}`,
    );
    return { ok: false, errors: remaining };
  }
  if (hasPendingCaptcha()) {
    setPanelStatus("Fields filled — complete CAPTCHA, then click Submit now");
    return { ok: true, errors: [], captcha_pending: true };
  }
  setPanelStatus("Validation errors cleared — ready to submit");
  return { ok: true, errors: [] };
}

async function attemptSubmit() {
  // Submission is an explicit user action; allow exactly one fresh repair
  // pass for edits made during review.
  repairPasses = 0;
  const repaired = await repairMissingFields();
  if (!repaired.ok) return false;

  const btn = findSubmitButton();
  if (!btn) {
    setPanelStatus("Submit button not found");
    return false;
  }
  btn.click();
  await sleep(3000);

  if (detectSubmitSuccess()) {
    const resp = await sendCapture(true);
    updateLearnStatus(resp);
    hideReviewUI();
    setPanelStatus("Submitted successfully · answers saved");
    return true;
  }

  const errors = filterActionableValidationErrors(detectValidationErrors());
  const resp = await sendCapture(false, { submit_failed: true, validation_errors: errors });
  updateLearnStatus(resp);
  await fillForm({ force: true, silent: false, skipRepair: true });
  setPanelStatus(
    errors.length
      ? `Submit blocked — ${errors.length} field(s) still red. Retrying after repair.`
      : hasPendingCaptcha()
        ? "Complete CAPTCHA, then click Submit now"
        : "Submit may have failed — form still visible. Review and retry.",
  );
  return false;
}

function updateLearnStatus(resp) {
  mergeLiveContext(resp);
  const el = document.getElementById("jobkit-learn");
  if (!el || !resp || resp.error) return;
  el.textContent = `Learned ${resp.saved_count || 0} answers (cache ${resp.cache_size || 0})`;
  if (resp.automation?.armed) {
    el.textContent += " · review required before submit";
  } else {
    el.textContent += ` · ${resp.automation?.trust_clean || 0}/${resp.automation?.trust_threshold || 20} toward auto`;
  }
  if (resp.submitted) {
    el.textContent += resp.had_corrections ? " · corrections detected" : " · submit recorded";
  }
  if (resp.submit_failed) {
    el.textContent += ` · submit failed (${(resp.validation_errors || []).length} validation)`;
  }
}

function setPanelStatus(text) {
  const status = document.getElementById("jobkit-status");
  if (status) status.textContent = text;
  void safeStorageSet({ jobkitPanelStatus: { text, at: Date.now(), frame: location.hostname, job_key: currentJobKey() } });
}

function mountPanel() {
  installPanelActions();
  if (document.getElementById("jobkit-panel")) return;
  if (!document.body) {
    document.addEventListener("DOMContentLoaded", mountPanel, { once: true });
    return;
  }
  createPanel();
}

async function uploadUserResume() {
  const response = await safeSendMessage({ type: "FETCH_USER_RESUME" });
  if (!response?.resume?.bytes?.length) return false;
  const { bytes, filename } = response.resume;
  const file = new File([new Uint8Array(bytes)], filename || "resume.pdf", { type: "application/pdf" });
  return attachResumeFile(file);
}

async function uploadResumeFromPackage() {
  if (fillBudgetExpired()) return false;
  if (await uploadUserResume()) return true;
  if (!ctx?.application_id) return false;
  const resumeUrl =
    ctx.resume_download_url ||
    ctx.automation_session?.resume_download_url ||
    ctx.approved_pdf_url;
  const filename = ctx.resume_filename || ctx.automation_session?.resume_filename || "resume.pdf";
  if (!resumeUrl) return false;

  const resp = await safeSendMessage({
    type: "FETCH_RESUME",
    url: resumeUrl,
    applicationId: ctx.application_id,
    filename,
  });
  if (resp?.error || !resp?.bytes?.length) return false;

  const blob = new Blob([new Uint8Array(resp.bytes)], {
    type: resp.mime || "application/pdf",
  });
  const file = new File([blob], resp.filename || filename, { type: "application/pdf" });
  return attachResumeFile(file);
}

function findResumeFileInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  return (
    inputs.find((el) => {
      const hay = `${fieldLabel(el)} ${el.name || ""} ${el.id || ""}`.toLowerCase();
      return /resume|cv|curriculum|vitae/.test(hay);
    }) || inputs.find((el) => !/cover.?letter/i.test(`${fieldLabel(el)} ${el.name || ""} ${el.id || ""}`))
  );
}

function attachResumeFile(file) {
  const input = findResumeFileInput();
  if (!input) return false;
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function isSponsorshipFollowup(name, label) {
  const hay = `${name || ""} ${label || ""}`.toLowerCase();
  return name === "question_66419403" || (/if you do require/.test(hay) && /sponsor/.test(hay));
}

function isSponsorshipKnockoutField(name, label) {
  const nm = String(name || "").trim();
  if (
    nm === "question_68319125" ||
    nm === "question_66419387" ||
    nm === "question_15076692008" ||
    nm === "question_15076693008"
  ) {
    return true;
  }
  const hay = `${name || ""} ${label || ""}`.toLowerCase();
  return /visa sponsorship|require visa sponsorship/.test(hay);
}

function explicitYesNo(value) {
  if (value === true || /^(yes|true)$/i.test(String(value || "").trim())) return "Yes";
  if (value === false || /^(no|false)$/i.test(String(value || "").trim())) return "No";
  return null;
}

function authorizationAnswer() {
  return explicitYesNo(staticPrefs().authorized_to_work);
}

function sponsorshipKnockoutAnswer() {
  const pref = explicitYesNo(staticPrefs().requires_sponsorship);
  if (pref !== null) return pref;
  const values = ctx?.field_values || {};
  return values.question_68319125 || values.question_66419387 || values.question_15076692008 ||
    values.question_15076693008 || values.question_64186580 || values.question_68579587 || null;
}

function relocationAnswer() {
  return ctx?.field_values?.question_15076696008 || explicitYesNo(staticPrefs().open_to_relocation);
}

function transgenderAnswer() {
  const values = ctx?.field_values || {};
  return values.demographic_606 || values.transgender || staticPrefs().transgender || null;
}

function eeoAnswers() {
  const values = ctx?.field_values || {};
  const prefs = staticPrefs();
  if (prefs.fill_voluntary_eeo !== true) return {};
  return {
    gender: values.gender || values.demographic_29783 || prefs.gender || null,
    race: prefs.race || values.race || values.ethnicity || values.demographic_29784 || null,
    veteran: values.veteran_status || values.demographic_29785 || prefs.veteran_status || null,
    disability: values.disability_status || values.demographic_29786 || prefs.disability_status || null,
    hispanic: values.hispanic_latino || prefs.hispanic_latino || null,
    transgender: values.demographic_606 || values.transgender || prefs.transgender || null,
  };
}

function sponsorRequired() {
  return String(sponsorshipKnockoutAnswer()).trim().toLowerCase() === "yes";
}

function sanitizeCapturedFields(fields) {
  if (sponsorshipKnockoutAnswer() !== "No") return fields;
  return fields
    .filter((field) => !isSponsorshipFollowup(field.name, field.label))
    .map((field) => {
      if (isSponsorshipFollowup(field.name, field.label)) return { ...field, value: "" };
      return field;
    });
}

async function fixSponsorshipFollowupField() {
  if (sponsorshipKnockoutAnswer() !== "No") return false;
  const textarea =
    document.querySelector('textarea[name="question_66419403"]') ||
    findFieldRoot(/if you do require.*sponsorship|list the type of support/i)?.querySelector("textarea");
  if (!textarea) return false;
  const current = String(textarea.value || "").trim();
  if (!current) return false;
  setNativeValue(textarea, "");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function findGreenhouseAutofillButton() {
  const scoped = document.querySelector(".application--header--autofill-with-greenhouse button");
  if (scoped && isVisible(scoped) && scoped.getAttribute("aria-disabled") !== "true" && !scoped.disabled) {
    return scoped;
  }
  return (
    [...document.querySelectorAll("button, a.btn")].find((el) => {
      if (!isVisible(el)) return false;
      if (el.getAttribute("aria-disabled") === "true" || el.disabled) return false;
      const text = el.textContent.trim();
      return /autofill\s+(my\s+application|with\s+greenhouse)/i.test(text);
    }) || null
  );
}

function isGreenhouseApplyForm() {
  return (
    /(?:job-boards|boards)\.greenhouse\.io$/i.test(location.hostname) &&
    !!document.querySelector("#application-form, .application--form, .application--header--autofill-with-greenhouse")
  );
}

function detectMyGreenhouseSignInModal() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="Modal"]')].filter(isVisible);
  return dialogs.find((node) => /mygreenhouse|quick apply|sign in|verification code|enter your email/i.test(node.textContent || ""));
}

async function waitForGreenhouseAutofillResult(timeoutMs = 9000) {
  const start = Date.now();
  const baselineEmail = String(document.querySelector('input[name="email"], #email')?.value || "").trim();
  const baselineFirst = String(document.querySelector('input[name="first_name"], #first_name')?.value || "").trim();

  while (Date.now() - start < timeoutMs) {
    if (detectMyGreenhouseSignInModal()) {
      return { ok: false, reason: "mygreenhouse_signin_required" };
    }
    const email = String(document.querySelector('input[name="email"], #email')?.value || "").trim();
    const first = String(document.querySelector('input[name="first_name"], #first_name')?.value || "").trim();
    const phone = String(document.querySelector('input[name="phone"], #phone')?.value || "").trim();
    const changed = (email && email !== baselineEmail) || (first && first !== baselineFirst);
    const populated = email && first;
    if (changed || (populated && (!baselineEmail || !baselineFirst))) {
      return { ok: true, reason: "fields_populated", email: !!email, phone: !!phone };
    }
    if (populated && Date.now() - start > 1200) {
      return { ok: true, reason: "fields_already_filled", email: !!email, phone: !!phone };
    }
    await sleep(250);
  }
  return { ok: false, reason: "timeout" };
}

async function triggerGreenhouseAutofill(options = {}) {
  const { silent = false } = options;
  if (!isGreenhouseApplyForm()) return { ok: false, reason: "not_greenhouse" };

  // A prepared Jobkit package already contains the canonical contact data.
  // Greenhouse's optional MyGreenhouse autofill can open a slow/sign-in flow
  // and leave the page half-filled, so use the package directly instead.
  if (packageIsReady(ctx)) {
    return { ok: true, reason: "jobkit_package_fill" };
  }

  // MyGreenhouse is optional. Avoid opening its flow when the page already
  // has the basic contact fields populated by browser/profile autofill.
  const existingEmail = String(document.querySelector('input[name="email"], #email')?.value || "").trim();
  const existingFirst = String(document.querySelector('input[name="first_name"], #first_name')?.value || "").trim();
  if (existingEmail && existingFirst) {
    return { ok: true, reason: "fields_already_filled", email: true, phone: !!document.querySelector('input[name="phone"], #phone')?.value };
  }

  const btn = findGreenhouseAutofillButton();
  if (!btn) return { ok: false, reason: "button_not_found" };

  if (!silent) setPanelStatus("Clicking Greenhouse Autofill…");
  btn.scrollIntoView({ block: "center", behavior: "instant" });
  btn.click();
  await sleep(400);

  const result = await waitForGreenhouseAutofillResult();
  if (result.ok && !silent) {
    setPanelStatus("Greenhouse Autofill applied — filling Jobkit package…");
  } else if (result.reason === "mygreenhouse_signin_required" && !silent) {
    setPanelStatus("MyGreenhouse sign-in opened — complete once, or dismiss; Jobkit will fill package fields");
  }
  return result;
}

async function fillForm(options) {
  const opts = options && typeof options === "object" ? options : {};
  const { silent = false, force = false, skipRepair = false } = opts;

  if (fillInProgress && !skipRepair) {
    if (!silent) setPanelStatus("Fill already in progress…");
    return 0;
  }
  const ownsFillLock = !fillInProgress;
  if (ownsFillLock) {
    fillInProgress = true;
    fillDeadline = Date.now() + FILL_RUN_BUDGET_MS;
  }

  try {
    // Form fields live in the Greenhouse iframe — skip empty parent Stripe page unless forced
    if (!force && window.top === window.self && !document.querySelector(formFieldSelector())) {
      if (!silent) setPanelStatus("Sending fill to apply form iframe…");
      void safeSendMessage({ type: "TRIGGER_FILL", jobKey: currentJobKey() });
      return 0;
    }

    const ready = await ensurePackageReady({ silent });
    if (!ready.ok) {
      if (!silent) setPanelStatus(ready.error);
      schedulePackageRetry();
      return 0;
    }

    await waitForApplyFormReady(Math.min(1000, Math.max(100, fillDeadline - Date.now())));

    if (isGreenhouseApplyForm()) {
      await triggerGreenhouseAutofill({ silent });
    }

    let filled = 0;
    filled += fillPlainPackageFields();
    filled += await fillCanonicalContact();
    if (await uploadResumeFromPackage()) filled += 1;
    if (await fillPhoneCountryCode()) filled += 1;
    if (await fixSponsorshipFollowupField()) filled += 1;

    filled += await fillPackageFieldsByName();
    filled += await fillRequiredDemographicDeclines();
    if (await fixSponsorshipFollowupField()) filled += 1;
    if (await fillCurrentEmployer()) filled += 1;

    const seenRadio = new Set();
    document.querySelectorAll(formFieldSelector()).forEach((el) => {
      if (fillBudgetExpired()) return;
      try {
        const label = fieldLabel(el);
        const question = fieldQuestionText(el);
        if (isSponsorshipFollowup(el.name, question) && !sponsorRequired()) return;
        if (isKnockoutField(question) && !/sponsor/i.test(question)) return;
        if (el.tagName === "SELECT") return;
        if (el.getAttribute("role") === "combobox" || el.classList.contains("select__input")) return;
        if (reactSelectShell(el)) return;
        if (el.type === "checkbox") return;
        if (el.type === "radio") {
          if (seenRadio.has(el.name)) return;
          seenRadio.add(el.name);
        }
        const val = matchFieldValue(el.name || el.id, question, ctx.field_values, ctx.learned_answers);
        if (val && safeSetValue(el, val)) filled += 1;
      } catch (err) {
        console.warn("[Jobkit] field fill skipped");
      }
    });

    if (await fixSponsorshipFollowupField()) filled += 1;

    reportFillResult(filled, isInApplyFrame() ? "iframe" : "page");
    if (!silent) {
      const where = isInApplyFrame() ? "in apply form" : "on page";
      const resumeNote = filled && findResumeFileInput()?.files?.length ? " (incl. resume)" : "";
      setPanelStatus(`Filled ${filled} fields ${where}${resumeNote} · app #${ctx.application_id || "?"}`);
    }
    const learnEl = document.getElementById("jobkit-learn");
    if (learnEl) {
      learnEl.textContent =
        ctx.automation?.learn_only_mode !== false
          ? "Learning mode — answers save as you type"
          : "Autonomous mode available";
    }
    scheduleCapture();
    let repair = { ok: true, errors: [] };
    if (!skipRepair) {
      repair = await repairMissingFields();
      if (!silent && repair.errors?.length) {
        const blockers = repair.errors
          .slice(0, 5)
          .map((e) => e.label.replace(/\*+$/, "").trim())
          .join("; ");
        setPanelStatus(`Filled ${filled} · blockers: ${blockers}`);
      } else if (!silent && repair.ok && !hasPendingCaptcha()) {
        setPanelStatus(`Filled ${filled} fields · ready for review/submit · app #${ctx.application_id || "?"}`);
      }
    }
    fillForm.lastRepair = repair;
    return filled;
  } finally {
    if (ownsFillLock) {
      fillInProgress = false;
      fillDeadline = 0;
    }
  }
}

function isKnockoutField(label) {
  return KNOCKOUT_PATTERNS.some((p) => p.test(label));
}

function findSubmitButton() {
  return (
    document.querySelector("#submit_app") ||
    document.querySelector("button[type=submit]") ||
    document.querySelector("[data-testid=submit-application-button]") ||
    document.querySelector('input[type=submit][value*="Submit"]')
  );
}

function tryAutoSubmit() {
  // Never submit an employment application from a timer or an armed/trust
  // flag. The user must explicitly click Jobkit's Submit now button after
  // reviewing the populated form.
  if (findSubmitButton()) setPanelStatus("Ready to submit — review the form, then click Submit now");
}

async function getAutomationPrefs() {
  const stored = await safeStorageGet([
    "jobkitSemiAutoSubmit",
    "jobkitReviewSeconds",
    "jobkitAutonomous",
  ]);
  const session = ctx?.automation_session || {};
  return {
    // Autofill is always enabled once the user has clicked Fill + Learn.
    // There is intentionally no page-load autofill preference anymore.
    autoFill: true,
    semiAutoSubmit: stored.jobkitSemiAutoSubmit !== false && session.semi_auto_submit !== false,
    reviewSeconds: Number(stored.jobkitReviewSeconds || session.review_seconds || 90),
    armedAuto: !!stored.jobkitAutonomous && !!ctx?.automation?.autonomous_submit_allowed,
  };
}

function clickApplyIfNeeded() {
  if (document.querySelector(formFieldSelector())) return false;
  const apply = [...document.querySelectorAll("a, button")].find((el) => {
    const text = el.textContent.trim();
    return /^apply$/i.test(text) || /^apply for this job$/i.test(text);
  });
  if (apply) {
    apply.click();
    return true;
  }
  return false;
}

function updateReviewCountdown() {
  const el = document.getElementById("jobkit-countdown");
  if (el) {
    el.textContent = reviewRemaining > 0
      ? `Review: ${reviewRemaining}s · submit manually when ready`
      : "Ready to submit manually after review";
  }
  const badge = document.getElementById("jobkit-iframe-badge");
  if (badge && window.top !== window.self) {
    badge.textContent = `Jobkit · review ${reviewRemaining}s (submit manually)`;
  }
}

function showReviewUI() {
  const panel = document.getElementById("jobkit-review");
  if (panel) panel.classList.remove("hidden");
  updateReviewCountdown();
}

function hideReviewUI() {
  const panel = document.getElementById("jobkit-review");
  if (panel) panel.classList.add("hidden");
  const badge = document.getElementById("jobkit-iframe-badge");
  if (badge && window.top !== window.self) badge.textContent = "Jobkit · apply form";
}

function cancelReviewSubmit() {
  clearTimeout(reviewTimer);
  clearInterval(reviewInterval);
  reviewTimer = null;
  reviewInterval = null;
  hideReviewUI();
  void safeStorageRemove([jobStorageKey("jobkitReviewState")]);
  setPanelStatus("Review cancelled — submit manually when ready");
}

function submitNow() {
  if (findSubmitButton()) {
    clearTimeout(reviewTimer);
    clearInterval(reviewInterval);
    reviewTimer = null;
    reviewInterval = null;
    hideReviewUI();
    void safeStorageRemove([jobStorageKey("jobkitReviewState")]);
    attemptSubmit();
    return;
  }
  void safeStorageSet({ [jobStorageKey("jobkitReviewSubmitNow")]: Date.now() });
}

function syncReviewState() {
  void safeStorageSet({
    [jobStorageKey("jobkitReviewState")]: {
      remaining: reviewRemaining,
      application_id: ctx?.application_id || null,
      job_key: currentJobKey(),
    },
  });
}

function scheduleReviewSubmit(seconds) {
  if (!findSubmitButton()) return;
  clearTimeout(reviewTimer);
  clearInterval(reviewInterval);
  reviewRemaining = 0;
  showReviewUI();
  setPanelStatus("Filled — review the form, then click Submit now");
}

async function runAutoApplyFlow() {
  if (!userStarted || autoFlowStarted || fillInProgress) return;
  const prefs = await getAutomationPrefs();
  if (!prefs.autoFill) return;

  const ready = await ensurePackageReady({ silent: false, maxWaitMs: 6000, retryMs: 350 });
  if (!ready.ok) {
    setPanelStatus(ready.error);
    schedulePackageRetry();
    return;
  }

  autoFlowStarted = true;
  repairPasses = 0;
  scrapeFormQuestions().forEach((q) => knownQuestionKeys.add(`${q.name}:${q.question}`));
  setPanelStatus("Auto-fill starting…");

  if (window.top === window.self) {
    if (clickApplyIfNeeded()) await sleep(2000);
    if (!document.querySelector(formFieldSelector())) {
      void safeSendMessage({ type: "TRIGGER_FILL", jobKey: currentJobKey() });
      autoFlowStarted = false;
      return;
    }
  }

  const filled = await fillForm({ force: true, silent: false });
  const repair = fillForm.lastRepair || { ok: false, errors: detectValidationErrors() };
  const blockers = filterActionableValidationErrors(repair.errors || detectValidationErrors());

  if (filled <= 0 && blockers.length) {
    autoFlowStarted = false;
    setPanelStatus(`Fill failed — ${blockers.length} required field(s) empty. Click Fill + Learn to retry.`);
    if (window.top !== window.self) schedulePackageRetry();
    return;
  }

  if (blockers.length) {
    autoFlowStarted = false;
    setPanelStatus(
      `Fill incomplete — fix: ${blockers
        .slice(0, 4)
        .map((e) => e.label.replace(/\*+$/, "").trim())
        .join("; ")}`,
    );
    return;
  }

  if (filled <= 0) {
    autoFlowStarted = false;
    if (window.top !== window.self) schedulePackageRetry();
    return;
  }

  if (findSubmitButton()) {
    scheduleReviewSubmit(0);
  }
}

async function maybeAutonomousBootstrap() {
  // Kept as a compatibility hook for older pages, but intentionally inert.
  // The submit boundary always requires an explicit user click.
  return;
}

function installCaptureListeners() {
  const captureUserEdit = (event) => {
    if (!event.isTrusted || fillInProgress || event.target?.closest?.('#jobkit-panel')) return;
    userEditedSinceCapture = true;
    scheduleCapture();
  };
  document.addEventListener("input", captureUserEdit, true);
  document.addEventListener("change", captureUserEdit, true);
  document.addEventListener(
    "submit",
    () => {
      if (!userStarted) return;
      setTimeout(async () => {
        if (detectSubmitSuccess()) {
          const resp = await sendCapture(true);
          updateLearnStatus(resp);
          if (resp?.automation) ctx = { ...ctx, automation: resp.automation };
        } else {
          const errors = detectValidationErrors();
          const resp = await sendCapture(false, { submit_failed: true, validation_errors: errors });
          updateLearnStatus(resp);
          await repairMissingFields();
        }
      }, 2500);
    },
    true,
  );
}

function maybeAutoFill() {
  // Deliberately inert: page load and DOM mutations must never start a fill.
  // The user starts the flow from the visible Fill + Learn button.
  return;
}

function hasVisibleAutofillControl() {
  if (detectPlatform() !== "greenhouse") return false;
  const documents = [document];
  if (window.top !== window.self) {
    try {
      documents.push(window.top.document);
    } catch (_err) {
      // A cross-origin frame cannot inspect its parent; the local document
      // check still prevents duplicate controls when the form owns Autofill.
    }
  }
  return documents.some((doc) =>
    [...doc.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']")]
      .filter(isVisible)
      .some((el) => /autofill/i.test(String(el.textContent || el.value || "").trim())),
  );
}

function shouldMountPanel() {
  // Native/third-party Autofill controls do not expose Jobkit's prepared
  // package, resume, or review flow. Keep Jobkit accessible on actual jobs.
  const job = parseJobFromUrl();
  return !!job.platform && !!job.jobId;
}

function watchForDynamicForm() {
  if (formObserver) return;
  formObserver = new MutationObserver((mutations) => {
    if (!document.getElementById("jobkit-panel") && document.body && shouldMountPanel()) {
      mountPanel();
      setPanelStatus(packageIsReady(ctx)
        ? `Ready · click Fill + Learn to start · ${ctx.company || ""} ${ctx.job_title || ""} (#${ctx.application_id})`
        : "No prepared package for this job — prepare it in Jobkit");
    }
    const changedControls = mutations.some((mutation) =>
      mutation.type === "attributes" || (mutation.type === "childList" &&
      [...mutation.addedNodes].some((node) =>
        node.nodeType === Node.ELEMENT_NODE &&
        (node.matches?.(formFieldSelector()) || node.querySelector?.(formFieldSelector()) || node.matches?.("[role='combobox'], [aria-haspopup='listbox']") || node.querySelector?.("[role='combobox'], [aria-haspopup='listbox']")),
      )),
    );
    if (userStarted && changedControls && scrapeFormQuestions().length) {
      scheduleCapture();
      clearTimeout(dynamicFillTimer);
      dynamicFillTimer = setTimeout(async () => {
        const questions = scrapeFormQuestions();
        const unseen = questions.filter((q) => !knownQuestionKeys.has(`${q.name}:${q.question}`));
        if (!userStarted || fillInProgress || !unseen.length) return;
        questions.forEach((q) => knownQuestionKeys.add(`${q.name}:${q.question}`));
        if (autoFlowStarted && !filterActionableValidationErrors(detectValidationErrors()).length) return;
        await refreshContext();
        await fillForm({ force: true, silent: true, skipRepair: true });
        await sendCapture(false);
        setPanelStatus(`New questions detected — package refreshed and form continued (${unseen.length})`);
      }, 500);
    }
  });
  formObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "aria-expanded", "aria-controls"],
  });
}

let panelActionsInstalled = false;
function installPanelActions() {
  if (panelActionsInstalled) return;
  panelActionsInstalled = true;
  document.addEventListener('click', (event) => {
    const button = event.target?.closest?.('#jobkit-panel button');
    if (!button || !event.isTrusted) return;
    if (button.id === 'jobkit-attach-resume') {
      void uploadUserResume().then(attached => setPanelStatus(attached
        ? 'Your resume attached — review before submitting'
        : 'Choose your PDF in the extension popup, then retry Attach my resume'))
        .catch(() => setPanelStatus('Could not attach your resume'));
    } else if (button.id === 'jobkit-fill') {
      userStarted = true;
      autoFlowStarted = false;
      clearTimeout(packageRetryTimer);
      setPanelStatus('Starting Fill + Learn…');
      void runAutoApplyFlow().catch(err => {
        autoFlowStarted = false;
        console.error('[Jobkit] Fill failed');
        setPanelStatus('Fill failed — click Fill + Learn to retry');
      });
    } else if (button.id === 'jobkit-cancel-submit') {
      cancelReviewSubmit();
      void safeStorageSet({ [jobStorageKey('jobkitReviewCancel')]: Date.now() });
    } else if (button.id === 'jobkit-submit-now') {
      submitNow();
      if (!findSubmitButton()) void safeStorageSet({ [jobStorageKey('jobkitReviewSubmitNow')]: Date.now() });
    }
  }, true);
}

function createPanel() {
  installPanelActions();
  if (document.getElementById("jobkit-panel")) return;
  const panel = document.createElement("div");
  panel.id = "jobkit-panel";
  panel.innerHTML = `
    <div class="jobkit-header">Jobkit · auto-apply</div>
    <div id="jobkit-status">Connecting…</div>
    <button id="jobkit-fill" type="button">Fill + Learn</button>
    <button id="jobkit-attach-resume" type="button">Attach my resume</button>
    <div id="jobkit-review" class="jobkit-review hidden">
      <div id="jobkit-countdown">Review countdown</div>
      <div class="jobkit-review-actions">
        <button id="jobkit-cancel-submit" type="button">Cancel review</button>
        <button id="jobkit-submit-now" type="button">Submit now</button>
      </div>
    </div>
    <div id="jobkit-learn" class="jobkit-note">Greenhouse Autofill → Jobkit package fill when a prepared app is bound</div>
  `;
  document.body.appendChild(panel);
}

function createIframeBadge() {
  if (document.getElementById("jobkit-iframe-badge")) return;
  if (document.getElementById("jobkit-panel")) return;
  const badge = document.createElement("div");
  badge.id = "jobkit-iframe-badge";
  badge.textContent = "Jobkit · apply form";
  document.body.appendChild(badge);
}

function listenForFillBroadcast() {
  if (!extensionContextAlive()) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!extensionContextAlive()) {
      showContextInvalidated();
      return;
    }
    if (area !== "local") return;
    if (changes[jobStorageKey("jobkitFillTrigger")] && isInApplyFrame()) {
      userStarted = true;
      autoFlowStarted = false;
      clearTimeout(packageRetryTimer);
      runAutoApplyFlow();
    }
    if (changes[jobStorageKey("jobkitReviewCancel")]) {
      cancelReviewSubmit();
    }
    if (changes[jobStorageKey("jobkitReviewSubmitNow")]) {
      submitNow();
    }
    const reviewChange = changes[jobStorageKey("jobkitReviewState")];
    if (reviewChange) {
      const state = reviewChange.newValue;
      if (state?.remaining > 0) {
        reviewRemaining = state.remaining;
        showReviewUI();
        updateReviewCountdown();
        setPanelStatus(`Review ${reviewRemaining}s — verify form, then click Submit now`);
      } else if (state === undefined || state === null) {
        hideReviewUI();
      }
    }
    if (changes.jobkitPanelStatus && window.top === window.self) {
      const data = changes.jobkitPanelStatus.newValue;
      if (data?.job_key === currentJobKey() && data?.text && /greenhouse/i.test(data.frame || "")) {
        const status = document.getElementById("jobkit-status");
        if (status) status.textContent = data.text;
      }
    }
    if (changes.jobkitLastFill) {
      const data = changes.jobkitLastFill.newValue;
      if (data?.job_key !== currentJobKey()) return;
      if (data?.filled > 0) {
        setPanelStatus(`Filled ${data.filled} fields in apply form · app #${data.application_id || "?"}`);
      } else if (data?.filled === 0 && data?.source === "iframe") {
        setPanelStatus("Apply form found but no fields matched — check API package");
      }
    }
  });
}

async function init() {
  if (!isSupportedApplicationUrl(location.href) || !shouldMountPanel()) return;
  if (!extensionContextAlive()) {
    if (shouldMountPanel()) mountPanel();
    showContextInvalidated();
    return;
  }

  installCaptureListeners();
  watchForDynamicForm();
  listenForFillBroadcast();

  const loaded = await refreshContext();
  ctx = loaded.ctx || ctx;

  const hasForm = !!document.querySelector(formFieldSelector());
  const inApplyFrame = isInApplyFrame();

  // Show the control panel on the page you're actually using (including Greenhouse iframes).
  if ((inApplyFrame || window.top === window.self) && shouldMountPanel()) {
    mountPanel();
  }

  if (inApplyFrame || hasForm) {
    if (packageIsReady(ctx)) {
      setPanelStatus(`Ready · click Fill + Learn to start · ${ctx.company || ""} ${ctx.job_title || ""} (#${ctx.application_id})`);
    } else {
      setPanelStatus(loaded.error || "No prepared package for this job — prepare it in Jobkit");
    }
  } else if (window.top === window.self) {
    setPanelStatus("Ready · click Fill + Learn when you want to start");
  }

  await maybeAutonomousBootstrap();
}

init();
