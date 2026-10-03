/* SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0 */
importScripts("security.js");

async function getToken() {
  // Session storage is inaccessible to content scripts by default.
  await chrome.storage.local.remove("jobkitToken");
  const stored = await chrome.storage.session.get(["jobkitToken"]);
  if (stored.jobkitToken) return stored.jobkitToken;
  const res = await fetch(localApiUrl("/api/auth/bootstrap"), {
    redirect: "error", credentials: "omit", cache: "no-store",
  });
  if (!res.ok) throw new Error("Start the local Jobkit API on port 8765");
  const data = await res.json();
  if (typeof data.token !== "string" || !data.token) throw new Error("Invalid local API response");
  await chrome.storage.session.set({ jobkitToken: data.token });
  return data.token;
}

async function authenticatedFetch(path, options = {}) {
  const url = localApiUrl(path); // Validate before obtaining or sending a token.
  let token = await getToken();
  const request = () => fetch(url, {
    ...options,
    redirect: "error", credentials: "omit", cache: "no-store",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
  let res = await request();
  if (res.status === 401 || res.status === 403) {
    await chrome.storage.session.remove("jobkitToken");
    token = await getToken();
    res = await request();
  }
  if (!res.ok) throw new Error(`Local Jobkit API request failed (${res.status})`);
  return res;
}

async function api(path, options = {}) {
  return (await authenticatedFetch(path, options)).json();
}

function validateSender(sender, popupOnly = false) {
  if (sender?.id !== chrome.runtime.id) throw new Error("Untrusted extension sender");
  const popup = sender.url === chrome.runtime.getURL("popup.html") && !sender.tab;
  if (popupOnly ? !popup : !popup && !isSupportedApplicationUrl(sender.url)) {
    throw new Error("Unsupported sender page");
  }
}

const MAX_USER_RESUME_BYTES = 4 * 1024 * 1024;

function validatePdfBytes(bytes) {
  if (!Array.isArray(bytes) || bytes.length < 5 || bytes.length > MAX_USER_RESUME_BYTES ||
      bytes.some(value => !Number.isInteger(value) || value < 0 || value > 255) ||
      String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") {
    throw new Error("Choose a PDF resume up to 4 MiB");
  }
}

async function savedUserResume() {
  const { jobkitUserResume } = await chrome.storage.local.get("jobkitUserResume");
  if (!jobkitUserResume) return null;
  if (typeof jobkitUserResume.base64 !== "string" || jobkitUserResume.base64.length > 6 * 1024 * 1024) {
    throw new Error("Invalid saved resume");
  }
  const bytes = Array.from(atob(jobkitUserResume.base64), value => value.charCodeAt(0));
  validatePdfBytes(bytes);
  return { bytes, filename: jobkitUserResume.filename || "resume.pdf", mime: "application/pdf" };
}

async function handleMessage(msg, sender) {
  if (!msg || typeof msg !== "object") throw new Error("Invalid message");
  validateSender(sender, ["OPEN_APPLY_TAB", "CONNECT_API", "GET_LAST_APPLICATION", "SAVE_USER_RESUME", "GET_USER_RESUME_INFO", "REMOVE_USER_RESUME"].includes(msg.type));
  if (msg.type === "SAVE_USER_RESUME") {
    validatePdfBytes(msg.bytes);
    const filename = String(msg.filename || "resume.pdf").replace(/[\\/\r\n\x00-\x1f]/g, "_").slice(0, 180);
    let binary = "";
    for (let index = 0; index < msg.bytes.length; index += 8192) {
      binary += String.fromCharCode(...msg.bytes.slice(index, index + 8192));
    }
    await chrome.storage.local.set({ jobkitUserResume: { base64: btoa(binary), filename } });
    return { filename, bytes: msg.bytes.length };
  }
  if (msg.type === "GET_USER_RESUME_INFO") {
    const { jobkitUserResume } = await chrome.storage.local.get("jobkitUserResume");
    return { filename: jobkitUserResume?.filename || null };
  }
  if (msg.type === "REMOVE_USER_RESUME") {
    await chrome.storage.local.remove("jobkitUserResume");
    return { ok: true };
  }
  if (msg.type === "FETCH_USER_RESUME") return { resume: await savedUserResume() };
  if (msg.type === "CONNECT_API") { await getToken(); return { ok: true }; }
  if (msg.type === "GET_LAST_APPLICATION") {
    const data = await api("/api/ledger/applications?limit=1");
    return { apply_url: data.applications?.[0]?.apply_url || null };
  }
  if (msg.type === "GET_CONTEXT") {
    const url = sanitizedApplicationUrl(sender.url);
    if (msg.url && sanitizedApplicationUrl(msg.url) !== url) throw new Error("Application URL mismatch");
    const q = new URLSearchParams({ url,
      ...(msg.platform ? { platform: msg.platform } : {}),
      ...(msg.boardToken ? { board_token: msg.boardToken } : {}),
      ...(msg.jobId ? { job_id: msg.jobId } : {}),
      ...(msg.applicationId ? { application_id: String(msg.applicationId) } : {}),
    });
    return api(`/api/extension/context?${q}`);
  }
  if (msg.type === "CAPTURE_ANSWERS") {
    const url = sanitizedApplicationUrl(sender.url);
    if (!msg.payload || sanitizedApplicationUrl(msg.payload.url) !== url) throw new Error("Capture URL mismatch");
    return api("/api/extension/capture", { method: "POST", body: JSON.stringify({ ...msg.payload, url }) });
  }
  if (msg.type === "OPEN_APPLY_TAB") {
    await chrome.tabs.create({ url: sanitizedApplicationUrl(msg.url), active: true });
    return { ok: true };
  }
  if (msg.type === "TRIGGER_FILL") {
    if (!msg.jobKey || typeof msg.jobKey !== "string" || msg.jobKey.length > 300) throw new Error("Missing job scope");
    await chrome.storage.local.set({ [`jobkitFillTrigger:${msg.jobKey}`]: Date.now() });
    return { ok: true };
  }
  if (msg.type === "FETCH_RESUME") {
    const url = localResumeUrl(msg.url || `/api/ledger/applications/${msg.applicationId}/resume`);
    const res = await authenticatedFetch(url);
    const declaredLength = Number(res.headers.get("Content-Length"));
    if (declaredLength > 10 * 1024 * 1024) throw new Error("Resume exceeds 10 MiB limit");
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > 10 * 1024 * 1024) throw new Error("Resume exceeds 10 MiB limit");
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("Resume must be a PDF");
    const disposition = res.headers.get("Content-Disposition") || "";
    const name = disposition.match(/filename="?([^";\n]+)"?/)?.[1] || msg.filename || "resume.pdf";
    const filename = String(name).replace(/[\\/\r\n\x00-\x1f]/g, "_").slice(0, 180);
    return { bytes: Array.from(bytes), filename, mime: "application/pdf" };
  }
  throw new Error("Unknown extension request");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, err => sendResponse({ error: err.message || "Jobkit request failed" }));
  return true;
});
